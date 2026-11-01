import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { runAgent, parseVerdict } from './agents.js';
import { runShell } from './proc.js';
import * as git from './git.js';
import * as tmaster from './taskmaster.js';
import { implementPrompt, fixChecksPrompt, fixReviewPrompt, codeReviewPrompt, handoverPrompt } from './prompts.js';
import { appendLog, isPidAlive, readState, taskDir, taskState, updateState } from './state.js';
import { acquireSlot, release as releaseSlot } from './queue.js';
import { archiveTasks } from './archive.js';
import { updateItem } from './backlog.js';

const RUN_SCOPE = 'runner';

export function featureBranch(cfg, state) {
  const base = cfg.feature || state.prd.idea || 'feature';
  const slug = base
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'feature';
  return `${cfg.branch_prefix}${slug}`;
}

function setPipeline(root, status, reason = '', extra = {}) {
  updateState(root, (s) => {
    s.pipeline = { ...s.pipeline, status, reason, ...extra };
  });
  appendLog(root, RUN_SCOPE, `流程狀態：${status}${reason ? `（${reason}）` : ''}`);
}

function setTask(root, id, patch) {
  updateState(root, (s) => {
    Object.assign(taskState(s, id), patch);
  });
}

/** 依序跑 build → lint → test；全部跑完再回報，讓修正時一次看到所有錯誤。 */
async function runChecks(root, cfg, id, scope) {
  const results = [];
  for (const name of ['build', 'lint', 'test']) {
    const cmd = cfg.commands[name];
    if (!cmd) continue;
    setTask(root, id, { step: `執行 ${name}` });
    appendLog(root, scope, `$ ${cmd}`);
    const res = await runShell(cmd, {
      cwd: root,
      timeoutSec: cfg.command_timeout_sec,
      onStdout: (d) => appendLog(root, scope, d.trimEnd()),
      onStderr: (d) => appendLog(root, scope, d.trimEnd()),
    });
    const ok = res.code === 0;
    results.push({ name, cmd, ok, code: res.code, output: (res.stdout + '\n' + res.stderr).trim(), timedOut: res.timedOut });
    appendLog(root, scope, `${name}：${ok ? '通過' : `失敗（結束碼 ${res.code}${res.timedOut ? '，逾時' : ''}）`}`);
  }
  const text = results.length
    ? results.map((r) => `## ${r.name}: ${r.ok ? 'PASS' : 'FAIL'} (\`${r.cmd}\`, exit ${r.code})\n${r.output.slice(-20000)}`).join('\n\n')
    : '（未設定 build/test/lint 指令，略過）';
  fs.writeFileSync(path.join(taskDir(root, id), 'checks.txt'), text);
  return { ok: results.every((r) => r.ok), results, text };
}

class StuckError extends Error {}

/**
 * 執行單一任務：實作 → 驗證 → 審查 → 修正（最多 max_fix_rounds 輪）→ 更新 handover →
 * 自動模式 commit + done；手動模式停在「等待測試」。
 */
async function runTask(root, cfg, id, { verifyOnly = false } = {}) {
  const scope = `task-${id}`;
  const task = tmaster.findTask(root, id);
  if (!task) throw new Error(`tasks.json 找不到任務 ${id}`);
  const dir = taskDir(root, id);
  const prev = readState(root).tasks[id];
  if (!verifyOnly) {
    // 新的一次嘗試：清掉上一次的審查與驗證紀錄，避免 UI 顯示過期內容（log 保留）。
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  }
  const baseTree = verifyOnly && prev?.base_tree ? prev.base_tree : git.snapshotTree(root);

  updateState(root, (s) => {
    const t = taskState(s, id);
    Object.assign(t, {
      title: task.title,
      phase: 'implementing',
      step: verifyOnly ? '重新驗證' : '實作中',
      fix_round: 0,
      attempts: (t.attempts || 0) + (verifyOnly ? 0 : 1),
      base_tree: baseTree,
      started_at: new Date().toISOString(),
      finished_at: null,
      error: '',
      review_verdict: null,
      last_check_ok: null,
    });
    s.pipeline.current_task = String(id);
  });
  appendLog(root, scope, `═══ 任務 ${id}：${task.title} ═══`);
  await tmaster.setStatus(root, cfg, id, 'in-progress', scope);

  let notes = '';
  if (!verifyOnly) {
    const impl = await runAgent({
      root, cfg, provider: cfg.roles.implementer, prompt: implementPrompt(root, cfg, task),
      write: true, scope, label: `實作任務 ${id}`,
    });
    if (!impl.ok) throw new StuckError(`實作 AI 失敗：${impl.error}`);
    notes = impl.text;
    fs.writeFileSync(path.join(dir, 'implement.md'), notes);
  }

  let round = 0;
  for (;;) {
    setTask(root, id, { phase: 'implementing', step: '驗證中', fix_round: round });
    const checks = await runChecks(root, cfg, id, scope);
    setTask(root, id, { last_check_ok: checks.ok });
    if (!checks.ok) {
      if (round >= cfg.max_fix_rounds) throw new StuckError(`驗證失敗且修正輪數已用盡（${cfg.max_fix_rounds}）`);
      round++;
      setTask(root, id, { step: `修正驗證錯誤（第 ${round} 輪）`, fix_round: round });
      const failed = checks.results.filter((r) => !r.ok).map((r) => `## ${r.name} (\`${r.cmd}\`)\n${r.output.slice(-15000)}`).join('\n\n');
      const fix = await runAgent({
        root, cfg, provider: cfg.roles.implementer, prompt: fixChecksPrompt(root, cfg, task, failed, round),
        write: true, scope, label: `修正驗證錯誤 第 ${round} 輪`,
      });
      if (!fix.ok) throw new StuckError(`修正 AI 失敗：${fix.error}`);
      notes += `\n\n### 修正第 ${round} 輪\n${fix.text}`;
      continue;
    }

    setTask(root, id, { phase: 'reviewing', step: '程式碼審查中' });
    await tmaster.setStatus(root, cfg, id, 'review', scope);
    const diff = git.diffTrees(root, baseTree, git.snapshotTree(root));
    fs.writeFileSync(path.join(dir, 'diff.patch'), diff);
    const summary = checks.results.length ? checks.results.map((r) => `- ${r.name}: PASS`).join('\n') : '- 未設定驗證指令';
    const review = await runAgent({
      root, cfg, provider: cfg.roles.code_reviewer, prompt: codeReviewPrompt(root, cfg, task, diff || '（沒有任何變更）', summary),
      write: false, scope, label: `程式碼審查 第 ${round + 1} 次`,
    });
    if (!review.ok) throw new StuckError(`審查 AI 失敗：${review.error}`);
    const { pass, verdict } = parseVerdict(review.text, ['PASS']);
    fs.writeFileSync(path.join(dir, `review-${round + 1}.md`), review.text);
    setTask(root, id, { review_verdict: verdict, reviews: round + 1 });
    if (pass) break;
    if (round >= cfg.max_fix_rounds) throw new StuckError(`審查未通過且修正輪數已用盡（${cfg.max_fix_rounds}）`);
    round++;
    setTask(root, id, { phase: 'implementing', step: `處理審查意見（第 ${round} 輪）`, fix_round: round });
    const fix = await runAgent({
      root, cfg, provider: cfg.roles.implementer, prompt: fixReviewPrompt(root, cfg, task, review.text, round),
      write: true, scope, label: `處理審查意見 第 ${round} 輪`,
    });
    if (!fix.ok) throw new StuckError(`修正 AI 失敗：${fix.error}`);
    notes += `\n\n### 處理審查意見第 ${round} 輪\n${fix.text}`;
  }

  setTask(root, id, { phase: 'reviewing', step: '更新 handover' });
  const stat = git.diffTrees(root, baseTree, git.snapshotTree(root)).split('\n').filter((l) => /^ \S.*\|/.test(l) || /files? changed/.test(l)).join('\n');
  const ho = await runAgent({
    root, cfg, provider: cfg.roles.implementer, prompt: handoverPrompt(root, cfg, task, notes, stat),
    write: true, scope, label: '更新 handover',
  });
  if (!ho.ok) appendLog(root, scope, `⚠ handover 更新失敗：${ho.error}（不影響任務結果）`);
  // 最終 diff（含 handover）供 UI 顯示。
  fs.writeFileSync(path.join(dir, 'diff.patch'), git.diffTrees(root, baseTree, git.snapshotTree(root)));

  const fresh = loadConfig(root);
  if (fresh.mode === 'auto') {
    setTask(root, id, { step: 'git commit' });
    // 先標 done 再 commit，讓 tasks.json 的狀態和程式碼在同一個 commit；commit 失敗就退回 review。
    await tmaster.setStatus(root, fresh, id, 'done', scope);
    let sha;
    try {
      sha = git.commitAll(root, `aipipe: task ${id} ${task.title}`);
    } catch (err) {
      await tmaster.setStatus(root, fresh, id, 'review', scope);
      throw new StuckError(err.message);
    }
    appendLog(root, scope, sha ? `已 commit ${sha.slice(0, 8)}` : '沒有變更可 commit');
    setTask(root, id, { phase: 'done', step: '完成', commit: sha, finished_at: new Date().toISOString() });
    return 'done';
  }
  setTask(root, id, { phase: 'awaiting_test', step: '等待人工測試', finished_at: new Date().toISOString() });
  return 'awaiting_test';
}

function acquireRunner(root) {
  const s = readState(root);
  if (s.runner.pid && s.runner.pid !== process.pid && isPidAlive(s.runner.pid)) {
    throw new Error(`已有 aipipe run 在執行（pid ${s.runner.pid}）`);
  }
  updateState(root, (st) => {
    st.runner = { pid: process.pid, started_at: new Date().toISOString() };
    st.control.pause_requested = false;
  });
}

function releaseRunner(root) {
  updateState(root, (st) => {
    if (st.runner.pid === process.pid) st.runner = { pid: null, started_at: null };
    if (['running', 'queued'].includes(st.pipeline.status)) st.pipeline.status = 'idle';
  });
}

/**
 * 主迴圈。停下來的時機：
 * - 手動模式：每個任務完成後（等待測試）
 * - 自動模式：全部任務完成（功能待測試）
 * - 兩種模式：修正輪數用盡／AI 失敗、使用者按暫停
 */
export async function runPipeline(root, { firstTask = null, verifyOnly = false } = {}) {
  acquireRunner(root);
  try {
    let cfg = loadConfig(root);
    const state = readState(root);
    if (state.prd.status !== 'approved') throw new Error('PRD 尚未核准');
    if (!tmaster.readTasks(root).length) throw new Error('還沒有任務，請先執行 aipipe tasks');
    const waiting = Object.values(state.tasks).find((t) => t.phase === 'awaiting_test');
    if (waiting) {
      setPipeline(root, 'waiting', `任務 ${waiting.id} 等待人工測試，測完請按「我測完了，繼續」`);
      return 'waiting';
    }

    // 全域佇列：其他專案正在跑時在這裡排隊；排隊中按暫停就放棄排隊。
    const granted = await acquireSlot(root, {
      onWait: (position, running) => {
        const names = running.map((e) => path.basename(e.root)).join('、');
        setPipeline(root, 'queued', `排隊第 ${position} 位${names ? `，執行中：${names}` : ''}`);
      },
      shouldAbort: () => readState(root).control.pause_requested,
    });
    if (!granted) {
      updateState(root, (s) => {
        s.control.pause_requested = false;
      });
      setPipeline(root, 'paused', '使用者在排隊時暫停');
      return 'paused';
    }

    if (cfg.mode === 'auto') {
      if (!git.hasIdentity(root)) throw new Error('自動模式需要 git 使用者身分：請先設定 git config user.name 與 user.email');
      const branch = git.ensureFeatureBranch(root, featureBranch(cfg, state));
      appendLog(root, RUN_SCOPE, `自動模式：在分支 ${branch} 上工作`);
    }
    setPipeline(root, 'running', '', { mode: cfg.mode });

    let pending = firstTask ? String(firstTask) : null;
    for (;;) {
      cfg = loadConfig(root);
      if (readState(root).control.pause_requested) {
        updateState(root, (s) => {
          s.control.pause_requested = false;
        });
        setPipeline(root, 'paused', '使用者暫停');
        return 'paused';
      }
      const id = pending ?? (await tmaster.nextTaskId(root, cfg, RUN_SCOPE));
      const once = verifyOnly && pending != null;
      pending = null;
      if (!id) {
        const all = tmaster.readTasks(root);
        const open = all.filter((t) => !['done', 'cancelled', 'deferred'].includes(t.status));
        if (open.length === 0) {
          setPipeline(root, 'feature_test', '所有任務完成，請進行功能測試', { current_task: null });
          return 'feature_test';
        }
        setPipeline(root, 'stuck', `沒有可執行的任務（剩 ${open.length} 個未完成，可能卡在依賴或 blocked）`);
        return 'stuck';
      }
      let outcome;
      try {
        outcome = await runTask(root, cfg, id, { verifyOnly: once });
      } catch (err) {
        if (!(err instanceof StuckError)) throw err;
        setTask(root, id, { phase: 'stuck', step: '需要人工處理', error: err.message });
        appendLog(root, `task-${id}`, `✖ ${err.message}`);
        setPipeline(root, 'stuck', `任務 ${id}：${err.message}`);
        return 'stuck';
      }
      if (outcome === 'awaiting_test') {
        setPipeline(root, 'waiting', `任務 ${id} 完成，等待人工測試`);
        return 'waiting';
      }
    }
  } catch (err) {
    setPipeline(root, 'error', err.message);
    throw err;
  } finally {
    releaseSlot();
    releaseRunner(root);
    try {
      archiveTasks(root);
    } catch (err) {
      appendLog(root, RUN_SCOPE, `⚠ 封存任務清單失敗：${err.message}`);
    }
  }
}

/**
 * 「我測完了，繼續」：
 * - 手動模式等待測試的任務 → 標記 done，回傳 true 表示可以接著跑
 * - 功能待測試 → 流程結束
 * - 卡住的任務 → 使用者處理過後重新驗證（不重新實作），修正輪數重新計算
 */
export async function acknowledge(root) {
  const cfg = loadConfig(root);
  const state = readState(root);
  const waiting = Object.values(state.tasks).filter((t) => t.phase === 'awaiting_test');
  for (const t of waiting) {
    await tmaster.setStatus(root, cfg, t.id, 'done', `task-${t.id}`);
    setTask(root, t.id, { phase: 'done', step: '人工測試通過' });
    appendLog(root, `task-${t.id}`, '使用者確認測試通過');
  }
  if (state.pipeline.status === 'feature_test') {
    setPipeline(root, 'complete', '功能已完成並通過人工測試');
    finishFeature(root);
    return { next: null };
  }
  // 卡住的任務，或流程出錯時停在半途的任務（runner 已不在）：重新驗證與審查。
  const runnerAlive = isPidAlive(state.runner.pid);
  const stuck = Object.values(state.tasks).find(
    (t) => t.phase === 'stuck' || (!runnerAlive && ['implementing', 'reviewing'].includes(t.phase)),
  );
  if (stuck && !waiting.length) return { next: 'verify', task: stuck.id };
  setPipeline(root, 'idle', '');
  return { next: 'run' };
}

/** 功能完成：封存最後的任務清單，並把對應的待辦項目標成完成。 */
function finishFeature(root) {
  const s = readState(root);
  try {
    archiveTasks(root, { completed_at: new Date().toISOString() });
    if (s.prd.backlog_id) updateItem(root, s.prd.backlog_id, { status: 'done', feature: s.prd.archive_dir || undefined });
  } catch (err) {
    appendLog(root, RUN_SCOPE, `⚠ 功能完成後的封存／待辦更新失敗：${err.message}`);
  }
}

export function requestPause(root) {
  updateState(root, (s) => {
    s.control.pause_requested = true;
  });
  appendLog(root, RUN_SCOPE, '已要求暫停：目前任務結束後停下');
}

/** 重跑任務。revert=true 時：自動模式 git revert 該任務的 commit；手動模式把該任務改過的檔案還原到任務開始前。 */
export async function prepareRerun(root, id, { revert = false } = {}) {
  const cfg = loadConfig(root);
  const state = readState(root);
  const t = state.tasks[String(id)];
  if (state.runner.pid && isPidAlive(state.runner.pid)) throw new Error('流程執行中，請先暫停');
  if (revert && t) {
    if (t.commit) {
      const sha = git.revertCommit(root, t.commit);
      appendLog(root, `task-${id}`, `已 revert ${t.commit.slice(0, 8)} → ${sha.slice(0, 8)}`);
    } else if (t.base_tree) {
      git.restoreToTree(root, t.base_tree);
      appendLog(root, `task-${id}`, '已把此任務改過的檔案還原到任務開始前的狀態');
    }
  }
  await tmaster.setStatus(root, cfg, id, 'pending', `task-${id}`);
  updateState(root, (s) => {
    const ts = taskState(s, id);
    Object.assign(ts, { phase: 'pending', step: '等待重跑', commit: null, error: '', fix_round: 0 });
    if (s.pipeline.status === 'stuck' || s.pipeline.status === 'waiting') s.pipeline.status = 'idle';
  });
}

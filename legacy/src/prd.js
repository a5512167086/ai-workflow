import fs from 'node:fs';
import path from 'node:path';
import { runAgent, parseVerdict } from './agents.js';
import { prdDraftPrompt, prdReviewPrompt, prdRevisePrompt, stripOuterFence } from './prompts.js';
import { aipipeDir, appendLog, readState, updateState, readText } from './state.js';
import { archivePrd, archiveTasks } from './archive.js';

const SCOPE = 'prd';

function versionFile(root, v) {
  return aipipeDir(root, 'prd', `v${v}.md`);
}

export function currentPrd(root) {
  return readText(aipipeDir(root, 'prd', 'current.md'));
}

function saveVersion(root, text) {
  const state = readState(root);
  const v = (state.prd.version || 0) + 1;
  fs.writeFileSync(versionFile(root, v), text);
  fs.writeFileSync(aipipeDir(root, 'prd', 'current.md'), text);
  updateState(root, (s) => {
    s.prd.version = v;
  });
  return v;
}

function addRound(root, entry) {
  updateState(root, (s) => {
    s.prd.rounds.push({ ...entry, at: new Date().toISOString() });
  });
}

function setPrdStatus(root, status) {
  updateState(root, (s) => {
    s.prd.status = status;
  });
}

async function author(root, cfg, prompt, label) {
  const res = await runAgent({ root, cfg, provider: cfg.roles.author, prompt, write: false, scope: SCOPE, label, stage: 'prd' });
  const text = stripOuterFence(res.text);
  if (!res.ok || !text) throw new Error(`作者 AI 失敗：${res.error || '沒有輸出'}`);
  return { text, provider: res.provider };
}

/** 審查→修訂來回，最多 max_prd_rounds 輪；審查通過就提早結束。最後一律停在 awaiting_approval 等人核准。 */
async function reviewLoop(root, cfg) {
  for (let i = 1; i <= cfg.max_prd_rounds; i++) {
    const state = readState(root);
    const round = (state.prd.round || 0) + 1;
    updateState(root, (s) => {
      s.prd.round = round;
      s.prd.status = 'reviewing';
    });
    const prd = currentPrd(root);
    const res = await runAgent({
      root, cfg, provider: cfg.roles.reviewer, prompt: prdReviewPrompt(root, cfg, prd, round),
      write: false, scope: SCOPE, label: `PRD 審查 第 ${round} 輪`, stage: 'prd_review',
    });
    if (!res.ok) throw new Error(`審查 AI 失敗：${res.error}`);
    const { pass, verdict } = parseVerdict(res.text, ['APPROVE']);
    const reviewFile = aipipeDir(root, 'prd', `review-${round}.md`);
    fs.writeFileSync(reviewFile, res.text);
    addRound(root, { kind: 'review', round, provider: res.provider, verdict, version: readState(root).prd.version, file: path.basename(reviewFile) });
    if (pass) {
      appendLog(root, SCOPE, `審查者核可（第 ${round} 輪）`);
      break;
    }
    setPrdStatus(root, 'revising');
    const revised = await author(root, cfg, prdRevisePrompt(root, cfg, prd, res.text, '審查者'), `PRD 修訂 第 ${round} 輪`);
    const v = saveVersion(root, revised.text);
    addRound(root, { kind: 'revise', round, provider: revised.provider, version: v, file: `v${v}.md` });
  }
  setPrdStatus(root, 'awaiting_approval');
  appendLog(root, SCOPE, '等待使用者在 UI 核准 PRD（或執行 aipipe prd --approve）');
}

function guard(root) {
  const s = readState(root);
  if (['drafting', 'reviewing', 'revising'].includes(s.prd.status) && s.prd.pid && s.prd.pid !== process.pid) {
    try {
      process.kill(s.prd.pid, 0);
      throw new Error('PRD 流程已在執行中');
    } catch (err) {
      if (err.message === 'PRD 流程已在執行中') throw err;
    }
  }
  updateState(root, (st) => {
    st.prd.pid = process.pid;
  });
}

async function withErrorState(root, fn) {
  try {
    await fn();
  } catch (err) {
    updateState(root, (s) => {
      s.prd.status = currentPrd(root) ? 'awaiting_approval' : 'none';
      s.prd.error = err.message;
    });
    appendLog(root, SCOPE, `錯誤：${err.message}`);
    throw err;
  } finally {
    updateState(root, (s) => {
      s.prd.pid = null;
    });
  }
}

export async function draftPrd(root, cfg, idea, { backlogId = null } = {}) {
  guard(root);
  // 開始新功能前，把上一個功能最後的任務狀態寫進它的封存；之後 archive_dir 清空，核准時會建新的資料夾。
  try {
    archiveTasks(root);
  } catch (err) {
    appendLog(root, SCOPE, `⚠ 封存上一個功能的任務清單失敗：${err.message}`);
  }
  await withErrorState(root, async () => {
    updateState(root, (s) => {
      s.prd = {
        ...s.prd, status: 'drafting', idea, round: 0, rounds: [], version: 0, approved_at: null, error: '', pid: process.pid,
        archive_dir: null, backlog_id: backlogId,
      };
    });
    for (const f of fs.readdirSync(aipipeDir(root, 'prd'))) fs.rmSync(aipipeDir(root, 'prd', f));
    appendLog(root, SCOPE, `新想法：${idea}`);
    const draft = await author(root, cfg, prdDraftPrompt(root, cfg, idea), 'PRD 初稿');
    const v = saveVersion(root, draft.text);
    addRound(root, { kind: 'draft', round: 0, provider: draft.provider, version: v, file: `v${v}.md` });
    await reviewLoop(root, cfg);
  });
}

/** 使用者附意見要求再改：作者依意見修訂後，再走一次審查迴圈。 */
export async function revisePrd(root, cfg, feedback) {
  const prd = currentPrd(root);
  if (!prd) throw new Error('還沒有 PRD，請先執行 aipipe prd "<想法>"');
  guard(root);
  await withErrorState(root, async () => {
    updateState(root, (s) => {
      s.prd.status = 'revising';
      s.prd.error = '';
      s.prd.approved_at = null;
    });
    const fbFile = aipipeDir(root, 'prd', `user-feedback-${Date.now()}.md`);
    fs.writeFileSync(fbFile, feedback);
    addRound(root, { kind: 'user_feedback', round: readState(root).prd.round, provider: 'user', file: path.basename(fbFile) });
    const revised = await author(root, cfg, prdRevisePrompt(root, cfg, prd, feedback, '使用者'), 'PRD 依使用者意見修訂');
    const v = saveVersion(root, revised.text);
    addRound(root, { kind: 'revise', round: readState(root).prd.round, provider: revised.provider, version: v, file: `v${v}.md` });
    await reviewLoop(root, cfg);
  });
}

export function approvePrd(root, cfg) {
  const prd = currentPrd(root);
  if (!prd) throw new Error('還沒有 PRD 可以核准');
  const s = readState(root);
  if (s.prd.status !== 'awaiting_approval' && s.prd.status !== 'approved') {
    throw new Error(`PRD 目前狀態是 ${s.prd.status}，不能核准`);
  }
  const target = path.join(root, cfg.prd_path);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, prd);
  updateState(root, (st) => {
    st.prd.status = 'approved';
    st.prd.approved_at = new Date().toISOString();
  });
  appendLog(root, SCOPE, `PRD 已核准，寫入 ${cfg.prd_path}`);
  try {
    const dir = archivePrd(root, cfg);
    appendLog(root, SCOPE, `PRD 與每輪紀錄已封存到 ${dir}`);
  } catch (err) {
    appendLog(root, SCOPE, `⚠ 封存 PRD 失敗：${err.message}`);
  }
  return target;
}

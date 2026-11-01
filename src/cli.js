import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { isGitRepo } from './git.js';
import { CONFIG_FILE, findProjectRoot, loadConfig, patchConfig, MODES } from './config.js';
import { initProject } from './init.js';
import { draftPrd, revisePrd, approvePrd } from './prd.js';
import * as tmaster from './taskmaster.js';
import { runPipeline, acknowledge, requestPause, prepareRerun } from './runner.js';
import { appendLog, ensureDirs, readState, updateState } from './state.js';
import { doctorReport } from './doctor.js';
import { runAgent } from './agents.js';
import { tasksFromPrdPrompt } from './prompts.js';
import { IS_SEA } from './home.js';
import { addProject, listProjects, projectSummary, removeProject } from './projects.js';
import { queueSnapshot, setMaxConcurrent } from './queue.js';
import { archiveTasks, tagSlug } from './archive.js';
import { getItem, ideaFor, updateItem } from './backlog.js';

const HELP = `aipipe — 用本機已登入的 Claude Code / Codex CLI 跑 AI 開發流程

用法：aipipe <指令> [選項]

  init [--mode auto|manual] [--author claude|codex] [--reviewer ...]
       [--implementer ...] [--code-reviewer ...] [--feature 名稱] [--force] [--git-init]
                          在目前專案建立 .aipipe.json；不是 git repo 時 --git-init 會先 git init
                          （互動終端機下沒加也會詢問）
  doctor                  檢查 claude / codex / task-master 是否可用、是否走訂閱登入
  prd "<想法>"            作者 AI 起草 PRD → 審查 AI 審 → 來回最多 max_prd_rounds 輪
  prd --backlog <id>      用需求待辦清單裡的項目起草 PRD
  prd --revise "<意見>"   依你的意見修訂後再審一次
  prd --approve           核准目前的 PRD（寫入 prd_path）
  tasks                   用 Task Master parse-prd 產生 .taskmaster/tasks/tasks.json
  run [--task <id>]       逐個任務執行（實作 → 驗證 → 審查 → 修正 → handover）
  pause                   目前任務結束後暫停
  continue                「我測完了，繼續」
  rerun <id> [--revert]   重跑任務；--revert 先還原該任務的變更
  mode <auto|manual>      切換模式
  status                  顯示目前狀態
  ui [--port 4317] [--no-open]
                          開本機網頁 UI；不帶 --cwd 時顯示所有專案的總覽，帶 --cwd 時直接開該專案
  projects list           列出總覽裡的專案（~/.aipipe/projects.json）
  projects add [目錄]     加入專案（預設目前專案）
  projects remove <id|目錄|名稱>
                          從總覽移除（不刪任何檔案）
  queue [--max <n>]       顯示全域執行佇列；--max 設定同時執行的 aipipe run 上限（預設 1）

全域選項：--cwd <目錄>  指定目標專案（預設從目前目錄往上找 .aipipe.json）`;

async function confirmPrompt(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^n/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, inline] = a.slice(2).split(/=(.*)/s);
      const key = k.replace(/-/g, '_');
      if (inline !== undefined) opts[key] = inline;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[key] = argv[++i];
      else opts[key] = true;
    } else {
      opts._.push(a);
    }
  }
  return opts;
}

export const BIN_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'aipipe.js');

export async function main(argv) {
  const opts = parseArgs(argv);
  const [cmd, ...rest] = opts._;
  const start = opts.cwd ? path.resolve(String(opts.cwd)) : process.cwd();
  const root = cmd === 'init' ? start : findProjectRoot(start);

  switch (cmd) {
    case 'init': {
      let gitInit = !!opts.git_init;
      if (!gitInit && process.stdin.isTTY && !isGitRepo(root)) {
        gitInit = await confirmPrompt(`${root} 不是 git repo（aipipe 用 git 追蹤、審查與還原 AI 的變更）。要幫你執行 git init 嗎？[Y/n] `);
      }
      const { cfg, created, gitInitialized } = initProject(root, {
        gitInit,
        mode: opts.mode,
        author: opts.author,
        reviewer: opts.reviewer,
        implementer: opts.implementer,
        code_reviewer: opts.code_reviewer,
        feature: opts.feature,
        force: !!opts.force,
      });
      if (gitInitialized) console.log(`已在 ${root} 執行 git init`);
      console.log(`已建立 ${path.join(root, '.aipipe.json')}（模式：${cfg.mode}）`);
      console.log(`偵測到的指令：build=${cfg.commands.build || '-'} test=${cfg.commands.test || '-'} lint=${cfg.commands.lint || '-'}`);
      if (created.length) console.log(`已建立範本：${created.join(', ')}`);
      console.log('下一步：aipipe doctor 確認 CLI 登入狀態，然後 aipipe prd "<想法>" 或 aipipe ui');
      return;
    }
    case 'doctor':
      return doctor(root);
    case 'prd': {
      const cfg = loadConfig(root);
      ensureDirs(root);
      if (opts.approve) {
        const file = approvePrd(root, cfg);
        console.log(`PRD 已核准：${file}\n下一步：aipipe tasks`);
        return;
      }
      if (opts.revise) {
        await revisePrd(root, cfg, String(opts.revise));
      } else if (opts.backlog) {
        const item = getItem(root, String(opts.backlog));
        updateItem(root, item.id, { status: 'in_progress' });
        await draftPrd(root, cfg, ideaFor(item), { backlogId: item.id });
      } else {
        const idea = rest.join(' ').trim();
        if (!idea) throw new Error('請提供想法，例如：aipipe prd "加入匯出 CSV 功能"');
        await draftPrd(root, cfg, idea);
      }
      console.log('PRD 已完成審查，等待核准：在 UI 按「核准」或執行 aipipe prd --approve');
      return;
    }
    case 'tasks':
      return generateTasks(root);
    case 'run': {
      const result = await runPipeline(root, { firstTask: opts.task ? String(opts.task) : null, verifyOnly: !!opts.verify });
      const s = readState(root);
      console.log(`流程停止：${result}${s.pipeline.reason ? ` — ${s.pipeline.reason}` : ''}`);
      return;
    }
    case 'pause':
      requestPause(root);
      console.log('已要求暫停，目前任務結束後停下');
      return;
    case 'continue': {
      const r = await acknowledge(root);
      if (r.next === 'run' && !opts.no_run) await main(['run', '--cwd', root]);
      else if (r.next === 'verify') await main(['run', '--cwd', root, '--task', String(r.task), '--verify']);
      else console.log('功能已完成');
      return;
    }
    case 'rerun': {
      const id = rest[0];
      if (!id) throw new Error('請指定任務 id');
      await prepareRerun(root, id, { revert: !!opts.revert });
      if (!opts.no_run) await main(['run', '--cwd', root, '--task', String(id)]);
      return;
    }
    case 'mode': {
      const mode = rest[0];
      if (!MODES.includes(mode)) throw new Error(`模式必須是 ${MODES.join(' / ')}`);
      patchConfig(root, { mode });
      console.log(`已切換為 ${mode} 模式`);
      return;
    }
    case 'status':
      return printStatus(root);
    case 'ui': {
      const { startServer } = await import('./server.js');
      // 目前目錄是專案時自動加進總覽；只有明確指定 --cwd 時首頁才直接開該專案。
      const isProject = fs.existsSync(path.join(root, CONFIG_FILE));
      if (isProject) {
        try {
          addProject(root);
        } catch {
          // 加不進清單不影響開 UI
        }
      }
      await startServer(isProject ? root : null, { port: Number(opts.port) || 4317, open: !opts.no_open, overview: !opts.cwd });
      return;
    }
    case 'projects':
      return projectsCommand(rest, root);
    case 'queue': {
      if (opts.max !== undefined) setMaxConcurrent(opts.max);
      const q = queueSnapshot();
      console.log(`同時執行上限：${q.max}`);
      console.log(`執行中：${q.running.length ? q.running.map((e) => `${e.root}（pid ${e.pid}）`).join('、') : '無'}`);
      for (const e of q.waiting) console.log(`  排隊 #${e.position}：${e.root}（pid ${e.pid}）`);
      return;
    }
    case undefined:
    case 'help':
    case '--help':
      console.log(HELP);
      return;
    default:
      throw new Error(`未知指令：${cmd}\n\n${HELP}`);
  }
}

async function generateTasks(root) {
  const cfg = loadConfig(root);
  const state = readState(root);
  if (state.prd.status !== 'approved') throw new Error('PRD 尚未核准');
  const scope = 'tasks';
  updateState(root, (s) => {
    s.task_gen = { status: 'running', pid: process.pid, error: '' };
  });
  try {
    await tmaster.ensureTaskMaster(root, cfg, scope);
    let tag = tmaster.currentTag(root);
    if (cfg.taskmaster.use_tags) {
      tag = (await tmaster.useFeatureTag(root, cfg, tagSlug(cfg.feature || state.prd.idea), scope)) || tag;
    }
    const via = await tmaster.parsePrd(root, cfg, cfg.prd_path, scope, async () => {
      const prd = fs.readFileSync(path.join(root, cfg.prd_path), 'utf8');
      const res = await runAgent({
        root, cfg, provider: cfg.roles.author, prompt: tasksFromPrdPrompt(root, cfg, prd),
        write: false, scope, label: '依 PRD 產生任務',
      });
      if (!res.ok) throw new Error(`作者 AI 產生任務失敗：${res.error}`);
      const text = res.text.trim();
      const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
      tmaster.writeTasks(root, json.tasks);
    });
    const tasks = tmaster.readTasks(root);
    updateState(root, (s) => {
      s.task_gen = { status: 'done', pid: null, error: '', count: tasks.length, via, tag };
      s.tasks = {};
    });
    archiveTasks(root);
    appendLog(root, scope, `產生 ${tasks.length} 個任務（${via === 'agent' ? '作者 AI 產生、Task Master 管理' : 'task-master parse-prd'}）`);
    console.log(`Task Master 產生 ${tasks.length} 個任務，下一步：aipipe run 或在 UI 按「開始」`);
  } catch (err) {
    updateState(root, (s) => {
      s.task_gen = { status: 'error', pid: null, error: err.message };
    });
    throw err;
  }
}

function printStatus(root) {
  const cfg = loadConfig(root);
  const s = readState(root);
  console.log(`模式：${cfg.mode}　流程：${s.pipeline.status}${s.pipeline.reason ? `（${s.pipeline.reason}）` : ''}`);
  console.log(`PRD：${s.prd.status}${s.prd.round ? `，審查 ${s.prd.round} 輪` : ''}`);
  for (const t of tmaster.readTasks(root)) {
    const ts = s.tasks[String(t.id)];
    console.log(`  #${t.id} [${t.status}] ${t.title}${ts ? ` — ${ts.phase}${ts.step ? `：${ts.step}` : ''}` : ''}`);
  }
}

function projectsCommand([sub, ...args], root) {
  if (sub === 'add') {
    const dir = args[0] ? path.resolve(args[0]) : root;
    const p = addProject(dir);
    console.log(`已加入：${p.name}（${p.path}，id ${p.id}）`);
    return;
  }
  if (sub === 'remove' || sub === 'rm') {
    if (!args[0]) throw new Error('請指定要移除的專案 id、路徑或名稱');
    const p = removeProject(args[0]);
    console.log(`已從總覽移除：${p.name}（${p.path}），檔案沒有變動`);
    return;
  }
  if (sub && sub !== 'list' && sub !== 'ls') throw new Error('用法：aipipe projects list|add [目錄]|remove <id|目錄|名稱>');
  const list = listProjects();
  if (!list.length) {
    console.log('總覽裡還沒有專案：在專案目錄執行 aipipe projects add');
    return;
  }
  for (const p of list) {
    const s = projectSummary(p);
    const prog = s.progress?.total ? ` ${s.progress.done}/${s.progress.total}` : '';
    const feature = s.feature ? `  ${s.feature.split('\n')[0].slice(0, 40)}` : '';
    console.log(`${p.id}  ${p.name}  [${s.status}${prog}]${feature}\n            ${p.path}`);
  }
}

async function doctor(root) {
  const { lines } = await doctorReport(root);
  console.log(lines.join('\n'));
}

export function spawnDetachedCli(root, args) {
  return import('node:child_process').then(({ spawn }) => {
    ensureDirs(root);
    const out = fs.openSync(path.join(root, '.aipipe', 'logs', 'process.log'), 'a');
    fs.writeSync(out, `\n[${new Date().toISOString()}] aipipe ${args.join(' ')}\n`);
    // SEA（桌面版 sidecar）本身就是 aipipe，不需要再帶入口腳本。
    const argv = IS_SEA ? [...args, '--cwd', root] : [BIN_PATH, ...args, '--cwd', root];
    const child = spawn(process.execPath, argv, {
      cwd: root,
      detached: true,
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.unref();
    fs.closeSync(out);
    return child.pid;
  });
}

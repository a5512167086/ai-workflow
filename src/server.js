import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CONFIG_FILE, loadConfig, patchConfig, MODES, CLI_NAMES, RUNTIMES } from './config.js';
import { doctorReport } from './doctor.js';
import { approvePrd, currentPrd } from './prd.js';
import { readTasks, tasksFile } from './tasks.js';
import { listSkills, importSkill, saveSkill, loadSkill, listSkillRuns, SKILL_STAGES } from './skills.js';
import { requestPause } from './runner.js';
import { usageSnapshot, refreshUsageLimits, usageFile } from './usage.js';
import { spawnDetachedCli } from './cli.js';
import { initProject } from './init.js';
import { isGitRepo } from './git.js';
import { seaAsset, IS_SEA } from './home.js';
import { addItem, deleteItem, getItem, readBacklog, reorderItems, updateItem } from './backlog.js';
import { listArchives, readArchive } from './archive.js';
import { addProject, getProject, listProjects, projectId, projectSummary, removeProject, touchProject } from './projects.js';
import { queueEntryFor, queueSnapshot, setMaxConcurrent } from './queue.js';
import { aipipeDir, ensureDirs, isPidAlive, logPath, readState, readText } from './state.js';

const UI_DIR = IS_SEA ? '' : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const ASSETS = {
  'index.html': 'text/html; charset=utf-8',
  'overview.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'overview.js': 'text/javascript; charset=utf-8',
  'common.js': 'text/javascript; charset=utf-8',
  'markdown.js': 'text/javascript; charset=utf-8',
  'style.css': 'text/css; charset=utf-8',
};

/** UI 靜態檔：開發時從 ui/ 讀（改了重新整理就生效），SEA 版從 exe 內嵌的資源讀。 */
function uiFile(name) {
  return seaAsset(name) ?? fs.readFileSync(path.join(UI_DIR, name));
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendAsset(res, name) {
  res.writeHead(200, { 'Content-Type': ASSETS[name], 'Cache-Control': 'no-store' });
  res.end(uiFile(name));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (d) => {
      data += d;
      if (data.length > 1e6) reject(new Error('body too large'));
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function tail(file, maxBytes = 200000) {
  try {
    const { size } = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const start = Math.max(0, size - maxBytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return { text: buf.toString('utf8'), size };
  } catch {
    return { text: '', size: 0 };
  }
}

const httpError = (status, message) => Object.assign(new Error(message), { status });

function snapshot(root) {
  const cfg = loadConfig(root);
  const state = readState(root);
  const runnerAlive = isPidAlive(state.runner.pid);
  const prdBusy = isPidAlive(state.prd.pid);
  const taskGenBusy = isPidAlive(state.task_gen?.pid);
  return {
    root,
    project: { id: projectId(root), name: getProject(projectId(root))?.name || path.basename(root) },
    config: cfg,
    state,
    runnerAlive,
    prdBusy,
    taskGenBusy,
    skillBusy: isPidAlive(state.skill_job?.pid),
    queue: runnerAlive ? queueEntryFor(root) : null,
    prd: currentPrd(root),
    tasks: readTasks(root),
    usage: usageSnapshot(root, cfg),
  };
}

function prdRounds(root, state) {
  return state.prd.rounds.map((r) => ({ ...r, text: r.file ? readText(aipipeDir(root, 'prd', r.file)) : '' }));
}

function taskDetail(root, id) {
  const dir = aipipeDir(root, 'tasks', String(id));
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const reviews = files
    .filter((f) => /^review-\d+\.md$/.test(f))
    .sort((a, b) => parseInt(a.slice(7)) - parseInt(b.slice(7)))
    .map((f) => ({ name: f, text: readText(path.join(dir, f)) }));
  return {
    id: String(id),
    state: readState(root).tasks[String(id)] || null,
    task: readTasks(root).find((t) => String(t.id) === String(id)) || null,
    checks: readText(path.join(dir, 'checks.txt')),
    diff: readText(path.join(dir, 'diff.patch')),
    implement: readText(path.join(dir, 'implement.md')),
    reviews,
    log: tail(logPath(root, `task-${id}`)).text,
  };
}

function busyGuard(snap) {
  if (snap.skillBusy) throw httpError(409, 'Skill 執行中');
  if (snap.runnerAlive) throw httpError(409, '流程執行中');
  if (snap.prdBusy) throw httpError(409, 'PRD 流程執行中');
  if (snap.taskGenBusy) throw httpError(409, '任務產生中');
}

async function handleAction(root, action, body) {
  const snap = snapshot(root);
  switch (action) {
    case 'prd/new': {
      busyGuard(snap);
      const idea = String(body.idea || '').trim();
      if (!idea) throw httpError(400, '請輸入想法');
      return { pid: await spawnDetachedCli(root, ['prd', idea]) };
    }
    case 'prd/approve':
      return { file: approvePrd(root, snap.config) };
    case 'prd/revise': {
      busyGuard(snap);
      const feedback = String(body.feedback || '').trim();
      if (!feedback) throw httpError(400, '請輸入修改意見');
      return { pid: await spawnDetachedCli(root, ['prd', '--revise', feedback]) };
    }
    case 'tasks/generate':
      busyGuard(snap);
      return { pid: await spawnDetachedCli(root, ['tasks']) };
    case 'run/start':
      busyGuard(snap);
      return { pid: await spawnDetachedCli(root, ['run']) };
    case 'run/pause':
      requestPause(root);
      return { ok: true };
    case 'run/continue':
      busyGuard(snap);
      return { pid: await spawnDetachedCli(root, ['continue']) };
    case 'task/rerun': {
      busyGuard(snap);
      const id = String(body.id || '');
      if (!/^\d+(\.\d+)?$/.test(id)) throw httpError(400, '任務 id 不正確');
      return { pid: await spawnDetachedCli(root, ['rerun', id, ...(body.revert ? ['--revert'] : [])]) };
    }
    case 'config/runtime': {
      const runtime = {};
      for (const name of CLI_NAMES) {
        if (body.runtime?.[name] !== undefined) {
          if (!RUNTIMES.includes(body.runtime[name])) throw httpError(400, `${name} 的 runtime 不正確`);
          runtime[name] = body.runtime[name];
        }
      }
      const patch = { runtime };
      if (body.wsl_distro !== undefined) patch.wsl_distro = String(body.wsl_distro).trim();
      return { config: patchConfig(root, patch) };
    }
    case 'doctor':
      return doctorReport(root);
    case 'usage/refresh':
      return refreshUsageLimits(root, snap.config);
    case 'skills/import':
      busyGuard(snap);
      return { skill: importSkill(root, String(body.path || '')) };
    case 'skills/save':
      busyGuard(snap);
      return { skill: saveSkill(root, body.text, body.name) };
    case 'skills/config': {
      busyGuard(snap);
      for (const [stage, names] of Object.entries(body.skills || {})) {
        if (!SKILL_STAGES.includes(stage) || !Array.isArray(names)) throw httpError(400, 'Skill 階段設定不正確');
        for (const name of names) {
          const skill = loadSkill(root, name);
          if (skill.extensions.length) throw httpError(400, `${name} 含執行器專屬設定`);
        }
      }
      return { config: patchConfig(root, { skills: body.skills }) };
    }
    case 'skills/run': {
      busyGuard(snap);
      loadSkill(root, body.name);
      if (!String(body.input || '').trim()) throw httpError(400, '請輸入需求或回答');
      const args = ['skills', 'run', body.name, '--input', String(body.input)];
      if (body.provider) {
        if (!['claude', 'codex'].includes(body.provider)) throw httpError(400, 'provider 不正確');
        args.push('--provider', body.provider);
      }
      if (body.previousId) args.push('--session', String(body.previousId));
      return { pid: await spawnDetachedCli(root, args) };
    }
    case 'config/mode': {
      if (!MODES.includes(body.mode)) throw httpError(400, '模式不正確');
      return { config: patchConfig(root, { mode: body.mode }) };
    }
    case 'backlog/add':
      return { item: addItem(root, body) };
    case 'backlog/update':
      return { item: updateItem(root, String(body.id || ''), { title: body.title, detail: body.detail, status: body.status }) };
    case 'backlog/delete':
      return { items: deleteItem(root, String(body.id || '')) };
    case 'backlog/reorder':
      return { items: reorderItems(root, body.ids) };
    case 'backlog/draft': {
      busyGuard(snap);
      const item = getItem(root, String(body.id || ''));
      return { pid: await spawnDetachedCli(root, ['prd', '--backlog', item.id]) };
    }
    default:
      throw httpError(404, '未知操作');
  }
}

async function handleGlobalAction(action, body) {
  switch (action) {
    case 'projects/add': {
      const dir = path.resolve(String(body.path || '').trim() || '.');
      if (!String(body.path || '').trim()) throw httpError(400, '請輸入專案資料夾路徑');
      if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw httpError(400, `資料夾不存在：${dir}`);
      if (!fs.existsSync(path.join(dir, CONFIG_FILE))) {
        if (!body.init) return { needs_init: true, needs_git: !isGitRepo(dir), path: dir };
        // 前端確認對話框已告知會 git init，所以這裡一併允許
        initProject(dir, { gitInit: true });
      }
      return { project: addProject(dir, { name: body.name ? String(body.name).trim() : undefined }) };
    }
    case 'projects/remove':
      return { removed: removeProject(String(body.id || '')) };
    case 'projects/open':
      touchProject(String(body.id || ''));
      return { ok: true };
    case 'queue/config':
      return { queue: { ...queueSnapshot(), max: setMaxConcurrent(body.max).max_concurrent_runs } };
    default:
      throw httpError(404, '未知操作');
  }
}

function projectsPayload() {
  return {
    projects: listProjects().map(projectSummary),
    queue: queueSnapshot(),
    desktop: !!process.env.AIPIPE_DESKTOP,
  };
}

function sseHeaders(res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/** SSE：每 0.7 秒檢查 state.json 與 logs/ 的變化，推送狀態與新增的 log。 */
function sse(root, req, res) {
  const send = sseHeaders(res);
  const logDir = aipipeDir(root, 'logs');
  const sizes = new Map();
  for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) sizes.set(f, fs.statSync(path.join(logDir, f)).size);
  let lastState = '';
  let lastTasks = '';
  const tick = () => {
    try {
      const stateStat = fs.statSync(aipipeDir(root, 'state.json'), { throwIfNoEntry: false });
      const tasksStat = fs.statSync(tasksFile(root), { throwIfNoEntry: false });
      const tmStateStat = fs.statSync(path.join(root, '.taskmaster', 'state.json'), { throwIfNoEntry: false });
      const cfgStat = fs.statSync(path.join(root, '.aipipe.json'), { throwIfNoEntry: false });
      const usageStat = fs.statSync(usageFile(root), { throwIfNoEntry: false });
      const sig = `${stateStat?.mtimeMs}|${cfgStat?.mtimeMs}|${usageStat?.mtimeMs}`;
      const tsig = `${tasksStat?.mtimeMs}|${tmStateStat?.mtimeMs}`;
      if (sig !== lastState || tsig !== lastTasks) {
        lastState = sig;
        lastTasks = tsig;
        send('state', snapshot(root));
      }
      for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) {
        const file = path.join(logDir, f);
        const size = fs.statSync(file).size;
        const prev = sizes.get(f) ?? 0;
        if (size > prev) {
          const fd = fs.openSync(file, 'r');
          const buf = Buffer.alloc(Math.min(size - prev, 500000));
          fs.readSync(fd, buf, 0, buf.length, size - buf.length);
          fs.closeSync(fd);
          send('log', { scope: f.replace(/\.log$/, ''), text: buf.toString('utf8') });
        }
        sizes.set(f, size);
      }
    } catch (err) {
      send('error', { message: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, 700);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(ping);
  });
}

/** 總覽的 SSE：每 1.5 秒重算所有專案的摘要，有變化才推送。 */
function projectsSse(req, res) {
  const send = sseHeaders(res);
  let last = '';
  const tick = () => {
    try {
      const payload = projectsPayload();
      const text = JSON.stringify(payload);
      if (text !== last) {
        last = text;
        send('projects', payload);
      }
    } catch (err) {
      send('error', { message: err.message });
    }
  };
  tick();
  const timer = setInterval(tick, 1500);
  const ping = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => {
    clearInterval(timer);
    clearInterval(ping);
  });
}

/** 單一專案的 API。rest 是 /api/ 或 /api/p/<id>/ 之後的路徑。 */
async function projectRoute(root, req, res, rest) {
  if (req.method === 'GET') {
    if (rest === 'state') return json(res, 200, snapshot(root));
    if (rest === 'usage') return json(res, 200, usageSnapshot(root, loadConfig(root)));
    if (rest === 'events') return sse(root, req, res);
    if (rest === 'skills') return json(res, 200, { skills: listSkills(root), stages: SKILL_STAGES, config: loadConfig(root).skills });
    if (rest === 'skills/runs') return json(res, 200, { runs: listSkillRuns(root) });
    if (rest === 'prd') {
      const state = readState(root);
      return json(res, 200, { prd: currentPrd(root), status: state.prd, rounds: prdRounds(root, state) });
    }
    if (rest === 'backlog') return json(res, 200, { items: readBacklog(root), path: loadConfig(root).backlog_path });
    if (rest === 'archive') return json(res, 200, { items: listArchives(root), dir: loadConfig(root).archive_dir });
    let m;
    if ((m = rest.match(/^archive\/(.+)$/))) return json(res, 200, readArchive(root, decodeURIComponent(m[1])));
    if ((m = rest.match(/^task\/(\d+(?:\.\d+)?)$/))) return json(res, 200, taskDetail(root, m[1]));
    if ((m = rest.match(/^log\/([\w.-]+)$/))) return json(res, 200, tail(logPath(root, m[1])));
  }
  if (req.method === 'POST') {
    const body = await readBody(req);
    return json(res, 200, await handleAction(root, rest, body));
  }
  return json(res, 404, { error: 'not found' });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // 開不了瀏覽器就讓使用者自己點網址
  }
}

/**
 * defaultRoot：舊版單一專案 API（/api/state 等）對應的專案，可以是 null。
 * overview：首頁顯示所有專案的總覽；false 時首頁直接是 defaultRoot 的專案畫面（aipipe ui --cwd）。
 */
export function createServer(defaultRoot, { overview = false } = {}) {
  if (defaultRoot) ensureDirs(defaultRoot);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 只服務本機網址，避免 DNS rebinding 讓外部網頁讀到狀態。
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden host' });
    try {
      const p = url.pathname;
      if (req.method === 'GET' && !p.startsWith('/api/')) {
        if (p === '/') return sendAsset(res, overview || !defaultRoot ? 'overview.html' : 'index.html');
        if (p === '/overview') return sendAsset(res, 'overview.html');
        if (/^\/p\/[0-9a-f]{10}\/?$/.test(p)) return sendAsset(res, 'index.html');
        const name = p.slice(1);
        if (ASSETS[name] && !name.endsWith('.html')) return sendAsset(res, name);
        return json(res, 404, { error: 'not found' });
      }
      // 只接受本頁 fetch（自訂標頭），擋掉其他網站的跨站表單 POST。
      if (req.method === 'POST' && req.headers['x-aipipe'] !== '1') return json(res, 403, { error: 'forbidden' });

      if (p === '/api/projects' && req.method === 'GET') return json(res, 200, projectsPayload());
      if (p === '/api/projects/events' && req.method === 'GET') return projectsSse(req, res);
      if (req.method === 'POST' && /^\/api\/(projects|queue)\//.test(p)) {
        return json(res, 200, await handleGlobalAction(p.slice(5), await readBody(req)));
      }

      let m;
      if ((m = p.match(/^\/api\/p\/([0-9a-f]{10})\/(.+)$/))) {
        const project = getProject(m[1]);
        if (!project) throw httpError(404, '總覽裡沒有這個專案');
        if (!fs.existsSync(path.join(project.path, CONFIG_FILE))) throw httpError(404, `找不到 ${project.path}${path.sep}${CONFIG_FILE}`);
        ensureDirs(project.path);
        return await projectRoute(project.path, req, res, m[2]);
      }
      if (p.startsWith('/api/')) {
        if (!defaultRoot) throw httpError(404, '沒有預設專案：請從總覽選一個專案（/api/p/<id>/...）');
        return await projectRoute(defaultRoot, req, res, p.slice(5));
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, err.status || 500, { error: err.message });
    }
  });
}

export function startServer(root, { port = 4317, open = true, overview = false } = {}) {
  const server = createServer(root, { overview });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address().port;
      const page = !overview && root ? `/p/${projectId(root)}/` : '/';
      const url = `http://localhost:${actual}${page}`;
      console.log(`aipipe UI：${url}${root ? `（專案：${root}）` : '（所有專案總覽）'}  Ctrl+C 結束`);
      if (open) openBrowser(url);
      // 桌面版：外殼程式結束（包含當掉或被強制關閉）時跟著結束，不留下孤兒 sidecar。
      // 由 UI 啟動的 aipipe run 是另外的獨立程序，不受影響。
      const parent = Number(process.env.AIPIPE_PARENT_PID);
      if (parent) {
        setInterval(() => {
          if (!isPidAlive(parent)) process.exit(0);
        }, 2000).unref();
      }
      resolve(server);
    });
  });
}

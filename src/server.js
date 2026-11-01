import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadConfig, patchConfig, MODES, CLI_NAMES, RUNTIMES } from './config.js';
import { doctorReport } from './doctor.js';
import { approvePrd, currentPrd } from './prd.js';
import { readTasks } from './taskmaster.js';
import { requestPause } from './runner.js';
import { spawnDetachedCli } from './cli.js';
import { aipipeDir, ensureDirs, isPidAlive, logPath, readState, readText } from './state.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
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

function snapshot(root) {
  const cfg = loadConfig(root);
  const state = readState(root);
  const runnerAlive = isPidAlive(state.runner.pid);
  const prdBusy = isPidAlive(state.prd.pid);
  const taskGenBusy = isPidAlive(state.task_gen?.pid);
  return {
    root,
    config: cfg,
    state,
    runnerAlive,
    prdBusy,
    taskGenBusy,
    prd: currentPrd(root),
    tasks: readTasks(root),
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
  if (snap.runnerAlive) throw Object.assign(new Error('流程執行中'), { status: 409 });
  if (snap.prdBusy) throw Object.assign(new Error('PRD 流程執行中'), { status: 409 });
  if (snap.taskGenBusy) throw Object.assign(new Error('任務產生中'), { status: 409 });
}

async function handleAction(root, action, body) {
  const snap = snapshot(root);
  switch (action) {
    case 'prd/new': {
      busyGuard(snap);
      const idea = String(body.idea || '').trim();
      if (!idea) throw Object.assign(new Error('請輸入想法'), { status: 400 });
      return { pid: await spawnDetachedCli(root, ['prd', idea]) };
    }
    case 'prd/approve':
      return { file: approvePrd(root, snap.config) };
    case 'prd/revise': {
      busyGuard(snap);
      const feedback = String(body.feedback || '').trim();
      if (!feedback) throw Object.assign(new Error('請輸入修改意見'), { status: 400 });
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
      if (!/^\d+(\.\d+)?$/.test(id)) throw Object.assign(new Error('任務 id 不正確'), { status: 400 });
      return { pid: await spawnDetachedCli(root, ['rerun', id, ...(body.revert ? ['--revert'] : [])]) };
    }
    case 'config/runtime': {
      const runtime = {};
      for (const name of CLI_NAMES) {
        if (body.runtime?.[name] !== undefined) {
          if (!RUNTIMES.includes(body.runtime[name])) throw Object.assign(new Error(`${name} 的 runtime 不正確`), { status: 400 });
          runtime[name] = body.runtime[name];
        }
      }
      const patch = { runtime };
      if (body.wsl_distro !== undefined) patch.wsl_distro = String(body.wsl_distro).trim();
      return { config: patchConfig(root, patch) };
    }
    case 'doctor':
      return doctorReport(root);
    case 'config/mode': {
      if (!MODES.includes(body.mode)) throw Object.assign(new Error('模式不正確'), { status: 400 });
      return { config: patchConfig(root, { mode: body.mode }) };
    }
    default:
      throw Object.assign(new Error('未知操作'), { status: 404 });
  }
}

/** SSE：每 0.7 秒檢查 state.json 與 logs/ 的變化，推送狀態與新增的 log。 */
function sse(root, req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 2000\n\n');
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  const logDir = aipipeDir(root, 'logs');
  const sizes = new Map();
  for (const f of fs.existsSync(logDir) ? fs.readdirSync(logDir) : []) sizes.set(f, fs.statSync(path.join(logDir, f)).size);
  let lastState = '';
  let lastTasks = '';
  const tick = () => {
    try {
      const stateStat = fs.statSync(aipipeDir(root, 'state.json'), { throwIfNoEntry: false });
      const tasksStat = fs.statSync(path.join(root, '.taskmaster', 'tasks', 'tasks.json'), { throwIfNoEntry: false });
      const cfgStat = fs.statSync(path.join(root, '.aipipe.json'), { throwIfNoEntry: false });
      const sig = `${stateStat?.mtimeMs}|${cfgStat?.mtimeMs}`;
      const tsig = `${tasksStat?.mtimeMs}`;
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

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true, windowsHide: true }).unref();
  } catch {
    // 開不了瀏覽器就讓使用者自己點網址
  }
}

export function createServer(root) {
  ensureDirs(root);
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    // 只服務本機網址，避免 DNS rebinding 讓外部網頁讀到狀態。
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(req.headers.host || '')) return json(res, 403, { error: 'forbidden host' });
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
        res.end(fs.readFileSync(path.join(UI_DIR, file)));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, snapshot(root));
      if (req.method === 'GET' && url.pathname === '/api/events') return sse(root, req, res);
      if (req.method === 'GET' && url.pathname === '/api/prd') {
        const state = readState(root);
        return json(res, 200, { prd: currentPrd(root), status: state.prd, rounds: prdRounds(root, state) });
      }
      let m;
      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/task\/(\d+(?:\.\d+)?)$/))) {
        return json(res, 200, taskDetail(root, m[1]));
      }
      if (req.method === 'GET' && (m = url.pathname.match(/^\/api\/log\/([\w.-]+)$/))) {
        return json(res, 200, tail(logPath(root, m[1])));
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // 只接受本頁 fetch（自訂標頭），擋掉其他網站的跨站表單 POST。
        if (req.headers['x-aipipe'] !== '1') return json(res, 403, { error: 'forbidden' });
        const body = await readBody(req);
        return json(res, 200, await handleAction(root, url.pathname.slice(5), body));
      }
      json(res, 404, { error: 'not found' });
    } catch (err) {
      json(res, err.status || 500, { error: err.message });
    }
  });
}

export function startServer(root, { port = 4317, open = true } = {}) {
  const server = createServer(root);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const url = `http://localhost:${port}`;
      console.log(`aipipe UI：${url}（專案：${root}）  Ctrl+C 結束`);
      if (open) openBrowser(url);
      resolve(server);
    });
  });
}

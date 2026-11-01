import fs from 'node:fs';
import path from 'node:path';

// 所有運行狀態都放在目標專案的 .aipipe/，讓 CLI 與 UI 兩個程序能透過檔案共用。
export function aipipeDir(root, ...parts) {
  return path.join(root, '.aipipe', ...parts);
}

export function ensureDirs(root) {
  for (const sub of ['logs', 'prd', 'tasks', 'tmp']) {
    fs.mkdirSync(aipipeDir(root, sub), { recursive: true });
  }
}

export function emptyState() {
  return {
    version: 1,
    // idle | running | paused | waiting | feature_test | stuck | error
    pipeline: { status: 'idle', reason: '', current_task: null, updated_at: null },
    control: { pause_requested: false },
    prd: {
      // none | drafting | reviewing | revising | awaiting_approval | approved
      status: 'none',
      idea: '',
      round: 0,
      rounds: [],
      approved_at: null,
    },
    tasks: {},
    runner: { pid: null, started_at: null },
  };
}

function statePath(root) {
  return aipipeDir(root, 'state.json');
}

export function readState(root) {
  try {
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(statePath(root), 'utf8')) };
  } catch {
    return emptyState();
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows 上讀取中的檔案偶爾無法覆蓋，稍等重試。
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

/** 讀取→修改→寫回；每次都重新讀檔，避免覆蓋另一個程序剛寫入的欄位。 */
export function updateState(root, fn) {
  ensureDirs(root);
  const state = readState(root);
  const result = fn(state) ?? state;
  result.pipeline.updated_at = new Date().toISOString();
  writeAtomic(statePath(root), JSON.stringify(result, null, 2));
  return result;
}

export function taskState(state, id) {
  const key = String(id);
  state.tasks[key] ??= {
    id: key,
    phase: 'pending',
    step: '',
    fix_round: 0,
    attempts: 0,
    commit: null,
    base_tree: null,
    started_at: null,
    finished_at: null,
    last_check_ok: null,
    review_verdict: null,
    error: '',
  };
  return state.tasks[key];
}

export function taskDir(root, id) {
  const dir = aipipeDir(root, 'tasks', String(id));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function logPath(root, scope) {
  return aipipeDir(root, 'logs', `${scope}.log`);
}

export function appendLog(root, scope, text) {
  ensureDirs(root);
  const stamp = new Date().toISOString().slice(11, 19);
  const lines = String(text).replace(/\r/g, '').split('\n');
  if (lines.at(-1) === '') lines.pop();
  fs.appendFileSync(logPath(root, scope), lines.map((l) => `[${stamp}] ${l}`).join('\n') + '\n');
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export function readText(file, fallback = '') {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return fallback;
  }
}

import path from 'node:path';
import { aipipeHome, readJson, withLock, writeJson } from './home.js';
import { isPidAlive } from './state.js';

/*
 * 全域執行佇列：所有專案的 `aipipe run` 共用，同時最多 max_concurrent_runs 個在跑（預設 1），
 * 避免多個專案同時燒同一份 Claude／Codex 訂閱額度。
 * 佇列存在 ~/.aipipe/queue.json，由各個 run 程序自己排隊與釋放，不依賴 UI 是否開著。
 * 停下來等人（等待核准、等待測試、卡住）時 run 程序已經結束，自然不佔名額。
 */

const QUEUE_FILE = () => aipipeHome('queue.json');
const CONFIG_FILE = () => aipipeHome('config.json');

export function globalConfig() {
  const cfg = readJson(CONFIG_FILE(), {});
  const n = Number(cfg.max_concurrent_runs);
  return { ...cfg, max_concurrent_runs: Number.isInteger(n) && n >= 1 ? n : 1 };
}

export function setMaxConcurrent(n) {
  const v = Number(n);
  if (!Number.isInteger(v) || v < 1 || v > 8) throw new Error('同時執行上限必須是 1–8 的整數');
  return withLock('config', () => {
    const cfg = readJson(CONFIG_FILE(), {});
    writeJson(CONFIG_FILE(), { ...cfg, max_concurrent_runs: v });
    return globalConfig();
  });
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function load() {
  const q = readJson(QUEUE_FILE(), {});
  const alive = (e) => e && isPidAlive(e.pid);
  return { running: (q.running || []).filter(alive), waiting: (q.waiting || []).filter(alive) };
}

/** 目前佇列（已清掉結束的程序）。position 從 1 開始。 */
export function queueSnapshot() {
  const { running, waiting } = load();
  return { max: globalConfig().max_concurrent_runs, running, waiting: waiting.map((e, i) => ({ ...e, position: i + 1 })) };
}

export function queueEntryFor(root) {
  const snap = queueSnapshot();
  const run = snap.running.find((e) => samePath(e.root, root));
  if (run) return { state: 'running', ...run };
  const wait = snap.waiting.find((e) => samePath(e.root, root));
  if (wait) return { state: 'waiting', ...wait };
  return null;
}

/** 嘗試取得名額：排在最前面且有空位才拿得到。回傳 { granted, position, running }。 */
export function tryAcquire(root, pid = process.pid) {
  return withLock('queue', () => {
    const q = load();
    if (q.running.some((e) => e.pid === pid)) return { granted: true, position: 0, running: q.running };
    if (!q.waiting.some((e) => e.pid === pid)) q.waiting.push({ pid, root, since: new Date().toISOString() });
    const idx = q.waiting.findIndex((e) => e.pid === pid);
    const max = globalConfig().max_concurrent_runs;
    let granted = false;
    if (idx === 0 && q.running.length < max) {
      const [me] = q.waiting.splice(0, 1);
      q.running.push({ ...me, started_at: new Date().toISOString() });
      granted = true;
    }
    writeJson(QUEUE_FILE(), q);
    return { granted, position: granted ? 0 : idx + 1, running: q.running };
  });
}

export function release(pid = process.pid) {
  withLock('queue', () => {
    const q = load();
    writeJson(QUEUE_FILE(), { running: q.running.filter((e) => e.pid !== pid), waiting: q.waiting.filter((e) => e.pid !== pid) });
  });
}

/**
 * 等到拿到名額為止。onWait(position, running) 在排隊位置改變時呼叫；shouldAbort() 回傳 true 時放棄排隊。
 * 回傳 true＝拿到名額，false＝放棄。
 */
export async function acquireSlot(root, { onWait = () => {}, shouldAbort = () => false, intervalMs = 1500 } = {}) {
  let last = null;
  for (;;) {
    const r = tryAcquire(root);
    if (r.granted) return true;
    const key = `${r.position}|${r.running.map((e) => e.root).join(',')}`;
    if (key !== last) {
      last = key;
      onWait(r.position, r.running);
    }
    if (shouldAbort()) {
      release();
      return false;
    }
    await new Promise((res) => setTimeout(res, intervalMs));
  }
}

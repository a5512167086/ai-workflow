import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 打包成 Node SEA（桌面版 sidecar）時，process.execPath 是 aipipe 自己的 exe，不是 node。
const sea = process.getBuiltinModule?.('node:sea');
export const IS_SEA = !!sea?.isSea?.();

/** 讀取 SEA 內嵌的檔案（UI 靜態檔）；不是 SEA 時回傳 null。 */
export function seaAsset(name) {
  if (!IS_SEA) return null;
  try {
    return Buffer.from(sea.getAsset(name));
  } catch {
    return null;
  }
}

/**
 * 全域資料目錄：專案清單、執行佇列、全域設定。預設 ~/.aipipe，測試或多份安裝可用 AIPIPE_HOME 指定。
 * 與專案裡的 .aipipe/ 不同：那是單一專案的運行狀態。
 */
export function aipipeHome(...parts) {
  const base = process.env.AIPIPE_HOME || path.join(os.homedir(), '.aipipe');
  fs.mkdirSync(base, { recursive: true });
  return path.join(base, ...parts);
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      // Windows 上讀取中的檔案偶爾無法覆蓋，稍等重試。
      if (i >= 20 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      sleepSync(25);
    }
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨程序的互斥鎖：用 mkdir 的原子性建立鎖目錄。多個 aipipe run／UI 程序同時改佇列或專案清單時使用。
 * 超過 staleMs 沒釋放的鎖視為持有者已當掉，直接清掉。
 */
export function withLock(name, fn, { staleMs = 10000, timeoutMs = 15000 } = {}) {
  const lock = aipipeHome(`${name}.lock`);
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > staleMs) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // 別的程序剛好釋放了
      }
      if (Date.now() - start > timeoutMs) throw new Error(`等待 ${name} 鎖逾時`);
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

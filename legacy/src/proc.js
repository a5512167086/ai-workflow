import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { IS_SEA } from './home.js';
import { cliEnvironment, wslLocation } from './runtime.js';

const IS_WIN = process.platform === 'win32';

/**
 * 子程序環境：移除所有會讓 CLI 改走付費 API 的變數，確保使用訂閱登入。
 * 同時移除從上層 Claude Code session 繼承的變數（例如 CLAUDE_CODE_SIMPLE 會讓 claude 忽略 OAuth 登入）。
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    const k = key.toUpperCase();
    if (k === 'CLAUDE_CODE_GIT_BASH_PATH') continue;
    if (
      k.startsWith('ANTHROPIC_') ||
      k === 'OPENAI_API_KEY' ||
      k === 'OPENAI_BASE_URL' ||
      k === 'CODEX_API_KEY' ||
      k === 'OPENAI_CODEX_API_KEY' ||
      k === 'CLAUDECODE' ||
      k.startsWith('CLAUDE_CODE_') ||
      k.startsWith('CLAUDE_AGENT_SDK_')
    ) {
      delete env[key];
    }
  }
  return { ...env, ...extra, NO_COLOR: '1', FORCE_COLOR: '0' };
}

export const STRIPPED_ENV_DESCRIPTION =
  'ANTHROPIC_*、OPENAI_API_KEY、OPENAI_BASE_URL、CODEX_API_KEY、OPENAI_CODEX_API_KEY、CLAUDECODE、CLAUDE_CODE_*、CLAUDE_AGENT_SDK_*';

export function which(name) {
  const exts = IS_WIN ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (fs.statSync(file).isFile()) return file;
      } catch {
        // 不存在就繼續找
      }
    }
  }
  return null;
}

/** 執行 npm 安裝的 .js CLI 用的 node。桌面版（SEA）的 process.execPath 是 aipipe 自己，要另外找 node。 */
function nodeExe() {
  return IS_SEA ? which('node') : process.execPath;
}

/**
 * 把設定或 PATH 裡的 CLI 解析成可直接 spawn 的 { command, prefixArgs, shell }。
 * npm 在 Windows 產生的 .cmd 包裝檔會改成用 node 直接執行其 JS 入口，避免經過 cmd.exe 的參數跳脫問題。
 */
export function resolveCli(configured, fallbackName) {
  const file = configured || which(fallbackName);
  if (!file) {
    throw new Error(`找不到 ${fallbackName}，請安裝後確認在 PATH 中，或在 .aipipe.json 的 cli 欄位填完整路徑`);
  }
  if (IS_WIN && /\.(cmd|bat)$/i.test(file)) {
    const text = fs.readFileSync(file, 'utf8');
    const m = text.match(/"%(?:dp0|~dp0)%\\([^"]+\.(?:js|mjs|cjs))"/i);
    if (m && nodeExe()) {
      return { command: nodeExe(), prefixArgs: [path.join(path.dirname(file), m[1])], shell: false, label: file };
    }
    return { command: file, prefixArgs: [], shell: true, label: file };
  }
  if (/\.(js|mjs|cjs)$/i.test(file)) {
    if (!nodeExe()) throw new Error(`${file} 是 Node.js 腳本，需要安裝 Node.js 並放在 PATH 中`);
    return { command: nodeExe(), prefixArgs: [file], shell: false, label: file };
  }
  return { command: file, prefixArgs: [], shell: false, label: file };
}

const BIN_NAMES = { claude: 'claude', codex: 'codex' };

/**
 * 在 WSL 裡啟動指令前執行的清理腳本。login shell 會讀 .bashrc／.profile，可能又設回 API key，
 * 所以在 WSL 端再清一次（Windows 端的 cleanEnv 管不到 WSL 自己的設定檔，也擋不住 WSLENV 轉送）。
 */
export const WSL_SCRUB_SCRIPT = [
  'for v in $(compgen -e); do',
  '  case "$v" in ANTHROPIC_*|CLAUDE_CODE_*|CLAUDE_AGENT_SDK_*|CLAUDECODE|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|OPENAI_CODEX_API_KEY) unset "$v";; esac;',
  'done;',
  'exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY "$@"',
].join(' ');

/**
 * 依 .aipipe.json 的 runtime 解析 CLI：windows 用 resolveCli；wsl 透過 wsl.exe 執行。
 * name 是 claude / codex。回傳的 spec 都有 toPath()，把 Windows 路徑轉成該 runtime 看得懂的路徑。
 */
export function resolveCliFor(cfg, name, root = process.cwd()) {
  const environment = cliEnvironment(cfg, name, root);
  if (environment.runtime === 'wsl') {
    if (!IS_WIN) return { ...resolveCli(cfg.wsl_cli?.[name], BIN_NAMES[name]), runtime: 'wsl', toPath: (p) => p };
    const distro = environment.distro;
    const bin = cfg.wsl_cli?.[name] || BIN_NAMES[name];
    return {
      wsl: true,
      runtime: 'wsl',
      distro,
      bin,
      command: 'wsl.exe',
      prefixArgs: [],
      shell: false,
      label: `WSL${distro ? `（${distro}）` : '（預設發行版）'}：${bin}`,
      toPath: (p) => toWslPath(distro, p),
    };
  }
  return { ...resolveCli(cfg.cli?.[name], BIN_NAMES[name]), runtime: 'windows', toPath: (p) => p };
}

function wslBaseArgs(distro) {
  return distro ? ['-d', distro] : [];
}

const wslPathCache = new Map();
export function toWslPath(distro, winPath, { execute = spawnSync } = {}) {
  const location = wslLocation(winPath);
  if (location) {
    if (distro && location.distro.toLowerCase() !== distro.toLowerCase()) throw new Error('不可跨 WSL 發行版存取專案');
    return location.path;
  }
  if (winPath.startsWith('/')) return winPath;
  const key = `${distro}|${winPath}`;
  if (execute === spawnSync && wslPathCache.has(key)) return wslPathCache.get(key);
  // Launch independently of the desktop app's cwd. WSL can take time to cold-start.
  const r = execute('wsl.exe', [...wslBaseArgs(distro), '--cd', '/', '-e', '/usr/bin/wslpath', '-a', winPath], {
    encoding: 'utf8',
    env: cleanEnv(),
    windowsHide: true,
    timeout: 30000,
  });
  if (r.error || r.status !== 0 || !r.stdout?.trim()) {
    const detail = r.error?.code === 'ETIMEDOUT' ? 'WSL 啟動或路徑轉換超過 30 秒，請確認發行版可正常啟動'
      : r.error ? `${r.error.code || ''} ${r.error.message}`
      : (r.stderr || r.stdout || `結束碼 ${r.status}，沒有回傳路徑`).replace(/\0/g, '').trim();
    throw new Error(`wslpath 轉換失敗（${distro || '預設發行版'}）：${winPath}；${detail}`);
  }
  const out = r.stdout.trim();
  if (!out.startsWith('/') || /[\r\n]/.test(out)) throw new Error(`wslpath 未回傳有效的 Linux 路徑：${winPath}`);
  if (execute === spawnSync) wslPathCache.set(key, out);
  return out;
}

/**
 * 組出 wsl.exe 的參數。必須用 -e（--exec）：用 -- 時 wsl.exe 會把參數接成字串交給預設 shell，
 * 引號與 $、;、| 會被重新解析。--cd 直接接受 Windows 路徑。
 */
export function wslArgs(spec, cwd, args) {
  // WSL --cd accepts Windows paths itself. Only UNC Linux paths need local parsing.
  const location = cwd ? wslLocation(cwd) : null;
  if (location && spec.distro && location.distro.toLowerCase() !== spec.distro.toLowerCase()) throw new Error('不可跨 WSL 發行版存取專案');
  const directory = location?.path || cwd;
  return [...wslBaseArgs(spec.distro), ...(directory ? ['--cd', directory] : []), '-e', 'bash', '-lc', WSL_SCRUB_SCRIPT, 'aipipe', spec.bin, ...args];
}

function quoteForCmd(arg) {
  if (/^[\w\-.:=\\/@,]+$/.test(arg)) return arg;
  return `"${String(arg).replace(/"/g, '""')}"`;
}

export function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

/**
 * 執行子程序。input 會寫入 stdin（長 prompt 一律走 stdin，避開命令列長度限制）。
 * 回傳 { code, stdout, stderr, timedOut }，不因非零結束碼丟例外。
 */
function spawnCommand(spec, args, { cwd, env, shellCommand } = {}) {
    let child;
    // A Linux/UNC project directory is for WSL --cd, not the Windows launcher.
    const opts = { cwd: spec?.wsl ? undefined : cwd, env: env || cleanEnv(), windowsHide: true, detached: !IS_WIN };
    if (shellCommand) {
      child = spawn(shellCommand, { ...opts, shell: true });
    } else if (spec.wsl) {
      child = spawn('wsl.exe', wslArgs(spec, cwd, args), opts);
    } else if (spec.shell) {
      const line = [spec.command, ...spec.prefixArgs, ...args].map(quoteForCmd).join(' ');
      child = spawn(line, { ...opts, shell: true });
    } else {
      child = spawn(spec.command, [...spec.prefixArgs, ...args], opts);
    }
    return child;
}

/** Query the Codex control plane without starting a conversation or model turn. */
export function queryCodexRpc(spec, { cwd, method, timeoutSec = 15 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(spec, ['app-server'], { cwd });
    let buffer = '', finished = false;
    const finish = (error, value) => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.stdin.end(); killTree(child);
      if (error) reject(error); else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('額度查詢逾時')), timeoutSec * 1000);
    const send = message => child.stdin.write(JSON.stringify(message) + '\n');
    child.stdout.setEncoding('utf8');
    child.stderr.resume(); // Never surface control-plane stderr, which can contain account details.
    child.stdin.on('error', error => finish(error));
    child.on('error', error => finish(error));
    child.on('close', () => { if (!finished) finish(new Error('CLI 未提供額度查詢結果')); });
    child.stdout.on('data', data => {
      buffer += data;
      if (buffer.length > 1e6) return finish(new Error('額度查詢回應過大'));
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('CLI 不支援額度查詢初始化'));
          send({ method: 'initialized', params: {} });
          send({ id: 2, method });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error('無法取得訂閱額度，請確認 CLI 版本與登入狀態'));
          return finish(null, message.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'aipipe', version: '0.1.1' } } });
  });
}

export function run(spec, args, { cwd, input, env, timeoutSec = 0, onStdout, onStderr, shellCommand } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCommand(spec, args, { cwd, env, shellCommand });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;
    if (timeoutSec > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
      }, timeoutSec * 1000);
    }
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
      onStdout?.(d);
    });
    child.stderr.on('data', (d) => {
      stderr += d;
      onStderr?.(d);
    });
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
    child.stdin.on('error', () => {});
    if (input != null) child.stdin.end(input);
    else child.stdin.end();
  });
}

export function runShell(command, opts) {
  const location = IS_WIN && opts?.cwd ? wslLocation(opts.cwd) : null;
  if (location) {
    return run({ wsl: true, distro: location.distro, bin: 'bash' }, ['-c', command], opts);
  }
  return run(null, [], { ...opts, shellCommand: command });
}

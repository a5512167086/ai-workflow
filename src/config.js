import fs from 'node:fs';
import path from 'node:path';

export const CONFIG_FILE = '.aipipe.json';
export const ROLES = ['author', 'reviewer', 'implementer', 'code_reviewer'];
export const PROVIDERS = ['claude', 'codex'];
export const MODES = ['auto', 'manual'];
export const CLI_NAMES = ['claude', 'codex', 'task_master'];
export const RUNTIMES = ['windows', 'wsl'];

export function defaultConfig() {
  return {
    mode: 'manual',
    feature: '',
    commands: {
      build: '',
      test: '',
      lint: '',
    },
    context_files: ['docs/ai-context.md', 'docs/index.md'],
    handover_path: 'docs/handovers/current_handover.md',
    prd_path: '.taskmaster/docs/prd.md',
    roles: {
      author: 'claude',
      reviewer: 'codex',
      implementer: 'claude',
      code_reviewer: 'codex',
    },
    max_fix_rounds: 3,
    max_prd_rounds: 2,
    num_tasks: 0,
    command_timeout_sec: 900,
    agent_timeout_sec: 1800,
    branch_prefix: 'aipipe/',
    // 每個 CLI 在 Windows 原生（windows）或 WSL（wsl）執行。
    runtime: {
      claude: 'windows',
      codex: 'windows',
      task_master: 'windows',
    },
    // 空字串＝WSL 預設發行版。
    wsl_distro: '',
    // runtime 為 wsl 時在 WSL 裡執行的指令名稱或路徑；空字串＝claude / codex / task-master。
    wsl_cli: {
      claude: '',
      codex: '',
      task_master: '',
    },
    // runtime 為 windows 時使用。空字串代表從 PATH 尋找；Windows 上可填 .exe 或 .cmd 的完整路徑。
    cli: {
      claude: '',
      codex: '',
      task_master: '',
    },
    claude: {
      model: '',
      // 實作者在 -p 模式下額外允許的工具，例如 "Bash(npm test:*)"；預設只允許編輯。
      allowed_tools: [],
    },
    codex: {
      model: '',
      // Windows 上 Codex 需要 windows.sandbox 才會真的啟用 workspace-write，否則會默默降成 read-only。
      // 可填 elevated / unelevated；空字串代表沿用 ~/.codex/config.toml。
      windows_sandbox: process.platform === 'win32' ? 'elevated' : '',
    },
    taskmaster: {
      provider: 'claude-code',
      model: 'sonnet',
      // auto：先用 task-master parse-prd，失敗再由作者 AI 依 Task Master 格式產生；task-master／agent 只用其中一種。
      parse_with: 'auto',
    },
  };
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function configPath(root) {
  return path.join(root, CONFIG_FILE);
}

export function validateConfig(cfg) {
  const errors = [];
  if (!MODES.includes(cfg.mode)) errors.push(`mode 必須是 ${MODES.join(' / ')}`);
  for (const role of ROLES) {
    if (!PROVIDERS.includes(cfg.roles?.[role])) errors.push(`roles.${role} 必須是 ${PROVIDERS.join(' / ')}`);
  }
  for (const key of ['max_fix_rounds', 'max_prd_rounds']) {
    const n = cfg[key];
    if (!Number.isInteger(n) || n < 1 || n > 10) errors.push(`${key} 必須是 1–10 的整數`);
  }
  if (!['claude-code', 'codex-cli'].includes(cfg.taskmaster?.provider)) {
    errors.push('taskmaster.provider 必須是 claude-code 或 codex-cli（不使用 API key 的 provider）');
  }
  for (const name of CLI_NAMES) {
    if (!RUNTIMES.includes(cfg.runtime?.[name])) errors.push(`runtime.${name} 必須是 ${RUNTIMES.join(' / ')}`);
  }
  if (typeof cfg.wsl_distro !== 'string' || !/^[\w.-]*$/.test(cfg.wsl_distro)) {
    errors.push('wsl_distro 只能包含英數字、底線、點與連字號');
  }
  if (!['auto', 'task-master', 'agent'].includes(cfg.taskmaster?.parse_with)) {
    errors.push('taskmaster.parse_with 必須是 auto / task-master / agent');
  }
  return errors;
}

export function loadConfig(root, { required = true } = {}) {
  const file = configPath(root);
  if (!fs.existsSync(file)) {
    if (required) throw new Error(`找不到 ${CONFIG_FILE}，請先在專案根目錄執行 aipipe init`);
    return defaultConfig();
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = deepMerge(defaultConfig(), raw);
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`${CONFIG_FILE} 設定錯誤：\n- ${errors.join('\n- ')}`);
  return cfg;
}

export function saveConfig(root, cfg) {
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(errors.join('; '));
  fs.writeFileSync(configPath(root), JSON.stringify(cfg, null, 2) + '\n');
}

/** 只改單一欄位（例如 UI 切換模式），保留使用者手寫的其餘內容。 */
export function patchConfig(root, patch) {
  const file = configPath(root);
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const next = deepMerge(raw, patch);
  const errors = validateConfig(deepMerge(defaultConfig(), next));
  if (errors.length) throw new Error(errors.join('; '));
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return loadConfig(root);
}

/** 從目前目錄往上找含 .aipipe.json 的目錄，找不到就回傳起點。 */
export function findProjectRoot(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

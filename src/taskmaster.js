import fs from 'node:fs';
import path from 'node:path';
import { resolveCliFor, run } from './proc.js';
import { appendLog } from './state.js';

const PROVIDER_FLAG = { 'claude-code': '--claude-code', 'codex-cli': '--codex-cli' };

export function tasksFile(root) {
  return path.join(root, '.taskmaster', 'tasks', 'tasks.json');
}

async function tm(root, cfg, args, scope, { allowFail = false } = {}) {
  const spec = resolveCliFor(cfg, 'task_master');
  appendLog(root, scope, `$ task-master ${args.join(' ')}`);
  const res = await run(spec, args, {
    cwd: root,
    timeoutSec: cfg.agent_timeout_sec,
    onStdout: (d) => appendLog(root, scope, d.trimEnd()),
    onStderr: (d) => appendLog(root, scope, d.trimEnd()),
  });
  if (res.code !== 0 && !allowFail) {
    throw new Error(`task-master ${args[0]} 失敗（結束碼 ${res.code}），詳見 .aipipe/logs/${scope}.log`);
  }
  return res;
}

/** 初始化 .taskmaster 並把 main／fallback 模型設成走 CLI 訂閱的 provider（不需要 API key）。 */
export async function ensureTaskMaster(root, cfg, scope) {
  const tmConfig = path.join(root, '.taskmaster', 'config.json');
  if (!fs.existsSync(tmConfig)) {
    // --rules "" 不產生 CLAUDE.md、.mcp.json 等編輯器規則檔，只建 .taskmaster/。
    await tm(root, cfg, ['init', '-y', '--skip-install', '--no-git', '--no-aliases', '--rules', ''], scope);
  }
  // main／fallback／research 全部設成同一個 CLI provider；預設的 research 是 perplexity，會要求 API key。
  const flag = PROVIDER_FLAG[cfg.taskmaster.provider];
  for (const role of ['main', 'fallback', 'research']) {
    await tm(root, cfg, ['models', `--set-${role}`, cfg.taskmaster.model, flag], scope);
  }

  // Task Master 的 provider 會在 Task Master 自己的 runtime 裡找 claude／codex；
  // 兩者 runtime 不同時（例如 task-master 在 Windows、claude 在 WSL）它找不到，parse-prd 會失敗並由 parse_with=auto 接手。
  const tmRuntime = cfg.runtime?.task_master || 'windows';
  const providerCli = cfg.taskmaster.provider === 'claude-code' ? 'claude' : 'codex';
  if ((cfg.runtime?.[providerCli] || 'windows') !== tmRuntime) {
    appendLog(root, scope, `⚠ task-master 在 ${tmRuntime}，但 ${providerCli} 設在 ${cfg.runtime[providerCli]}；Task Master 的 ${cfg.taskmaster.provider} provider 可能找不到 CLI`);
  }

  // 讓 Task Master 內建的 provider 用和 aipipe 相同的 CLI 執行檔（只在同為 Windows 時有意義），並關閉匿名遙測。
  const json = JSON.parse(fs.readFileSync(tmConfig, 'utf8'));
  json.global = { ...(json.global || {}), anonymousTelemetry: false };
  const sameWin = (name) => tmRuntime === 'windows' && (cfg.runtime?.[name] || 'windows') === 'windows';
  if (sameWin('claude') && cfg.cli.claude && /\.(exe|js|mjs)$/i.test(cfg.cli.claude)) {
    json.claudeCode = { ...(json.claudeCode || {}), pathToClaudeCodeExecutable: cfg.cli.claude };
  }
  if (sameWin('codex') && cfg.cli.codex && /\.(exe|js|mjs)$/i.test(cfg.cli.codex)) {
    json.codexCli = { ...(json.codexCli || {}), codexPath: cfg.cli.codex };
  }
  fs.writeFileSync(tmConfig, JSON.stringify(json, null, 2) + '\n');
}

/**
 * 產生 tasks.json。parse_with：
 * - task-master：只用 task-master parse-prd
 * - agent：由 aipipe 的作者 AI 依 Task Master 格式產生（Task Master 的 provider 不能用時）
 * - auto（預設）：先 parse-prd，失敗再改用 agent
 * 之後的 next／set-status 一律仍由 Task Master 處理。
 */
export async function parsePrd(root, cfg, prdFile, scope, agentFallback) {
  const mode = cfg.taskmaster.parse_with;
  if (mode !== 'agent') {
    const args = ['parse-prd', '--input', prdFile, '--force', '--tag', currentTag(root)];
    if (cfg.num_tasks > 0) args.push('--num-tasks', String(cfg.num_tasks));
    const res = await tm(root, cfg, args, scope, { allowFail: mode === 'auto' });
    if (res.code === 0 && fs.existsSync(tasksFile(root))) return 'task-master';
    if (mode !== 'auto') throw new Error('parse-prd 執行完但沒有產生 .taskmaster/tasks/tasks.json');
    appendLog(root, scope, '⚠ task-master parse-prd 失敗，改由作者 AI 依 Task Master 格式產生任務');
  }
  await agentFallback();
  // 用 Task Master 讀一次，確認格式它看得懂。
  await tm(root, cfg, ['list'], scope);
  return 'agent';
}

/** 目前使用中的 Task Master tag（.taskmaster/state.json 的 currentTag），預設 master。 */
export function currentTag(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, '.taskmaster', 'state.json'), 'utf8')).currentTag || 'master';
  } catch {
    return 'master';
  }
}

function readTasksFile(root) {
  const file = tasksFile(root);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Task Master 的 tag 名稱只接受英數字、底線與連字號。 */
export function tagName(date, slug, existing = []) {
  const base = `f-${date.replace(/-/g, '')}-${slug}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+$/, '');
  let name = base;
  for (let i = 2; existing.includes(name); i++) name = `${base}-${i}`;
  return name;
}

/**
 * 為新功能建立並切換到自己的 tag。失敗（例如舊版 Task Master）就回傳 null，沿用目前的 tag。
 */
export async function useFeatureTag(root, cfg, slug, scope) {
  const data = readTasksFile(root) || {};
  const existing = Array.isArray(data.tasks) ? [] : Object.keys(data);
  // 目前的 tag 還是空的（例如全新專案的 master），直接用它就好。
  const cur = currentTag(root);
  if (!Array.isArray(data.tasks) && !(data[cur]?.tasks || []).length) return cur;
  const name = tagName(new Date().toISOString().slice(0, 10), slug, existing);
  const add = await tm(root, cfg, ['tags', 'add', name, '--description', `aipipe ${slug}`], scope, { allowFail: true });
  if (add.code !== 0) {
    appendLog(root, scope, `⚠ 建立 Task Master tag ${name} 失敗，沿用 ${cur}`);
    return null;
  }
  const use = await tm(root, cfg, ['tags', 'use', name], scope, { allowFail: true });
  if (use.code !== 0) {
    appendLog(root, scope, `⚠ 切換到 Task Master tag ${name} 失敗，沿用 ${cur}`);
    return null;
  }
  appendLog(root, scope, `這個功能的任務放在 Task Master tag「${name}」`);
  return name;
}

/** 驗證並寫入 AI 產生的任務清單（Task Master tag 格式），只覆蓋目前的 tag，其他功能的 tag 保留。 */
export function writeTasks(root, tasks, tag = currentTag(root)) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('任務清單是空的');
  const ids = new Set();
  const clean = tasks.map((t, i) => {
    const id = i + 1;
    ids.add(id);
    if (!t.title) throw new Error(`第 ${id} 個任務沒有 title`);
    return {
      id,
      title: String(t.title),
      description: String(t.description || ''),
      details: String(t.details || ''),
      testStrategy: String(t.testStrategy || ''),
      priority: ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium',
      dependencies: (t.dependencies || []).map(Number).filter((d) => d >= 1 && d < id),
      status: 'pending',
      subtasks: [],
    };
  });
  const file = tasksFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const now = new Date().toISOString();
  let data = readTasksFile(root) || {};
  if (Array.isArray(data.tasks)) data = {}; // 舊版單一清單格式：改寫成 tag 格式
  const meta = data[tag]?.metadata || {};
  data[tag] = { tasks: clean, metadata: { ...meta, created: meta.created || now, updated: now, description: meta.description || `Tasks for ${tag} context` } };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return clean;
}

/** 呼叫 task-master next；回傳任務 id 或 null（沒有可做的任務）。 */
export async function nextTaskId(root, cfg, scope) {
  const res = await tm(root, cfg, ['next', '--format', 'json'], scope, { allowFail: true });
  const text = res.stdout.trim();
  const start = text.indexOf('{');
  if (start >= 0) {
    try {
      const data = JSON.parse(text.slice(start));
      const task = data.task ?? data.nextTask ?? data.data?.nextTask ?? data.data?.task ?? (data.id != null ? data : null);
      return task?.id != null ? String(task.id) : null;
    } catch {
      // 退回文字解析
    }
  }
  const m = text.match(/Next Task:\s*#?(\d+(?:\.\d+)?)/i);
  return m ? m[1] : null;
}

export async function setStatus(root, cfg, id, status, scope) {
  await tm(root, cfg, ['set-status', `--id=${id}`, `--status=${status}`], scope);
}

/** 讀目前 tag 的任務；支援新版 tag 格式 { <tag>: { tasks } } 與舊版 { tasks }。 */
export function readTasks(root) {
  const data = readTasksFile(root);
  if (!data) return [];
  if (Array.isArray(data.tasks)) return data.tasks;
  const tag = data[currentTag(root)] || data.master || Object.values(data).find((v) => v && Array.isArray(v.tasks));
  return tag?.tasks || [];
}

export function findTask(root, id) {
  const [parentId, subId] = String(id).split('.');
  const parent = readTasks(root).find((t) => String(t.id) === parentId);
  if (!parent || !subId) return parent || null;
  const sub = (parent.subtasks || []).find((s) => String(s.id) === subId);
  return sub ? { ...sub, id: String(id), parent: { id: parent.id, title: parent.title } } : null;
}

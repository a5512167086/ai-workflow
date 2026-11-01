import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_FILE, loadConfig } from './config.js';
import { aipipeHome, readJson, withLock, writeJson } from './home.js';
import { queueEntryFor } from './queue.js';
import { isPidAlive, readState } from './state.js';
import { readTasks } from './taskmaster.js';

/*
 * 全域專案清單：~/.aipipe/projects.json。只記錄路徑與使用時間，專案本身的狀態仍在各自的 .aipipe/。
 */

const FILE = () => aipipeHome('projects.json');

const norm = (p) => path.resolve(p);
const key = (p) => (process.platform === 'win32' ? norm(p).toLowerCase() : norm(p));

export function projectId(root) {
  return crypto.createHash('sha1').update(key(root)).digest('hex').slice(0, 10);
}

function load() {
  const data = readJson(FILE(), {});
  return Array.isArray(data.projects) ? data.projects : [];
}

function save(projects) {
  writeJson(FILE(), { version: 1, projects });
}

/** 依最近開啟（沒有就依加入時間）排序。 */
export function listProjects() {
  return load()
    .map((p) => ({ ...p, id: projectId(p.path) }))
    .sort((a, b) => String(b.last_opened_at || b.added_at).localeCompare(String(a.last_opened_at || a.added_at)));
}

export function getProject(id) {
  return listProjects().find((p) => p.id === id) || null;
}

export function findProjectByPath(dir) {
  return listProjects().find((p) => key(p.path) === key(dir)) || null;
}

/** 加入專案（已存在就只更新名稱）。資料夾必須存在且已有 .aipipe.json。 */
export function addProject(dir, { name } = {}) {
  const root = norm(dir);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new Error(`資料夾不存在：${root}`);
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) throw new Error(`${root} 還沒有 ${CONFIG_FILE}，請先執行 aipipe init`);
  return withLock('projects', () => {
    const projects = load();
    const now = new Date().toISOString();
    const existing = projects.find((p) => key(p.path) === key(root));
    if (existing) {
      if (name) existing.name = name;
    } else {
      projects.push({ path: root, name: name || path.basename(root), added_at: now, last_opened_at: null });
    }
    save(projects);
    return { ...(existing || projects.at(-1)), id: projectId(root) };
  });
}

/** 依 id、路徑或名稱移除；只移出清單，不刪任何檔案。 */
export function removeProject(ref) {
  return withLock('projects', () => {
    const projects = load();
    const idx = projects.findIndex((p) => projectId(p.path) === ref || key(p.path) === key(ref) || p.name === ref);
    if (idx < 0) throw new Error(`找不到專案：${ref}`);
    const [removed] = projects.splice(idx, 1);
    save(projects);
    return removed;
  });
}

export function touchProject(id) {
  withLock('projects', () => {
    const projects = load();
    const p = projects.find((x) => projectId(x.path) === id);
    if (!p) return;
    p.last_opened_at = new Date().toISOString();
    save(projects);
  });
}

/**
 * 總覽用的狀態摘要。attention 為 true 表示流程停下來等使用者（核准 PRD、測試、處理卡住）。
 * status：missing | idle | drafting | awaiting_approval | generating | ready | queued | running |
 *         paused | waiting | feature_test | stuck | error | complete
 */
export function projectSummary(project) {
  const root = project.path;
  const base = { id: project.id, name: project.name, path: root, last_opened_at: project.last_opened_at };
  if (!fs.existsSync(path.join(root, CONFIG_FILE))) return { ...base, status: 'missing', attention: false, reason: '找不到資料夾或 .aipipe.json' };
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch (err) {
    return { ...base, status: 'error', attention: true, reason: err.message };
  }
  const state = readState(root);
  let tasks = [];
  try {
    tasks = readTasks(root);
  } catch {
    // tasks.json 壞掉時總覽仍要能顯示
  }
  const done = tasks.filter((t) => t.status === 'done').length;
  const runnerAlive = isPidAlive(state.runner.pid);
  const queue = runnerAlive ? queueEntryFor(root) : null;
  const ps = state.pipeline.status;
  let status = ps;
  let reason = state.pipeline.reason || '';
  if (isPidAlive(state.prd.pid)) {
    status = 'drafting';
    reason = 'PRD 起草／審查中';
  } else if (isPidAlive(state.task_gen?.pid)) {
    status = 'generating';
    reason = 'Task Master 產生任務中';
  } else if (runnerAlive && (ps === 'queued' || queue?.state === 'waiting')) {
    status = 'queued';
    reason = queue?.position ? `排隊第 ${queue.position} 位，等其他專案的流程跑完` : reason;
  } else if (runnerAlive) {
    status = 'running';
  } else if (state.prd.status === 'awaiting_approval') {
    status = 'awaiting_approval';
    reason = 'PRD 等待核准';
  } else if (['running', 'queued'].includes(ps)) {
    // runner 已經不在但狀態沒收尾（例如程序被關掉）
    status = 'idle';
  } else if (ps === 'idle' && state.prd.status === 'approved' && tasks.length && done < tasks.length) {
    status = 'ready';
    reason = '可以開始執行';
  } else if (ps === 'idle' && state.prd.status === 'none') {
    reason = '尚未開始功能';
  }
  const attention = ['awaiting_approval', 'waiting', 'feature_test', 'stuck', 'error'].includes(status);
  return {
    ...base,
    status,
    reason,
    attention,
    mode: cfg.mode,
    feature: cfg.feature || state.prd.idea || '',
    prd_status: state.prd.status,
    progress: { done, total: tasks.length },
    current_task: state.pipeline.current_task,
    queue_position: queue?.state === 'waiting' ? queue.position : null,
    updated_at: state.pipeline.updated_at,
  };
}

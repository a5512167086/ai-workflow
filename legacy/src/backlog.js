import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';

/*
 * 需求待辦清單：每個專案一份 JSON（預設 docs/aipipe/backlog.json），可以 commit。
 * 陣列順序就是優先順序。status：open（待辦）、in_progress（已用它起草 PRD）、done（功能完成）。
 */

export const BACKLOG_STATUSES = ['open', 'in_progress', 'done'];

function file(root, cfg) {
  return path.join(root, cfg.backlog_path);
}

export function readBacklog(root, cfg = loadConfig(root)) {
  try {
    const data = JSON.parse(fs.readFileSync(file(root, cfg), 'utf8'));
    return Array.isArray(data.items) ? data.items : [];
  } catch {
    return [];
  }
}

function writeBacklog(root, cfg, items) {
  const f = file(root, cfg);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ version: 1, items }, null, 2) + '\n');
  return items;
}

function clean(text, max) {
  return String(text ?? '').replace(/\r\n?/g, '\n').trim().slice(0, max);
}

function mutate(root, fn) {
  const cfg = loadConfig(root);
  const items = readBacklog(root, cfg);
  const result = fn(items);
  writeBacklog(root, cfg, items);
  return result ?? items;
}

const find = (items, id) => {
  const item = items.find((i) => i.id === id);
  if (!item) throw Object.assign(new Error('找不到這個需求'), { status: 404 });
  return item;
};

export function addItem(root, { title, detail }) {
  const t = clean(title, 200);
  if (!t) throw Object.assign(new Error('請輸入需求標題'), { status: 400 });
  return mutate(root, (items) => {
    const now = new Date().toISOString();
    const item = { id: crypto.randomBytes(5).toString('hex'), title: t, detail: clean(detail, 20000), status: 'open', created_at: now, updated_at: now };
    items.push(item);
    return item;
  });
}

export function updateItem(root, id, patch) {
  return mutate(root, (items) => {
    const item = find(items, id);
    if (patch.title !== undefined) {
      const t = clean(patch.title, 200);
      if (!t) throw Object.assign(new Error('請輸入需求標題'), { status: 400 });
      item.title = t;
    }
    if (patch.detail !== undefined) item.detail = clean(patch.detail, 20000);
    if (patch.status !== undefined) {
      if (!BACKLOG_STATUSES.includes(patch.status)) throw Object.assign(new Error('狀態不正確'), { status: 400 });
      item.status = patch.status;
    }
    if (patch.feature !== undefined) item.feature = patch.feature;
    item.updated_at = new Date().toISOString();
    return item;
  });
}

export function deleteItem(root, id) {
  return mutate(root, (items) => {
    items.splice(items.indexOf(find(items, id)), 1);
  });
}

/** 依給定的 id 順序重排；沒列到的項目保持原順序接在後面。 */
export function reorderItems(root, ids) {
  if (!Array.isArray(ids)) throw Object.assign(new Error('ids 必須是陣列'), { status: 400 });
  return mutate(root, (items) => {
    const byId = new Map(items.map((i) => [i.id, i]));
    const ordered = ids.map((id) => byId.get(id)).filter(Boolean);
    const rest = items.filter((i) => !ids.includes(i.id));
    items.splice(0, items.length, ...ordered, ...rest);
  });
}

/** 起草 PRD 用的想法文字。 */
export function ideaFor(item) {
  return item.detail ? `${item.title}\n\n${item.detail}` : item.title;
}

export function getItem(root, id) {
  return find(readBacklog(root), id);
}

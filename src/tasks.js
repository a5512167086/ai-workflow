import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withLock, writeJson } from './home.js';

export const TASK_STATUSES = ['pending', 'in-progress', 'review', 'done', 'blocked', 'cancelled', 'deferred'];
export const tasksFile = root => path.join(root, '.aipipe', 'tasks.json');
const legacyFile = root => path.join(root, '.taskmaster', 'tasks', 'tasks.json');
const empty = () => ({ version: 1, currentTag: 'master', groups: {}, events: [] });

function loadStore(root) {
  if (fs.existsSync(tasksFile(root))) {
    const store = JSON.parse(fs.readFileSync(tasksFile(root), 'utf8'));
    if (store.version !== 1 || !store.groups || !store.currentTag) throw new Error('任務資料格式不支援');
    return store;
  }
  const store = empty();
  if (!fs.existsSync(legacyFile(root))) return store;
  const old = JSON.parse(fs.readFileSync(legacyFile(root), 'utf8'));
  store.groups = Array.isArray(old.tasks) ? { master: old } : old;
  const stateFile = path.join(root, '.taskmaster', 'state.json');
  if (fs.existsSync(stateFile)) store.currentTag = JSON.parse(fs.readFileSync(stateFile, 'utf8')).currentTag || 'master';
  store.events.push({ at: new Date().toISOString(), kind: 'import-task-master' });
  return store;
}

function mutate(root, change) {
  const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  return withLock(`tasks-${key}`, () => {
    const store = loadStore(root);
    const result = change(store);
    writeJson(tasksFile(root), store);
    return result;
  });
}

export const currentTag = root => loadStore(root).currentTag;
export function readTasks(root) {
  const store = loadStore(root);
  return store.groups[store.currentTag]?.tasks || [];
}

export function tagName(date, slug, existing = []) {
  const base = `f-${date.replaceAll('-', '')}-${slug}`.replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/-+$/, '');
  let name = base;
  for (let i = 2; existing.includes(name); i++) name = `${base}-${i}`;
  return name;
}

export async function useFeatureTag(root, cfg, slug) {
  return mutate(root, store => {
    if (store.groups[store.currentTag]?.tasks?.length) {
      store.currentTag = tagName(new Date().toISOString().slice(0, 10), slug, Object.keys(store.groups));
    }
    return store.currentTag;
  });
}

function flatten(tasks) {
  return tasks.flatMap(task => [task, ...(task.subtasks || []).map(sub => ({
    ...sub, id: `${task.id}.${sub.id}`, parent: task,
    dependencies: (sub.dependencies || []).map(dep => String(dep).includes('.') ? String(dep) : `${task.id}.${dep}`),
  }))]);
}

function normalize(tasks, preserveStatus = false) {
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('任務清單是空的');
  const ids = new Set();
  function clean(task, index, sub = false) {
    if (!task || typeof task.title !== 'string' || !task.title.trim()) throw new Error('任務缺少 title');
    const id = task.id ?? index + 1;
    if (!Number.isSafeInteger(id) || id < 1) throw new Error('任務 id 必須是正整數');
    if (!sub && ids.has(String(id))) throw new Error(`重複任務 id：${id}`);
    if (!sub) ids.add(String(id));
    if (task.dependencies !== undefined && !Array.isArray(task.dependencies)) throw new Error(`任務 ${id} 的 dependencies 必須是陣列`);
    if (task.skills !== undefined && (!Array.isArray(task.skills) || task.skills.some(s => typeof s !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s)))) throw new Error(`任務 ${id} 的 skills 格式錯誤`);
    const status = preserveStatus ? (task.status || 'pending') : 'pending';
    if (!TASK_STATUSES.includes(status)) throw new Error(`任務 ${id} 狀態不正確`);
    return { ...task, id, title: task.title.trim(), description: String(task.description || ''), details: String(task.details || ''),
      testStrategy: String(task.testStrategy || ''), priority: ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium',
      dependencies: [...new Set((task.dependencies || []).map(String))], status, skills: task.skills || [],
      subtasks: sub ? [] : (task.subtasks || []).map((t, i) => clean(t, i, true)) };
  }
  const normalized = tasks.map((task, i) => clean(task, i));
  const all = flatten(normalized);
  const graph = new Map();
  for (const task of all) {
    if (graph.has(String(task.id))) throw new Error(`重複任務 id：${task.id}`);
    graph.set(String(task.id), task.dependencies.map(String));
  }
  // A parent completes only when all children complete; include this in cycle detection.
  for (const task of normalized) {
    graph.get(String(task.id)).push(...task.subtasks.map(sub => `${task.id}.${sub.id}`));
    for (const sub of task.subtasks) graph.get(`${task.id}.${sub.id}`).push(...task.dependencies.map(String));
  }
  const visited = new Set(), visiting = new Set();
  function visit(id) {
    if (!graph.has(id)) throw new Error(`不存在的任務依賴：${id}`);
    if (visiting.has(id)) throw new Error(`任務有循環依賴：${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dep of graph.get(id)) visit(dep);
    visiting.delete(id); visited.add(id);
  }
  for (const id of graph.keys()) visit(id);
  return normalized;
}

export const validateTasks = tasks => normalize(tasks);

export function writeTasks(root, tasks, tag = currentTag(root), metadata = {}) {
  const clean = normalize(tasks);
  return mutate(root, store => {
    if (!/^[a-zA-Z0-9_-]+$/.test(tag) || ['__proto__', 'constructor', 'prototype'].includes(tag)) throw new Error('任務群組名稱格式錯誤');
    store.groups[tag] = { tasks: clean, metadata: { ...metadata, updated: new Date().toISOString() } };
    store.currentTag = tag;
    store.events.push({ kind: 'generate', tag, at: new Date().toISOString(), count: clean.length });
    return clean;
  });
}

export function findTask(root, id) {
  return flatten(readTasks(root)).find(task => String(task.id) === String(id)) || null;
}

function eligible(task, all) {
  const done = new Set(all.filter(t => t.status === 'done' || t.status === 'completed').map(t => String(t.id)));
  return task.dependencies.every(dep => done.has(String(dep))) && (!task.parent || task.parent.dependencies.every(dep => done.has(String(dep))));
}

export async function nextTaskId(root) {
  const current = readTasks(root);
  if (!current.length) return null;
  const tasks = normalize(current, true);
  const all = flatten(tasks);
  const priority = { high: 0, medium: 1, low: 2 };
  const candidates = all.filter(t => !t.subtasks?.length && ['pending', 'in-progress', 'review'].includes(t.status)
    && (!t.parent || ['pending', 'in-progress', 'review'].includes(t.parent.status)) && eligible(t, all));
  candidates.sort((a, b) => Number(b.status !== 'pending') - Number(a.status !== 'pending')
    || priority[a.priority] - priority[b.priority] || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  return candidates.length ? String(candidates[0].id) : null;
}

export async function setStatus(root, cfg, id, status) {
  if (!TASK_STATUSES.includes(status)) throw new Error(`無效任務狀態：${status}`);
  return mutate(root, store => {
    const tasks = normalize(store.groups[store.currentTag]?.tasks || [], true);
    store.groups[store.currentTag].tasks = tasks;
    const all = flatten(tasks);
    const target = all.find(t => String(t.id) === String(id));
    if (!target) throw new Error(`找不到任務 ${id}`);
    if (['in-progress', 'review', 'done'].includes(status) && !eligible(target, all)) throw new Error(`任務 ${id} 的依賴尚未完成`);
    if (status === 'done' && target.subtasks?.some(t => t.status !== 'done')) throw new Error('子任務尚未完成');
    const actual = target.parent ? target.parent.subtasks.find(t => `${target.parent.id}.${t.id}` === String(id)) : target;
    const from = actual.status;
    if (status === 'done' && from !== 'review' && from !== 'done') throw new Error('任務需先進入 review 再完成');
    actual.status = status;
    if (target.parent) target.parent.status = target.parent.subtasks.every(t => t.status === 'done') ? 'done' : 'in-progress';
    // Reopening a prerequisite would invalidate already completed dependent work.
    if (from === 'done' && status !== 'done') {
      const invalidated = new Set([String(id), ...(target.parent ? [String(target.parent.id)] : []),
        ...(target.subtasks || []).map(sub => `${id}.${sub.id}`)]);
      let changed;
      do {
        changed = false;
        for (const t of all) if (!invalidated.has(String(t.id)) && t.dependencies.some(dep => invalidated.has(String(dep)))) {
          if (t.status !== 'pending') throw new Error(`請先重設依賴此任務的 ${t.id}`);
          invalidated.add(String(t.id)); changed = true;
        }
      } while (changed);
      if (status === 'pending' && !target.parent) for (const sub of actual.subtasks) sub.status = 'pending';
    }
    store.events.push({ kind: 'status', tag: store.currentTag, id: String(id), from, to: status, at: new Date().toISOString() });
    return actual;
  });
}

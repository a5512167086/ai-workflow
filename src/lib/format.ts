import { CLAUDE_EFFORTS } from '@/lib/constants';
import type { ModelOptions, Provider, Snapshot, Task, TaskState, Column, Subtask } from '@/types/api';

/** AI 工作中的持續時間文字，例如「1 分 23 秒」；時間無效回傳空字串。 */
export function elapsedText(since?: string | null, now = Date.now()): string {
  const ms = since ? now - new Date(since).getTime() : Number.NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  if (s < 3600) return `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
  return `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 只接受字串；其他型別（物件、undefined…）當成空字串，避免 String(物件) 變成 "[object Object]"。 */
const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

export const tokenNumber = (value: unknown) => (typeof value === 'number' ? value.toLocaleString('zh-TW') : '未知');
export const usageTime = (value?: string | null) => (value ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '（台北）' : '未提供');
export const shortTime = (value?: string | null) => (value ? new Date(value).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '');
export const shortDate = (value?: string | null) => (value ? new Date(value).toLocaleDateString('zh-TW') : '');
export const dateTime = (value?: string | null) => (value ? new Date(value).toLocaleString('zh-TW') : '—');

/** 審查意見最後一個 VERDICT。 */
export function verdictOf(text: unknown): string {
  return [...textOf(text).matchAll(/VERDICT[\s*]*[:：][\s*]*([A-Z_]+)/gi)].at(-1)?.[1].toUpperCase() || '';
}
/** Codex 有時用自己的 P0–P3：P0/P1 算必須修正，P2/P3 算建議（與後端 only_suggestions 相同）。 */
export function reviewCounts(text: string) {
  const must = (text.match(/\[(必須修正|P0|P1)\]/g) || []).length;
  const suggest = (text.match(/\[(建議|P2|P3)\]/g) || []).length;
  return { must, suggest };
}

/** SKILL.md 最上面 YAML frontmatter 的頂層欄位（只為顯示，解析在後端）。 */
export function skillFrontmatter(text: unknown): [string, string][] {
  // 逐行找開頭的 --- 與下一個 ---（不用跨行的正規表示式，避免大量回溯）。
  const lines = textOf(text).replace(/^﻿/, '').split(/\r?\n/);
  if (lines[0] !== '---') return [];
  const end = lines.indexOf('---', 1);
  if (end < 0) return [];
  const fields: [string, string][] = [];
  for (const line of lines.slice(1, end)) {
    // 正規表示式只比對鍵名；值是冒號後面的其餘部分（避免 \s*(.*) 這種會回溯的寫法）。
    const key = /^[A-Za-z_][\w-]*:/.exec(line);
    const value = key ? line.slice(key[0].length).trimStart() : '';
    if (key) fields.push([key[0].slice(0, -1), /^[|>][-+]?$/.test(value) ? '' : value]);
    else if (fields.length && line.trim() && line.trimStart() !== line) {
      // 縮排的下一行是上一個欄位的續行
      const last = fields.at(-1)!;
      last[1] = `${last[1]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** 游標前面是不是訊息開頭的 `/技能` 片段（前面可以已經有其他 `/技能 `）；是就回傳要替換的範圍。 */
export function skillCommandToken(text: string, caret: number): { start: number; end: number; query: string } | null {
  const before = text.slice(0, caret);
  const match = /^\s*(?:\/[a-z0-9-]+\s+)*\/([a-z0-9-]*)$/.exec(before);
  return match ? { start: before.length - match[1].length - 1, end: caret, query: match[1] } : null;
}

/** 這個模型支援的推理強度。Claude：CLI 回報了就用它的（可能是空的），否則列出全部；Codex：找該模型或預設模型。 */
export function effortsFor(options: ModelOptions | null | undefined, provider: Provider, model: string): string[] {
  if (provider === 'claude') return options?.claude?.models?.find((m) => m.id === model)?.efforts ?? CLAUDE_EFFORTS;
  const list = options?.codex?.models || [];
  const found = list.find((m) => m.id === model) || list.find((m) => m.default);
  return found?.efforts?.length ? found.efforts : [...new Set(list.flatMap((m) => m.efforts || []))];
}

// ---------- 任務看板 ----------
export type FlatTask = (Task | Subtask) & { id: string; dependencies?: (string | number)[] };

export function childTasks(task: Task): FlatTask[] {
  return (task.subtasks || []).map((sub) => ({
    ...sub,
    id: `${task.id}.${sub.id}`,
    dependencies: [
      ...(task.dependencies || []),
      ...(sub.dependencies || []).map((id) => (String(id).includes('.') ? String(id) : `${task.id}.${id}`)),
    ],
  }));
}

/** 流程自己記錄的階段優先；沒跑過的任務才看任務引擎的狀態。 */
export function column(task: { status?: string }, ts?: TaskState | null): Column {
  const phase = ts?.phase;
  if (phase === 'awaiting_test') return 'test';
  if (phase === 'reviewing') return 'review';
  if (phase === 'implementing' || phase === 'stuck') return 'doing';
  if (phase === 'done' || task.status === 'done') return 'done';
  if (task.status === 'review') return 'review';
  if (task.status === 'in-progress') return 'doing';
  return 'todo';
}

export type BoardFilter = 'all' | 'attention' | 'blocked' | 'active' | 'done';
export interface BoardFacts {
  all: FlatTask[];
  stateFor: (task: { id: string | number }) => TaskState;
  done: Set<string>;
  unmet: (task: { dependencies?: (string | number)[] }) => (string | number)[];
  attention: (task: FlatTask | Task) => boolean;
  matches: (task: FlatTask | Task) => boolean;
  visible: Task[];
  filtered: boolean;
  counts: Record<Column, number>;
}

/** 搜尋與篩選只影響顯示；完成度及總數以完整資料計算。 */
export function boardFacts(snap: Pick<Snapshot, 'tasks' | 'state'>, query: string, filter: BoardFilter): BoardFacts {
  const all: FlatTask[] = snap.tasks.flatMap((task) => [task as FlatTask, ...childTasks(task)]);
  const stateFor = (task: { id: string | number }): TaskState => snap.state.tasks[String(task.id)] || {};
  const done = new Set(all.filter((task) => column(task, stateFor(task)) === 'done').map((task) => String(task.id)));
  const unmet = (task: { dependencies?: (string | number)[] }) => (task.dependencies || []).filter((id) => !done.has(String(id)));
  const attention = (task: FlatTask | Task) => stateFor(task).phase === 'stuck' || task.status === 'blocked' || column(task, stateFor(task)) === 'test';
  const q = query.trim().toLocaleLowerCase();
  const matches = (task: FlatTask | Task) => {
    const state = stateFor(task), stage = column(task, state);
    const text = `${task.id} ${task.title || ''} ${task.description || ''} ${state.step || ''}`.toLocaleLowerCase();
    return (!q || text.includes(q)) && (filter === 'all'
      || (filter === 'attention' && attention(task))
      || (filter === 'blocked' && stage !== 'done' && unmet(task).length > 0)
      || (filter === 'active' && ['doing', 'review'].includes(stage))
      || (filter === 'done' && stage === 'done'));
  };
  const counts: Record<Column, number> = { todo: 0, doing: 0, review: 0, test: 0, done: 0 };
  for (const t of snap.tasks) counts[column(t, stateFor(t))]++;
  return {
    all, stateFor, done, unmet, attention, matches,
    visible: snap.tasks.filter((task) => [task, ...childTasks(task)].some(matches)),
    filtered: !!q || filter !== 'all',
    counts,
  };
}

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * 從還沒寫完的 JSON 文字裡取出某個字串欄位目前已經寫出來的部分（需求釐清的回覆是 {"message": "...", "ready": …}）。
 * 欄位還沒出現回傳 null；字串還沒結束就回傳目前為止的內容。處理 \n、\"、\\、\uXXXX 等跳脫。
 */
export function partialJsonString(text: string, field: string): string | null {
  const key = new RegExp(String.raw`"${field}"\s*:\s*"`).exec(text);
  if (key?.index === undefined) return null;
  let out = '';
  for (let i = key.index + key[0].length; i < text.length; i++) {
    const c = text[i];
    if (c === '"') return out;
    if (c !== '\\') { out += c; continue; }
    const next = text[i + 1];
    if (next === undefined) return out; // 跳脫字元還沒寫完
    const simple: Record<string, string> = { n: '\n', t: '\t', r: '', '"': '"', '\\': '\\', '/': '/', b: '', f: '' };
    if (next === 'u') {
      const hex = text.slice(i + 2, i + 6);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) return out;
      out += String.fromCodePoint(Number.parseInt(hex, 16));
      i += 5;
    } else {
      out += simple[next] ?? next;
      i += 1;
    }
  }
  return out;
}

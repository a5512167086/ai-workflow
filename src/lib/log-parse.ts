// 把流程 log 文字整理成可展開的區塊（像 Claude Code：每段 AI 工作包成一個區塊）。純函式，LogTree 元件與測試共用。

export interface LogLine { kind: 'line'; time: string; text: string }
export interface LogHeader { kind: 'header'; time: string; text: string }
export interface LogGroup {
  kind: 'agent' | 'check';
  title: string;
  provider?: string;
  mode?: string;
  time: string;
  status: 'running' | 'done' | 'error';
  lines: LogLine[];
  secs?: number;
  error?: string;
  result?: string;
  end?: string;
}
export type LogItem = LogLine | LogHeader | LogGroup;

const TIME_RE = /^\[(\d\d:\d\d:\d\d)\] ?([\s\S]*)$/;
const AGENT_START_RE = /^── (.+?)：(claude|codex)（(可編輯|唯讀)）開始(?:，session (\S+))? ──$/;
const AGENT_END_RE = /^── (.+?)：(完成|失敗)（(\d+)s）\s?([\s\S]*?) ──$/;
const CHECK_END_RE = /^(build|lint|test)：(通過|失敗[\s\S]*)$/;
const HEADER_RE = /^═══ (.+) ═══$/;

/** AI 工作的結束標記；對上就把結果寫進區塊並回傳 true。 */
function finishAgent(group: LogGroup, msg: string, time: string): boolean {
  const s = AGENT_END_RE.exec(msg);
  if (!s) return false;
  Object.assign(group, { status: s[2] === '完成' ? 'done' : 'error', secs: Number(s[3]), error: s[4], end: time });
  return true;
}

/** 驗證指令的結果行；對上就把結果寫進區塊並回傳 true。 */
function finishCheck(group: LogGroup, msg: string, time: string): boolean {
  const s = CHECK_END_RE.exec(msg);
  if (!s) return false;
  Object.assign(group, { status: s[2] === '通過' ? 'done' : 'error', result: `${s[1]}：${s[2]}`, end: time });
  return true;
}

/** 處理一行 log，回傳處理後「目前開著的區塊」。 */
function consumeLine(items: LogItem[], group: LogGroup | null, time: string, msg: string): LogGroup | null {
  const start = AGENT_START_RE.exec(msg);
  if (start) {
    const next: LogGroup = { kind: 'agent', title: start[1], provider: start[2], mode: start[3], time, status: 'running', lines: [] };
    items.push(next);
    return next;
  }
  if (group?.kind === 'agent' && finishAgent(group, msg, time)) return null;
  if (!group && msg.startsWith('$ ')) {
    const next: LogGroup = { kind: 'check', title: msg.slice(2), time, status: 'running', lines: [] };
    items.push(next);
    return next;
  }
  if (group?.kind === 'check' && finishCheck(group, msg, time)) return null;
  const header = HEADER_RE.exec(msg);
  if (header) {
    items.push({ kind: 'header', text: header[1], time });
    return null;
  }
  const line: LogLine = { kind: 'line', time, text: msg };
  if (group) group.lines.push(line);
  else items.push(line);
  return group;
}

/** 區塊：AI 工作（── 標記 ── 開始／完成）、驗證指令（$ cmd → 通過／失敗）、任務標題（═══ ═══）與零散的行。 */
export function parseLog(text: string | null | undefined): LogItem[] {
  const items: LogItem[] = [];
  let group: LogGroup | null = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const m = TIME_RE.exec(raw);
    group = consumeLine(items, group, m ? m[1] : '', m ? m[2] : raw);
  }
  return items;
}

/** 區塊裡的行：🔧 開頭是工具呼叫，其餘連續的文字行合併成一段。 */
export type LogSegment = { kind: 'tool'; name: string; arg: string } | { kind: 'text'; text: string; warn: boolean };
/** 「🔧 名稱 參數」這種工具呼叫行（名稱是第一段非空白，參數是之後的全部）。 */
function toolCall(line: string): { name: string; arg: string } | null {
  if (!line.startsWith('🔧 ')) return null;
  const rest = line.slice('🔧 '.length);
  const space = rest.search(/\s/);
  if (space === 0 || !rest) return null;
  return space < 0 ? { name: rest, arg: '' } : { name: rest.slice(0, space), arg: rest.slice(space + 1) };
}

export function segmentLines(lines: LogLine[]): LogSegment[] {
  const out: LogSegment[] = [];
  let text: Extract<LogSegment, { kind: 'text' }> | null = null;
  for (const l of lines) {
    const tool = toolCall(l.text);
    if (tool) {
      text = null;
      out.push({ kind: 'tool', ...tool });
    } else if (!text) {
      text = { kind: 'text', text: l.text, warn: l.text.startsWith('⚠') || l.text.startsWith('✖') };
      out.push(text);
    } else text.text += `\n${l.text}`;
  }
  return out;
}

export function groupKey(item: LogGroup, index: number) {
  return `${item.time}|${item.title}|${index}`;
}

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

/** 區塊：AI 工作（── 標記 ── 開始／完成）、驗證指令（$ cmd → 通過／失敗）、任務標題（═══ ═══）與零散的行。 */
export function parseLog(text: string | null | undefined): LogItem[] {
  const items: LogItem[] = [];
  let group: LogGroup | null = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\[(\d\d:\d\d:\d\d)\] ?([\s\S]*)$/);
    const time = m ? m[1] : '';
    const msg = m ? m[2] : raw;
    let s: RegExpMatchArray | null;
    if ((s = msg.match(/^── (.+?)：(claude|codex)（(可編輯|唯讀)）開始(?:，session (\S+))? ──$/))) {
      group = { kind: 'agent', title: s[1], provider: s[2], mode: s[3], time, status: 'running', lines: [] };
      items.push(group);
    } else if (group?.kind === 'agent' && (s = msg.match(/^── (.+?)：(完成|失敗)（(\d+)s）\s?([\s\S]*?) ──$/))) {
      Object.assign(group, { status: s[2] === '完成' ? 'done' : 'error', secs: Number(s[3]), error: s[4], end: time });
      group = null;
    } else if (!group && msg.startsWith('$ ')) {
      group = { kind: 'check', title: msg.slice(2), time, status: 'running', lines: [] };
      items.push(group);
    } else if (group?.kind === 'check' && (s = msg.match(/^(build|lint|test)：(通過|失敗[\s\S]*)$/))) {
      Object.assign(group, { status: s[2] === '通過' ? 'done' : 'error', result: `${s[1]}：${s[2]}`, end: time });
      group = null;
    } else if ((s = msg.match(/^═══ (.+) ═══$/))) {
      group = null;
      items.push({ kind: 'header', text: s[1], time });
    } else {
      const line: LogLine = { kind: 'line', time, text: msg };
      if (group) group.lines.push(line);
      else items.push(line);
    }
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

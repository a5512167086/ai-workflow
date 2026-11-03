import { describe, expect, test } from 'vitest';
import { parseLog, segmentLines, type LogGroup } from '@/lib/log-parse';

const LOG = `[10:00:00] ═══ 任務 1：匯出 API ═══
[10:00:02] ── 實作：claude（可編輯）開始，session abc ──
[10:00:05] 🔧 Read src/a.ts
[10:00:06] 🔧 Edit src/a.ts
[10:00:07] 寫完了
[10:01:30] ── 實作：完成（88s） ──
[10:01:31] $ npm test
[10:01:40] PASS a.test.ts
[10:01:50] test：通過
[10:02:00] ── 審查：codex（唯讀）開始 ──
[10:02:10] ⚠ 問題
[10:02:20] ── 審查：失敗（10s） 逾時 ──
[10:02:21] $ npm run lint
[10:02:25] lint：失敗（2 個錯誤）
[10:02:30] 零散的一行`;

describe('parseLog', () => {
  test('分出標題、AI 區塊（完成／失敗）、指令區塊（通過／失敗）與零散的行', () => {
    const items = parseLog(LOG);
    expect(items.map((i) => i.kind)).toEqual(['header', 'agent', 'check', 'agent', 'check', 'line']);
    const [header, impl, test1, review, lint, stray] = items;
    expect(header).toMatchObject({ kind: 'header', text: '任務 1：匯出 API', time: '10:00:00' });
    expect(impl).toMatchObject({ kind: 'agent', title: '實作', provider: 'claude', mode: '可編輯', status: 'done', secs: 88, end: '10:01:30' });
    expect((impl as LogGroup).lines.map((l) => l.text)).toEqual(['🔧 Read src/a.ts', '🔧 Edit src/a.ts', '寫完了']);
    expect(test1).toMatchObject({ kind: 'check', title: 'npm test', status: 'done', result: 'test：通過' });
    expect((test1 as LogGroup).lines).toHaveLength(1);
    expect(review).toMatchObject({ kind: 'agent', provider: 'codex', mode: '唯讀', status: 'error', secs: 10, error: '逾時' });
    expect(lint).toMatchObject({ kind: 'check', status: 'error', result: 'lint：失敗（2 個錯誤）' });
    expect(stray).toMatchObject({ kind: 'line', text: '零散的一行', time: '10:02:30' });
  });

  test('還沒結束的區塊是執行中；沒有時間戳的行也能解析；空字串沒有項目', () => {
    const items = parseLog('── 實作：claude（可編輯）開始 ──\n還在跑');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'agent', status: 'running', time: '' });
    expect((items[0] as LogGroup).lines[0].text).toBe('還在跑');
    expect(parseLog('')).toEqual([]);
    expect(parseLog(null)).toEqual([]);
  });

  test('segmentLines：工具行拆成名稱與參數，連續文字合併，⚠ 標為警告', () => {
    const group = parseLog(LOG)[3] as LogGroup;
    const segs = segmentLines([...group.lines, { kind: 'line', time: '', text: '第二行' }]);
    expect(segs).toEqual([{ kind: 'text', text: '⚠ 問題\n第二行', warn: true }]);
    const tools = segmentLines((parseLog(LOG)[1] as LogGroup).lines);
    expect(tools).toEqual([
      { kind: 'tool', name: 'Read', arg: 'src/a.ts' },
      { kind: 'tool', name: 'Edit', arg: 'src/a.ts' },
      { kind: 'text', text: '寫完了', warn: false },
    ]);
    expect(tools.filter((s) => s.kind === 'tool')).toHaveLength(2);
  });
});

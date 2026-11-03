import { describe, expect, test } from 'vitest';
import { boardFacts, childTasks, column, effortsFor, elapsedText, reviewCounts, skillCommandToken, skillFrontmatter, verdictOf } from '@/lib/format';
import type { ModelOptions, Snapshot } from '@/types/api';

describe('format', () => {
  test('elapsedText：秒、分、時；無效或未來的時間回傳空字串', () => {
    const now = Date.parse('2026-11-03T10:00:00Z');
    expect(elapsedText('2026-11-03T09:59:30Z', now)).toBe('30 秒');
    expect(elapsedText('2026-11-03T09:58:37Z', now)).toBe('1 分 23 秒');
    expect(elapsedText('2026-11-03T07:30:00Z', now)).toBe('2 小時 30 分');
    expect(elapsedText('2026-11-03T11:00:00Z', now)).toBe('');
    expect(elapsedText('not a date', now)).toBe('');
    expect(elapsedText(null)).toBe('');
  });

  test('verdictOf 取最後一個 VERDICT；reviewCounts 計入 Codex 的 P0–P3', () => {
    expect(verdictOf('VERDICT: REVISE\n…\n**VERDICT**: PASS')).toBe('PASS');
    expect(verdictOf('verdict：approve')).toBe('APPROVE');
    expect(verdictOf('')).toBe('');
    expect(reviewCounts('[必須修正] a\n[P0] b\n[P1] c\n[建議] d\n[P3] e')).toEqual({ must: 3, suggest: 2 });
  });

  test('skillFrontmatter 解析頂層欄位與接續行；沒有 frontmatter 回傳空陣列', () => {
    expect(skillFrontmatter('﻿---\nname: my-skill\ndescription: >-\n  多行\n  說明\nallowed-tools: Bash\n---\n本文')).toEqual([
      ['name', 'my-skill'], ['description', '多行 說明'], ['allowed-tools', 'Bash'],
    ]);
    expect(skillFrontmatter('# 沒有 frontmatter')).toEqual([]);
  });

  test('skillCommandToken 只認訊息開頭的 /，中間的路徑不算', () => {
    expect(skillCommandToken('/gri', 4)).toEqual({ start: 0, end: 4, query: 'gri' });
    expect(skillCommandToken('/grill-me /to', 13)).toEqual({ start: 10, end: 13, query: 'to' });
    expect(skillCommandToken('看 /src/app.js', 14)).toBeNull();
    expect(skillCommandToken('/grill-me 我想做', 12)).toBeNull();
  });

  test('effortsFor：Claude 依 CLI 回報、沒有就全部；Codex 找該模型或預設模型', () => {
    const options: ModelOptions = {
      claude: { models: [{ id: 'opus', name: 'Opus', efforts: ['low', 'high'] }, { id: 'haiku', name: 'Haiku', efforts: [] }] },
      codex: { models: [{ id: 'gpt', name: 'gpt', efforts: ['low', 'medium'], default: true }, { id: 'mini', name: 'mini', efforts: ['low'] }] },
    };
    expect(effortsFor(options, 'claude', 'opus')).toEqual(['low', 'high']);
    expect(effortsFor(options, 'claude', 'haiku')).toEqual([]);
    expect(effortsFor(options, 'claude', 'unknown')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(null, 'claude', 'opus')).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(effortsFor(options, 'codex', 'mini')).toEqual(['low']);
    expect(effortsFor(options, 'codex', '')).toEqual(['low', 'medium']);
    expect(effortsFor(null, 'codex', '')).toEqual([]);
  });

  test('column：流程階段優先於任務引擎狀態', () => {
    expect(column({ status: 'pending' }, { phase: 'awaiting_test' })).toBe('test');
    expect(column({ status: 'pending' }, { phase: 'stuck' })).toBe('doing');
    expect(column({ status: 'pending' }, { phase: 'reviewing' })).toBe('review');
    expect(column({ status: 'done' }, {})).toBe('done');
    expect(column({ status: 'review' }, null)).toBe('review');
    expect(column({ status: 'in-progress' })).toBe('doing');
    expect(column({ status: 'blocked' })).toBe('todo');
  });

  test('boardFacts：搜尋與篩選只影響顯示、總數不變，依賴完成包含子任務', () => {
    const snap: Pick<Snapshot, 'tasks' | 'state'> = {
      tasks: [
        { id: 1, title: '登入', status: 'done', subtasks: [{ id: 1, title: '表單', status: 'done' }, { id: 2, title: '驗證', status: 'pending' }] },
        { id: 2, title: '報表', status: 'pending', dependencies: [1, '1.2'] },
        { id: 3, title: '通知', status: 'pending', dependencies: [1] },
      ],
      state: { prd: { status: 'approved', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: { '3': { phase: 'stuck', error: '卡住' } } },
    };
    expect(childTasks(snap.tasks[0]).map((t) => [t.id, t.dependencies])).toEqual([['1.1', []], ['1.2', []]]);
    const all = boardFacts(snap, '', 'all');
    expect(all.filtered).toBe(false);
    expect(all.visible).toHaveLength(3);
    expect(all.counts).toEqual({ todo: 1, doing: 1, review: 0, test: 0, done: 1 });
    expect([...all.done]).toEqual(['1', '1.1']);
    expect(all.unmet(snap.tasks[1])).toEqual(['1.2']);
    expect(all.unmet(snap.tasks[2])).toEqual([]);
    const blocked = boardFacts(snap, '', 'blocked');
    expect(blocked.filtered).toBe(true);
    expect(blocked.visible.map((t) => t.id)).toEqual([2]);
    expect(blocked.counts.done).toBe(1);
    expect(boardFacts(snap, '', 'attention').visible.map((t) => t.id)).toEqual([3]);
    // 搜尋子任務標題時父任務也顯示
    expect(boardFacts(snap, '驗證', 'all').visible.map((t) => t.id)).toEqual([1]);
    expect(boardFacts(snap, '沒有', 'all').visible).toHaveLength(0);
  });
});

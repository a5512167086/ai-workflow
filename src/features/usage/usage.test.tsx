import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { UsagePage, savedText } from './UsagePage';
import { useProject } from '@/stores/project';
import type { Snapshot, UsageSnapshot } from '@/types/api';

function usage(context?: { remainingPercent?: number; remainingTokens?: number; capacity?: number }): UsageSnapshot {
  return {
    totalTokens: 12345, measuredSessions: 3, unknownSessions: 1, savedEstimate: 4200,
    tokenSaving: { review_diff_filter: true, prd_excerpt: false, dedupe_skills: true, code_map: false, terse: { reviewer: true, fixer: true } },
    byStage: [{ stage: 'implement', sessions: 2, tokens: 8000, savedEstimate: 4000 }, { stage: 'chat', sessions: 1, tokens: 2000 }],
    providers: [{ provider: 'claude', runtime: 'windows', tokens: 10000, latest: { label: '任務 1 實作', status: 'done', tokens: { inputTokens: 100, outputTokens: 20 }, context }, limits: { windows: [{ name: 'Current session', remainingPercent: 62.5, windowMinutes: 300, resetsText: '18:00' }], checkedAt: '2026-11-01T00:00:00Z' } }],
    recent: [{ label: '任務 1 實作', provider: 'claude', runtime: 'windows', status: 'done', tokens: { inputTokens: 100, outputTokens: 20, totalTokens: 120 }, savedEstimate: 50, terse: true }],
  };
}

function setup(u: UsageSnapshot) {
  const api = vi.fn(async () => u);
  useProject.setState({ api: api as never, snap: { usage: u, state: { prd: { status: 'none', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} } } as unknown as Snapshot });
  return render(<MemoryRouter><UsagePage /></MemoryRouter>);
}

describe('用量', () => {
  it('顯示估計省下的 tokens、目前的節省開關與依階段的用量', () => {
    setup(usage());
    expect(screen.getByText('4,200')).toBeInTheDocument();
    expect(screen.getByText('開・審查略過 lockfile')).toBeInTheDocument();
    expect(screen.getByText('關・只附相關 PRD')).toBeInTheDocument();
    expect(screen.getByText('開・精簡回覆（2 個角色）')).toBeInTheDocument();
    const row = screen.getByText('實作').closest('tr')!;
    expect(row).toHaveTextContent('2');
    expect(row).toHaveTextContent('8,000');
    expect(row).toHaveTextContent('80%');
    expect(row).toHaveTextContent('4,000');
    expect(screen.getByText('12,345')).toBeInTheDocument();
    expect(screen.getByText(/62\.5%/)).toBeInTheDocument();
    expect(savedText({ label: 'x', provider: 'claude', runtime: 'w', status: 'done', savedEstimate: 50, terse: true })).toBe('50（精簡回覆）');
    expect(savedText({ label: 'x', provider: 'claude', runtime: 'w', status: 'done' })).toBe('—');
  });

  it('未知 context 隱藏，已有數據才顯示', () => {
    const { unmount } = setup(usage());
    expect(screen.queryByText(/context 剩餘/)).not.toBeInTheDocument();
    unmount();
    setup(usage({ remainingPercent: 71.25, remainingTokens: 142000, capacity: 200000 }));
    expect(screen.getByText(/context 剩餘/)).toBeInTheDocument();
    expect(screen.getByText(/71\.3% · 142,000 \/ 200,000 tokens（CLI 回報）/)).toBeInTheDocument();
  });
});

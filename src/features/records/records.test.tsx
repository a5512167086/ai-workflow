import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { RecordsPage, logScopes, archiveRounds } from './RecordsPage';
import { useProject } from '@/stores/project';
import type { Snapshot } from '@/types/api';

function snapshot(): Snapshot {
  return {
    root: 'C:\\code\\app', dataDir: 'C:\\data', project: { id: '0123456789', name: 'app' },
    config: { mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'x/', roles: {}, models: {}, runtime: {}, feature: '測試功能', commands: {}, context_files: [] },
    runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null,
    prd: '# PRD 目前', tasks: [{ id: 3, title: '第三' }, { id: 1, title: '第一', status: 'done' }, { id: 2, title: '第二' }], taskTag: 't', taskRevision: 'r1', taskReferences: null,
    usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
    state: { prd: { status: 'approved', rounds: [], archive_dir: 'archive/2026-11-01-current' }, pipeline: { status: 'idle' }, control: {}, tasks: { '1': { phase: 'done', step: '人工測試通過' } } },
    guards: {},
  };
}

function setup(api: ReturnType<typeof vi.fn>, extra: Partial<ReturnType<typeof useProject.getState>> = {}) {
  useProject.setState({ id: '0123456789', snap: snapshot(), api: api as never, logs: {}, logsFull: new Set(), rounds: [], ...extra });
  return render(<MemoryRouter><RecordsPage /></MemoryRouter>);
}

// Radix 的分頁在 jsdom 裡要用 mousedown／focus 才會切換（user-event 的 click 不會）。
const pick = (tab: HTMLElement) => act(async () => { fireEvent.mouseDown(tab, { button: 0 }); fireEvent.focus(tab); });

describe('紀錄', () => {
  it('log 來源列出每個任務（依編號），固定來源在前，對話與技能的 log 不列入', () => {
    const scopes = logScopes(snapshot(), { 'chat-1': 'x', 'skill-a': 'y', 'task-9': 'z' });
    expect(scopes).toEqual(['runner', 'prd', 'tasks', 'task-3', 'task-1', 'task-2', 'process', 'task-9']);
  });

  it('封存的每輪紀錄從檔名推回種類與結論', () => {
    const list = archiveRounds([{ name: '1-draft-claude.md', text: 'a' }, { name: '1-review-codex-approve.md', text: 'b' }, { name: '2-user-feedback.md', text: 'c' }]);
    expect(list.map((r) => r.verdict)).toEqual(['', 'APPROVE', '']);
    expect(list[0].title).toMatch(/^初稿/);
    expect(list[2].title).toMatch(/^使用者意見/);
  });

  it('第一次選取來源時讀完整 log，封存清單從 /api/archive 讀取', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/archive') return { items: [{ name: '2026-10-20-old', feature: '舊功能', progress: { done: 2, total: 2 }, completed_at: '2026-10-21T00:00:00Z' }, { name: '2026-11-01-current', feature: '測試功能' }], dir: 'C:\\archive' };
      if (path === '/api/log/runner') return { text: '[10:00:00] 完整 log' };
      throw new Error(`unexpected ${path}`);
    });
    setup(api);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/log/runner'));
    await waitFor(() => expect(screen.getByText('完整 log')).toBeInTheDocument());
    // 目前功能核准後也會有封存，不重複列出。
    expect(screen.getByText('舊功能')).toBeInTheDocument();
    expect(within(screen.getByRole('list', { name: '功能紀錄' })).getAllByText('測試功能')).toHaveLength(1);
    expect(screen.getByRole('combobox', { name: 'log 來源' })).toHaveTextContent('流程');
  });

  it('慢速封存回應不覆蓋後來選取的目前功能', async () => {
    let resolveArchive: (v: unknown) => void = () => {};
    const api = vi.fn(async (path: string) => {
      if (path === '/api/archive') return { items: [{ name: '2026-10-20-old', feature: '舊功能' }], dir: '' };
      if (path.startsWith('/api/log/')) return { text: '' };
      if (path === '/api/archive/2026-10-20-old') return new Promise((r) => { resolveArchive = r; });
      throw new Error(`unexpected ${path}`);
    });
    setup(api);
    const user = userEvent.setup();
    await screen.findByText('舊功能');
    await user.click(screen.getByText('舊功能'));
    expect(screen.getByText('讀取封存…')).toBeInTheDocument();
    await user.click(screen.getByText('測試功能'));
    resolveArchive({ name: '2026-10-20-old', path: 'C:\\old', meta: { feature: '舊功能' }, prd: '# 舊 PRD', rounds: [], tasks: [] });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText('舊 PRD')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('測試功能');
  });

  it('方向鍵只切換紀錄子頁；選封存時 Log 子頁換成 PRD', async () => {
    const api = vi.fn(async (path: string) => {
      if (path === '/api/archive') return { items: [{ name: '2026-10-20-old', feature: '舊功能' }], dir: '' };
      if (path.startsWith('/api/log/')) return { text: '' };
      if (path === '/api/archive/2026-10-20-old') return { name: '2026-10-20-old', path: 'C:\\old', meta: { feature: '舊功能', tm_tag: 'old' }, prd: '# 舊 PRD', rounds: [], tasks: [{ id: 1, title: '舊任務', status: 'done' }] };
      throw new Error(`unexpected ${path}`);
    });
    setup(api, { rounds: [{ round: 1, kind: 'review', provider: 'codex', verdict: 'APPROVE', text: 'ok' }] });
    const user = userEvent.setup();
    await screen.findByText('舊功能');
    const tabs = screen.getByRole('tablist', { name: '紀錄內容' });
    const prdTab = within(tabs).getByRole('tab', { name: 'PRD' });
    await pick(prdTab);
    expect(screen.getByText('PRD 目前')).toBeInTheDocument();
    // Radix 的方向鍵移動焦點用 setTimeout，要等一拍。
    await act(async () => { fireEvent.keyDown(prdTab, { key: 'ArrowRight' }); await new Promise((r) => setTimeout(r, 10)); });
    expect(within(tabs).getByRole('tab', { name: '每輪紀錄' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/第 1 輪・審查・Codex・APPROVE/)).toBeInTheDocument();
    // 回到 Log，再選封存：封存沒有 log，子頁自動換成 PRD。
    await pick(within(tabs).getByRole('tab', { name: 'Log' }));
    await user.click(screen.getByText('舊功能'));
    await screen.findByText('舊 PRD');
    expect(within(tabs).queryByRole('tab', { name: 'Log' })).not.toBeInTheDocument();
    expect(within(tabs).getByRole('tab', { name: 'PRD' })).toHaveAttribute('aria-selected', 'true');
    await pick(within(tabs).getByRole('tab', { name: '任務' }));
    expect(screen.getByText('舊任務')).toBeInTheDocument();
  });
});

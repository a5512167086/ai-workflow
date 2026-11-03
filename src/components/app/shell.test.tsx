import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@/lib/tauri', () => ({ invoke: vi.fn().mockResolvedValue({}), listen: vi.fn().mockResolvedValue(() => {}), inTauri: false, dialogs: {}, onFileDrop: vi.fn().mockResolvedValue(() => {}) }));

import { Sidebar } from '@/components/app/Sidebar';
import { StatusBar } from '@/components/app/StatusBar';
import { useShortcuts } from '@/hooks/use-shortcuts';
import { useProjects } from '@/stores/projects';
import { useProject } from '@/stores/project';
import { useBadges } from '@/stores/badges';
import { useUi } from '@/stores/ui';
import type { Snapshot } from '@/types/api';

const snap = {
  root: 'C:\\code\\my-app', dataDir: '', project: { id: '0123456789', name: 'my-app' },
  config: { mode: 'auto', roles: {}, models: {}, runtime: {}, max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: '' },
  runnerAlive: true, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '', tasks: [], taskTag: '', taskRevision: '', taskReferences: null,
  usage: { totalTokens: 1234, measuredSessions: 1, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
  state: { prd: { status: 'approved', rounds: [] }, pipeline: { status: 'running', reason: '任務 2 實作中' }, control: {}, tasks: {}, runner: { pid: 42, started_at: new Date().toISOString() } },
  guards: {},
} as unknown as Snapshot;

function Shell({ path }: { path: string }) {
  function Keys() { useShortcuts(); return null; }
  return (
    <MemoryRouter initialEntries={[path]}>
      <TooltipProvider>
        <Keys />
        <Routes>
          <Route path="/" element={<><Sidebar /><StatusBar /></>} />
          <Route path="/settings" element={<div>設定頁</div>} />
          <Route path="/p/:id/:view" element={<><Sidebar /><StatusBar /></>} />
        </Routes>
      </TooltipProvider>
    </MemoryRouter>
  );
}

describe('App 外框', () => {
  beforeEach(() => {
    useProjects.setState({ projects: [{ id: '0123456789', name: 'my-app', path: 'C:\\code\\my-app', status: 'running', attention: false }, { id: 'abcdef0123', name: 'api', path: 'C:\\code\\api', status: 'waiting', attention: true }], queue: { max: 1, running: [{ root: 'C:\\code\\my-app' }], waiting: [] }, loaded: true });
    useProject.setState({ id: '0123456789', snap });
    useBadges.setState({ badges: { prd: { text: '待核准', attention: true }, board: { text: '1/4' } } });
    useUi.setState({ paletteOpen: false, sidebarCollapsed: false });
  });

  it('側欄列出專案的八個畫面與徽章，專案切換器顯示目前專案', () => {
    render(<Shell path="/p/0123456789/board" />);
    const nav = screen.getByRole('navigation', { name: '專案畫面' });
    for (const label of ['專案對話', '需求待辦', 'PRD', '任務看板', '紀錄', '架構圖', '用量', 'Skills']) expect(within(nav).getByText(label)).toBeInTheDocument();
    expect(within(nav).getByText('待核准')).toBeInTheDocument();
    expect(within(nav).getByText('1/4')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /切換專案，目前：my-app/ })).toBeInTheDocument();
  });

  it('狀態列顯示流程狀態、原因、執行資訊、佇列、模式與 tokens', () => {
    render(<Shell path="/p/0123456789/board" />);
    const bar = screen.getByRole('contentinfo');
    expect(within(bar).getByText('執行中')).toBeInTheDocument();
    expect(within(bar).getByText('任務 2 實作中')).toBeInTheDocument();
    expect(within(bar).getByText(/pid 42/)).toBeInTheDocument();
    expect(within(bar).getByText(/執行中 1\/1：my-app/)).toBeInTheDocument();
    expect(within(bar).getByText('自動')).toBeInTheDocument();
    expect(within(bar).getByText(/Tokens 1,234/)).toBeInTheDocument();
  });

  it('總覽時狀態列顯示等你處理的專案數', () => {
    useProject.setState({ id: null, snap: null });
    render(<Shell path="/" />);
    expect(within(screen.getByRole('contentinfo')).getByText('1 個專案等你處理')).toBeInTheDocument();
  });

  it('Ctrl+K 開指令面板、Ctrl+B 收合側欄、Ctrl+, 到設定', () => {
    render(<Shell path="/p/0123456789/board" />);
    fireEvent.keyDown(window, { key: 'k', ctrlKey: true });
    expect(useUi.getState().paletteOpen).toBe(true);
    fireEvent.keyDown(window, { key: 'b', ctrlKey: true });
    expect(useUi.getState().sidebarCollapsed).toBe(true);
    fireEvent.keyDown(window, { key: ',', ctrlKey: true });
    expect(screen.getByText('設定頁')).toBeInTheDocument();
  });
});

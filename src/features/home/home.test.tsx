import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { HomePage } from './HomePage';
import { useProjects } from '@/stores/projects';
import type { ProjectSummary } from '@/types/api';

const apiMock = vi.fn();
const confirmMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});
vi.mock('@/components/app/confirm', () => ({ confirmDialog: (...args: unknown[]) => confirmMock(...args), promptDialog: vi.fn(), ConfirmHost: () => null }));
vi.mock('@/lib/tauri', () => ({ inTauri: false, dialogs: { pickFolder: vi.fn() }, invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));

const projects: ProjectSummary[] = [
  { id: '0123456789', name: 'my-app', path: 'C:\\code\\my-app', status: 'running', attention: false, feature: '報表匯出', progress: { done: 1, total: 4 } },
  { id: 'abcdef0123', name: 'api-server', path: 'C:\\code\\api-server', status: 'waiting', attention: true, reason: '任務 3 等待人工測試', progress: { done: 2, total: 5 } },
];

function renderHome(initial = '/') {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/p/:id" element={<p>專案頁</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('所有專案', () => {
  beforeEach(() => {
    apiMock.mockReset(); confirmMock.mockReset();
    apiMock.mockImplementation(async (path: string) => (path === '/api/projects' ? { projects, queue: { max: 1, running: [], waiting: [] } } : {}));
    useProjects.setState({ projects: [], loaded: false, error: null });
  });

  it('列出專案卡片與狀態，等你處理的專案排在最前面', async () => {
    renderHome();
    await waitFor(() => expect(screen.getAllByTestId('project-card')).toHaveLength(3));
    const cards = screen.getAllByTestId('project-card');
    // 第一張在「等你處理」區，是 api-server
    expect(within(cards[0]).getByText('api-server')).toBeInTheDocument();
    expect(within(cards[0]).getByText('等待人工測試')).toBeInTheDocument();
    expect(within(cards[0]).getByText('任務 3 等待人工測試')).toBeInTheDocument();
    expect(within(cards[1]).getByText('my-app')).toBeInTheDocument();
    expect(within(cards[1]).getByText('執行中')).toBeInTheDocument();
    expect(within(cards[1]).getByText('功能：報表匯出')).toBeInTheDocument();
    expect(within(cards[1]).getByText('1/4')).toBeInTheDocument();
  });

  it('移除先確認，確認後才呼叫 /api/projects/remove', async () => {
    const user = userEvent.setup();
    renderHome();
    await waitFor(() => expect(screen.getAllByTestId('project-card')).toHaveLength(3));
    confirmMock.mockResolvedValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'my-app 的更多動作' }));
    await user.click(await screen.findByRole('menuitem', { name: '從總覽移除' }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(apiMock).not.toHaveBeenCalledWith('/api/projects/remove', expect.anything());
    confirmMock.mockResolvedValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'my-app 的更多動作' }));
    await user.click(await screen.findByRole('menuitem', { name: '從總覽移除' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/projects/remove', { id: '0123456789' }));
  });

  it('加入專案：還不是 git repo 時先詢問，同意後帶 init 重試並開啟專案', async () => {
    const user = userEvent.setup();
    apiMock.mockImplementation(async (path: string, body?: { init?: boolean }) => {
      if (path === '/api/projects') return { projects, queue: { max: 1, running: [], waiting: [] } };
      if (path === '/api/projects/add') return body?.init ? { project: { id: 'ffffffffff', name: 'new-app' } } : { needs_init: true, path: 'C:\\code\\new-app' };
      return {};
    });
    confirmMock.mockResolvedValueOnce(true);
    renderHome('/?add=1');
    const input = await screen.findByLabelText('專案資料夾');
    await user.type(input, 'C:\\code\\new-app');
    await user.click(screen.getByRole('button', { name: '加入' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/projects/add', { path: 'C:\\code\\new-app', init: true }));
    expect(apiMock).toHaveBeenCalledWith('/api/projects/add', { path: 'C:\\code\\new-app', init: false });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('專案頁')).toBeInTheDocument();
  });

  it('沒有專案時顯示空狀態', async () => {
    apiMock.mockImplementation(async () => ({ projects: [], queue: { max: 1, running: [], waiting: [] } }));
    renderHome();
    expect(await screen.findByText('還沒有專案')).toBeInTheDocument();
  });
});

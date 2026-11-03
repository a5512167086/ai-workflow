import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { BacklogPage } from '@/features/backlog/BacklogPage';
import { useReferences } from '@/stores/references';
import { useBadges } from '@/stores/badges';
import { installBridge, makeItems, seedProject, emptyRequirements, renderApp, typeInto, type Routes } from '@/features/backlog/test-utils';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/tauri', () => ({
  inTauri: false,
  invoke: (...args: unknown[]) => bridge.invoke(...args),
  listen: vi.fn(async () => () => {}),
  dialogs: { pickFolder: vi.fn(), pickSkillFolder: vi.fn(), pickReferenceFiles: vi.fn(async () => []), pickReferenceFolder: vi.fn() },
  onFileDrop: vi.fn(async () => () => {}),
}));
vi.mock('@/components/app/confirm', () => ({ confirmDialog: vi.fn(async () => true), promptDialog: vi.fn(async () => null), ConfirmHost: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

function setup(extra: Routes = {}) {
  let items = makeItems();
  const routes: Routes = {
    'GET /api/backlog': () => ({ items, path: 'C:\\data\\backlog.json' }),
    'GET /api/references': { items: [] },
    'POST /api/backlog/reorder': (body: unknown) => { const ids = (body as { ids: string[] }).ids; items = ids.map((id) => items.find((i) => i.id === id)!); return { items }; },
    'POST /api/backlog/add': (body: unknown) => { const b = body as { title: string; detail: string; references: string[] }; const item = { id: 'new1', title: b.title, detail: b.detail, status: 'open' as const, references: b.references }; items = [...items, item]; return { item }; },
    'POST /api/backlog/delete': (body: unknown) => { items = items.filter((i) => i.id !== (body as { id: string }).id); return { items }; },
    'GET /api/requirements/new1': emptyRequirements(),
    'GET /api/requirements/bbb': emptyRequirements(),
    'POST /api/backlog/interview': (body: unknown) => ({ session: { id: 'req-1', status: 'done', messages: [{ role: 'assistant', text: `問題一（${(body as { id: string }).id}）`, at: '2026-11-03T00:00:00Z' }], requirementsReady: false }, confirmed: false, stale: false }),
    'GET /api/skills': { skills: [] },
    ...extra,
  };
  const { invoke, calls } = installBridge(routes);
  bridge.invoke.mockImplementation(invoke);
  return { calls };
}

beforeEach(() => {
  seedProject();
  useReferences.getState().reset();
  useBadges.getState().reset();
});

describe('需求待辦', () => {
  test('「釐清需求」開啟 Grill Me 會議並以該需求啟動，不直接起草 PRD', async () => {
    const { calls } = setup();
    renderApp(<BacklogPage />);
    const row = await screen.findByText('通知中心');
    const item = row.closest('li')!;
    await userEvent.click(within(item).getByRole('button', { name: /釐清需求：通知中心/ }));
    expect(await screen.findByText('Grill Me · 需求釐清')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/backlog/interview' && (c.body as { id: string }).id === 'bbb')).toBe(true));
    expect(calls.some((c) => c.path === '/api/backlog/draft')).toBe(false);
    expect(await screen.findByText('問題一（bbb）')).toBeInTheDocument();
  });

  test('防呆：已產生目前 PRD 的需求只能排序，按鈕停用並顯示原因；點擊也會被擋下', async () => {
    const { calls } = setup();
    renderApp(<BacklogPage />);
    const item = (await screen.findByText('鎖住的需求')).closest('li')!;
    for (const act of ['references', 'edit', 'delete', 'draft']) {
      const button = item.querySelector<HTMLButtonElement>(`[data-act="${act}"]`)!;
      expect(button).toBeDisabled();
      expect(button.dataset.guarded).toBe('1');
    }
    expect(within(item).getAllByText('這項需求已產生目前的 PRD，不能再修改').length).toBeGreaterThan(0);
    // 排序不受影響
    expect(item.querySelector<HTMLButtonElement>('[data-act="down"]')).toBeEnabled();
    // 就算畫面還沒更新被點到，也不會呼叫後端
    fireEvent.click(item.querySelector('[data-act="delete"]')!);
    expect(calls.some((c) => c.path === '/api/backlog/delete')).toBe(false);
    expect(screen.queryByText('Grill Me · 需求釐清')).not.toBeInTheDocument();
  });

  test('上／下按鈕送出新的順序，徽章顯示待辦數', async () => {
    const { calls } = setup();
    renderApp(<BacklogPage />);
    const item = (await screen.findByText('通知中心')).closest('li')!;
    await userEvent.click(within(item).getByRole('button', { name: /往上移：通知中心/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/reorder')?.body).toEqual({ ids: ['bbb', 'aaa', 'ccc'] }));
    const list = screen.getByRole('list', { name: '需求待辦清單，依優先順序' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')[0]).toHaveTextContent('通知中心'));
    expect(useBadges.getState().badges.backlog?.text).toBe('3');
  });

  test('新增需求會帶上草稿附件，新增後清掉草稿並開啟需求會議', async () => {
    const { calls } = setup();
    useReferences.getState().setDraft('backlog', ['ref-9']);
    renderApp(<BacklogPage />);
    await screen.findByText('通知中心');
    await typeInto(screen.getByLabelText('標題'), '匯出 CSV{Enter}');
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/add')?.body).toEqual({ title: '匯出 CSV', detail: '', references: ['ref-9'] }));
    expect(useReferences.getState().draft('backlog')).toEqual([]);
    expect(await screen.findByText('Grill Me · 需求釐清')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.path === '/api/backlog/interview' && (c.body as { id: string }).id === 'new1')).toBe(true));
    expect(screen.getByLabelText('標題')).toHaveValue('');
  });

  test('刪除會先確認，確認後呼叫後端並重讀', async () => {
    const { calls } = setup();
    renderApp(<BacklogPage />);
    const item = (await screen.findByText('深色模式')).closest('li')!;
    await userEvent.click(within(item).getByRole('button', { name: /刪除：深色模式/ }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/delete')?.body).toEqual({ id: 'ccc' }));
    await waitFor(() => expect(screen.queryByText('深色模式')).not.toBeInTheDocument());
  });
});

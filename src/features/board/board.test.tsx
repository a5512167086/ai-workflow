import { describe, expect, test } from 'vitest';
import { screen, waitFor, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardPage } from './BoardPage';
import { fakeApi, makeSnapshot, renderBoard, setupProject } from './test-utils';
import { useProject } from '@/stores/project';

describe('任務看板', () => {
  test('任務要先人工核准才能開始，核准後開始按鈕解鎖', async () => {
    const snap = makeSnapshot();
    const approvedSnap = makeSnapshot({ guards: { ...snap.guards, 'run.start': '' } }, { task_approval: { revision: 'r1' } });
    const api = setupProject(snap, fakeApi({
      '/api/tasks/approve': () => ({ ok: true }),
      '/api/state': () => approvedSnap,
    }));
    renderBoard(<BoardPage />);
    const start = screen.getByRole('button', { name: /開始/ });
    expect(start).toHaveAttribute('aria-disabled', 'true');
    const approve = screen.getByRole('button', { name: '檢視後核准任務' });
    expect(approve).toBeUsable();
    await userEvent.click(approve);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/tasks/approve' && (c.body as { revision: string }).revision === 'r1')).toBe(true));
    await waitFor(() => expect(screen.getByRole('button', { name: /開始/ })).toBeUsable());
    expect(screen.getByRole('button', { name: '任務已核准' })).toHaveAttribute('aria-disabled', 'true');
    expect(useProject.getState().snap?.state.task_approval?.revision).toBe('r1');
  });

  test('搜尋只影響顯示，欄位總數維持完整；依賴包含子任務完成狀態', async () => {
    setupProject(makeSnapshot());
    renderBoard(<BoardPage />);
    expect(screen.getByText('顯示 2 / 2 項主線任務')).toBeInTheDocument();
    // 任務 2 依賴子任務 1.1（已完成）
    const dep = screen.getByTitle('#1.1 已完成');
    expect(dep).toHaveTextContent('#1.1');
    await userEvent.type(screen.getByLabelText('搜尋任務'), '後續');
    expect(screen.getByText('顯示 1 / 2 項主線任務')).toBeInTheDocument();
    const todo = screen.getByRole('region', { name: '待辦' });
    expect(within(todo).getByRole('heading')).toHaveTextContent('1 / 1');
    const doing = screen.getByRole('region', { name: '進行中' });
    expect(within(doing).getByRole('heading')).toHaveTextContent('0 / 1');
    expect(within(doing).getByText('此欄沒有符合的任務')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '清除篩選' }));
    expect(screen.getByText('顯示 2 / 2 項主線任務')).toBeInTheDocument();
  });

  test('藍圖可切換，子任務可開啟詳情並在關閉後恢復焦點', async () => {
    setupProject(makeSnapshot());
    renderBoard(<BoardPage />);
    await userEvent.click(screen.getByRole('radio', { name: '任務藍圖' }));
    const child = screen.getByRole('button', { name: /#1\.1/ });
    await userEvent.click(child);
    expect(await screen.findByRole('heading', { name: '#1.1 子一' })).toBeInTheDocument();
    // 開啟檢視面板後畫布搬進分欄容器，重新查詢子任務列。
    expect(screen.getByRole('button', { name: /#1\.1/ })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: '關閉任務詳情' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: '#1.1 子一' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /#1\.1/ })));
  });

  test('點任務卡開啟檢視面板，Esc 會清掉選取並把焦點還給任務卡', async () => {
    setupProject(makeSnapshot());
    renderBoard(<BoardPage />);
    const card = screen.getByRole('button', { name: /#2/ });
    await userEvent.click(card);
    expect(await screen.findByRole('heading', { name: '#2 後續任務' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /#2/ })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('heading', { name: '#2 後續任務' })).not.toBeInTheDocument());
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /#2/ })));
    expect(screen.getByRole('button', { name: /#2/ })).toHaveAttribute('aria-pressed', 'false');
  });

  test('慢速任務詳情回應不覆蓋後來選取的任務', async () => {
    const snap = makeSnapshot();
    setupProject(snap, fakeApi({
      '/api/task/1': () => new Promise((resolve) => setTimeout(() => resolve({ id: '1', revision: 'r1', tag: 'tag', state: null, task: snap.tasks[0], checks: '', diff: '', implement: '', log: '', reviews: [] }), 150)),
    }));
    renderBoard(<BoardPage />);
    await userEvent.click(screen.getByRole('button', { name: /#1(?!\.)/ }));
    await userEvent.click(screen.getByRole('button', { name: /#2/ }));
    expect(await screen.findByRole('heading', { name: '#2 後續任務' })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 250));
    expect(screen.getByRole('heading', { name: '#2 後續任務' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: '#1 父任務' })).not.toBeInTheDocument();
  });

  test('沒有任務時顯示提示，看板徽章更新', () => {
    setupProject(makeSnapshot({ tasks: [] }));
    renderBoard(<BoardPage />);
    expect(screen.getByText('還沒有任務：先在 PRD 頁核准並產生任務')).toBeInTheDocument();
    expect(screen.getByText('需求釐清 → 你確認摘要 → PRD 交叉審查與人工核准 → 拆任務 → 你檢視並核准任務 → 執行與驗收')).toBeInTheDocument();
  });

  test('等待人工時「我測完了，繼續」變成主要按鈕並呼叫 run/continue', async () => {
    const api = setupProject(makeSnapshot({ guards: { 'run.start': '流程等待人工' } }, { pipeline: { status: 'waiting' } }));
    renderBoard(<BoardPage />);
    const cont = screen.getByRole('button', { name: '我測完了，繼續' });
    expect(cont).toBeUsable();
    expect(cont).toHaveAttribute('data-variant', 'default');
    expect(screen.getByRole('button', { name: /開始/ })).toHaveAttribute('data-variant', 'outline');
    await userEvent.click(cont);
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/run/continue')).toBe(true));
  });
});

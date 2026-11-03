import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { Toaster } from 'sonner';

vi.mock('@/lib/tauri', () => ({ invoke: vi.fn(), listen: vi.fn().mockResolvedValue(() => {}), inTauri: false, dialogs: {}, onFileDrop: vi.fn() }));

import { PrdErrorToast } from '@/features/prd/PrdErrorToast';
import { useProject } from '@/stores/project';
import type { Snapshot } from '@/types/api';

const ERROR = 'PRD 修訂時程序已結束（可能是 App 重新啟動或程序被關閉），已保留目前版本。';
const snapWith = (error: string, prdBusy = false) => ({
  prdBusy, state: { prd: { status: 'approved', error, rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} },
}) as unknown as Snapshot;

function setup(error: string) {
  const api = vi.fn().mockResolvedValue({ ok: true });
  useProject.setState({ id: '0123456789', api: api as never, snap: snapWith(error) });
  // 用 StrictMode 重現開發模式的掛載→卸載→再掛載。
  render(<StrictMode><MemoryRouter><Toaster closeButton /><PrdErrorToast /></MemoryRouter></StrictMode>);
  return api;
}

describe('PRD 錯誤通知', () => {
  beforeEach(() => useProject.setState({ id: null, snap: null }));

  it('有錯誤時跳出通知，按 × 關閉會清掉後端的錯誤，且不再出現', async () => {
    const api = setup(ERROR);
    expect(await screen.findByText(ERROR)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /close/i }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prd/dismiss_error', {}));
    expect(useProject.getState().snap?.state.prd.error).toBe('');
    await waitFor(() => expect(screen.queryByText(ERROR)).not.toBeInTheDocument());
  });

  it('AI 處理中不跳；錯誤被後端清掉（例如重新審查）時自動收起，不會呼叫清除', async () => {
    const api = setup('');
    act(() => useProject.setState({ snap: snapWith(ERROR, true) }));
    expect(screen.queryByText(ERROR)).not.toBeInTheDocument();
    act(() => useProject.setState({ snap: snapWith(ERROR) }));
    expect(await screen.findByText(ERROR)).toBeInTheDocument();
    act(() => useProject.setState({ snap: snapWith('') }));
    await waitFor(() => expect(screen.queryByText(ERROR)).not.toBeInTheDocument());
    expect(api).not.toHaveBeenCalled();
  });

  it('「查看 PRD」只跳頁，通知保留、錯誤不清', async () => {
    const api = setup(ERROR);
    fireEvent.click(await screen.findByRole('button', { name: '查看 PRD' }));
    expect(screen.getByText(ERROR)).toBeInTheDocument();
    expect(api).not.toHaveBeenCalled();
  });
});

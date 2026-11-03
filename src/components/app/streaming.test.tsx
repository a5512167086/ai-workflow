import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';

const handlers = vi.hoisted(() => new Map<string, (payload: unknown) => void>());
vi.mock('@/lib/tauri', () => ({
  inTauri: false,
  invoke: vi.fn(async (_cmd: string, args?: { path?: string }) => (args?.path?.endsWith('/state') ? null : { text: '', rounds: [] })),
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => { handlers.set(event, handler); return () => handlers.delete(event); }),
  dialogs: {},
  onFileDrop: vi.fn(async () => () => {}),
}));

import { LogTree } from '@/components/app/LogTree';
import { StreamingText } from '@/components/app/StreamingReply';
import { useProject } from '@/stores/project';

const RUNNING_LOG = [
  '[10:00:01] ── 實作：claude（可編輯）開始，session a ──',
  '[10:00:02] 🔧 Read src/a.ts',
].join('\n');
const DONE_LOG = [
  '[10:00:01] ── 實作：claude（可編輯）開始，session a ──',
  '[10:00:02] 完成',
  '[10:00:03] ── 實作：完成（2s） ──',
].join('\n');

describe('逐字輸出', () => {
  beforeEach(() => { handlers.clear(); useProject.getState().close(); });

  it('Log：打字中的文字放在執行中的 AI 區塊最下面', async () => {
    render(<LogTree text={RUNNING_LOG} live="正在分析 a.ts" />);
    const text = await screen.findByText('正在分析 a.ts');
    const group = text.closest('details')!;
    expect(group.open).toBe(true);
    expect(group).toHaveTextContent('Read');
  });

  it('Log：沒有執行中的區塊時放在最後面；沒有文字時不顯示', async () => {
    const { rerender, container } = render(<LogTree text={DONE_LOG} live="收尾說明" />);
    const text = await screen.findByText('收尾說明');
    expect(text.closest('details')).toBeNull();
    rerender(<LogTree text={DONE_LOG} live="" />);
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(container).not.toHaveTextContent('收尾說明');
  });

  it('打字中的回覆用 Markdown 顯示，但圖表只顯示原始碼（可能還沒寫完）', () => {
    const { container } = render(<StreamingText text={'## 標題\n\n```mermaid\nflowchart TD\n  A --> B'} />);
    expect(screen.getByRole('heading', { name: '標題' })).toBeInTheDocument();
    expect(container.querySelector('pre[data-lang="mermaid"]')).toHaveTextContent('flowchart TD');
    expect(container.querySelector('figure')).toBeNull();
  });

  it('專案 store 收到 stream 事件：有文字就記下，空字串就清掉', async () => {
    await useProject.getState().open('0123456789');
    const push = handlers.get('stream-0123456789')!;
    expect(push).toBeTypeOf('function');
    act(() => push({ scope: 'chat-t1', text: '你好' }));
    expect(useProject.getState().streams).toEqual({ 'chat-t1': '你好' });
    act(() => push({ scope: 'chat-t1', text: '' }));
    expect(useProject.getState().streams).toEqual({});
    // 離開專案時取消訂閱（包含 stream）。
    useProject.getState().close();
    expect(handlers.has('stream-0123456789')).toBe(false);
  });
});

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { useProject } from '@/stores/project';
import { useReferences } from '@/stores/references';
import type { ChatSession, Snapshot } from '@/types/api';

// 共用元件由別的子任務實作；這裡只測對話頁自己的行為。
vi.mock('@/components/ui/resizable', () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizablePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ResizableHandle: () => null,
}));
vi.mock('react-resizable-panels', () => ({ useDefaultLayout: () => ({ defaultLayout: undefined, onLayoutChanged: () => {} }) }));
vi.mock('@/features/references/ReferenceWidget', () => ({
  ReferenceWidget: () => null,
  ReferenceChips: () => null,
  referenceOptions: (_t: string, ctx: { chatId?: string | null }) => ({ title: '訊息參考', key: `chat:${ctx.chatId || 'new'}`, ids: [] }),
  useReferenceInput: () => {},
}));
vi.mock('@/features/skills/use-skill-command', () => ({ useSkillCommandInput: () => {} }));
vi.mock('@/components/app/LogTree', () => ({ LogTree: ({ text }: { text: string }) => <pre>{text}</pre> }));
vi.mock('@/components/app/ModelPicker', () => ({ ModelPicker: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <input aria-label="模型" value={value} onChange={(e) => onChange(e.target.value)} /> }));
vi.mock('@/components/app/confirm', () => ({ confirmDialog: vi.fn(async () => true), promptDialog: vi.fn(async () => null) }));

import { ChatPage } from './ChatPage';

const snapshot = (): Snapshot => ({
  root: 'C:\\app', dataDir: '', project: { id: '0123456789', name: 'app' },
  config: { mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: '', roles: { chat: 'codex', author: 'claude' }, models: {}, runtime: {} },
  runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '', tasks: [], taskTag: '', taskRevision: '', taskReferences: null,
  usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
  state: { prd: { status: 'none', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, guards: {},
});

function setup(handler: (path: string, body?: unknown) => Promise<unknown>) {
  const calls: { path: string; body?: unknown }[] = [];
  const api = vi.fn(async (path: string, body?: unknown) => { calls.push({ path, body }); return handler(path, body); }) as never;
  useProject.setState({ id: '0123456789', api, snap: snapshot(), logs: {}, logsFull: new Set(), rounds: [] });
  useReferences.getState().reset();
  return { calls, api };
}

const sessions: Record<string, ChatSession> = {
  a: { id: 'a', title: '對話 A', status: 'done', messages: [{ id: 'm1', role: 'user', text: '問 A', at: '2026-11-03T00:00:00Z' }], provider: 'claude' },
  b: { id: 'b', title: '對話 B', status: 'done', messages: [], provider: 'claude' },
};

beforeEach(() => { vi.useRealTimers(); });

describe('專案對話', () => {
  it('傳送只呼叫聊天 API 並帶 AI／模型／推理強度，不啟動 PRD 或任務；失敗仍保留輸入', async () => {
    let fail = true;
    const { calls } = setup(async (path, body) => {
      if (path === '/api/chats') return { items: [] };
      if (path === '/api/chat/send') {
        if (fail) throw new Error('CLI 無法啟動');
        const b = body as { input: string };
        return { id: 'new-1', title: b.input, status: 'running', messages: [{ id: 'u1', role: 'user', text: b.input }], provider: 'codex' };
      }
      return {};
    });
    render(<ChatPage />);
    const input = await screen.findByLabelText('詢問專案');
    fireEvent.change(input, { target: { value: '目前進度？' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/chat/send')).toBe(true));
    expect((input as HTMLTextAreaElement).value).toBe('目前進度？');
    expect(await screen.findAllByText(/CLI 無法啟動/)).not.toHaveLength(0);

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /傳送/ }));
    await waitFor(() => expect(calls.filter((c) => c.path === '/api/chat/send')).toHaveLength(2));
    const sent = calls.filter((c) => c.path === '/api/chat/send').at(-1)!.body as Record<string, unknown>;
    expect(sent).toMatchObject({ chatId: null, input: '目前進度？', retry: false, provider: 'codex', model: '', effort: '', references: [] });
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(''));
    expect(calls.every((c) => !/\/api\/(prd|run|tasks)/.test(c.path))).toBe(true);
  });

  it('切換對話時保存草稿，原始 HTML 不會執行', async () => {
    setup(async (path) => {
      if (path === '/api/chats') return { items: [{ id: 'a', title: '對話 A', status: 'done' }, { id: 'b', title: '對話 B', status: 'done' }] };
      if (path === '/api/chat/a') return { ...sessions.a, messages: [...sessions.a.messages, { id: 'm2', role: 'assistant', provider: 'claude', text: '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>**粗體**' }] };
      if (path === '/api/chat/b') return sessions.b;
      return {};
    });
    render(<ChatPage />);
    const input = await screen.findByLabelText('詢問專案');
    fireEvent.change(input, { target: { value: '新對話的草稿' } });
    fireEvent.click(await screen.findByRole('button', { name: /對話 A/ }));
    await screen.findByRole('heading', { name: '對話 A' });
    expect((input as HTMLTextAreaElement).value).toBe('');
    fireEvent.change(input, { target: { value: 'A 的草稿' } });
    fireEvent.click(screen.getByRole('button', { name: /對話 B/ }));
    await screen.findByRole('heading', { name: '對話 B' });
    expect((input as HTMLTextAreaElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /對話 A/ }));
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe('A 的草稿'));
    expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('img[onerror]')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
    expect(screen.getByText('粗體').tagName).toBe('STRONG');
  });

  it('停止按鈕只呼叫 chat/cancel，不會暫停專案任務', async () => {
    const running: ChatSession = { id: 'r', title: '回覆中', status: 'running', turn: 't1', messages: [{ id: 'u', role: 'user', text: '問', at: '2026-11-03T00:00:00Z' }], provider: 'claude' };
    const { calls } = setup(async (path) => {
      if (path === '/api/chats') return { items: [{ id: 'r', title: '回覆中', status: 'running' }] };
      if (path === '/api/chat/r') return running;
      if (path === '/api/chat/cancel') return { ...running, status: 'cancelled', cancelRequested: true };
      if (path.startsWith('/api/log/')) return { text: '' };
      return {};
    });
    render(<ChatPage />);
    fireEvent.click(await screen.findByRole('button', { name: /回覆中/ }));
    const stop = await screen.findByRole('button', { name: '停止回覆' });
    expect(screen.getByRole('button', { name: /傳送/ })).toBeDisabled();
    await act(async () => { fireEvent.click(stop); });
    await waitFor(() => expect(calls.some((c) => c.path === '/api/chat/cancel' && (c.body as { chatId: string }).chatId === 'r')).toBe(true));
    expect(calls.some((c) => c.path.startsWith('/api/run'))).toBe(false);
  });
});

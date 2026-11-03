import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { InterviewDialog } from '@/features/backlog/InterviewDialog';
import { installBridge, makeSnapshot, seedProject, renderApp, typeInto, type Routes } from '@/features/backlog/test-utils';
import type { RequirementsPayload } from '@/types/api';

const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/lib/tauri', () => ({
  inTauri: false,
  invoke: (...args: unknown[]) => bridge.invoke(...args),
  listen: vi.fn(async () => () => {}),
  dialogs: {},
  onFileDrop: vi.fn(async () => () => {}),
}));
const confirm = vi.hoisted(() => ({ fn: vi.fn(async (_options?: unknown) => true) }));
vi.mock('@/components/app/confirm', () => ({ confirmDialog: (options: unknown) => confirm.fn(options), promptDialog: vi.fn(async () => null), ConfirmHost: () => null }));
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

const AT = '2026-11-03T00:00:00Z';
function session(over: Partial<NonNullable<RequirementsPayload['session']>> = {}): NonNullable<RequirementsPayload['session']> {
  return { id: 'req-1', status: 'done', turn: 't1', messages: [{ role: 'assistant', text: '1. 誰會用？', at: AT }], ...over };
}

function setup(initial: RequirementsPayload, extra: Routes = {}) {
  let data = initial;
  const { invoke, calls } = installBridge({
    'GET /api/requirements/bbb': () => data,
    'POST /api/backlog/interview': (body: unknown) => { const b = body as { input: string }; data = { session: session({ messages: [...session().messages, { role: 'user', text: b.input, at: AT }, { role: 'assistant', text: '收到。', at: AT }], requirementsReady: true, requirementsSummary: '# 摘要\n- 匯出 CSV' }), confirmed: false, stale: false }; return data; },
    'POST /api/backlog/confirm': (body: unknown) => { const b = body as { summary: string }; data = { session: session({ requirementsReady: true, requirementsSummary: '# 摘要\n- 匯出 CSV', confirmedSummary: b.summary }), confirmed: true, stale: false }; return data; },
    'POST /api/backlog/draft': { ok: true },
    'POST /api/chat/cancel': () => data.session,
    'GET /api/skills': { skills: [] },
    ...extra,
  });
  bridge.invoke.mockImplementation(invoke);
  return { calls };
}

beforeEach(() => { seedProject(); confirm.fn.mockClear(); confirm.fn.mockResolvedValue(true); });

describe('需求釐清會議', () => {
  test('摘要面板只在關鍵問題釐清後出現；「開始寫 PRD」要先確認摘要', async () => {
    const { calls } = setup({ session: session(), confirmed: false, stale: false });
    renderApp(<InterviewDialog id="bbb" onClose={() => {}} />);
    expect(await screen.findByText(/誰會用/)).toBeInTheDocument();
    expect(screen.queryByTestId('interview-summary')).not.toBeInTheDocument();
    expect(screen.getByText('請回答本輪問題；AI 會依回答繼續追問。')).toBeInTheDocument();

    await typeInto(screen.getByLabelText('你的回答或補充'), '分析師');
    await userEvent.click(screen.getByRole('button', { name: '送出回答' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/interview')?.body).toMatchObject({ id: 'bbb', input: '分析師', provider: 'claude', restart: false, retry: false }));

    expect(await screen.findByTestId('interview-summary')).toBeInTheDocument();
    expect(screen.getByText('關鍵問題已釐清，請檢閱、修正並確認右側摘要。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '開始寫 PRD' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('你的回答或補充')).toHaveValue('');

    await userEvent.click(screen.getByRole('button', { name: '確認需求摘要' }));
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/confirm')?.body).toEqual({ id: 'bbb', sessionId: 'req-1', turn: 't1', summary: '# 摘要\n- 匯出 CSV' }));
    expect(await screen.findByRole('button', { name: '已確認' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '開始寫 PRD' })).toBeEnabled();
    expect(calls.some((c) => c.path === '/api/backlog/draft')).toBe(false);
  });

  test('確認後修改摘要就要重新確認，「開始寫 PRD」停用並說明原因', async () => {
    const { calls } = setup({ session: session({ requirementsReady: true, requirementsSummary: '# 摘要', confirmedSummary: '# 摘要' }), confirmed: true, stale: false });
    renderApp(<InterviewDialog id="bbb" onClose={() => {}} />);
    expect(await screen.findByRole('button', { name: '已確認' })).toBeDisabled();
    const draft = screen.getByRole('button', { name: '開始寫 PRD' });
    expect(draft).toBeEnabled();

    await userEvent.click(screen.getByRole('radio', { name: '編輯' }));
    await typeInto(screen.getByLabelText('需求摘要 Markdown'), '\n- 多一項');
    expect(screen.getByText('摘要已修改，請重新確認。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重新確認摘要' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '開始寫 PRD' })).toBeDisabled();
    expect(calls.some((c) => c.path === '/api/backlog/confirm')).toBe(false);
  });

  test('已確認後按「開始寫 PRD」：有 PRD 時先確認切換，再呼叫 backlog/draft 並關閉', async () => {
    const onClose = vi.fn();
    const { calls } = setup({ session: session({ requirementsReady: true, requirementsSummary: '# 摘要', confirmedSummary: '# 摘要' }), confirmed: true, stale: false });
    seedProject(makeSnapshot({ prd: '# PRD', tasks: [{ id: 1, title: 'a', status: 'pending' }], guards: { 'backlog.draft': '' } }));
    renderApp(<InterviewDialog id="bbb" onClose={onClose} />);
    await userEvent.click(await screen.findByRole('button', { name: '開始寫 PRD' }));
    await waitFor(() => expect(confirm.fn).toHaveBeenCalled());
    expect((confirm.fn.mock.calls[0][0] as { description: string }).description).toContain('還有 1 個任務未完成');
    await waitFor(() => expect(calls.find((c) => c.path === '/api/backlog/draft')?.body).toEqual({ id: 'bbb' }));
    expect(onClose).toHaveBeenCalled();
  });

  test('流程執行中時「開始寫 PRD」依後端防呆停用', async () => {
    setup({ session: session({ requirementsReady: true, requirementsSummary: '# 摘要', confirmedSummary: '# 摘要' }), confirmed: true, stale: false });
    seedProject(makeSnapshot({ guards: { 'backlog.draft': '流程執行中，結束後才能起草' } }));
    renderApp(<InterviewDialog id="bbb" onClose={() => {}} />);
    const draft = await screen.findByRole('button', { name: '開始寫 PRD' });
    expect(draft).toBeDisabled();
    expect(draft.dataset.guarded).toBe('1');
  });
});

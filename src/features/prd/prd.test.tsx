import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ConfirmHost } from '@/components/app/confirm';
import { useProject } from '@/stores/project';
import type { Snapshot } from '@/types/api';
import { PrdPage, stepIndex } from '@/features/prd/PrdPage';

vi.mock('@/features/references/ReferenceWidget', async () => {
  const actual = await vi.importActual<typeof import('@/features/references/ReferenceWidget')>('@/features/references/ReferenceWidget');
  return { ...actual, ReferenceWidget: () => null, useReferenceInput: () => {} };
});

function snapshot(over: Partial<Snapshot['state']['prd']> = {}, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    root: 'C:\\code\\app', dataDir: '', project: { id: '0123456789', name: 'app' },
    config: { mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: '', roles: {}, models: {}, runtime: {}, commands: {} },
    runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null,
    prd: '# PRD\n\n內容', tasks: [], taskTag: '', taskRevision: '', taskReferences: null,
    usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
    state: { prd: { status: 'awaiting_approval', version: 3, reviewed_version: 3, reference_scope: 'scope-a', rounds: [], ...over }, pipeline: { status: 'idle' }, control: {}, tasks: {} },
    guards: { 'prd.edit': '', 'prd.review': '', 'prd.approve': '', 'prd.revise': '', 'tasks.generate': 'PRD 尚未核准' },
    ...extra,
  };
}

function setup(snap: Snapshot, rounds: Snapshot['state']['prd']['rounds'] = []) {
  const api = vi.fn(async (path: string) => {
    if (path === '/api/prd') return { rounds };
    if (path === '/api/state') return snap;
    return { ok: true };
  });
  useProject.setState({ id: snap.project.id, snap, api: api as never, rounds, logs: {}, logsFull: new Set(), error: null });
  const utils = render(
    <MemoryRouter><TooltipProvider><PrdPage /><ConfirmHost /></TooltipProvider></MemoryRouter>,
  );
  return { api, ...utils };
}

beforeEach(() => { localStorage.clear(); });

describe('PRD 頁', () => {
  test('核准時帶版本與參考範圍', async () => {
    const { api } = setup(snapshot());
    await userEvent.click(screen.getByRole('button', { name: /核准 PRD/ }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prd/approve', { version: 3, scope: 'scope-a' }));
  });

  test('人工版本尚未重新審查時先確認；取消不送出', async () => {
    const { api } = setup(snapshot({ human_edited_at: '2026-11-01T00:00:00Z', reviewed_version: 2 }));
    expect(screen.getByText(/目前含人工修改/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /核准 PRD/ }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: '取消' }));
    expect(api).not.toHaveBeenCalledWith('/api/prd/approve', expect.anything());
    await userEvent.click(screen.getByRole('button', { name: /核准 PRD/ }));
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: '核准' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prd/approve', { version: 3, scope: 'scope-a' }));
  });

  test('要求再改送出意見；重新產生任務只在拆任務失敗時顯示', async () => {
    const { api } = setup(snapshot());
    expect(screen.queryByRole('button', { name: /重新產生任務/ })).not.toBeInTheDocument();
    // jsdom 裡所有元素的座標都是 0，react-resizable-panels 會把點擊當成拉分隔線而吃掉焦點，所以用 focus＋鍵盤輸入。
    screen.getByLabelText('附意見要求再改').focus();
    await userEvent.keyboard('日期要支援時區');
    await userEvent.click(screen.getByRole('button', { name: /要求再改/ }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prd/revise', { feedback: '日期要支援時區' }));
  });

  test('拆任務失敗時顯示重新產生任務並呼叫 tasks/generate', async () => {
    const snap = snapshot({ status: 'approved' }, { guards: { 'prd.edit': '', 'prd.review': '', 'prd.approve': 'PRD 已核准', 'prd.revise': '', 'tasks.generate': '' } });
    snap.state.task_gen = { status: 'error', error: '無法啟動' };
    const { api } = setup(snap);
    expect(screen.getByText('失敗：無法啟動')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /重新產生任務/ }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/tasks/generate', {}));
  });

  test('防呆：按鈕依後端原因停用並顯示原因', () => {
    setup(snapshot({}, { guards: { 'prd.edit': '流程執行中', 'prd.review': '流程執行中', 'prd.approve': '流程執行中', 'prd.revise': '流程執行中', 'tasks.generate': '' } }));
    const approve = screen.getByRole('button', { name: /核准 PRD/ });
    expect(approve).toBeDisabled();
    expect(approve).toHaveAttribute('data-guarded', '1');
    expect(screen.getByRole('button', { name: /人工編輯/ })).toBeDisabled();
    expect(screen.getByLabelText('附意見要求再改')).toBeDisabled();
    expect(screen.getByLabelText('附意見要求再改')).toHaveAttribute('title', '流程執行中');
  });

  test('每輪紀錄列出輪次；原始模式顯示原文', async () => {
    setup(snapshot(), [
      { round: 1, kind: 'draft', provider: 'claude', version: 1, text: '初稿' },
      { round: 1, kind: 'review', provider: 'codex', verdict: 'REVISE', version: 1, text: '[必須修正] 缺時區' },
    ]);
    expect(screen.getByText('第 1 輪・初稿・Claude・v1')).toBeInTheDocument();
    expect(screen.getByText('第 1 輪・審查・Codex・REVISE・v1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: '原始 Markdown' }));
    expect(localStorage.getItem('ai-workflow-prd-view')).toBe('raw');
    expect(document.querySelector('pre.mono')?.textContent).toBe('# PRD\n\n內容');
  });

  test('人工編輯以開啟時的版本儲存', async () => {
    const { api } = setup(snapshot());
    await userEvent.click(screen.getByRole('button', { name: /人工編輯/ }));
    const editor = await screen.findByLabelText('PRD Markdown');
    fireEvent.change(editor, { target: { value: '# 新版' } });
    await userEvent.click(screen.getByRole('button', { name: '儲存修改' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/prd/save', { text: '# 新版', version: 3, scope: 'scope-a' }));
    await waitFor(() => expect(screen.queryByLabelText('PRD Markdown')).not.toBeInTheDocument());
  });

  test('步驟進度與舊版相同', () => {
    expect(stepIndex({ state: { prd: { status: 'drafting', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, tasks: [] })).toBe(0);
    expect(stepIndex({ state: { prd: { status: 'awaiting_approval', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, tasks: [] })).toBe(2);
    expect(stepIndex({ state: { prd: { status: 'approved', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, tasks: [] })).toBe(3);
    expect(stepIndex({ state: { prd: { status: 'approved', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {}, task_gen: { status: 'done' } }, tasks: [] })).toBe(4);
  });
});

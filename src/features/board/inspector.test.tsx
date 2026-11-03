import { describe, expect, test } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { TaskInspector } from './TaskInspector';
import { acceptReason, taskGates } from './board-logic';
import { fakeApi, makeDetail, makeSnapshot, setupProject } from './test-utils';
import type { Snapshot, TaskState } from '@/types/api';

const renderInspector = (id: string) => render(<TooltipProvider><TaskInspector id={id} onClose={() => {}} /></TooltipProvider>);

describe('任務詳情', () => {
  test('審查未通過而卡住時才顯示「接受目前結果」，驗證失敗或執行中會停用並說明原因', () => {
    const snap = makeSnapshot();
    const stuck: TaskState = { phase: 'stuck', review_verdict: 'REVISE' };
    expect(acceptReason(snap, stuck)).toEqual({ show: true, reason: null });
    expect(acceptReason(snap, { ...stuck, last_check_ok: false }).reason).toBe('驗證指令沒有通過，請先修好或重新執行');
    expect(acceptReason({ ...snap, guards: { ...snap.guards, 'backlog.draft': '流程執行中' } }, stuck).reason).toBe('流程執行中');
    expect(acceptReason(snap, { phase: 'stuck', review_verdict: 'PASS' }).show).toBe(false);
    expect(acceptReason(snap, { phase: 'implementing', review_verdict: 'REVISE' }).show).toBe(false);
  });

  test('卡住的任務顯示接受按鈕與卡住原因，審查意見標出必須修正與建議的數量', async () => {
    const snap = makeSnapshot({}, { tasks: { '2': { phase: 'stuck', review_verdict: 'REVISE', error: '審查未通過', stuck_reasons: ['補上測試'] } } });
    setupProject(snap, fakeApi({
      '/api/task/2': () => makeDetail('2', snap, { reviews: [
        { name: 'review-1-claude.md', round: 1, provider: 'claude', text: '[必須修正] 缺測試\n[建議] 改名\nVERDICT: REVISE' },
        { name: 'review-1-codex.md', round: 1, provider: 'codex', text: '[P1] missing test\n[P3] rename\nVERDICT: REVISE' },
      ] }),
    }));
    renderInspector('2');
    expect(await screen.findByRole('button', { name: '接受目前結果' })).toBeUsable();
    expect(screen.getByText('卡住原因：審查未通過')).toBeInTheDocument();
    expect(screen.getByText('補上測試')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: '審查意見' }));
    expect(await screen.findByText('第 1 次審查・雙人審查')).toBeInTheDocument();
    expect(screen.getAllByText('必須修正 1・建議 1')).toHaveLength(2);
    expect(screen.getAllByText('REVISE')).toHaveLength(2);
  });

  test('接受按鈕在審查通過或未卡住時不顯示', async () => {
    const snap = makeSnapshot({}, { tasks: { '2': { phase: 'done', review_verdict: 'PASS' } } });
    setupProject(snap);
    renderInspector('2');
    expect(await screen.findByRole('heading', { name: '#2 後續任務' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '接受目前結果' })).not.toBeInTheDocument();
  });

  test('自動完成與未設定驗證指令不會顯示成已人工驗收或驗證通過', () => {
    const snap: Snapshot = makeSnapshot({ config: { ...makeSnapshot().config, commands: { build: '', test: '', lint: '' } } }, { pipeline: { status: 'running' } });
    const gates = taskGates(snap, snap.tasks[1], { phase: 'done' }, null, new Set(['1.1']));
    expect(gates.map((g) => [g.label, g.text, g.status])).toEqual([
      ['依賴', '已滿足', 'pass'],
      ['驗證', '未設定驗證指令', 'pending'],
      ['審查', '尚未審查', 'pending'],
      ['人工驗收', '等待人工確認', 'pending'],
    ]);
    const done = taskGates({ ...snap, state: { ...snap.state, pipeline: { status: 'complete' } } }, snap.tasks[1], { phase: 'done', last_check_ok: true, review_verdict: 'PASS' }, null, new Set(['1.1']));
    expect(done[1]).toEqual({ label: '驗證', text: '未設定驗證指令', status: 'pending' });
    expect(done[3].status).toBe('pass');
  });

  test('任務內容用標籤與段落呈現，不顯示原始 JSON；人工驗收清單分開列出', async () => {
    const snap = makeSnapshot();
    setupProject(snap);
    renderInspector('2');
    await screen.findByRole('heading', { name: '#2 後續任務' });
    await userEvent.click(screen.getByRole('tab', { name: '任務內容' }));
    expect(await screen.findByText('驗收條件')).toBeInTheDocument();
    expect(screen.getByText('可以匯出')).toBeInTheDocument();
    expect(screen.getByText('人工驗收（你自己測，AI 不做也不審）')).toBeInTheDocument();
    expect(screen.getByText('用 Excel 開啟')).toBeInTheDocument();
    expect(screen.getByTitle('已完成')).toHaveTextContent('#1.1');
    expect(document.body.textContent).not.toMatch(/[{}]/);
  });

  test('人工編輯任務送出 task/save 並帶 tag 與 revision', async () => {
    const snap = makeSnapshot();
    const api = setupProject(snap, fakeApi({ '/api/task/save': () => ({ ok: true }) }));
    renderInspector('2');
    await screen.findByRole('heading', { name: '#2 後續任務' });
    await userEvent.click(screen.getByRole('button', { name: '人工編輯任務' }));
    const title = await screen.findByLabelText('標題');
    expect(title).toHaveValue('後續任務');
    await userEvent.clear(title);
    await userEvent.type(title, '改過的任務');
    await userEvent.click(screen.getByRole('button', { name: '儲存修改' }));
    await waitFor(() => expect(api.calls.some((c) => c.path === '/api/task/save')).toBe(true));
    const call = api.calls.find((c) => c.path === '/api/task/save')!.body as { id: string; tag: string; revision: string; task: { title: string; dependencies: string[]; acceptanceCriteria: string[] } };
    expect(call.id).toBe('2');
    expect(call.tag).toBe('tag');
    expect(call.revision).toBe('r1');
    expect(call.task.title).toBe('改過的任務');
    expect(call.task.dependencies).toEqual(['1.1']);
    expect(call.task.acceptanceCriteria).toEqual(['可以匯出']);
  });
});

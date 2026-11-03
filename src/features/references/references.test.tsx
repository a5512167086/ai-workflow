import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useProject } from '@/stores/project';
import { useReferences } from '@/stores/references';
import { referenceOptions, saveReferenceSelection, ReferenceWidget, ReferenceChips, openReferenceDialog, ReferenceDialogHost } from '@/features/references/ReferenceWidget';
import type { Snapshot, ReferenceItem } from '@/types/api';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  root: 'C:\\x', dataDir: '', project: { id: '0123456789', name: 'x' }, config: { mode: 'manual' } as Snapshot['config'],
  runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '', tasks: [], taskTag: 'tag-1', taskRevision: 'r1',
  taskReferences: ['g1'], usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
  state: { prd: { status: 'none', rounds: [], reference_scope: 'scope-1', references: ['f1'] }, pipeline: { status: 'idle' }, control: {}, tasks: {} },
  guards: {}, ...over,
});
const item = (id: string, name: string): ReferenceItem => ({ id, name, kind: 'file', sourcePath: `C:\\${name}`, fileCount: 1, totalBytes: 1024 });

beforeEach(() => {
  useReferences.getState().reset();
  useProject.setState({ snap: snap(), api: vi.fn(async () => ({})) as never, refresh: vi.fn(async () => null) as never });
});

describe('referenceOptions', () => {
  it('草稿區域用前端的 key，功能／任務用後端目標與防呆原因', () => {
    useReferences.getState().setDraft('backlog', ['d1']);
    expect(referenceOptions('backlog-draft')).toMatchObject({ key: 'backlog', ids: ['d1'] });
    expect(referenceOptions('chat', { chatId: 'c9' }).key).toBe('chat:c9');
    expect(referenceOptions('chat').key).toBe('chat:new');
    expect(referenceOptions('feature')).toMatchObject({ target: 'feature', featureScope: 'scope-1', ids: ['f1'], lock: '' });
    expect(referenceOptions('group')).toMatchObject({ target: 'group', tag: 'tag-1', ids: ['g1'] });
    useProject.setState({ snap: snap({ guards: { 'prd.references': '流程執行中', 'tasks.references': '功能已完成' } }) });
    expect(referenceOptions('feature').lock).toBe('流程執行中');
    expect(referenceOptions('task', { taskId: '2', taskReferences: ['t1'] })).toMatchObject({ target: 'task', id: '2', tag: 'tag-1', ids: ['t1'], lock: '功能已完成' });
    useProject.setState({ snap: snap() });
    expect(referenceOptions('task', { taskId: '1', taskStatus: 'done' }).lock).toBe('這個任務已完成，參考資料不會再被使用');
  });
});

describe('saveReferenceSelection', () => {
  it('草稿只存在前端，後端目標才呼叫 assign 並重讀快照；鎖住或超過 24 份會拒絕', async () => {
    await saveReferenceSelection({ title: '', key: 'backlog', ids: [] }, ['a', 'a', 'b']);
    expect(useReferences.getState().draft('backlog')).toEqual(['a', 'b']);
    expect(useProject.getState().api).not.toHaveBeenCalled();
    await saveReferenceSelection({ title: '', target: 'feature', featureScope: 's', ids: [] }, ['x']);
    expect(useProject.getState().api).toHaveBeenCalledWith('/api/references/assign', { target: 'feature', id: undefined, tag: undefined, featureScope: 's', references: ['x'] });
    expect(useProject.getState().refresh).toHaveBeenCalled();
    await expect(saveReferenceSelection({ title: '', target: 'group', ids: [], lock: '執行中' }, ['x'])).rejects.toThrow('執行中');
    await expect(saveReferenceSelection({ title: '', key: 'k', ids: [] }, Array.from({ length: 25 }, (_, i) => `r${i}`))).rejects.toThrow('24');
  });
});

describe('ReferenceWidget 與 chips', () => {
  it('移除 chip 會立刻儲存；鎖住時不能移除也不能加入', async () => {
    useReferences.getState().put(item('f1', 'spec.md'));
    const api = useProject.getState().api as ReturnType<typeof vi.fn>;
    render(<TooltipProvider><ReferenceWidget options={referenceOptions('feature')} /></TooltipProvider>);
    fireEvent.click(screen.getByLabelText('移除參考：spec.md'));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/references/assign', expect.objectContaining({ references: [] })));
    useProject.setState({ snap: snap({ guards: { 'prd.references': '流程執行中' } }) });
    render(<TooltipProvider><ReferenceWidget options={referenceOptions('feature')} /></TooltipProvider>);
    expect(screen.queryAllByLabelText('移除參考：spec.md')).toHaveLength(1); // 只有第一個（未鎖）widget 有移除鈕
    const locked = screen.getAllByRole('button', { name: /加入參考/ }).at(-1)!;
    expect(locked).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getAllByText('流程執行中').length).toBeGreaterThan(0);
  });
  it('ReferenceChips 顯示名稱並可移除', () => {
    useReferences.getState().put(item('a', 'a.md'));
    const remove = vi.fn();
    render(<ReferenceChips ids={['a', 'zzz']} remove={remove} />);
    expect(screen.getByText(/a\.md/)).toBeInTheDocument();
    expect(screen.getByText(/參考 zzz/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('移除參考：a.md'));
    expect(remove).toHaveBeenCalledWith('a');
  });
});

describe('參考資料視窗', () => {
  it('取消不套用，套用才呼叫 assign 並帶勾選的清單', async () => {
    const api = vi.fn(async (path: string) => (path === '/api/references' ? { items: [item('f1', 'spec.md'), item('f2', 'design.md')] } : {}));
    useProject.setState({ api: api as never });
    render(<ReferenceDialogHost />);
    act(() => openReferenceDialog(referenceOptions('feature')));
    await screen.findByText('功能參考（PRD、拆任務共用）');
    await screen.findByText('design.md');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    await waitFor(() => expect(screen.queryByText('套用參考資料')).not.toBeInTheDocument());
    expect(api).not.toHaveBeenCalledWith('/api/references/assign', expect.anything());

    act(() => openReferenceDialog(referenceOptions('feature')));
    await screen.findByText('design.md');
    fireEvent.click(screen.getByRole('checkbox', { name: 'design.md' }));
    fireEvent.click(screen.getByRole('button', { name: '套用參考資料' }));
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/references/assign', expect.objectContaining({ target: 'feature', references: ['f1', 'f2'] })));
    await waitFor(() => expect(screen.queryByText('套用參考資料')).not.toBeInTheDocument());
  });
});

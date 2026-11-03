import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useProject } from '@/stores/project';
import { PermissionDialog, permissionRuleText } from '@/features/permissions/PermissionDialog';
import type { Snapshot, PermissionEntry } from '@/types/api';

const entry = (id: string): PermissionEntry => ({
  id, label: '任務 2 實作', provider: 'claude', tool: 'Bash', display_name: 'Bash', description: '執行指令', input: { command: 'npm install left-pad' }, reason: '不在允許清單',
  suggestions: [{ rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }] }],
});
const snap = (permissions: PermissionEntry[]): Snapshot => ({
  root: '', dataDir: '', project: { id: '0123456789', name: 'x' }, config: { mode: 'manual' } as Snapshot['config'],
  runnerAlive: true, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '', tasks: [], taskTag: '', taskRevision: '', taskReferences: null,
  usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions,
  state: { prd: { status: 'none', rounds: [] }, pipeline: { status: 'running' }, control: {}, tasks: {} }, guards: {},
});

beforeEach(() => {
  useProject.setState({ snap: snap([entry('p1'), entry('p2')]), api: vi.fn(async () => ({ ok: true })) as never });
});

describe('PermissionDialog', () => {
  it('顯示指令與規則，允許會送出決定並從快照移除', async () => {
    render(<PermissionDialog />);
    expect(screen.getByText('npm install left-pad')).toBeInTheDocument();
    expect(screen.getByText('還有 1 個等待中')).toBeInTheDocument();
    expect(permissionRuleText(entry('x'))).toBe('Bash(npm install:*)');
    expect(screen.getByRole('button', { name: '這次執行都允許 Bash(npm install:*)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '允許這一次' }));
    await waitFor(() => expect(useProject.getState().api).toHaveBeenCalledWith('/api/permissions/answer', { id: 'p1', decision: 'allow', message: '' }));
    await waitFor(() => expect(useProject.getState().snap?.permissions.map((e) => e.id)).toEqual(['p2']));
  });
  it('拒絕會帶原因；Esc 等於稍後決定，留下提示可再打開', async () => {
    render(<PermissionDialog />);
    fireEvent.change(screen.getByLabelText('拒絕原因（選填，會告訴 AI）'), { target: { value: '改用 pnpm' } });
    fireEvent.click(screen.getByRole('button', { name: '拒絕' }));
    await waitFor(() => expect(useProject.getState().api).toHaveBeenCalledWith('/api/permissions/answer', { id: 'p1', decision: 'deny', message: '改用 pnpm' }));
    await screen.findByText('npm install left-pad'); // p2 接著跳出來
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(useProject.getState().api).toHaveBeenCalledTimes(1);
    expect(screen.getByText('AI 等待你允許 1 個操作')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '檢視' }));
    await screen.findByText('npm install left-pad');
  });
});

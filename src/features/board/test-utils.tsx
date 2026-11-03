// 看板測試共用：假快照、假 API、在路由與 TooltipProvider 裡渲染。
import type { ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useProject } from '@/stores/project';
import type { Api } from '@/lib/api';
import type { Snapshot, TaskDetail } from '@/types/api';

export function makeSnapshot(overrides: Partial<Snapshot> = {}, state: Partial<Snapshot['state']> = {}): Snapshot {
  return {
    root: String.raw`C:\code\my-app`, dataDir: String.raw`C:\data`, project: { id: '0123456789', name: 'my-app' },
    config: {
      mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'ai/', roles: {}, models: {}, runtime: {},
      feature: '測試功能', commands: { build: '', test: 'npm test', lint: '' }, context_files: [],
    },
    runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '# PRD',
    tasks: [
      { id: 1, title: '父任務', status: 'in-progress', priority: 'high', dependencies: [], subtasks: [{ id: 1, title: '子一', status: 'done' }, { id: 2, title: '子二', status: 'pending', dependencies: [1] }] },
      { id: 2, title: '後續任務', status: 'pending', priority: 'medium', dependencies: ['1.1'], acceptanceCriteria: ['可以匯出'], manualChecks: ['用 Excel 開啟'] },
    ],
    taskTag: 'tag', taskRevision: 'r1', taskReferences: [],
    usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] },
    permissions: [],
    state: {
      prd: { status: 'approved', rounds: [] }, pipeline: { status: 'idle' }, control: {},
      tasks: { '1.1': { phase: 'done' } },
      task_approval: {},
      ...state,
    },
    guards: { 'run.start': '請先檢視並核准任務', 'tasks.approve': '', 'project.settings': '', 'task.rerun': '', 'task.edit': '', 'backlog.draft': '' },
    ...overrides,
  };
}

export function makeDetail(id: string, snap: Snapshot, extra: Partial<TaskDetail> = {}): TaskDetail {
  const [parentId, subId] = id.split('.');
  const parent = snap.tasks.find((t) => String(t.id) === parentId)!;
  const task = subId ? { ...parent.subtasks!.find((s) => String(s.id) === subId)!, id, parent } : parent;
  return { id, revision: snap.taskRevision, tag: snap.taskTag, state: snap.state.tasks[id] || null, task: task as TaskDetail['task'], checks: '', diff: '', implement: '', log: '', reviews: [], ...extra };
}

export type FakeApi = Api & { calls: { path: string; body: unknown }[] };

/** 假 API：GET /api/task/<id> 回詳情、/api/state 回目前快照；其他 POST 記錄下來回 ok。 */
export function fakeApi(handlers: Record<string, (body: unknown) => unknown> = {}): FakeApi {
  const calls: { path: string; body: unknown }[] = [];
  const respond = (path: string, body?: unknown) => {
    calls.push({ path, body });
    if (handlers[path]) return handlers[path](body);
    const snap = useProject.getState().snap!;
    if (path === '/api/state') return snap;
    const task = /^\/api\/task\/(.+)$/.exec(path);
    if (task) return makeDetail(task[1], snap);
    return { ok: true };
  };
  // 和真的 api 一樣回傳 Promise（處理函式回傳的 Promise 也會被攤平）。
  const fn = ((path: string, body?: unknown) => Promise.resolve().then(() => respond(path, body))) as FakeApi;
  fn.calls = calls;
  return fn;
}

export function setupProject(snap: Snapshot, api: FakeApi = fakeApi()) {
  useProject.setState({ id: snap.project.id, snap, api, error: null, logs: {}, logsFull: new Set(), rounds: [] });
  return api;
}

export function renderBoard(element: ReactElement, path = '/p/0123456789/board') {
  return render(
    <TooltipProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes><Route path="/p/:id/board" element={element} /></Routes>
      </MemoryRouter>
    </TooltipProvider>,
  );
}

// 需求待辦與需求會議測試共用：假的 Tauri 橋接（依路徑回應）與專案 store 的初始狀態。
import { render, type RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';
import { vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';
import { projectApi } from '@/lib/api';
import { useProject } from '@/stores/project';
import type { BacklogItem, RequirementsPayload, Snapshot } from '@/types/api';

export const PID = '0123456789';

export type Call = { method: string; path: string; body: unknown };
export type Route = unknown | ((body: unknown, call: Call) => unknown);
export type Routes = Record<string, Route>;

/** jsdom 裡 react-resizable-panels 會把每個點都當成分隔線（矩形全是 0×0）而擋掉 click 的聚焦，所以先 focus 再打字。 */
export async function typeInto(el: HTMLElement, text: string) {
  el.focus();
  await userEvent.keyboard(text);
}

/** GuardButton 用到 Tooltip，測試要包 TooltipProvider。 */
export function renderApp(ui: ReactElement): RenderResult {
  return render(<TooltipProvider>{ui}</TooltipProvider>);
}

export function makeSnapshot(over: Partial<Snapshot> = {}): Snapshot {
  return {
    root: 'C:\\code\\my-app', dataDir: 'C:\\data', project: { id: PID, name: 'my-app' },
    config: { mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'ai/', roles: { interviewer: 'claude', author: 'claude' }, models: {}, runtime: {} },
    runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null,
    prd: '', tasks: [], taskTag: '', taskRevision: '', taskReferences: [], usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] },
    permissions: [],
    state: { prd: { status: 'none', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} },
    guards: {},
    ...over,
  };
}

export function makeItems(): BacklogItem[] {
  return [
    { id: 'aaa', title: '鎖住的需求', detail: '', status: 'in_progress', references: ['ref-1'], lock: '這項需求已產生目前的 PRD，不能再修改' },
    { id: 'bbb', title: '通知中心', detail: '**要** 推播', status: 'open', references: [] },
    { id: 'ccc', title: '深色模式', detail: '', status: 'open', references: [] },
  ];
}

export function emptyRequirements(): RequirementsPayload { return { session: null, confirmed: false, stale: false }; }

/** 安裝假橋接：routes 依 `METHOD path` 給回應（函式可讀 body）；回傳呼叫紀錄。 */
export function installBridge(routes: Routes) {
  const calls: Call[] = [];
  const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'api') return null;
    const method = String(args?.method); const path = String(args?.path).replace(`/api/p/${PID}`, '/api');
    const call = { method, path, body: args?.body };
    calls.push(call);
    const key = `${method} ${path}`;
    const hit = routes[key] ?? routes[`${method} *`];
    if (hit === undefined) throw new Error(`沒有 ${key}`);
    const value = typeof hit === 'function' ? (hit as (b: unknown, c: Call) => unknown)(call.body, call) : hit;
    if (value instanceof Error) throw value;
    return value;
  });
  return { invoke, calls };
}

export function seedProject(snap: Snapshot = makeSnapshot()) {
  useProject.setState({ id: PID, api: projectApi(PID), snap, error: null, logs: {}, logsFull: new Set(), rounds: [] });
}

// 任務看板與任務詳情的純邏輯（不含 React），元件與測試共用。規則沿用舊版 app.js／human.js。
import { NEEDS_HUMAN, PROVIDER_LABEL } from '@/lib/constants';
import { childTasks, column, type BoardFacts } from '@/lib/format';
import type { Snapshot, Task, TaskDetail, TaskState } from '@/types/api';

export const PASSING = ['PASS', 'APPROVE', 'ACCEPTED'];

export function featureTitle(snap: Snapshot) {
  return snap.config.feature || snap.state.prd.idea?.split('\n')[0] || '目前功能';
}

export function tasksApproved(snap: Snapshot) {
  return !!snap.taskRevision && snap.taskRevision === snap.state.task_approval?.revision;
}

export function anyBusy(snap: Snapshot) {
  return !!(snap.runnerAlive || snap.prdBusy || snap.taskGenBusy || snap.skillBusy);
}

export function needsHuman(snap: Snapshot) {
  return NEEDS_HUMAN.includes(snap.state.pipeline.status);
}

/** 看板頂端的人工流程說明。 */
export function humanNote(snap: Snapshot) {
  if (!snap.tasks?.length) return '需求釐清 → 你確認摘要 → PRD 交叉審查與人工核准 → 拆任務 → 你檢視並核准任務 → 執行與驗收';
  if (tasksApproved(snap)) return '任務已由你核准。手動模式每項完成後等你測試；所有模式最後都需功能驗收。';
  return '核准前請確認：每個任務做完都能單獨展示與手動測試嗎？粒度會太粗或太細嗎？依賴是否只列真正擋住它的任務？有沒有該合併或再拆的？可以直接人工編輯；核准後照清單順序執行。';
}

export interface Metric { label: string; value: string | number; attention?: boolean }

/** 本功能任務進度：主線完成、進行與審查、等待驗收、卡住任務。 */
export function boardMetrics(snap: Snapshot, facts: BoardFacts): { metrics: Metric[]; completed: number; percent: number } {
  const tasks = snap.tasks;
  const completed = tasks.filter((task) => facts.done.has(String(task.id))).length;
  const percent = tasks.length ? Math.round((completed / tasks.length) * 100) : 0;
  const stuck = tasks.filter((task) => [task, ...childTasks(task)].some((item) => facts.stateFor(item).phase === 'stuck' || item.status === 'blocked')).length;
  return {
    completed, percent,
    metrics: [
      { label: '主線完成', value: `${completed} / ${tasks.length}` },
      { label: '進行與審查', value: tasks.filter((task) => facts.stateFor(task).phase !== 'stuck' && ['doing', 'review'].includes(column(task, facts.stateFor(task)))).length },
      { label: '等待驗收', value: tasks.filter((task) => column(task, facts.stateFor(task)) === 'test').length },
      { label: '卡住任務', value: stuck, attention: stuck > 0 },
    ],
  };
}

export type GateStatus = 'pass' | 'fail' | 'pending';
export interface Gate { label: string; text: string; status: GateStatus }

const checksConfigured = (snap: Snapshot) => Object.values(snap.config.commands || {}).some((value) => typeof value === 'string' && value.trim());

type GateResult = Pick<Gate, 'text' | 'status'>;

/** 驗證條件：有結果才看通過／失敗，否則看有沒有設定驗證指令。 */
function checkGate(verified: boolean, ok: boolean | null | undefined, configured: boolean): GateResult {
  if (!verified) return { text: configured ? '尚未執行' : '未設定驗證指令', status: 'pending' };
  return ok ? { text: '通過', status: 'pass' } : { text: '失敗', status: 'fail' };
}

/** 審查條件：人工接受也算通過。 */
function reviewGate(review: string | undefined): GateResult {
  if (!review) return { text: '尚未審查', status: 'pending' };
  const status = PASSING.includes(review) ? 'pass' : 'fail';
  if (review === 'ACCEPTED') return { text: '你已接受目前結果', status };
  return { text: ['PASS', 'APPROVE'].includes(review) ? '通過' : '未通過', status };
}

/** 完成條件：依賴、驗證、審查與人工驗收；未知值不顯示成通過。 */
export function taskGates(snap: Snapshot, task: Task, state: TaskState, detail: TaskDetail | null, done: Set<string>): Gate[] {
  const missing = (task.dependencies || []).filter((id) => !done.has(String(id)));
  const configured = checksConfigured(snap);
  const verified = state.last_check_ok != null && (configured || !!detail?.checks?.trim());
  const humanDone = state.step === '人工測試通過' || (snap.state.pipeline.status === 'complete' && column(task, state) === 'done');
  const dependency: GateResult = missing.length ? { text: `尚有 ${missing.length} 項未完成`, status: 'pending' } : { text: '已滿足', status: 'pass' };
  return [
    { label: '依賴', ...dependency },
    { label: '驗證', ...checkGate(verified, state.last_check_ok, configured) },
    { label: '審查', ...reviewGate(state.review_verdict) },
    { label: '人工驗收', text: humanDone ? '已確認' : '等待人工確認', status: humanDone ? 'pass' : 'pending' },
  ];
}

export interface MetaRow { label: string; value: string; cls?: 'ok' | 'bad' | 'mono' }

/** 驗證那一列：沒有指令、尚未執行、通過或失敗。 */
function checkMeta(hasChecks: boolean, ok: boolean | null | undefined): [string, MetaRow['cls']] {
  if (!hasChecks) return ['未設定指令', undefined];
  if (ok == null) return ['尚未執行', undefined];
  return ok ? ['通過', 'ok'] : ['失敗', 'bad'];
}

/** 審查那一列的文字：人工接受、各家審查結果，或單一結論。 */
function reviewMetaText(state: TaskState): string {
  const verdict = state.review_verdict;
  if (verdict === 'ACCEPTED') return '人工接受';
  if (verdict && state.review_verdicts) return Object.entries(state.review_verdicts).map(([p, v]) => `${PROVIDER_LABEL[p] || p} ${v}`).join(' · ');
  return verdict || '—';
}

function verdictClass(verdict: string | undefined): MetaRow['cls'] {
  if (!verdict) return undefined;
  return PASSING.includes(verdict) ? 'ok' : 'bad';
}

/** 執行資訊：步驟、修正輪數、嘗試次數、驗證、審查、commit。 */
export function taskMeta(snap: Snapshot, state: TaskState, detail: TaskDetail): MetaRow[] {
  const hasChecks = checksConfigured(snap) || !!detail.checks?.trim();
  const check = checkMeta(hasChecks, state.last_check_ok);
  return [
    { label: '步驟', value: state.step || state.phase || '未開始' },
    { label: '修正輪數', value: `${state.fix_round || 0} / ${snap.config.max_fix_rounds}` },
    { label: '嘗試次數', value: String(state.attempts || 0) },
    { label: '驗證', value: check[0], cls: check[1] },
    { label: '審查', value: reviewMetaText(state), cls: verdictClass(state.review_verdict) },
    { label: 'commit', value: state.commit ? state.commit.slice(0, 8) : '—', cls: 'mono' },
  ];
}

/** 流程忙碌的原因：有後端防呆就用防呆，否則只看執行器是否在跑。 */
function busyReason(snap: Snapshot): string {
  if (snap.guards) return snap.guards['backlog.draft'] || '';
  return snap.runnerAlive ? '流程執行中' : '';
}

/** 審查未通過而卡住的任務才顯示「接受目前結果」；規則與後端 guards::task_accept 相同。 */
export function acceptReason(snap: Snapshot, state: TaskState): { show: boolean; reason: string | null } {
  if (state.phase !== 'stuck' || !state.review_verdict || PASSING.includes(state.review_verdict)) return { show: false, reason: null };
  const busy = busyReason(snap);
  if (busy) return { show: true, reason: busy };
  if (state.last_check_ok === false) return { show: true, reason: '驗證指令沒有通過，請先修好或重新執行' };
  return { show: true, reason: null };
}

export function revertTitle(state: TaskState) {
  return state.commit ? `會 git revert ${state.commit.slice(0, 8)}` : '手動模式沒有 commit：會把這個任務改過的檔案還原到任務開始前（之後任務對同檔案的修改也會一起還原）';
}

/** 人工編輯任務時要改的是子任務本體（detail.task 帶 parent）。 */
export function editableTask(detail: TaskDetail): Task {
  const task = detail.task;
  if (task.parent) {
    const subId = String(detail.id).split('.')[1];
    const found = task.parent.subtasks?.find((child) => String(child.id) === subId);
    if (found) return found as Task;
  }
  return task;
}

export type FieldType = 'input' | 'select' | 'textarea' | 'lines' | 'dependencies';
export const EDIT_FIELDS: [keyof Task & string, string, FieldType][] = [
  ['title', '標題', 'input'],
  ['priority', '優先序', 'select'],
  ['description', '需求說明', 'textarea'],
  ['details', '實作說明／限制', 'textarea'],
  ['acceptanceCriteria', '驗收條件（每行一項）', 'lines'],
  ['manualChecks', '人工驗收：只有你能做的檢查，AI 不做也不審（每行一項）', 'lines'],
  ['testStrategy', '驗證方式', 'textarea'],
  ['dependencies', '依賴的任務 ID（逗號分隔；子任務可用完整 ID）', 'dependencies'],
  ['requirement_ids', '對應需求 ID（每行一項）', 'lines'],
  ['skills', 'Skills 名稱（每行一項）', 'lines'],
];

export function fieldToText(task: Task, key: string, type: FieldType): string {
  const value = task[key];
  if (type === 'lines') return ((value as string[]) || []).join('\n');
  if (type === 'dependencies') return ((value as (string | number)[]) || []).join(', ');
  if (key === 'priority') return (value as string) || 'medium';
  return (value as string) || '';
}

export function textToField(text: string, type: FieldType): string | string[] {
  if (type === 'lines') return text.split('\n').map((s) => s.trim()).filter(Boolean);
  if (type === 'dependencies') return text.split(/[,，\s]+/).filter(Boolean);
  return text;
}

/** 沒有後端防呆時，前端自己判斷能不能開始執行。 */
function localStartGuard(snap: Snapshot, busy: boolean, approved: boolean): string {
  return busy || !snap.tasks.length || snap.state.prd.status !== 'approved' || !approved ? '目前不能開始' : '';
}

/** 依後端防呆算出看板主要動作的狀態。 */
export function boardActions(snap: Snapshot) {
  const busy = anyBusy(snap);
  const human = needsHuman(snap);
  const approved = tasksApproved(snap);
  const guard = (name: string) => snap.guards?.[name] || '';
  return {
    approved,
    approveGuard: approved ? '任務已核准' : guard('tasks.approve'),
    approveText: approved ? '任務已核准' : '檢視後核准任務',
    startGuard: snap.guards ? guard('run.start') : localStartGuard(snap, busy, approved),
    pauseDisabled: !snap.runnerAlive || !!snap.state.control.pause_requested,
    continueDisabled: busy || !human,
    continuePrimary: human && !busy,
    settingsGuard: guard('project.settings'),
  };
}

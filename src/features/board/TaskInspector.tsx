// 任務詳情（檢視面板）：執行資訊、完成條件、動作，以及即時 log／test 輸出／審查意見／diff／任務內容。
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Check, ChevronDown, Pencil, RotateCcw, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { GuardButton } from '@/components/app/GuardButton';
import { Markdown } from '@/components/app/Markdown';
import { LogTree } from '@/components/app/LogTree';
import { DiffView } from '@/components/app/DiffView';
import { Chip } from '@/components/app/StatusPill';
import { Notice, Loading } from '@/components/app/Page';
import { confirmDialog } from '@/components/app/confirm';
import { ReferenceWidget, referenceOptions } from '@/features/references/ReferenceWidget';
import { runAction } from '@/lib/actions';
import { PRIORITY_TEXT, PROVIDER_LABEL, TASK_STATUS_TEXT } from '@/lib/constants';
import { boardFacts, reviewCounts, verdictOf } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProject } from '@/stores/project';
import type { Snapshot, Task, TaskDetail, TaskState } from '@/types/api';
import { acceptReason, revertTitle, taskGates, taskMeta } from './board-logic';
import { TaskEditDialog } from './TaskEditDialog';

type SubTab = 'log' | 'checks' | 'reviews' | 'diff' | 'task';

/** 任務內容：用標籤、段落與清單呈現任務欄位，不顯示原始 JSON。 */
export function TaskContent({ task, implement, done }: { task: Task; implement?: string; done: Set<string> }) {
  const chipRow = (label: string, items: { text: string; tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info'; title?: string; mono?: boolean }[]) => items.length ? (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {items.map((item, i) => <Chip key={i} tone={item.tone} title={item.title} className={cn(item.mono && 'mono')}>{item.text}</Chip>)}
    </div>
  ) : null;
  const section = (title: string, content: React.ReactNode) => content ? (
    <section className="grid gap-1">
      <h4 className="text-xs font-semibold text-muted-foreground">{title}</h4>
      {content}
    </section>
  ) : null;
  const text = (value?: string) => (typeof value === 'string' && value.trim() ? <Markdown small text={value} /> : null);
  const list = <T,>(items: T[] | undefined, render: (item: T, i: number) => React.ReactNode, manual = false) => items?.length ? (
    <ul className="grid gap-1">
      {items.map((item, i) => <li key={i} className={cn('rounded-md border px-2 py-1', manual ? 'border-warn/40 bg-warn-soft/40' : 'bg-surface-2')}>{render(item, i)}</li>)}
    </ul>
  ) : null;
  const statusTone = (status?: string) => (status === 'done' ? 'ok' : status === 'blocked' ? 'bad' : status === 'in-progress' || status === 'review' ? 'info' : 'neutral');
  const blocks = [
    chipRow('狀態', [{ text: TASK_STATUS_TEXT[task.status || 'pending'] || task.status || '待處理', tone: statusTone(task.status) }]),
    task.priority ? chipRow('優先順序', [{ text: PRIORITY_TEXT[task.priority] || task.priority, tone: task.priority === 'high' ? 'warn' : 'neutral' }]) : null,
    chipRow('依賴', (task.dependencies || []).map((id) => ({ text: `#${id}`, tone: done.has(String(id)) ? 'ok' : 'neutral', title: done.has(String(id)) ? '已完成' : '尚未完成' }))),
    chipRow('對應需求', (task.requirement_ids || []).map((id) => ({ text: id, mono: true }))),
    chipRow('技能', (task.skills || []).map((name) => ({ text: name, tone: 'info' }))),
    section('說明', text(task.description)),
    section('實作細節', text(task.details)),
    section('驗收條件', list(task.acceptanceCriteria, (item) => <Markdown small text={String(item)} />)),
    section('人工驗收（你自己測，AI 不做也不審）', list(task.manualChecks, (item) => <Markdown small text={String(item)} />, true)),
    section('測試策略', text(task.testStrategy)),
    section(`子任務（${(task.subtasks || []).length}）`, list(task.subtasks, (sub) => (
      <div className="grid gap-1">
        <div className="flex items-center gap-2"><span className="mono text-[11px]">{task.id}.{sub.id}</span><b>{sub.title || ''}</b><Chip tone={statusTone(sub.status)}>{TASK_STATUS_TEXT[sub.status || 'pending'] || sub.status || '待處理'}</Chip></div>
        {(sub.description || sub.details) && <Markdown small text={[sub.description, sub.details].filter(Boolean).join('\n\n')} />}
      </div>
    ))),
    section('實作回報', text(implement)),
  ].filter(Boolean);
  return <div className="grid gap-3 p-1">{blocks.length ? blocks : <p className="text-xs text-muted-foreground">（這個任務沒有其他內容）</p>}</div>;
}

/** 每次審查一列（最新的在上面）；雙人審查時 Claude 與 Codex 的意見並排。 */
export function ReviewsView({ reviews }: { reviews: TaskDetail['reviews'] }) {
  if (!reviews?.length) return <p className="p-1 text-xs text-muted-foreground">（尚無審查意見）</p>;
  const byRound = new Map<number, TaskDetail['reviews']>();
  for (const r of reviews) byRound.set(r.round, [...(byRound.get(r.round) || []), r]);
  return (
    <div className="grid gap-3 p-1">
      {[...byRound].reverse().map(([round, list]) => (
        <section key={round} className="grid gap-1.5">
          <h4 className="text-xs font-semibold text-muted-foreground">第 {round} 次審查{list.length > 1 ? '・雙人審查' : ''}</h4>
          <div className={cn('grid gap-2', list.length > 1 && 'md:grid-cols-2')}>
            {list.map((r) => {
              const verdict = verdictOf(r.text);
              const { must, suggest } = reviewCounts(r.text);
              const pass = ['PASS', 'APPROVE'].includes(verdict);
              return (
                <div key={r.name} className={cn('rounded-md border p-2', verdict && (pass ? 'border-ok/40' : 'border-danger/40'))}>
                  <div className="mb-1 flex flex-wrap items-center gap-1.5">
                    <Chip tone={r.provider === 'codex' ? 'review' : 'info'}>{PROVIDER_LABEL[r.provider] || '審查者'}</Chip>
                    <Chip tone={verdict ? (pass ? 'ok' : 'bad') : 'neutral'}>{verdict || '未判定'}</Chip>
                    {(must || suggest) ? <span className="text-[11px] text-muted-foreground">{[must && `必須修正 ${must}`, suggest && `建議 ${suggest}`].filter(Boolean).join('・')}</span> : null}
                  </div>
                  <Markdown small text={r.text} />
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

function Gates({ snap, task, state, detail }: { snap: Snapshot; task: Task; state: TaskState; detail: TaskDetail | null }) {
  const done = boardFacts(snap, '', 'all').done;
  const gates = taskGates(snap, task, state, detail, done);
  return (
    <section aria-labelledby="d-gates-title" className="grid gap-1.5">
      <h3 id="d-gates-title" className="text-xs font-semibold text-muted-foreground">完成條件</h3>
      <ul className="grid grid-cols-2 gap-1.5">
        {gates.map((g) => (
          <li key={g.label} className={cn('flex items-center gap-2 rounded-md bg-surface-2 px-2 py-1.5', `gate-${g.status}`)}>
            <span aria-hidden="true" className={cn('grid size-5 shrink-0 place-items-center rounded-full bg-card text-muted-foreground', g.status === 'pass' && 'bg-ok-soft text-ok', g.status === 'fail' && 'bg-danger-soft text-danger')}>
              {g.status === 'pass' ? <Check className="size-3" /> : g.status === 'fail' ? <AlertTriangle className="size-3" /> : '—'}
            </span>
            <span className="flex min-w-0 flex-col text-[11px] text-muted-foreground"><b className="text-xs text-foreground">{g.label}</b><span>{g.text}</span></span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface TaskInspectorProps { id: string; onClose: () => void; autoEdit?: boolean; onAutoEditHandled?: () => void }

export function TaskInspector({ id, onClose, autoEdit, onAutoEditHandled }: TaskInspectorProps) {
  const snap = useProject((s) => s.snap)!;
  const api = useProject((s) => s.api);
  const liveLog = useProject((s) => s.logs[`task-${id}`]);
  // AI 正在打字的文字（還沒進 log）。
  const typing = useProject((s) => s.streams[`task-${id}`] || '');
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [subtab, setSubtab] = useState<SubTab>('log');
  const [revert, setRevert] = useState(false);
  const [editing, setEditing] = useState(false);
  const selection = useRef(0);
  const title = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async (first = false) => {
    const current = ++selection.current;
    try {
      const data = await api<TaskDetail>(`/api/task/${id}`);
      if (current !== selection.current) return;
      setDetail(data); setError('');
      // 即時 log 以詳情的完整內容為起點，之後只接串流新增的部分。
      useProject.setState((s) => { const full = new Set(s.logsFull); full.add(`task-${id}`); return { logs: { ...s.logs, [`task-${id}`]: data.log || '' }, logsFull: full }; });
      if (first) title.current?.focus({ preventScroll: true });
    } catch (err) {
      if (current !== selection.current) return;
      setError((err as Error).message);
      toast.error((err as Error).message);
    }
  }, [api, id]);

  useEffect(() => { setDetail(null); setError(''); setRevert(false); load(true); }, [id, load]);
  // 狀態更新後重新讀取詳情（去抖 300ms，與舊版相同）。
  useEffect(() => { const t = setTimeout(() => load(), 300); return () => clearTimeout(t); }, [snap, load]);
  useEffect(() => { if (autoEdit && detail) { setEditing(true); onAutoEditHandled?.(); } }, [autoEdit, detail, onAutoEditHandled]);

  const state: TaskState = detail?.state || {};
  const task = detail?.task;
  const guard = (name: string) => snap.guards?.[name] || '';
  const accept = acceptReason(snap, state);
  const rerunGuard = snap.guards ? guard('task.rerun') : snap.runnerAlive ? '流程執行中' : '';

  const onAccept = async () => {
    const ok = await confirmDialog({ title: `接受任務 ${id} 目前的實作？`, description: '會重新跑一次驗證指令，通過後不再送審查，直接進入人工驗收。審查意見會保留在「審查意見」分頁。', confirmText: '接受' });
    if (!ok) return;
    runAction(api, snap, '/api/task/accept', { id }, `任務 ${id} 已接受，重新驗證中`);
  };
  const onRerun = async () => {
    if (revert && !(await confirmDialog({ title: '會還原這個任務的變更後重跑，確定？', confirmText: '還原並重跑', destructive: true }))) return;
    runAction(api, snap, '/api/task/rerun', { id, revert }, `任務 ${id} 重跑中`);
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-task-inspector onKeyDown={(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); onClose(); } }}>
      <div className="flex shrink-0 items-start gap-2 border-b px-3 py-2">
        <h2 ref={title} tabIndex={-1} className="min-w-0 flex-1 text-[14px] font-semibold leading-5 break-words outline-none">
          {detail ? `#${detail.id} ${task?.title || ''}` : error ? `任務 #${id} 載入失敗` : `載入任務 #${id}`}
        </h2>
        <Button type="button" variant="ghost" size="icon-sm" aria-label="關閉任務詳情" onClick={onClose}><X /></Button>
      </div>
      {error && !detail ? (
        <div className="p-3 text-xs"><span>{error} </span><Button type="button" size="sm" variant="outline" onClick={() => load(true)}>重新讀取</Button></div>
      ) : !detail || !task ? (
        <Loading inline label="載入任務…" className="px-3 py-3" />
      ) : (
        <>
          <div className="grid shrink-0 gap-3 overflow-y-auto border-b px-3 py-2" style={{ maxHeight: '45%' }}>
            <div data-reference-drop="task"><ReferenceWidget options={referenceOptions('task', { taskId: id, taskStatus: task.status, taskReferences: task.references })} /></div>
            {state.phase === 'stuck' && state.error && (
              <Notice tone="bad" className="grid gap-1" role="status">
                <strong>卡住原因：{state.error}</strong>
                {Array.isArray(state.stuck_reasons) && state.stuck_reasons.length > 0 && (
                  <>
                    <p>最後一次審查要求修正的項目（完整內容在「審查意見」分頁）：</p>
                    <ul className="list-disc pl-4">{state.stuck_reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </>
                )}
              </Notice>
            )}
            <Collapsible>
              <CollapsibleTrigger className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">執行資訊與 commit<ChevronDown className="size-3" /></CollapsibleTrigger>
              <CollapsibleContent>
                <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
                  {taskMeta(snap, state, detail).map((row) => (
                    <div key={row.label} className="flex min-w-0 gap-2"><dt className="shrink-0 text-muted-foreground">{row.label}</dt><dd title={row.value} className={cn('min-w-0 truncate', row.cls === 'ok' && 'text-ok', row.cls === 'bad' && 'text-danger', row.cls === 'mono' && 'mono')}>{row.value}</dd></div>
                  ))}
                </dl>
              </CollapsibleContent>
            </Collapsible>
            <Gates snap={snap} task={task} state={state} detail={detail} />
            <div className="flex flex-wrap items-center gap-2">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Label className="flex items-center gap-1.5 text-[11px]"><Checkbox id="d-revert" checked={revert} onCheckedChange={(v) => setRevert(v === true)} />重跑前還原這個任務的變更</Label>
                </TooltipTrigger>
                <TooltipContent className="max-w-xs">{revertTitle(state)}</TooltipContent>
              </Tooltip>
              <span className="flex-1" />
              <GuardButton type="button" variant="outline" size="sm" guard={snap.guards ? guard('task.edit') : ''} onClick={() => setEditing(true)}><Pencil />人工編輯任務</GuardButton>
              {accept.show && <GuardButton type="button" variant="outline" size="sm" guard={accept.reason || ''} title="審查未通過但你接受目前的實作：重新跑驗證，通過後跳過審查，進入人工驗收" onClick={onAccept}><Check />接受目前結果</GuardButton>}
              <GuardButton type="button" variant="outline" size="sm" guard={rerunGuard} onClick={onRerun}><RotateCcw />重跑任務</GuardButton>
            </div>
          </div>
          <Tabs value={subtab} onValueChange={(v) => setSubtab(v as SubTab)} className="min-h-0 flex-1 gap-0">
            <TabsList variant="line" className="w-full shrink-0 justify-start overflow-x-auto border-b px-2" aria-label="任務詳情內容">
              <TabsTrigger value="log" className="flex-none">即時 log</TabsTrigger>
              <TabsTrigger value="checks" className="flex-none">test 輸出</TabsTrigger>
              <TabsTrigger value="reviews" className="flex-none">審查意見</TabsTrigger>
              <TabsTrigger value="diff" className="flex-none">diff</TabsTrigger>
              <TabsTrigger value="task" className="flex-none">任務內容</TabsTrigger>
            </TabsList>
            <TabsContent value="log" className="min-h-0 flex-1 overflow-hidden p-2"><LogTree text={liveLog ?? detail.log} live={typing} className="h-full" /></TabsContent>
            <TabsContent value="checks" className="min-h-0 flex-1 overflow-auto p-2"><pre className="mono selectable whitespace-pre-wrap text-xs">{detail.checks || '（尚未執行驗證）'}</pre></TabsContent>
            <TabsContent value="reviews" className="min-h-0 flex-1 overflow-auto p-2"><ReviewsView reviews={detail.reviews} /></TabsContent>
            <TabsContent value="diff" className="min-h-0 flex-1 overflow-hidden p-2"><DiffView text={detail.diff} className="h-full" /></TabsContent>
            <TabsContent value="task" className="min-h-0 flex-1 overflow-auto p-2"><TaskContent task={task} implement={detail.implement} done={boardFacts(snap, '', 'all').done} /></TabsContent>
          </Tabs>
          <TaskEditDialog detail={detail} open={editing} onOpenChange={setEditing} onSaved={() => load()} />
        </>
      )}
    </div>
  );
}

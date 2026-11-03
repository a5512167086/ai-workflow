// 任務看板：五欄看板或任務藍圖，右側是可拉寬的任務檢視面板；窄視窗時詳情改為覆蓋式面板。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, Check, Link2, Pause, Pencil, Play, Search, StepForward } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { useDefaultLayout } from 'react-resizable-panels';
import { Page, PageHeader, Hint, Notice, EmptyState, Eyebrow } from '@/components/app/Page';
import { GuardButton } from '@/components/app/GuardButton';
import { Chip } from '@/components/app/StatusPill';
import { ReferenceWidget, referenceOptions } from '@/features/references/ReferenceWidget';
import { act } from '@/lib/api';
import { runAction } from '@/lib/actions';
import { COLUMNS, COLUMN_LABELS, PRIORITY_TEXT } from '@/lib/constants';
import { boardFacts, childTasks, column, type BoardFacts, type BoardFilter } from '@/lib/format';
import { readStorage, writeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { ProgressBar } from '@/components/app/ProgressBar';
import { useBadges } from '@/stores/badges';
import { useProject } from '@/stores/project';
import type { Column, Snapshot, Task } from '@/types/api';
import { boardActions, boardMetrics, featureTitle, humanNote, needsHuman } from './board-logic';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { TaskInspector } from './TaskInspector';
import { useMediaQuery } from './use-media-query';

type BoardView = 'kanban' | 'roadmap';
const COLUMN_BAR: Record<Column, string> = { todo: 'bg-muted-foreground/50', doing: 'bg-info', review: 'bg-review', test: 'bg-warn', done: 'bg-ok' };
const STAGE_TONE: Record<Column, 'neutral' | 'info' | 'review' | 'warn' | 'ok'> = { todo: 'neutral', doing: 'info', review: 'review', test: 'warn', done: 'ok' };
const PRIORITY_BORDER: Record<string, string> = { high: 'border-l-danger', medium: 'border-l-info', low: 'border-l-muted-foreground/40' };

/** 藍圖卡片的完成度：有子任務看子任務完成比例，沒有就看任務本身完成了沒。 */
function taskPercent(completed: number, total: number, selfDone: boolean): number {
  if (total) return Math.round((completed / total) * 100);
  return selfDone ? 100 : 0;
}

function TaskCard({ task, snap, facts, selected, onSelect, onEdit, onRerun }: Readonly<{ task: Task; snap: Snapshot; facts: BoardFacts; selected: boolean; onSelect: () => void; onEdit: () => void; onRerun: () => void }>) {
  const ts = facts.stateFor(task);
  const col = column(task, ts);
  const stuck = ts.phase === 'stuck';
  const children = childTasks(task);
  const remaining = facts.unmet(task).length;
  const priority = task.priority && ['high', 'medium', 'low'].includes(task.priority) ? task.priority : 'medium';
  const maxFix = snap.config.max_fix_rounds || 1;
  const fixPct = ts.fix_round ? Math.min(100, Math.round((ts.fix_round / maxFix) * 100)) : 0;
  const editGuard = snap.guards?.['task.edit'] || '';
  const rerunGuard = snap.guards?.['task.rerun'] || '';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          data-task-id={String(task.id)}
          data-priority={priority}
          aria-pressed={selected}
          onClick={onSelect}
          className={cn(
            'grid w-full gap-1 rounded-md border border-l-[3px] bg-card p-2 text-left text-xs outline-none transition-colors hover:border-muted-foreground/60 focus-visible:ring-2 focus-visible:ring-ring',
            PRIORITY_BORDER[priority], stuck && 'border-danger bg-danger-soft/30', selected && 'ring-2 ring-primary',
          )}
        >
          <div className="flex flex-wrap items-center gap-1">
            <span className="mono text-[11px] font-medium">#{task.id}</span>
            {task.priority && <Chip tone={task.priority === 'high' ? 'warn' : 'neutral'}>{PRIORITY_TEXT[task.priority] || task.priority}優先</Chip>}
            <Chip tone={stuck ? 'bad' : STAGE_TONE[col]}>{stuck ? '需要處理' : COLUMN_LABELS[col]}</Chip>
          </div>
          <div className="font-medium leading-snug break-words">{task.title}</div>
          {!!task.dependencies?.length && (
            <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
              <Link2 className="size-3" /><span>依賴</span>
              {task.dependencies.map((d) => { const met = facts.done.has(String(d)); return <span key={String(d)} title={met ? `#${d} 已完成` : `#${d} 尚未完成`} className={cn('mono rounded border px-1', met ? 'border-ok/40 text-ok line-through' : 'border-border')}>#{d}</span>; })}
            </div>
          )}
          {ts.step && (
            <>
              <div className="truncate text-[11px] text-muted-foreground" title={ts.step}>{ts.step}{ts.fix_round ? `（修正 ${ts.fix_round}/${snap.config.max_fix_rounds}）` : ''}</div>
              {!!ts.fix_round && <div className="h-1 overflow-hidden rounded bg-surface-2" aria-hidden="true"><span className="block h-full bg-warn" style={{ width: `${fixPct}%` }} /></div>}
            </>
          )}
          {(ts.error || stuck) && <div className="flex items-start gap-1 text-[11px] text-danger"><AlertTriangle className="mt-px size-3 shrink-0" /><span className="break-words">{ts.error || '需要處理'}</span></div>}
          <div className="flex flex-wrap gap-1 empty:hidden">
            {remaining > 0 && col !== 'done' && <Chip tone="bad">{remaining} 項依賴未完成</Chip>}
            {col === 'test' && <Chip tone="warn">需要人工驗收</Chip>}
            {children.length > 0 && <Chip>子任務 {children.filter((sub) => facts.done.has(sub.id)).length}/{children.length}</Chip>}
            {ts.last_check_ok != null && <Chip tone={ts.last_check_ok ? 'ok' : 'bad'}>驗證{ts.last_check_ok ? '通過' : '失敗'}</Chip>}
          </div>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onSelect}>開啟詳情</ContextMenuItem>
        <ContextMenuItem disabled={!!editGuard} onSelect={onEdit}>人工編輯任務{editGuard && <span className="ml-auto pl-2 text-[11px] text-muted-foreground">{editGuard}</span>}</ContextMenuItem>
        <ContextMenuItem disabled={!!rerunGuard} onSelect={onRerun}>重跑任務{rerunGuard && <span className="ml-auto pl-2 text-[11px] text-muted-foreground">{rerunGuard}</span>}</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function Kanban({ snap, facts, selected, onSelect, onEdit, onRerun }: Readonly<{ snap: Snapshot; facts: BoardFacts; selected: string | null; onSelect: (id: string) => void; onEdit: (id: string) => void; onRerun: (id: string) => void }>) {
  const byCol = useMemo(() => {
    const map: Record<Column, Task[]> = { todo: [], doing: [], review: [], test: [], done: [] };
    for (const t of snap.tasks) if (facts.visible.includes(t)) map[column(t, facts.stateFor(t))].push(t);
    return map;
  }, [snap.tasks, facts]);
  return (
    <div className="grid h-full min-h-0 auto-cols-[minmax(220px,1fr)] grid-flow-col gap-2 overflow-x-auto p-3" id="board">
      {COLUMNS.map(([key, label]) => {
        const items = byCol[key];
        return (
          <section key={key} data-col={key} aria-label={label} className="flex min-h-0 flex-col rounded-lg border bg-surface-2/60">
            <div className={cn('h-1 shrink-0 rounded-t-lg', COLUMN_BAR[key])} aria-hidden="true" />
            <h3 className="flex shrink-0 items-center justify-between px-2 py-1.5 text-xs font-semibold"><span>{label}</span><span className="mono text-muted-foreground">{facts.filtered ? `${items.length} / ${facts.counts[key]}` : facts.counts[key]}</span></h3>
            <div className="grid min-h-0 flex-1 content-start gap-2 overflow-y-auto px-2 pb-2">
              {items.length ? items.map((t) => (
                <TaskCard key={String(t.id)} task={t} snap={snap} facts={facts} selected={selected === String(t.id)} onSelect={() => onSelect(String(t.id))} onEdit={() => onEdit(String(t.id))} onRerun={() => onRerun(String(t.id))} />
              )) : <p className="py-2 text-center text-[11px] text-muted-foreground">{facts.filtered ? '此欄沒有符合的任務' : '此階段尚無任務'}</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/** 任務藍圖：功能 → 任務 → 子任務的完成度。 */
function Roadmap({ facts, selected, onSelect }: Readonly<{ facts: BoardFacts; selected: string | null; onSelect: (id: string) => void }>) {
  return (
    <div id="task-roadmap" aria-label="功能與任務藍圖" className="grid h-full min-h-0 content-start gap-2 overflow-y-auto p-3">
      {facts.visible.map((task) => {
        const children = childTasks(task);
        const state = facts.stateFor(task), stage = column(task, state);
        const completed = children.filter((sub) => facts.done.has(String(sub.id))).length;
        const percent = taskPercent(completed, children.length, facts.done.has(String(task.id)));
        const unmet = facts.unmet(task).length;
        return (
          <article key={String(task.id)} className="grid gap-1.5 rounded-lg border bg-card p-3">
            <button type="button" data-task-id={String(task.id)} aria-pressed={selected === String(task.id)} onClick={() => onSelect(String(task.id))} className={cn('flex items-center gap-2 rounded px-1 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', selected === String(task.id) && 'ring-2 ring-primary')}>
              <span className="mono text-[11px]">#{task.id}</span><strong className="min-w-0 flex-1 break-words">{task.title}</strong><Chip tone={STAGE_TONE[stage]}>{COLUMN_LABELS[stage]}</Chip>
            </button>
            <ProgressBar value={percent} label={`${task.title}完成度`} />
            <Hint>{children.length ? `${completed} / ${children.length} 子任務完成` : '獨立任務'}{unmet ? ` · ${unmet} 項依賴未完成` : ''}</Hint>
            {children.map((sub) => {
              if (facts.filtered && !facts.matches(sub) && !facts.matches(task)) return null;
              const subState = facts.stateFor(sub), subStage = column(sub, subState);
              return (
                <button key={sub.id} type="button" data-task-id={sub.id} aria-pressed={selected === sub.id} onClick={() => onSelect(sub.id)} className={cn('flex items-center gap-2 rounded px-1 py-0.5 text-left text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring', selected === sub.id && 'ring-2 ring-primary')}>
                  <span className={cn('size-1.5 shrink-0 rounded-full', COLUMN_BAR[subStage])} aria-hidden="true" />
                  <span className="mono text-[11px]">#{sub.id}</span><span className="min-w-0 flex-1 break-words">{sub.title}</span>
                  <Chip tone={subState.phase === 'stuck' ? 'bad' : STAGE_TONE[subStage]}>{subState.phase === 'stuck' ? '需要處理' : COLUMN_LABELS[subStage]}</Chip>
                </button>
              );
            })}
          </article>
        );
      })}
    </div>
  );
}

export function BoardPage() {
  const snap = useProject((s) => s.snap)!;
  const api = useProject((s) => s.api);
  const refresh = useProject((s) => s.refresh);
  const [params, setParams] = useSearchParams();
  const selected = params.get('task');
  const [view, setView] = useState<BoardView>(() => (readStorage('ai-workflow-board-view') === 'roadmap' ? 'roadmap' : 'kanban'));
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<BoardFilter>('all');
  const [refsOpen, setRefsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoEdit, setAutoEdit] = useState(false);
  const [quotaDismissed, setQuotaDismissed] = useState('');
  const narrow = useMediaQuery('(max-width: 999px)');
  // 看板／檢視面板的分欄比例記在 localStorage。
  const layout = useDefaultLayout({ id: 'ai-workflow.board', panelIds: ['board-canvas', 'board-inspector'] });
  const lastSelected = useRef<string | null>(null);
  const workspace = useRef<HTMLDivElement>(null);

  const facts = useMemo(() => boardFacts(snap, query, filter), [snap, query, filter]);
  const { metrics, percent, completed } = useMemo(() => boardMetrics(snap, facts), [snap, facts]);
  const actions = boardActions(snap);
  const human = needsHuman(snap);
  const tasks = snap.tasks;

  useEffect(() => {
    useBadges.getState().set('board', tasks.length ? { text: `${facts.counts.done}/${tasks.length}`, attention: human } : null);
  }, [tasks.length, facts.counts.done, human]);

  const select = useCallback((id: string | null) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (id) next.set('task', id);
      else next.delete('task');
      return next;
    }, { replace: true });
  }, [setParams]);
  const close = useCallback(() => {
    const id = selected;
    select(null);
    // 關閉後把焦點還給原本的任務卡
    requestAnimationFrame(() => { workspace.current?.querySelector<HTMLElement>(`[data-task-id="${CSS.escape(id || '')}"]`)?.focus({ preventScroll: true }); });
  }, [selected, select]);
  useEffect(() => { if (selected) lastSelected.current = selected; }, [selected]);
  // Esc 關閉檢視面板（對話框自己處理的 Esc 不算）。
  useEffect(() => {
    if (!selected) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (e.target instanceof Element && e.target.closest('[role="dialog"], [role="alertdialog"], [data-task-inspector]')) return;
      close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, close]);

  const chooseView = (v: BoardView) => { setView(v); writeStorage('ai-workflow-board-view', v); };
  const onEdit = (id: string) => { setAutoEdit(true); select(id); };
  const onRerun = (id: string) => runAction(api, snap, '/api/task/rerun', { id, revert: false }, `任務 ${id} 重跑中`);
  const approve = async () => {
    try { await api('/api/tasks/approve', { revision: snap.taskRevision }); await refresh(); toast.success('任務已核准，可開始執行'); }
    catch (err) { toast.error((err as Error).message); }
  };
  const blocked = snap.state.usage_blocked;
  const showQuota = !!blocked && quotaDismissed !== JSON.stringify(blocked) && !snap.runnerAlive && ['stuck', 'error'].includes(snap.state.pipeline.status);
  const refCount = snap.taskReferences?.length || 0;

  const inspector = selected && (
    <TaskInspector key={selected} id={selected} onClose={close} autoEdit={autoEdit} onAutoEditHandled={() => setAutoEdit(false)} />
  );
  const canvas = view === 'roadmap'
    ? <Roadmap facts={facts} selected={selected} onSelect={select} />
    : <Kanban snap={snap} facts={facts} selected={selected} onSelect={select} onEdit={onEdit} onRerun={onRerun} />;

  return (
    <Page>
      <PageHeader
        title={featureTitle(snap)}
        description={humanNote(snap)}
        actions={(
          <>
            <Button type="button" variant="outline" size="sm" aria-haspopup="dialog" aria-label={`功能共用參考：${refCount} 份`} onClick={() => setRefsOpen(true)}><Link2 />{refCount ? `參考 ${refCount}` : '參考'}</Button>
            <GuardButton type="button" variant="outline" size="sm" aria-haspopup="dialog" guard={actions.settingsGuard} onClick={() => setSettingsOpen(true)}><Pencil />專案指令</GuardButton>
            <GuardButton id="btn-task-approve" type="button" variant="outline" size="sm" guard={actions.approveGuard} disabled={actions.approved} onClick={approve}><Check />{actions.approveText}</GuardButton>
            <GuardButton id="btn-start" type="button" size="sm" variant={actions.continuePrimary ? 'outline' : 'default'} guard={actions.startGuard} onClick={() => runAction(api, snap, '/api/run/start', {}, '流程已開始')}><Play />開始</GuardButton>
            <Button id="btn-pause" type="button" variant="outline" size="sm" disabled={actions.pauseDisabled} onClick={() => act(api, '/api/run/pause', {}, '目前任務結束後會暫停')}><Pause />暫停</Button>
            <Button id="btn-continue" type="button" size="sm" variant={actions.continuePrimary ? 'default' : 'outline'} disabled={actions.continueDisabled} onClick={() => runAction(api, snap, '/api/run/continue', {}, '繼續')}><StepForward />我測完了，繼續</Button>
          </>
        )}
      />
      {showQuota && blocked && (
        <Notice tone="warn" className="mx-4 mt-3 flex flex-wrap items-center gap-2">
          <span className="flex-1">{blocked.message}。可確認後改用另一個 AI 繼續；實作與審查會分開建立 session。</span>
          <Button type="button" size="sm" onClick={() => runAction(api, snap, '/api/run/continue', {}, '已改用另一個 AI 繼續')}>確認並以另一個 AI 繼續</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setQuotaDismissed(JSON.stringify(blocked))}>取消</Button>
        </Notice>
      )}
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b px-4 py-2" aria-label="本功能任務進度">
        <div className="flex min-w-48 flex-1 items-center gap-3">
          <div className="min-w-0 flex-1">
            <Eyebrow>目前功能</Eyebrow>
            <ProgressBar value={percent} label="主線任務完成度" className="mt-1" />
          </div>
          <dl id="board-metrics" className="flex items-center gap-4">
            {metrics.map((m) => (
              <div key={m.label} className={cn('text-xs', m.attention && 'text-danger')}><dt className="text-[11px] text-muted-foreground">{m.label}</dt><dd className="mono font-semibold">{m.value}</dd></div>
            ))}
          </dl>
          <span className="sr-only">{completed} 個主線任務完成</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup type="single" value={view} onValueChange={(v) => v && chooseView(v as BoardView)} variant="outline" size="sm" aria-label="任務檢視">
            <ToggleGroupItem value="kanban" aria-label="看板">看板</ToggleGroupItem>
            <ToggleGroupItem value="roadmap" aria-label="任務藍圖">任務藍圖</ToggleGroupItem>
          </ToggleGroup>
          <div className="relative"><Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" /><Input type="search" aria-label="搜尋任務" placeholder="任務名稱、編號或步驟" className="h-7 w-48 pl-7 text-xs" value={query} onChange={(e) => setQuery(e.target.value)} /></div>
          <Select value={filter} onValueChange={(v) => setFilter(v as BoardFilter)}>
            <SelectTrigger size="sm" aria-label="狀態篩選" className="h-7 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">所有任務</SelectItem>
              <SelectItem value="attention">需要處理</SelectItem>
              <SelectItem value="blocked">依賴未完成</SelectItem>
              <SelectItem value="active">進行與審查中</SelectItem>
              <SelectItem value="done">已完成</SelectItem>
            </SelectContent>
          </Select>
          <Hint role="status">顯示 {facts.visible.length} / {tasks.length} 項主線任務</Hint>
          {facts.filtered && <Button type="button" variant="ghost" size="sm" onClick={() => { setQuery(''); setFilter('all'); }}>清除篩選</Button>}
        </div>
      </div>
      <div ref={workspace} className="min-h-0 flex-1">
        {!tasks.length && <EmptyState title="還沒有任務：先在 PRD 頁核准並產生任務" description="核准 PRD 後會自動建立任務看板與藍圖。" />}
        {!!tasks.length && !facts.visible.length && <EmptyState title="沒有符合條件的任務，請調整搜尋或篩選。" />}
        {!!facts.visible.length && (
          // 畫布一直放在同一個分欄容器裡，開關檢視面板不會重新掛載（保留各欄的捲動位置）。
          <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="h-full">
            <ResizablePanel id="board-canvas" defaultSize="55" minSize={320} className="min-w-0">{canvas}</ResizablePanel>
            {selected && !narrow && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel id="board-inspector" defaultSize="45" minSize={360} className="min-w-0 bg-card">{inspector}</ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
      </div>
      {narrow && (
        <Sheet open={!!selected} onOpenChange={(open) => { if (!open) close(); }}>
          <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-xl">
            <SheetTitle className="sr-only">任務詳情</SheetTitle>
            {inspector}
          </SheetContent>
        </Sheet>
      )}
      <Dialog open={refsOpen} onOpenChange={setRefsOpen}>
        <DialogContent className="sm:max-w-xl" data-reference-drop="group">
          <DialogHeader>
            <DialogTitle>功能共用參考</DialogTitle>
            <DialogDescription>這個功能的所有任務都會帶入這些參考；單一任務的額外參考在任務詳情裡加。</DialogDescription>
          </DialogHeader>
          <ReferenceWidget options={referenceOptions('group')} />
        </DialogContent>
      </Dialog>
      <ProjectSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Page>
  );
}

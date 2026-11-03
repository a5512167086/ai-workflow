// 紀錄：左側是目前功能與封存的歷史功能，右側以子分頁切換 Log（只有目前功能）、PRD、每輪紀錄、任務。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { ChevronRight, ChevronsDownUp, ChevronsUpDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Page, Hint, Loading } from '@/components/app/Page';
import { Chip } from '@/components/app/StatusPill';
import { LogTree } from '@/components/app/LogTree';
import { Markdown } from '@/components/app/Markdown';
import { LOG_SCOPE_LABELS, PRIORITY_TEXT, PROVIDER_LABEL, ROUND_KIND, TASK_STATUS_TEXT } from '@/lib/constants';
import { dateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProject } from '@/stores/project';
import { ArchivedTask } from '@/features/records/ArchivedTask';
import type { ArchivePayload, ArchiveSummary, PrdRound, Snapshot, Task, TaskState } from '@/types/api';

type RecordTab = 'log' | 'prd' | 'rounds' | 'tasks';

/** 來源清單：固定的流程 log、目前任務清單裡的每個任務（依編號），再加上串流出現過的其他來源（對話與技能會議的 log 在各自的頁面看）。 */
export function logScopes(snap: Snapshot | null, logs: Record<string, string>): string[] {
  const fixed = ['runner', 'prd', 'tasks'];
  const taskIds = (snap?.tasks || []).map((t) => `task-${t.id}`);
  const known = new Set([...fixed, ...taskIds, 'process']);
  const extra = Object.keys(logs).filter((s) => !known.has(s) && !s.startsWith('chat-') && !s.startsWith('skill-'));
  const num = (s: string) => Number(s.replace(/^task-/, '')) || 0;
  extra.sort((a, b) => (a.startsWith('task-') && b.startsWith('task-') ? num(a) - num(b) : a.localeCompare(b)));
  return [...fixed, ...taskIds, 'process', ...extra];
}

export const scopeLabel = (scope: string) => LOG_SCOPE_LABELS[scope] || scope.replace(/^task-/, '任務 ').replace(/^skill-.*/, 'Skill 會議');

interface RoundView { key: string; title: string; verdict: string; text: string }

/** 從檔名推回結論：approve／pass 算通過，revise／fail 算要修改。 */
function verdictFromName(name: string) {
  if (/approve|pass/i.test(name)) return 'APPROVE';
  return /revise|fail/i.test(name) ? 'REVISE' : '';
}

/** 封存的每輪紀錄只有檔名：從檔名推回種類與結論。 */
export function archiveRounds(rounds: { name: string; text: string }[]): RoundView[] {
  return rounds.map((r) => {
    const parts = r.name.replace(/\.md$/, '').split('-');
    const kind = parts[1] === 'user' ? 'user-feedback' : parts[1];
    return {
      key: r.name,
      title: `${ROUND_KIND[kind] || kind}・${r.name.replace(/\.md$/, '')}`,
      verdict: verdictFromName(r.name),
      text: r.text,
    };
  });
}

/** 目前功能的每輪紀錄：標題帶輪次、種類、AI、結論與版本。 */
function currentRound(r: PrdRound): RoundView {
  const parts = [`第 ${r.round} 輪`, ROUND_KIND[r.kind] || r.kind, PROVIDER_LABEL[r.provider] || r.provider];
  if (r.verdict) parts.push(r.verdict);
  if (r.version) parts.push(`v${r.version}`);
  return { key: `${r.round}-${r.kind}-${r.version || ''}`, title: parts.join('・'), verdict: r.verdict || '', text: r.text || '' };
}

function currentTitle(snap: Snapshot) {
  return (snap.config.feature || snap.state.prd.idea || '目前功能').split('\n')[0];
}

type ArchiveMeta = NonNullable<ArchivePayload['meta']>;

/** 標題下方的摘要：目前功能看 PRD／流程狀態，封存功能看核准與完成時間。 */
function currentMetaRows(snap: Snapshot, done: number): [string, string][] {
  return [['PRD', snap.state.prd.status], ['流程', snap.state.pipeline.status], ['進度', snap.tasks.length ? `${done} / ${snap.tasks.length}` : '—']];
}

function archiveMetaRows(m: ArchiveMeta): [string, string][] {
  return [['核准時間', dateTime(m.approved_at)], ['完成時間', dateTime(m.completed_at)], ['任務群組', m.tm_tag || '—'], ['進度', m.progress?.total ? `${m.progress.done} / ${m.progress.total}` : '—']];
}

/** 右側標題：目前功能、讀到的封存功能，或還在讀取時的資料夾名稱。 */
function recordTitle(snap: Snapshot, selected: string | null, archive: ArchivePayload | null) {
  if (selected === null) return currentTitle(snap);
  if (!archive) return selected;
  const m = archive.meta ?? {};
  // 封存的 feature 可能是空字串：跳過空的，依序退回 idea、資料夾名稱。
  const title = [m.feature, m.idea].find(Boolean) ?? archive.name;
  return title.split('\n')[0];
}

function HistoryItem({ title, meta, active, onClick }: Readonly<{ title: string; meta: string; active: boolean; onClick: () => void }>) {
  return (
    <li>
      <button
        type="button"
        aria-current={active ? 'true' : 'false'}
        onClick={onClick}
        className={cn('flex w-full flex-col items-start gap-0.5 rounded-md border px-2.5 py-2 text-left transition-colors hover:bg-accent', active ? 'border-primary bg-accent' : 'border-transparent')}
      >
        <span className="w-full truncate text-[13px] font-medium">{title}</span>
        <span className="w-full truncate text-[11px] text-muted-foreground">{meta}</span>
      </button>
    </li>
  );
}

function MetaList({ rows }: Readonly<{ rows: [string, string][] }>) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
      {rows.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="truncate" title={v}>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function RoundsView({ list }: Readonly<{ list: RoundView[] }>) {
  if (!list.length) return <p className="text-muted-foreground">（沒有紀錄）</p>;
  return (
    <div className="flex flex-col gap-2">
      {list.map((r) => (
        <details key={r.key} className={cn('rounded-md border', r.verdict === 'APPROVE' && 'border-l-2 border-l-ok', r.verdict === 'REVISE' && 'border-l-2 border-l-warn')}>
          <summary className="cursor-pointer px-3 py-1.5 text-xs font-medium">{r.title}</summary>
          <div className="border-t px-3 py-2"><Markdown text={r.text || '（無內容）'} small /></div>
        </details>
      ))}
    </div>
  );
}

/** 「階段：步驟」；沒有狀態時是空字串。 */
function stepText(ts: TaskState | undefined) {
  if (!ts) return '';
  return ts.step ? `${ts.phase || ''}：${ts.step}` : ts.phase || '';
}

function statusTone(status: Task['status']): 'ok' | 'bad' | 'info' | 'neutral' {
  if (status === 'done') return 'ok';
  if (status === 'blocked') return 'bad';
  return status === 'in-progress' || status === 'review' ? 'info' : 'neutral';
}

/** 任務清單的一列；封存功能的列可以點開紀錄。 */
function TaskRow({ task, state, archive, expanded, onToggle }: Readonly<{
  task: Task;
  state: TaskState | undefined;
  archive?: string;
  expanded: boolean;
  onToggle: () => void;
}>) {
  const id = String(task.id);
  return (
    <TableRow
      className={cn(archive && 'cursor-pointer', expanded && 'bg-accent/60')}
      onClick={archive ? onToggle : undefined}
    >
      <TableCell className="mono">
        {archive ? (
          <button type="button" className="inline-flex items-center gap-1" aria-expanded={expanded} aria-label={`${expanded ? '收合' : '展開'}任務 #${id} 的紀錄`} onClick={(e) => { e.stopPropagation(); onToggle(); }}>
            <ChevronRight className={cn('size-3.5 transition-transform', expanded && 'rotate-90')} />#{id}
          </button>
        ) : <>#{id}</>}
      </TableCell>
      <TableCell>{task.title}</TableCell>
      <TableCell>{task.priority ? PRIORITY_TEXT[task.priority] || task.priority : ''}</TableCell>
      <TableCell><Chip tone={statusTone(task.status)}>{TASK_STATUS_TEXT[task.status || ''] || task.status || '待處理'}</Chip></TableCell>
      <TableCell className="text-muted-foreground">{stepText(state)}</TableCell>
    </TableRow>
  );
}

/** 任務清單。給 archive 時是封存的功能：點一列展開那個任務的內容與實作紀錄（log、審查、diff）。 */
function TasksView({ tasks, states, archive }: Readonly<{ tasks: Task[]; states?: Record<string, TaskState> | null; archive?: string }>) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { setOpen(null); }, [archive]);
  if (!tasks.length) return <p className="text-muted-foreground">（沒有任務清單）</p>;
  const toggle = (id: string) => setOpen((cur) => (cur === id ? null : id));
  return (
    <Table>
      <TableHeader>
        <TableRow><TableHead>#</TableHead><TableHead>標題</TableHead><TableHead>優先</TableHead><TableHead>狀態</TableHead><TableHead>{archive ? '最後步驟' : '目前步驟'}</TableHead></TableRow>
      </TableHeader>
      <TableBody>
        {tasks.flatMap((t) => {
          const id = String(t.id);
          const expanded = open === id;
          const row = <TaskRow key={id} task={t} state={states?.[id]} archive={archive} expanded={expanded} onToggle={() => toggle(id)} />;
          if (!expanded || !archive) return [row];
          return [row, (
            <TableRow key={`${id}-detail`} className="hover:bg-transparent">
              <TableCell colSpan={5} className="whitespace-normal bg-surface-2/40 p-3">
                {/* contain:inline-size：寬度跟著表格，不被 diff 之類的寬內容撐開（內容自己捲動）。 */}
                <div className="w-full [contain:inline-size]"><ArchivedTask archive={archive} id={id} tasks={tasks} /></div>
              </TableCell>
            </TableRow>
          )];
        })}
      </TableBody>
    </Table>
  );
}

/** 左側的功能清單：目前功能在最上面，接著是封存的歷史功能。 */
function FeatureList({ snap, done, archives, archiveDir, selected, onCurrent, onArchive }: Readonly<{
  snap: Snapshot;
  done: number;
  archives: ArchiveSummary[];
  archiveDir: string;
  selected: string | null;
  onCurrent: () => void;
  onArchive: (name: string) => void;
}>) {
  const currentDir = snap.state.prd.archive_dir || '';
  const past = archives.filter((a) => !currentDir.endsWith(`/${a.name}`));
  const progress = snap.tasks.length ? `${done}/${snap.tasks.length} 任務` : '尚未產生任務';
  return (
    <>
      <div className="flex min-h-11 shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h1 className="text-[15px] font-semibold">功能</h1>
        <span className="mono truncate text-[11px] text-muted-foreground" title={archiveDir}>{archiveDir}</span>
      </div>
      <ul className="min-h-0 flex-1 space-y-0.5 overflow-auto p-2" aria-label="功能紀錄">
        <HistoryItem title={currentTitle(snap)} meta={`目前功能・${progress}`} active={selected === null} onClick={onCurrent} />
        <li className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{past.length ? '歷史功能' : '還沒有歷史功能：核准 PRD 後會自動封存'}</li>
        {past.map((a) => {
          const t = (a.feature || a.idea || a.name).split('\n')[0];
          const prog = a.progress?.total ? `${a.progress.done}/${a.progress.total} 任務` : '尚未產生任務';
          const completed = a.completed_at ? '・已完成' : '';
          return <HistoryItem key={a.name} title={t} meta={`${a.name.slice(0, 10)}・${prog}${completed}`} active={selected === a.name} onClick={() => onArchive(a.name)} />;
        })}
      </ul>
    </>
  );
}

/** Log 分頁的工具列：來源選單、全部展開／收合。 */
function LogControls({ scope, scopes, onScope, onOpenAll }: Readonly<{ scope: string; scopes: string[]; onScope: (scope: string) => void; onOpenAll: (open: boolean) => void }>) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-xs text-muted-foreground" htmlFor="log-scope">來源</label>
      <Select value={scope} onValueChange={onScope}>
        <SelectTrigger id="log-scope" size="sm" className="min-w-36" aria-label="log 來源"><SelectValue /></SelectTrigger>
        <SelectContent>
          {scopes.map((s) => <SelectItem key={s} value={s}>{scopeLabel(s)}</SelectItem>)}
        </SelectContent>
      </Select>
      <Button variant="outline" size="sm" onClick={() => onOpenAll(true)}><ChevronsUpDown />全部展開</Button>
      <Button variant="outline" size="sm" onClick={() => onOpenAll(false)}><ChevronsDownUp />全部收合</Button>
      <Hint>捲到最底時會自動跟隨新輸出</Hint>
    </div>
  );
}

/** 子分頁的內容。archive 為 null 表示目前功能（只有目前功能有 Log）。 */
function RecordContent({ tab, snap, archive, rounds, log }: Readonly<{
  tab: RecordTab;
  snap: Snapshot;
  archive: ArchivePayload | null;
  rounds: RoundView[];
  log: { loading: boolean; text?: string; live?: string; openAll?: boolean };
}>) {
  const current = archive === null;
  if (tab === 'log' && current) {
    if (log.loading) return <Loading label="讀取 log…" />;
    return <LogTree text={log.text || '（還沒有 log）'} live={log.live} openAll={log.openAll} className="h-full" />;
  }
  if (tab === 'prd') return <Markdown text={(current ? snap.prd : archive.prd) || '（還沒有 PRD）'} />;
  if (tab === 'rounds') return <RoundsView list={rounds} />;
  if (current) return <TasksView tasks={snap.tasks} states={snap.state.tasks} />;
  return <TasksView tasks={archive.tasks || []} states={archive.taskStates} archive={archive.name} />;
}

export function RecordsPage() {
  const snap = useProject((s) => s.snap)!;
  const api = useProject((s) => s.api);
  const logs = useProject((s) => s.logs);
  const streams = useProject((s) => s.streams);
  const rounds = useProject((s) => s.rounds);
  const [archives, setArchives] = useState<ArchiveSummary[]>([]);
  const [archiveDir, setArchiveDir] = useState('');
  const [selected, setSelected] = useState<string | null>(null); // null＝目前功能，否則是封存資料夾名稱
  const [archive, setArchive] = useState<ArchivePayload | null>(null);
  const [tab, setTab] = useState<RecordTab>('log');
  const [scope, setScope] = useState('runner');
  const [openAll, setOpenAll] = useState<boolean | undefined>(undefined);
  const selectionRef = useRef<string | null>(null);
  const layout = useDefaultLayout({ id: 'ai-workflow.records', panelIds: ['list', 'main'], storage: typeof localStorage === 'undefined' ? undefined : localStorage });

  const loadHistory = useCallback(async () => {
    try {
      const data = await api<{ items: ArchiveSummary[]; dir: string }>('/api/archive');
      setArchives(data.items || []);
      setArchiveDir(data.dir || '');
    } catch (err) {
      toast.error((err as Error).message);
    }
  }, [api]);

  const prdStatus = snap.state.prd.status;
  const prdRounds = snap.state.prd.rounds.length;
  useEffect(() => { void loadHistory(); }, [loadHistory, prdStatus, prdRounds]);

  const scopes = useMemo(() => logScopes(snap, logs), [snap, logs]);
  useEffect(() => { if (!scopes.includes(scope)) setScope('runner'); }, [scopes, scope]);
  const logsFull = useProject((s) => s.logsFull);
  const loading = !logsFull.has(scope);
  useEffect(() => {
    if (selected === null && tab === 'log' && !logsFull.has(scope)) useProject.getState().loadLog(scope).catch(() => {});
  }, [selected, tab, scope, logsFull]);

  const openCurrent = () => { selectionRef.current = null; setSelected(null); setArchive(null); };
  const openArchive = async (name: string) => {
    selectionRef.current = name;
    setSelected(name); setArchive(null);
    if (tab === 'log') setTab('prd');
    try {
      const data = await api<ArchivePayload>(`/api/archive/${encodeURIComponent(name)}`);
      if (selectionRef.current !== name) return; // 慢速回應不覆蓋後來的選取
      setArchive(data);
    } catch (err) {
      if (selectionRef.current === name) toast.error((err as Error).message);
    }
  };

  const current = selected === null;
  const currentDir = snap.state.prd.archive_dir || '';
  const done = snap.tasks.filter((t) => t.status === 'done').length;
  const title = recordTitle(snap, selected, archive);
  const path = current ? currentDir : archive?.path || '';
  const metaRows = current ? currentMetaRows(snap, done) : archiveMetaRows(archive?.meta || {});
  const roundList: RoundView[] = current ? rounds.map(currentRound) : archiveRounds(archive?.rounds || []);

  return (
    <Page>
      <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
        <ResizablePanel id="list" defaultSize="28" minSize={200} className="flex min-h-0 flex-col">
          <FeatureList snap={snap} done={done} archives={archives} archiveDir={archiveDir} selected={selected} onCurrent={openCurrent} onArchive={(name) => void openArchive(name)} />
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="main" defaultSize="72" minSize={320} className="flex min-h-0 flex-col">
          <div className="shrink-0 border-b px-4 py-2">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="truncate text-[15px] font-semibold">{title}</h2>
              <span className="mono truncate text-[11px] text-muted-foreground" title={path}>{path}</span>
            </div>
            <div className="mt-2"><MetaList rows={metaRows} /></div>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b px-4 py-1.5">
            <Tabs value={tab} onValueChange={(v) => setTab(v as RecordTab)}>
              <TabsList variant="line" aria-label="紀錄內容">
                {current && <TabsTrigger value="log">Log</TabsTrigger>}
                <TabsTrigger value="prd">PRD</TabsTrigger>
                <TabsTrigger value="rounds">每輪紀錄</TabsTrigger>
                <TabsTrigger value="tasks">任務</TabsTrigger>
              </TabsList>
            </Tabs>
            {current && tab === 'log' && <LogControls scope={scope} scopes={scopes} onScope={setScope} onOpenAll={setOpenAll} />}
          </div>
          <div className={cn('min-h-0 flex-1 overflow-auto', tab === 'log' ? 'p-2' : 'p-4')} role="tabpanel" tabIndex={0}>
            {!current && !archive ? (
              <Loading label="讀取封存…" />
            ) : (
              <RecordContent tab={tab} snap={snap} archive={current ? null : archive} rounds={roundList} log={{ loading, text: logs[scope], live: streams[scope], openAll }} />
            )}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Page>
  );
}

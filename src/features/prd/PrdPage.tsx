// PRD：左邊是 PRD 文件（預覽／原始 Markdown），右邊是決定（審查、核准、要求再改）與每輪紀錄；中間可拖拉。
import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy, Edit3, List, Pencil } from 'lucide-react';
import { toast } from 'sonner';
import { Page, PageHeader, Panel, Hint, Notice } from '@/components/app/Page';
import { Chip } from '@/components/app/StatusPill';
import { GuardButton } from '@/components/app/GuardButton';
import { LiveSince } from '@/components/app/LiveSince';
import { Markdown } from '@/components/app/Markdown';
import { confirmDialog } from '@/components/app/confirm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { ReferenceWidget, referenceOptions, useReferenceInput } from '@/features/references/ReferenceWidget';
import { act } from '@/lib/api';
import { PRD_TEXT, PROVIDER_LABEL, ROUND_KIND } from '@/lib/constants';
import { readJson, readStorage, writeJson, writeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { useBadges } from '@/stores/badges';
import { useGuards, useProject, useSnapshot } from '@/stores/project';
import type { PrdRound, PrdStatus, Snapshot } from '@/types/api';
import { PrdEditDialog } from '@/features/prd/PrdEditDialog';

type PrdView = 'preview' | 'raw';
const VIEW_KEY = 'ai-workflow-prd-view';
const LAYOUT_KEY = 'ai-workflow.prd.layout';

const STEPS: [string, string][] = [['draft', '起草'], ['review', '交叉審查'], ['approve', '核准'], ['tasks', '產生任務']];
const CHIP_TONE: Record<PrdStatus, 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'review'> = {
  none: 'neutral', drafting: 'info', reviewing: 'review', revising: 'info', awaiting_approval: 'warn', approved: 'ok',
};

/** 目前走到哪一步（與舊版 renderStepper 相同）：回傳目前步驟的索引，全部完成是 STEPS.length。 */
export function stepIndex(snap: Pick<Snapshot, 'state' | 'tasks'>): number {
  const ps = snap.state.prd.status;
  const tasksDone = snap.state.task_gen?.status === 'done' || snap.tasks.length > 0;
  let current: string | null;
  if (ps === 'none' || ps === 'drafting') current = 'draft';
  else if (ps === 'reviewing' || ps === 'revising') current = 'review';
  else if (ps === 'awaiting_approval') current = 'approve';
  else current = tasksDone ? null : 'tasks';
  return current ? STEPS.findIndex(([key]) => key === current) : STEPS.length;
}

function Stepper({ snap }: { snap: Snapshot }) {
  const idx = stepIndex(snap);
  return (
    <ol className="flex items-center gap-1 text-[11.5px]" aria-label="PRD 流程進度">
      {STEPS.map(([key, label], i) => {
        const done = i < idx, current = i === idx;
        return (
          <li key={key} aria-current={current ? 'step' : undefined} className={cn('flex items-center gap-1.5', i > 0 && 'before:mx-1 before:h-px before:w-3 before:bg-border before:content-[""]')}>
            <span className={cn('grid size-4 place-items-center rounded-full border text-[10px] font-semibold', done && 'border-primary bg-primary text-primary-foreground', current && 'border-primary text-primary', !done && !current && 'text-muted-foreground')}>
              {done ? <Check className="size-2.5" /> : i + 1}
            </span>
            <span className={cn(current ? 'font-medium' : 'text-muted-foreground')}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function roundTitle(r: PrdRound) {
  return `第 ${r.round} 輪・${ROUND_KIND[r.kind] || r.kind}・${PROVIDER_LABEL[r.provider] || r.provider}${r.verdict ? `・${r.verdict}` : ''}${r.version ? `・v${r.version}` : ''}`;
}
const roundKey = (r: PrdRound) => `${r.round}-${r.kind}-${r.version || ''}`;

function Rounds({ rounds, raw }: { rounds: PrdRound[]; raw: boolean }) {
  // 重畫時保留使用者展開過的輪次。
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  if (!rounds.length) return <p className="text-xs text-muted-foreground">（尚無）</p>;
  return (
    <div className="flex flex-col gap-1.5">
      {rounds.map((r) => {
        const key = roundKey(r);
        const tone = /approve|pass/i.test(r.verdict || '') ? 'border-l-ok' : /revise|fail/i.test(r.verdict || '') ? 'border-l-danger' : 'border-l-border';
        return (
          <details key={key} open={open.has(key)} onToggle={(e) => { const next = new Set(open); if ((e.currentTarget as HTMLDetailsElement).open) next.add(key); else next.delete(key); setOpen(next); }} className={cn('rounded-md border border-l-2 bg-surface-2/50', tone)}>
            <summary className="cursor-pointer px-2 py-1.5 text-xs font-medium">{roundTitle(r)}</summary>
            <div className="border-t px-2 py-2">
              {raw ? <pre className="mono selectable whitespace-pre-wrap text-xs">{r.text}</pre> : r.text ? <Markdown small text={r.text} /> : <p className="text-xs text-muted-foreground">（無內容）</p>}
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function PrdPage() {
  const snap = useSnapshot()!;
  const api = useProject((s) => s.api);
  const rounds = useProject((s) => s.rounds);
  const [gEdit, gReview, gApprove, gRevise, gTasks] = useGuards('prd.edit', 'prd.review', 'prd.approve', 'prd.revise', 'tasks.generate');
  const [view, setView] = useState<PrdView>(() => (readStorage(VIEW_KEY) === 'raw' ? 'raw' : 'preview'));
  const [feedback, setFeedback] = useState('');
  const [editing, setEditing] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);
  const rawRef = useRef<HTMLPreElement>(null);
  useReferenceInput(feedbackRef, () => referenceOptions('feature'));

  const prd = snap.state.prd;
  const raw = view === 'raw';
  useEffect(() => { useProject.getState().loadRounds().catch(() => {}); }, []);
  useEffect(() => {
    useBadges.getState().set('prd', prd.status === 'awaiting_approval' ? { text: '待核准', attention: true } : null);
  }, [prd.status]);
  const layout = useMemo(() => readJson<Record<string, number> | null>(LAYOUT_KEY, null), []);

  // 錯誤改由 PrdErrorToast 以可關閉的通知顯示，這裡只顯示處理中。
  const busyText = snap.prdBusy ? 'AI 處理中，可在「紀錄 → Log → PRD」查看輸出' : '';
  const humanNote = prd.human_edited_at && prd.reviewed_version !== prd.version
    ? '目前含人工修改。可只請不同 AI 審查，保留你的原文；最後仍由你核准。'
    : 'AI 審查提供意見；你可以直接編輯、要求修改，最後由你核准。';
  const tg = snap.state.task_gen;
  const generating = snap.taskGenBusy || tg?.status === 'running';
  const taskGenText = generating ? 'AI 產生任務中…' : tg?.status === 'done' ? `已產生 ${tg.count} 個任務` : tg?.status === 'error' ? `失敗：${tg.error}` : '';

  const changeView = (v: PrdView) => { setView(v); writeStorage(VIEW_KEY, v); };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(snap.prd || '');
      toast.success('已複製 PRD 原文');
    } catch {
      // 剪貼簿不可用時切到原始模式並選取全文，讓使用者自己複製
      changeView('raw');
      setTimeout(() => { if (rawRef.current) getSelection()?.selectAllChildren(rawRef.current); }, 0);
      toast.error('無法存取剪貼簿，已選取原文，請按 Ctrl+C');
    }
  };
  const approve = async () => {
    if (prd.human_edited_at && prd.reviewed_version !== prd.version) {
      const ok = await confirmDialog({ title: '這個人工版本尚未重新交叉審查', description: '要直接由你核准並開始拆任務嗎？', confirmText: '核准' });
      if (!ok) return;
    }
    await act(api, '/api/prd/approve', { version: prd.version, scope: prd.reference_scope ?? null }, 'PRD 已核准，正在產生供你檢視的任務');
  };
  const revise = async () => {
    const ok = await act(api, '/api/prd/revise', { feedback }, '已送出修改意見');
    if (ok) setFeedback('');
  };

  return (
    <Page>
      <PageHeader
        title={<span className="flex items-center gap-2">目前 PRD <Chip tone={CHIP_TONE[prd.status] || 'neutral'}>{PRD_TEXT[prd.status] || prd.status}</Chip></span>}
        actions={
          <>
            <ToggleGroup type="single" variant="outline" size="sm" value={view} onValueChange={(v) => { if (v) changeView(v as PrdView); }} aria-label="PRD 顯示方式">
              <ToggleGroupItem value="preview" className="text-xs">預覽</ToggleGroupItem>
              <ToggleGroupItem value="raw" className="text-xs">原始 Markdown</ToggleGroupItem>
            </ToggleGroup>
            <GuardButton variant="outline" guard={gEdit} onClick={() => setEditing(true)}><Pencil />人工編輯</GuardButton>
            <Button variant="outline" size="icon" onClick={copy} disabled={!snap.prd} aria-label="複製 PRD 原文" title="複製 PRD 原文"><Copy /></Button>
          </>
        }
      >
        <Stepper snap={snap} />
      </PageHeader>
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout || undefined} onLayoutChanged={(l) => writeJson(LAYOUT_KEY, l)}>
        <ResizablePanel id="prd-main" defaultSize="66" minSize={320} className="flex min-h-0 flex-col" data-reference-drop="feature">
          {busyText && (
            <Notice tone="info" className="m-3 mb-0">
              <LiveSince label={busyText} since={prd.started_at} className="text-info" />
            </Notice>
          )}
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {raw
              ? <pre ref={rawRef} className="mono selectable whitespace-pre-wrap text-xs leading-[1.6]">{snap.prd || '（尚無）'}</pre>
              : snap.prd ? <Markdown text={snap.prd} className="max-w-[80ch]" /> : <p className="text-muted-foreground">（尚無）</p>}
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="prd-side" defaultSize="34" minSize={280} className="flex min-h-0 flex-col gap-3 overflow-auto bg-surface-2/40 p-3">
          <Panel title="決定" bodyClassName="flex flex-col gap-2">
            <ReferenceWidget options={referenceOptions('feature')} />
            <Hint>{humanNote}</Hint>
            <GuardButton variant="outline" className="w-full" guard={gReview} onClick={() => act(api, '/api/prd/review', {}, '正在交叉審查目前版本，保留你的原文')}>只重新審查目前版本</GuardButton>
            <GuardButton className="w-full" guard={gApprove} onClick={approve}><Check />核准 PRD</GuardButton>
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">或</div>
            <label className="text-xs font-medium" htmlFor="prd-feedback">附意見要求再改</label>
            <Textarea id="prd-feedback" ref={feedbackRef} rows={3} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="要修改的地方" disabled={!!gRevise} title={gRevise || undefined} />
            <GuardButton variant="outline" className="w-full" guard={gRevise} onClick={revise}><Edit3 />要求再改</GuardButton>
            {tg?.status === 'error' && (
              <>
                <hr />
                <GuardButton variant="outline" className="w-full" guard={gTasks} onClick={() => act(api, '/api/tasks/generate', {}, '已開始產生任務')}><List />重新產生任務</GuardButton>
              </>
            )}
            {taskGenText && <LiveSince label={taskGenText} since={generating ? tg?.started_at : null} className="text-center text-xs" />}
          </Panel>
          <Panel title="每輪紀錄" actions={<Hint>跟隨 PRD 的顯示方式</Hint>}>
            <Rounds rounds={rounds} raw={raw} />
          </Panel>
        </ResizablePanel>
      </ResizablePanelGroup>
      {editing && <PrdEditDialog onClose={() => setEditing(false)} />}
    </Page>
  );
}

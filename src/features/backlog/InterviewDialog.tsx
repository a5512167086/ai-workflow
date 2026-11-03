// Grill Me · 需求釐清會議（移植自 legacy-src/human.js 的 openInterview）。
// 左側是對話與回答區，右側在關鍵問題釐清後出現需求摘要：先確認（可編輯），再「開始寫 PRD」。
// 用法：在畫面裡掛 <InterviewHost />，任何地方呼叫 openInterview(id)。
import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Markdown } from '@/components/app/Markdown';
import { LiveSince } from '@/components/app/LiveSince';
import { GuardButton } from '@/components/app/GuardButton';
import { Hint } from '@/components/app/Page';
import { confirmDialog } from '@/components/app/confirm';
import { useSkillCommandInput } from '@/features/skills/use-skill-command';
import { useProject } from '@/stores/project';
import { readJson, writeJson } from '@/lib/storage';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ChatSession, Provider, RequirementsPayload } from '@/types/api';

const chatActive = (session?: ChatSession | null) => !!session && ['pending', 'running'].includes(session.status);
/** 關閉再打開時保留還沒送出的回答（依需求分開）。 */
const interviewDrafts = new Map<string, string>();

// ---------- 命令式開啟 ----------
const openers = new Set<(id: string) => void>();
export function openInterview(id: string) {
  for (const fn of openers) fn(id);
}

/** 掛在需求待辦畫面裡；同一時間只會有一場會議開著。 */
export function InterviewHost() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    const open = (next: string) => setId((cur) => cur ?? next);
    openers.add(open);
    return () => { openers.delete(open); };
  }, []);
  if (!id) return null;
  return <InterviewDialog id={id} onClose={() => setId(null)} />;
}

const LAYOUT_KEY = 'ai-workflow.interview.layout';

export function InterviewDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const api = useProject((s) => s.api);
  const snap = useProject((s) => s.snap);
  const [data, setData] = useState<RequirementsPayload | null>(null);
  const [pending, setPending] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [input, setInput] = useState(() => interviewDrafts.get(id) || '');
  const [provider, setProvider] = useState<Provider>(() => (snap?.config?.roles?.interviewer || snap?.config?.roles?.author || 'claude') as Provider);
  const [summary, setSummary] = useState('');
  const [summaryView, setSummaryView] = useState<'preview' | 'edit'>('preview');
  const [summaryNote, setSummaryNote] = useState<string | null>(null);
  const summaryTurn = useRef<string | undefined>(undefined);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  useSkillCommandInput(inputRef);

  const session = data?.session ?? null;
  const active = chatActive(session);
  const guard = (name: string) => snap?.guards?.[name] || '';

  const load = useCallback(async () => {
    try {
      const next = await api<RequirementsPayload>(`/api/requirements/${encodeURIComponent(id)}`);
      if (!closed.current) { setData(next); setStatusError(null); }
      return next;
    } catch (err) {
      if (!closed.current) setStatusError(errorMessage(err));
      return null;
    }
  }, [api, id]);

  const send = useCallback(async (opts: { restart?: boolean; retry?: boolean; initial?: boolean } = {}) => {
    const { restart = false, retry = false, initial = false } = opts;
    if (pending || (!restart && !retry && !initial && !input.trim())) return;
    if (restart && !(await confirmDialog({ title: '重新開始需求釐清？', description: '舊會議會保留，這項需求改用新的會議。', confirmText: '重新釐清' }))) return;
    setPending(true);
    const answer = input;
    try {
      const next = await api<RequirementsPayload>('/api/backlog/interview', { id, input: initial || restart ? '' : answer, provider, restart, retry });
      if (closed.current) return;
      setData(next); setStatusError(null);
      if (!initial && !restart) { setInput(''); interviewDrafts.set(id, ''); }
    } catch (err) {
      if (!closed.current) setStatusError(errorMessage(err));
    } finally {
      if (!closed.current) setPending(false);
    }
  }, [api, id, input, pending, provider]);

  // 開啟：讀目前會議；還沒有會議就用需求內容啟動第一輪。
  useEffect(() => {
    closed.current = false;
    (async () => {
      const first = await load();
      if (first && !first.session && !closed.current) {
        setPending(true);
        try {
          const next = await api<RequirementsPayload>('/api/backlog/interview', { id, input: '', provider, restart: false, retry: false });
          if (!closed.current) { setData(next); setStatusError(null); }
        } catch (err) {
          if (!closed.current) setStatusError(errorMessage(err));
        } finally {
          if (!closed.current) setPending(false);
        }
      }
    })();
    return () => { closed.current = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // AI 回覆中每 1.2 秒更新。
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(load, 1200);
    return () => clearTimeout(t);
  }, [active, data, load]);

  // 摘要文字：這一輪第一次有摘要時帶入（確認過的優先），之後由使用者編輯。
  useEffect(() => {
    if (session?.requirementsReady && summaryTurn.current !== session.turn) {
      summaryTurn.current = session.turn;
      setSummary(session.confirmedSummary || session.requirementsSummary || '');
      setSummaryView('preview');
    }
  }, [session]);

  // 新訊息時捲到最底。
  useEffect(() => {
    const host = messagesRef.current;
    if (host) host.scrollTop = host.scrollHeight;
  }, [session?.messages?.length, active]);

  const close = () => { interviewDrafts.set(id, input); onClose(); };

  const edited = !!data?.confirmed && summary.trim() !== (session?.confirmedSummary || '').trim();
  const confirmed = !!data?.confirmed && !edited;
  const showSummary = !!session?.requirementsReady && !data?.stale && !active && !pending;
  const since = active ? session?.messages?.findLast?.((m) => m.role === 'user')?.at : null;
  const statusText = statusError
    ? statusError
    : data?.stale ? '需求或附件已修改，請重新釐清。舊對話仍保留。'
      : session?.error ? session.error
        : active || pending ? 'AI 正在查閱資料與整理問題…'
          : data?.confirmed ? '你已確認需求，可開始寫 PRD。'
            : session?.requirementsReady ? '關鍵問題已釐清，請檢閱、修正並確認右側摘要。'
              : '請回答本輪問題；AI 會依回答繼續追問。';
  const noteText = summaryNote
    ? summaryNote
    : confirmed ? '你已確認這份摘要。可以開始寫 PRD，或改成「編輯」再修改後重新確認。'
      : edited ? '摘要已修改，請重新確認。'
        : '請檢視 AI 整理的需求範圍、限制與驗收條件；可切到「編輯」直接修改，確認後才能開始寫 PRD。';

  const confirmSummary = async () => {
    if (pending || !session?.requirementsReady || !summary.trim()) return;
    setPending(true); setSummaryNote(null);
    try {
      const next = await api<RequirementsPayload>('/api/backlog/confirm', { id, sessionId: session.id, turn: session.turn, summary });
      if (closed.current) return;
      setData(next); toast.success('需求摘要已確認，可以開始寫 PRD');
    } catch (err) {
      if (!closed.current) setSummaryNote(errorMessage(err));
    } finally {
      if (!closed.current) setPending(false);
    }
  };

  const startDraft = async () => {
    if (pending || !data?.confirmed) return;
    // 目前功能還沒做完時講清楚後果：未完成的任務會留在原本的任務群組，不會繼續執行。
    const unfinished = (snap?.tasks || []).filter((task) => task.status !== 'done').length;
    const switching = snap?.state?.pipeline?.status === 'complete' || !unfinished
      ? '以這份已確認的需求起草新 PRD？目前 PRD 將切換到新功能。'
      : `目前功能還有 ${unfinished} 個任務未完成。改用這份需求起草新 PRD 後，流程會切換到新功能，舊任務留在原本的任務群組，不會繼續執行。確定要切換嗎？`;
    if (snap?.prd && !(await confirmDialog({ title: '開始寫 PRD', description: switching, confirmText: '開始寫 PRD' }))) return;
    setPending(true); setSummaryNote(null);
    try {
      await api('/api/backlog/draft', { id });
      interviewDrafts.delete(id);
      toast.success('正在依確認的需求起草 PRD');
      onClose();
    } catch (err) {
      if (!closed.current) { setSummaryNote(errorMessage(err)); setPending(false); }
    }
  };

  const stop = async () => {
    if (!session) return;
    try { await api('/api/chat/cancel', { chatId: session.id }); await load(); } catch (err) { setStatusError(errorMessage(err)); }
  };

  const layout = readJson<Record<string, number> | null>(LAYOUT_KEY, null);

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-3 p-4 sm:max-w-[90vw]" aria-describedby="interview-desc" onEscapeKeyDown={(e) => { if (pending) e.preventDefault(); }}>
        <DialogHeader className="shrink-0">
          <DialogTitle>Grill Me · 需求釐清</DialogTitle>
          <DialogDescription id="interview-desc">AI 先查專案、追問決策與驗收條件。釐清完成後右側會出現需求摘要：先檢視（可編輯）並確認，再開始寫 PRD。可關閉後回來接續。</DialogDescription>
        </DialogHeader>
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1" defaultLayout={layout || undefined} onLayoutChanged={(l) => writeJson(LAYOUT_KEY, l)}>
          <ResizablePanel id="chat" defaultSize={showSummary ? '55' : '100'} minSize="30">
            <div className="flex h-full min-h-0 flex-col gap-2 pr-2">
              <div ref={messagesRef} className="min-h-0 flex-1 space-y-3 overflow-auto rounded-md border bg-card p-3" role="log" aria-live="polite" data-testid="interview-conversation">
                {(session?.messages || []).map((message, i) => (
                  <article key={message.id || i} className={cn('rounded-md px-3 py-2', message.role === 'user' ? 'ml-8 bg-surface-2' : 'mr-8 border bg-background')}>
                    <b className="mb-1 block text-xs text-muted-foreground">{message.role === 'user' ? '你' : '需求釐清 AI'}</b>
                    {message.role === 'user' ? <div className="selectable whitespace-pre-wrap">{message.text}</div> : <Markdown text={message.text} />}
                  </article>
                ))}
              </div>
              <LiveSince label={statusText} since={since} className={cn('text-xs', (statusError || session?.error || data?.stale) && 'text-danger')} />
              <div className="shrink-0 space-y-2">
                <label className="block">
                  <span className="mb-1 block text-xs text-muted-foreground">你的回答或補充</span>
                  <Textarea
                    ref={inputRef}
                    rows={3}
                    maxLength={20000}
                    value={input}
                    onChange={(e) => { setInput(e.target.value); interviewDrafts.set(id, e.target.value); }}
                    placeholder="回答本輪問題；有多題時可依題號回答。開頭輸入 / 可叫用技能…"
                    // 和專案對話一樣：Enter 送出、Shift+Enter 換行，中文組字時不送出；技能清單開著時 Enter 由清單處理。
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
                      e.preventDefault();
                      if (!pending && !active && !data?.stale) void send();
                    }}
                    aria-label="你的回答或補充"
                  />
                </label>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <span className="mr-auto text-xs text-muted-foreground">Enter 送出 · Shift+Enter 換行 · 開頭輸入 / 叫用技能</span>
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">AI
                    <Select value={provider} onValueChange={(v) => setProvider(v as Provider)}>
                      <SelectTrigger size="sm" aria-label="需求釐清 AI" className="w-32"><SelectValue /></SelectTrigger>
                      <SelectContent><SelectItem value="claude">Claude Code</SelectItem><SelectItem value="codex">Codex</SelectItem></SelectContent>
                    </Select>
                  </label>
                  {active && <Button variant="outline" onClick={stop}>停止回覆</Button>}
                  {!!session && ['error', 'cancelled'].includes(session.status) && <Button variant="outline" disabled={pending || active} onClick={() => send({ retry: true })}>重試回覆</Button>}
                  <Button variant="outline" disabled={pending || active} onClick={() => send({ restart: true })}>重新釐清</Button>
                  <Button variant={showSummary ? 'outline' : 'default'} disabled={pending || active || !!data?.stale} onClick={() => send()}>送出回答</Button>
                </div>
              </div>
            </div>
          </ResizablePanel>
          {showSummary && (
            <>
              <ResizableHandle withHandle />
              <ResizablePanel id="summary" defaultSize="45" minSize="25">
                <aside className="flex h-full min-h-0 flex-col gap-2 pl-2" aria-label="需求摘要" data-testid="interview-summary">
                  <div className="flex shrink-0 items-center justify-between gap-2">
                    <h3 className="text-[13px] font-semibold">需求摘要</h3>
                    <ToggleGroup type="single" variant="outline" size="sm" value={summaryView} onValueChange={(v) => { if (v) setSummaryView(v as 'preview' | 'edit'); }} aria-label="摘要顯示方式">
                      <ToggleGroupItem value="preview" aria-label="預覽">預覽</ToggleGroupItem>
                      <ToggleGroupItem value="edit" aria-label="編輯">編輯</ToggleGroupItem>
                    </ToggleGroup>
                  </div>
                  <Hint role="status" className={cn(summaryNote && 'text-danger')}>{noteText}</Hint>
                  <div className="min-h-0 flex-1 overflow-auto rounded-md border bg-card p-3">
                    {summaryView === 'edit'
                      ? <Textarea className="mono h-full min-h-full resize-none" aria-label="需求摘要 Markdown" spellCheck={false} value={summary} onChange={(e) => { setSummary(e.target.value); setSummaryNote(null); }} autoFocus />
                      : <Markdown text={summary} />}
                  </div>
                  <div className="flex shrink-0 justify-end gap-2">
                    <Button variant={confirmed ? 'outline' : 'default'} disabled={pending || confirmed || !summary.trim()} onClick={confirmSummary}>
                      {edited ? '重新確認摘要' : confirmed ? '已確認' : '確認需求摘要'}
                    </Button>
                    {!!data?.confirmed && (
                      <GuardButton guard={pending ? '處理中…' : !confirmed ? '請先確認需求摘要' : guard('backlog.draft')} onClick={startDraft}>開始寫 PRD</GuardButton>
                    )}
                  </div>
                </aside>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      </DialogContent>
    </Dialog>
  );
}

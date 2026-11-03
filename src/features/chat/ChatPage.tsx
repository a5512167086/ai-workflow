// 專案對話：左側對話紀錄、右側訊息與固定的輸入區（移植自 legacy-src/chat.js）。
// 對話以唯讀 CLI 與最新專案背景回答，不觸發 PRD 或任務操作；長對話以最近訊息交接，完整紀錄仍保存。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDefaultLayout } from 'react-resizable-panels';
import { toast } from 'sonner';
import { Copy, Plus, Pencil, Trash2, Square, RotateCcw, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Page, Hint, Eyebrow, EmptyState } from '@/components/app/Page';
import { Markdown } from '@/components/app/Markdown';
import { StreamingText } from '@/components/app/StreamingReply';
import { LogTree } from '@/components/app/LogTree';
import { LiveSince } from '@/components/app/LiveSince';
import { ModelPicker } from '@/components/app/ModelPicker';
import { confirmDialog, promptDialog } from '@/components/app/confirm';
import { ReferenceChips, ReferenceWidget, referenceOptions, useReferenceInput } from '@/features/references/ReferenceWidget';
import { useSkillCommandInput } from '@/features/skills/use-skill-command';
import { CHAT_STATUS, PROVIDER_LABEL, PROVIDER_LONG, STATUS_TEXT } from '@/lib/constants';
import { shortDate, shortTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProject, useProjectApi, useSnapshot } from '@/stores/project';
import { useModels } from '@/stores/models';
import { useReferences } from '@/stores/references';
import { useBadges } from '@/stores/badges';
import type { ChatSession, ChatSummary, Provider } from '@/types/api';

const SUGGESTIONS = ['目前專案執行到哪裡？有什麼需要我處理？', '請閱讀程式碼，畫一張 Mermaid 專案架構圖。', '解釋目前的資料流與主要模組。', '目前有哪些風險、卡點或可以改善的地方？'];
const chatActive = (session?: { status?: string } | null) => !!session && ['pending', 'running'].includes(session.status || '');
const lastUserAt = (session?: ChatSession | null) => [...(session?.messages || [])].reverse().find((m) => m.role === 'user')?.at || null;

async function copyText(text: string, ok: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(ok);
  } catch {
    toast.error('無法存取剪貼簿，請選取文字複製');
  }
}

/** 一則訊息的執行紀錄（工具活動）：第一次讀完整檔案，之後跟著串流更新。 */
function TurnActivity({ turn, running, since }: { turn: string; running: boolean; since: string | null }) {
  const scope = `chat-${turn}`;
  const text = useProject((s) => s.logs[scope]);
  useEffect(() => { useProject.getState().loadLog(scope).catch(() => {}); }, [scope]);
  return (
    <details className="rounded-md border bg-card" open={running}>
      <summary className="px-3 py-1.5 text-xs text-muted-foreground"><LiveSince label={running ? '正在回覆 · 查看執行紀錄' : '這次回覆的執行紀錄'} since={running ? since : null} /></summary>
      <div className="max-h-72 overflow-auto border-t p-2"><LogTree text={text || '正在準備 CLI 與專案背景…'} /></div>
    </details>
  );
}

function MessageList({ session, onSuggest }: { session: ChatSession | null; onSuggest: (text: string) => void }) {
  const host = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const key = `${session?.id || ''}|${session?.messages?.map((m) => m.id).join(',') || ''}|${session?.status || ''}|${session?.turn || ''}`;
  // 重畫前記下是否在最底；是的話重畫後跟隨到最底（和舊版一樣）。
  useEffect(() => {
    const el = host.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [key]);
  const onScroll = () => {
    const el = host.current;
    if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 50;
  };
  const running = chatActive(session);
  // AI 正在打的這段回覆（逐字）；寫完後會變成正式訊息。
  const typing = useProject((s) => (running && session?.turn ? s.streams[`chat-${session.turn}`] || '' : ''));
  useEffect(() => {
    const el = host.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [typing]);
  return (
    <div ref={host} onScroll={onScroll} role="region" aria-label="對話訊息" tabIndex={0} className="min-h-0 flex-1 overflow-auto px-4 py-3">
      {!session?.messages?.length && (
        <div className="mx-auto flex max-w-xl flex-col items-center gap-2 py-10 text-center">
          <Eyebrow>問問題、理解程式、釐清下一步</Eyebrow>
          <h3 className="text-lg font-semibold">這次，你想了解什麼？</h3>
          <p className="text-xs text-muted-foreground">從目前進度聊到整體架構，都不必進入 PRD 流程。</p>
          <div className="mt-3 grid w-full gap-2 sm:grid-cols-2">
            {SUGGESTIONS.map((q) => (
              <Button key={q} type="button" variant="outline" className="h-auto justify-start whitespace-normal py-2 text-left text-xs" onClick={() => onSuggest(q)}>{q}</Button>
            ))}
          </div>
        </div>
      )}
      <div className="mx-auto flex max-w-3xl flex-col gap-3">
        {(session?.messages || []).map((m, i) => {
          const user = m.role === 'user';
          return (
            <article key={m.id || i} className={cn('rounded-lg border px-3 py-2', user ? 'bg-surface-2' : 'bg-card')}>
              <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
                <b className="text-foreground">{user ? '你' : PROVIDER_LABEL[m.provider || ''] || '專案助理'}</b>
                <span>{shortTime(m.at)}</span>
                <Button type="button" variant="ghost" size="xs" className="ml-auto" onClick={() => copyText(m.text, '已複製訊息')}><Copy />複製</Button>
              </div>
              {user ? <div className="selectable whitespace-pre-wrap break-words">{m.text}</div> : <Markdown text={m.text} />}
              {!!m.references?.length && <div className="mt-2"><ReferenceChips ids={m.references} /></div>}
            </article>
          );
        })}
        {/* 打字中的回覆放在執行紀錄上面：寫完後正式訊息出現在同一個位置，不會跳。 */}
        {typing && (
          <article className="rounded-lg border bg-card px-3 py-2" data-testid="chat-typing">
            <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground"><b className="text-foreground">{PROVIDER_LABEL[session?.provider || ''] || '專案助理'}</b><span>正在回覆…</span></div>
            <StreamingText text={typing} />
          </article>
        )}
        {session?.turn && <TurnActivity turn={session.turn} running={running} since={lastUserAt(session)} />}
      </div>
    </div>
  );
}

export function ChatPage() {
  const snap = useSnapshot()!;
  const api = useProjectApi();
  const loadModels = useModels((s) => s.load);
  const efforts = useModels((s) => s.efforts);
  const modelOptions = useModels((s) => s.options);
  const referencePending = useReferences((s) => s.pending);
  const clearReferenceDraft = useReferences((s) => s.clearDraft);
  const layout = useDefaultLayout({ id: 'ai-workflow.chat', panelIds: ['chat-history', 'chat-main'], storage: typeof localStorage !== 'undefined' ? localStorage : undefined });

  const [items, setItems] = useState<ChatSummary[]>([]);
  const [chatId, setChatId] = useState<string | null>(null);
  const [session, setSession] = useState<ChatSession | null>(null);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>(() => (snap.config.roles.chat || snap.config.roles.author || 'claude') as Provider);
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const drafts = useRef(new Map<string, string>());
  const selection = useRef(0);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const chatIdRef = useRef<string | null>(null);
  chatIdRef.current = chatId;
  const inputRefValue = useRef(input);
  inputRefValue.current = input;

  useEffect(() => { loadModels(); }, [loadModels]);
  useReferenceInput(inputRef, () => referenceOptions('chat', { chatId: chatIdRef.current }));
  useSkillCommandInput(inputRef);

  const refKey = `chat:${chatId || 'new'}`;
  const refOptions = useMemo(() => referenceOptions('chat', { chatId }), [chatId]);
  const active = chatActive(session);
  const anyActive = active || items.some(chatActive);

  useEffect(() => {
    useBadges.getState().set('chat', items.some(chatActive) ? { text: '回覆中', attention: true } : null);
  }, [items]);

  const loadHome = useCallback(async () => {
    try {
      const { items } = await api<{ items: ChatSummary[] }>('/api/chats');
      if (!Array.isArray(items)) throw new Error('無法讀取對話清單：回傳格式不正確');
      setItems(items);
    } catch (error) { setStatus((error as Error).message); }
  }, [api]);

  const rememberDraft = () => drafts.current.set(chatIdRef.current || 'new', inputRefValue.current);

  const openChat = useCallback(async (id: string) => {
    rememberDraft();
    const current = ++selection.current;
    try {
      const data = await api<ChatSession>(`/api/chat/${encodeURIComponent(id)}`);
      if (current !== selection.current) return;
      setChatId(id); setSession(data); setStatus(null);
      setInput(drafts.current.get(id) || '');
      setProvider((data.provider || 'claude') as Provider); setModel(data.model || ''); setEffort(data.effort || '');
    } catch (error) {
      if (current === selection.current) { setStatus((error as Error).message); toast.error((error as Error).message); }
    }
  }, [api]);

  const newChat = () => {
    rememberDraft(); ++selection.current;
    setChatId(null); setSession(null); setStatus(null);
    setInput(drafts.current.get('new') || ''); setModel(''); setEffort('');
    inputRef.current?.focus();
  };

  // 清單與目前對話的輪詢：有對話在回覆中，或這個畫面開著時每 1.5 秒更新一次。
  useEffect(() => { loadHome(); }, [loadHome]);
  useEffect(() => {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy || sending) return;
      busy = true;
      const current = selection.current, id = chatIdRef.current;
      try {
        await loadHome();
        if (id) {
          const data = await api<ChatSession>(`/api/chat/${encodeURIComponent(id)}`);
          if (current === selection.current && chatIdRef.current === id) setSession(data);
        }
      } catch (error) { setStatus((error as Error).message); }
      finally { busy = false; }
    }, 1500);
    return () => clearInterval(timer);
  }, [api, loadHome, sending]);

  const send = async (retry = false) => {
    if (sending || anyActive || referencePending.has(refKey)) return;
    const text = input.trim();
    const references = useReferences.getState().draft(refKey);
    if (!retry && !text && !references.length) return;
    setSending(true);
    const current = selection.current;
    try {
      const data = await api<ChatSession>('/api/chat/send', { chatId, input: text, retry, references, provider, model, effort });
      if (current === selection.current) {
        clearReferenceDraft(refKey);
        drafts.current.delete(chatId || 'new');
        setChatId(data.id); setSession(data); setInput(''); setStatus(null);
      }
      await loadHome();
    } catch (error) { setStatus((error as Error).message); toast.error((error as Error).message); }
    finally { setSending(false); }
  };

  const stop = async () => {
    if (!chatId) return;
    try { setSession(await api<ChatSession>('/api/chat/cancel', { chatId })); } catch (error) { toast.error((error as Error).message); }
  };
  const rename = async () => {
    if (!chatId) return;
    const title = await promptDialog({ title: '對話名稱', defaultValue: session?.title || '' });
    if (!title?.trim()) return;
    try { setSession(await api<ChatSession>('/api/chat/rename', { chatId, title })); await loadHome(); } catch (error) { toast.error((error as Error).message); }
  };
  const remove = async (id = chatId, title = session?.title) => {
    if (!id || !(await confirmDialog({ title: `刪除對話「${title || '未命名對話'}」？`, description: '訊息紀錄會一併刪除。', confirmText: '刪除', destructive: true }))) return;
    try {
      await api('/api/chat/delete', { chatId: id });
      drafts.current.delete(id);
      if (id === chatId) newChat();
      await loadHome();
    } catch (error) { toast.error((error as Error).message); }
  };

  const defaults = snap.config.models?.chat?.[provider];
  const defaultModel = defaults?.model || snap.config[provider]?.model || modelOptions?.[provider]?.defaultModel || modelOptions?.[provider]?.models?.find((m) => m.default)?.id;
  const defaultEffort = defaults?.effort || snap.config[provider]?.effort || modelOptions?.[provider]?.defaultEffort || modelOptions?.[provider]?.models?.find((m) => m.default)?.defaultEffort;
  const effortOptions = efforts(provider, model);
  const effortList = effort && !effortOptions.includes(effort) ? [...effortOptions, effort] : effortOptions;
  const pipeline = STATUS_TEXT[snap.state.pipeline.status] || snap.state.pipeline.status;
  const context = `帶入最新流程、任務、PRD 與交接文件 · 目前：${pipeline}${session?.contextTruncated ? ` · 最近 ${session.contextMessages} 則帶入模型，完整紀錄仍保留` : ''}${session?.contextReferencesTruncated ? ' · 參考資料帶入最近 24 份，較早的附件仍保留' : ''}`;
  const statusText = status ? status
    : session?.error ? `${CHAT_STATUS[session.status] || ''}：${session.error}`
    : active ? 'AI 正在讀取與分析專案，展開執行紀錄可查看工具活動。'
    : anyActive ? '另一個對話正在回覆；完成或停止後即可傳送。'
    : session ? '可直接追問，也可切換 AI 接續同一份對話紀錄。' : '不需要先產生 PRD，就可以討論專案。';
  const canRetry = !!session && ['error', 'cancelled'].includes(session.status) && session.messages?.at(-1)?.role === 'user';

  return (
    <Page>
      <ResizablePanelGroup orientation="horizontal" defaultLayout={layout.defaultLayout} onLayoutChanged={layout.onLayoutChanged} className="min-h-0 flex-1">
        <ResizablePanel id="chat-history" defaultSize="22" minSize={180} className="flex min-h-0 flex-col bg-sidebar/40">
          <div className="flex h-11 shrink-0 items-center justify-between border-b px-3">
            <h2 className="text-[13px] font-semibold">對話紀錄</h2>
            <Button type="button" size="sm" variant="outline" onClick={newChat}><Plus />新增對話</Button>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto p-1.5" aria-label="專案對話紀錄">
            {!items.length && <li className="px-2 py-3 text-xs text-muted-foreground">還沒有對話。從右邊問一個問題開始。</li>}
            {items.map((c) => (
              <li key={c.id}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      aria-current={c.id === chatId ? 'true' : 'false'}
                      onClick={() => openChat(c.id)}
                      className={cn('flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-accent focus-visible:outline-2', c.id === chatId && 'bg-accent font-medium')}
                    >
                      <span className="w-full truncate text-[13px]">{c.title || '未命名對話'}</span>
                      <span className="text-[11px] text-muted-foreground">{CHAT_STATUS[c.status] || c.status} · {c.updated_at ? shortDate(c.updated_at) : '檔案需要檢查'}</span>
                    </button>
                  </ContextMenuTrigger>
                  <ContextMenuContent>
                    <ContextMenuItem onSelect={async () => { if (c.id !== chatId) await openChat(c.id); rename(); }}><Pencil />改名</ContextMenuItem>
                    <ContextMenuItem variant="destructive" disabled={chatActive(c)} onSelect={() => remove(c.id, c.title)}><Trash2 />刪除</ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>
              </li>
            ))}
          </ul>
          <Hint className="border-t px-3 py-2">對話保存在本專案，重新開啟仍可接續。</Hint>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel id="chat-main" minSize={360} className="flex min-h-0 flex-col">
          <div className="flex min-h-11 shrink-0 items-center gap-3 border-b px-4 py-1.5">
            <div className="min-w-0 flex-1">
              <Eyebrow>專案助理 · 唯讀對話</Eyebrow>
              <h2 className="truncate text-[15px] font-semibold leading-5">{session?.title || '開始聊聊這個專案'}</h2>
            </div>
            <Button type="button" variant="outline" size="sm" disabled={!chatId} onClick={rename}><Pencil />改名</Button>
            <Button type="button" variant="outline" size="sm" disabled={!chatId || active} onClick={() => remove()}><Trash2 />刪除</Button>
          </div>
          <p role="status" className="shrink-0 truncate border-b bg-surface-2/60 px-4 py-1 text-[11px] text-muted-foreground" title={context}>{context}</p>
          {session === null && chatId !== null ? <EmptyState title="載入對話…" /> : <MessageList session={session} onSuggest={(q) => { setInput(q); inputRef.current?.focus(); }} />}
          <p role="status" className="shrink-0 px-4 pt-2 text-xs text-muted-foreground">
            <LiveSince label={statusText} since={active && !status && !session?.error ? lastUserAt(session) : null} />
          </p>
          <form data-reference-drop="chat" className="shrink-0 border-t px-4 py-3" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-muted-foreground">AI
                <Select value={provider} onValueChange={(v) => { setProvider(v as Provider); setModel(''); setEffort(''); }}>
                  <SelectTrigger size="sm" aria-label="對話使用的 AI" className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="claude">{PROVIDER_LONG.claude}</SelectItem>
                    <SelectItem value="codex">{PROVIDER_LONG.codex}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <Collapsible>
                <CollapsibleTrigger asChild><Button type="button" variant="ghost" size="sm">模型與推理設定{(model || effort) ? `：${model || '預設'} / ${effort || '預設'}` : ''}</Button></CollapsibleTrigger>
                <CollapsibleContent className="mt-2 flex w-full flex-wrap items-end gap-3 rounded-md border bg-surface-2/60 p-3">
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">模型
                    <ModelPicker provider={provider} value={model} onChange={setModel} placeholder={defaults?.model || snap.config[provider]?.model || '沿用對話角色預設'} aria-label="模型" className="w-64" />
                  </label>
                  <label className="flex flex-col gap-1 text-xs text-muted-foreground">推理強度
                    <select aria-label="推理強度" className="h-8 rounded-md border border-input bg-transparent px-2 text-[13px] text-foreground" value={effort} onChange={(e) => setEffort(e.target.value)}>
                      <option value="">預設</option>
                      {effortList.map((e) => <option key={e} value={e}>{e}</option>)}
                    </select>
                  </label>
                  <Hint className="basis-full">空白沿用首頁「專案對話」角色設定。預設模型：{defaultModel || 'CLI 依帳號決定（未回報）'}；推理強度：{defaultEffort || 'CLI 依模型決定（未回報）'}。</Hint>
                </CollapsibleContent>
              </Collapsible>
            </div>
            <div className="mb-2"><ReferenceWidget options={refOptions} /></div>
            <label className="sr-only" htmlFor="chat-input">詢問專案</label>
            <Textarea
              id="chat-input" ref={inputRef} rows={3} maxLength={20000} value={input}
              placeholder="問問目前的進度、執行問題，或請 AI 畫出專案架構圖…"
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(); } }}
              className="min-h-16 resize-y"
            />
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <Hint className="flex-1">Enter 傳送 · Shift+Enter 換行 · 開頭輸入 / 叫用技能 · 不修改專案檔案</Hint>
              {active && <Button type="button" variant="outline" size="sm" disabled={!!session?.cancelRequested} onClick={stop}><Square />{session?.cancelRequested ? '正在停止…' : '停止回覆'}</Button>}
              {canRetry && <Button type="button" variant="outline" size="sm" disabled={sending || anyActive} onClick={() => send(true)}><RotateCcw />重試這則訊息</Button>}
              <Button type="submit" disabled={sending || anyActive || referencePending.has(refKey)}><Send />傳送</Button>
            </div>
          </form>
        </ResizablePanel>
      </ResizablePanelGroup>
    </Page>
  );
}

// 需求待辦：左側新增需求，右側依優先順序的清單（拖曳或上／下按鈕排序）。新增後自動開啟 Grill Me 需求會議。
import { useCallback, useEffect, useRef, useState, type DragEvent } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, GripVertical, Link2, Pencil, Plus, Save, Sparkles, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Page, PageHeader, Panel, Hint, Notice, Loading } from '@/components/app/Page';
import { Chip } from '@/components/app/StatusPill';
import { Markdown } from '@/components/app/Markdown';
import { GuardButton } from '@/components/app/GuardButton';
import { confirmDialog } from '@/components/app/confirm';
import { ReferenceWidget, referenceOptions, openReferenceDialog, useReferenceInput } from '@/features/references/ReferenceWidget';
import { InterviewHost, openInterview } from '@/features/backlog/InterviewDialog';
import { useProject, useProjectApi } from '@/stores/project';
import { useReferences } from '@/stores/references';
import { useBacklogDraft } from '@/stores/backlog-draft';
import { useBadges } from '@/stores/badges';
import { BACKLOG_STATUS } from '@/lib/constants';
import { act, errorMessage } from '@/lib/api';
import { readJson, writeJson } from '@/lib/storage';
import { cn } from '@/lib/utils';
import type { BacklogItem, BacklogPayload } from '@/types/api';

const LAYOUT_KEY = 'ai-workflow.backlog.layout';
const LOCKED_ACTIONS = ['references', 'edit', 'delete', 'draft'] as const;

/** 不能再改的原因：後端給的 lock，或功能已完成。排序不受影響。 */
function lockOf(item: BacklogItem) {
  return item.lock || (item.status === 'done' ? '這項需求的功能已完成，不能再修改' : '');
}

export function BacklogPage() {
  const api = useProjectApi();
  const prdStatus = useProject((s) => s.snap?.state.prd.status);
  const prdRounds = useProject((s) => s.snap?.state.prd.rounds.length);
  const referenceDraftCount = useReferences((s) => s.drafts.get('backlog')?.length || 0);
  const referencePending = useReferences((s) => s.pending.has('backlog'));
  const [items, setItems] = useState<BacklogItem[]>([]);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [title, setTitle] = useState('');
  const [detail, setDetail] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ title: '', detail: '' });
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; before: boolean } | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const detailRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  useReferenceInput(detailRef, () => referenceOptions('backlog-draft'));

  const load = useCallback(async () => {
    try {
      const data = await api<BacklogPayload>('/api/backlog');
      setItems(data.items); setPath(data.path); setError(null);
    } catch (err) {
      setError(errorMessage(err)); toast.error(errorMessage(err));
    } finally {
      setLoaded(true);
    }
  }, [api]);

  // 進入畫面、以及 PRD 狀態或輪次改變（需求可能被鎖住或完成）時重讀。
  useEffect(() => { load(); }, [load, prdStatus, prdRounds]);

  // 技能會議「帶入需求待辦」。
  useEffect(() => {
    const draft = useBacklogDraft.getState().take();
    if (draft) { setTitle(draft.title); setDetail(draft.detail); titleRef.current?.focus(); }
  }, []);

  useEffect(() => {
    const open = items.filter((i) => i.status !== 'done').length;
    useBadges.getState().set('backlog', open ? { text: String(open) } : null);
  }, [items]);

  const add = async () => {
    const data = await act<{ item?: BacklogItem }>(api, '/api/backlog/add', { title, detail, references: useReferences.getState().draft('backlog') }, '已新增需求');
    if (!data) return;
    setTitle(''); setDetail('');
    useReferences.getState().clearDraft('backlog');
    await load();
    titleRef.current?.focus();
    if (data.item?.id) openInterview(data.item.id);
  };

  const saveOrder = async (ids: string[]) => {
    const data = await act<{ items: BacklogItem[] }>(api, '/api/backlog/reorder', { ids });
    if (data) setItems(data.items);
  };
  const move = async (id: string, delta: number) => {
    const ids = items.map((i) => i.id);
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + delta));
    if (from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    await saveOrder(ids);
    // 鍵盤操作後焦點跟著項目走
    listRef.current?.querySelector<HTMLButtonElement>(`[data-id="${id}"] [data-act="${delta < 0 ? 'up' : 'down'}"]`)?.focus();
  };

  /** 鎖住的需求只能排序：按鈕已停用，這裡再擋一次避免畫面還沒更新時被點到。 */
  const blocked = (item: BacklogItem) => {
    const lock = lockOf(item);
    if (lock) toast.error(lock);
    return !!lock;
  };
  const startEdit = (item: BacklogItem) => { if (blocked(item)) return; setEditingId(item.id); setEdit({ title: item.title, detail: item.detail || '' }); };
  const saveEdit = async (item: BacklogItem) => {
    if (blocked(item)) return;
    const data = await act(api, '/api/backlog/update', { id: item.id, title: edit.title, detail: edit.detail }, '已儲存');
    if (data) { setEditingId(null); await load(); }
  };
  const remove = async (item: BacklogItem) => {
    if (blocked(item)) return;
    if (!(await confirmDialog({ title: `刪除需求「${item.title}」？`, confirmText: '刪除', destructive: true }))) return;
    if (await act(api, '/api/backlog/delete', { id: item.id }, '已刪除')) await load();
  };
  const references = (item: BacklogItem) => {
    if (blocked(item)) return;
    openReferenceDialog({ title: `需求參考：${item.title}`, target: 'backlog', id: item.id, ids: item.references || [] }, () => { load(); });
  };
  const draft = (item: BacklogItem) => { if (blocked(item)) return; openInterview(item.id); };

  // 拖曳排序（滑鼠）；鍵盤與觸控用上／下按鈕。
  const onDragStart = (e: DragEvent, id: string) => { setDragId(id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', id); };
  const onDragOver = (e: DragEvent, id: string) => {
    if (!dragId || id === dragId) { setDrop(null); return; }
    e.preventDefault();
    const r = e.currentTarget.getBoundingClientRect();
    setDrop({ id, before: e.clientY < r.top + r.height / 2 });
  };
  const onDrop = async (e: DragEvent, id: string) => {
    e.preventDefault();
    const from = dragId; const target = drop;
    setDragId(null); setDrop(null);
    if (!from || from === id || !target) return;
    const ids = items.map((i) => i.id).filter((x) => x !== from);
    ids.splice(ids.indexOf(id) + (target.before ? 0 : 1), 0, from);
    await saveOrder(ids);
  };
  const onDragEnd = () => { setDragId(null); setDrop(null); };

  const layout = readJson<Record<string, number> | null>(LAYOUT_KEY, null);

  return (
    <Page>
      <PageHeader title="需求待辦" description="先把想做的功能列進待辦、排好順序；新增後會開啟需求會議釐清細節。" />
      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 p-3" defaultLayout={layout || undefined} onLayoutChanged={(l) => writeJson(LAYOUT_KEY, l)}>
        <ResizablePanel id="form" defaultSize="36" minSize="24">
          <Panel title="新增需求" className="mr-1.5 h-full" bodyClassName="flex flex-col gap-2 overflow-auto">
            <div className="flex flex-col gap-2" data-reference-drop="backlog-draft">
              <Label htmlFor="bl-title">標題</Label>
              <Input id="bl-title" ref={titleRef} value={title} maxLength={200} placeholder="例如：報表可以匯出 CSV" onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); add(); } }} />
              <Label htmlFor="bl-detail" className="mt-1">說明（選填，支援 Markdown）</Label>
              <ReferenceWidget options={referenceOptions('backlog-draft')} />
              <Textarea id="bl-detail" ref={detailRef} rows={5} value={detail} placeholder="先描述你的想法，新增後 AI 會追問需要釐清的資訊…" onChange={(e) => setDetail(e.target.value)} />
              <div className="flex justify-end">
                <Button onClick={add} disabled={referencePending} title={referencePending ? '附件處理中…' : undefined}><Plus />新增{referenceDraftCount ? `（${referenceDraftCount} 份參考）` : ''}</Button>
              </div>
            </div>
          </Panel>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="list" defaultSize="64" minSize="35">
          <Panel title="需求待辦" className="ml-1.5 h-full" bodyClassName="flex min-h-0 flex-col gap-2 overflow-hidden"
            actions={<Hint className="truncate">拖曳或用上／下按鈕排序・存在 <span className="mono" title={path}>{path}</span></Hint>}>
            {error && <Notice tone="bad" role="alert">{error}</Notice>}
            <ol ref={listRef} className="min-h-0 flex-1 space-y-2 overflow-auto" aria-label="需求待辦清單，依優先順序">
              {!items.length && (loaded
                ? <li className="py-8 text-center text-xs text-muted-foreground">還沒有需求，從左邊新增一個</li>
                : <li><Loading inline label="讀取需求…" className="justify-center py-8" /></li>)}
              {items.map((item, i) => {
                const lock = lockOf(item);
                if (editingId === item.id) {
                  return (
                    <li key={item.id} data-id={item.id} className="rounded-md border bg-card p-3">
                      <div className="flex flex-col gap-2">
                        <Label htmlFor="ed-title">標題</Label>
                        <Input id="ed-title" autoFocus maxLength={200} value={edit.title} onChange={(e) => setEdit({ ...edit, title: e.target.value })} />
                        <Label htmlFor="ed-detail">說明（Markdown）</Label>
                        <Textarea id="ed-detail" rows={5} value={edit.detail} onChange={(e) => setEdit({ ...edit, detail: e.target.value })} />
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                          <Button onClick={() => saveEdit(item)}><Save />儲存</Button>
                        </div>
                      </div>
                    </li>
                  );
                }
                return (
                  <ContextMenu key={item.id}>
                    <ContextMenuTrigger asChild>
                      <li
                        data-id={item.id}
                        draggable
                        onDragStart={(e) => onDragStart(e, item.id)}
                        onDragOver={(e) => onDragOver(e, item.id)}
                        onDragLeave={() => { if (drop?.id === item.id) setDrop(null); }}
                        onDrop={(e) => onDrop(e, item.id)}
                        onDragEnd={onDragEnd}
                        className={cn(
                          'relative flex gap-2 rounded-md border bg-card p-3',
                          dragId === item.id && 'opacity-50',
                          lock && 'bg-surface-2/60',
                          drop?.id === item.id && drop.before && 'before:absolute before:inset-x-2 before:-top-[5px] before:h-0.5 before:rounded before:bg-primary',
                          drop?.id === item.id && !drop.before && 'after:absolute after:inset-x-2 after:-bottom-[5px] after:h-0.5 after:rounded after:bg-primary',
                        )}
                      >
                        <span className="mt-0.5 shrink-0 cursor-grab text-muted-foreground" aria-hidden="true"><GripVertical className="size-4" /></span>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="mono text-xs text-muted-foreground">{i + 1}</span>
                            <b className="break-words">{item.title}</b>
                            <Chip tone={item.status === 'done' ? 'ok' : item.status === 'in_progress' ? 'info' : 'neutral'}>{BACKLOG_STATUS[item.status] || item.status}</Chip>
                          </div>
                          {item.detail && <Markdown text={item.detail} small className="mt-1 text-muted-foreground" />}
                          {lock && <Hint className="mt-1">{lock}</Hint>}
                        </div>
                        <div className="flex shrink-0 flex-wrap items-start justify-end gap-1" aria-label={`${item.title} 的操作`}>
                          <Button variant="ghost" size="icon-sm" data-act="up" aria-label={`往上移：${item.title}`} disabled={i === 0} onClick={() => move(item.id, -1)}><ArrowUp /></Button>
                          <Button variant="ghost" size="icon-sm" data-act="down" aria-label={`往下移：${item.title}`} disabled={i === items.length - 1} onClick={() => move(item.id, 1)}><ArrowDown /></Button>
                          <GuardButton variant="outline" size="sm" guard={lock} data-act="references" aria-label={`參考 ${item.references?.length || 0}：${item.title}`} onClick={() => references(item)}><Link2 />參考 {item.references?.length || 0}</GuardButton>
                          <GuardButton variant="ghost" size="icon-sm" guard={lock} data-act="edit" aria-label={`編輯：${item.title}`} onClick={() => startEdit(item)}><Pencil /></GuardButton>
                          <GuardButton variant="ghost" size="icon-sm" guard={lock} data-act="delete" aria-label={`刪除：${item.title}`} onClick={() => remove(item)}><Trash2 /></GuardButton>
                          <GuardButton variant="outline" size="sm" guard={lock} data-act="draft" aria-label={`釐清需求：${item.title}`} onClick={() => draft(item)}><Sparkles />釐清需求</GuardButton>
                        </div>
                      </li>
                    </ContextMenuTrigger>
                    <ContextMenuContent>
                      <ContextMenuItem disabled={!!lock} onSelect={() => draft(item)}><Sparkles />釐清需求</ContextMenuItem>
                      <ContextMenuItem disabled={!!lock} onSelect={() => references(item)}><Link2 />參考資料</ContextMenuItem>
                      <ContextMenuItem disabled={!!lock} onSelect={() => startEdit(item)}><Pencil />編輯</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem disabled={i === 0} onSelect={() => move(item.id, -1)}><ArrowUp />往上移</ContextMenuItem>
                      <ContextMenuItem disabled={i === items.length - 1} onSelect={() => move(item.id, 1)}><ArrowDown />往下移</ContextMenuItem>
                      <ContextMenuSeparator />
                      <ContextMenuItem variant="destructive" disabled={!!lock} onSelect={() => remove(item)}><Trash2 />刪除</ContextMenuItem>
                    </ContextMenuContent>
                  </ContextMenu>
                );
              })}
            </ol>
          </Panel>
        </ResizablePanel>
      </ResizablePanelGroup>
      <InterviewHost />
    </Page>
  );
}

export { LOCKED_ACTIONS };

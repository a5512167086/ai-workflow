// 參考資料的純邏輯：各區域的選項（referenceOptions）、儲存選取（草稿或寫到後端）、匯入快照。
import { useProject } from '@/stores/project';
import { useReferences } from '@/stores/references';
import type { ReferenceItem } from '@/types/api';

export type ReferenceType = 'backlog-draft' | 'chat' | 'feature' | 'group' | 'task';

export interface ReferenceOptions {
  title: string;
  /** 草稿附件的鍵（'backlog'、'chat:<id|new>'）；有鍵就只存在前端草稿，沒有鍵就直接寫到後端。 */
  key?: string;
  target?: 'feature' | 'group' | 'task' | 'backlog';
  id?: string;
  tag?: string;
  featureScope?: string | null;
  ids: string[];
  /** 後端防呆的原因；有原因時只能看、不能改。 */
  lock?: string;
  /** 寫到後端成功後的回呼（例如需求待辦要重新讀清單）。 */
  onSaved?: () => void | Promise<void>;
}

export interface ReferenceContext {
  chatId?: string | null;
  backlogId?: string;
  taskId?: string;
  taskStatus?: string;
  taskReferences?: string[];
}

export const MAX_REFERENCES = 24;
export const MAX_IMPORT_BATCH = 16;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** 每個區域的參考資料從哪裡來、能不能改。lock 是後端防呆規則給的原因（執行中、功能已完成、任務已完成）。 */
export function referenceOptions(type: ReferenceType, ctx: ReferenceContext = {}): ReferenceOptions {
  const snap = useProject.getState().snap;
  const guard = (name: string) => snap?.guards?.[name] || '';
  const draft = (key: string) => useReferences.getState().draft(key);
  switch (type) {
    case 'backlog-draft':
      return { title: '需求參考', key: 'backlog', ids: draft('backlog') };
    case 'chat': {
      const key = `chat:${ctx.chatId || 'new'}`;
      return { title: '訊息參考', key, ids: draft(key) };
    }
    case 'feature':
      return { title: '功能參考（PRD、拆任務共用）', target: 'feature', featureScope: snap?.state?.prd?.reference_scope ?? null, ids: snap?.state?.prd?.references || [], lock: guard('prd.references') };
    case 'group':
      return { title: '功能共用參考', target: 'group', tag: snap?.taskTag, ids: snap?.taskReferences || [], lock: guard('tasks.references') };
    case 'task':
      return {
        title: '此任務額外參考（另沿用功能與父任務）', target: 'task', id: ctx.taskId, tag: snap?.taskTag, ids: ctx.taskReferences || [],
        lock: guard('tasks.references') || (ctx.taskStatus === 'done' ? '這個任務已完成，參考資料不會再被使用' : ''),
      };
  }
}

/** 區域的鍵（草稿鍵或後端目標），用來標記「正在匯入」。 */
export const pendingKey = (options: Pick<ReferenceOptions, 'key' | 'target'>) => options.key || options.target || '';

/** 儲存選取：草稿只放前端；其他直接寫到後端並重讀快照。 */
export async function saveReferenceSelection(options: ReferenceOptions, ids: string[]) {
  if (options.lock) throw new Error(options.lock);
  ids = [...new Set(ids)];
  if (ids.length > MAX_REFERENCES) throw new Error(`最多加入 ${MAX_REFERENCES} 份參考資料`);
  const refs = useReferences.getState();
  if (options.key) {
    refs.setDraft(options.key, ids);
    await options.onSaved?.();
    return;
  }
  const project = useProject.getState();
  await project.api('/api/references/assign', { target: options.target, id: options.id, tag: options.tag, featureScope: options.featureScope, references: ids });
  if (options.target !== 'backlog') await project.refresh();
  await options.onSaved?.();
}

export async function importReference(body: { path?: string; name?: string; data?: string }): Promise<ReferenceItem> {
  const item = await useProject.getState().api<ReferenceItem>('/api/references/import', body);
  useReferences.getState().put(item);
  return item;
}

/** 瀏覽器端的檔案（貼上、拖放或 <input type=file>）：讀成 base64 交給後端建立快照。 */
export async function uploadReference(file: File): Promise<ReferenceItem> {
  if (file.size > MAX_FILE_BYTES) throw new Error('單檔上限 20 MB');
  const data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error || new Error('讀取檔案失敗'));
    reader.readAsDataURL(file);
  });
  return importReference({ name: file.name || `貼上圖片-${Date.now()}.png`, data });
}

export const kindGlyph = (kind?: string) => (kind === 'folder' ? '▤' : '▧');

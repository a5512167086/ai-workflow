// 視窗層級的檔案拖放（Tauri onDragDropEvent）：依游標所在的區域決定加到哪裡。
// 各畫面在自己的區域加上 data-reference-drop="backlog-draft|feature|task|group|chat"；Skills 頁加 data-skill-drop，
// 拖進去會發出 window 事件 'ai-workflow:import-skills'（detail.paths）讓 Skills 頁匯入技能資料夾。
import { useEffect } from 'react';
import { toast } from 'sonner';
import { onFileDrop } from '@/lib/tauri';
import { errorMessage } from '@/lib/api';
import { importReference, referenceOptions, saveReferenceSelection, MAX_IMPORT_BATCH, type ReferenceType } from '@/features/references/options';
import { isReferenceDialogOpen, importPathsIntoDialog } from '@/features/references/ReferenceDialog';

const TYPES: ReferenceType[] = ['backlog-draft', 'feature', 'task', 'group', 'chat'];

/** 處理一次拖放（匯出給測試用）。ctx 由 data-reference-* 屬性提供：task 區域可帶 data-reference-task-id／status。 */
export async function handleDrop(paths: string[], element: Element | null) {
  if (isReferenceDialogOpen()) { importPathsIntoDialog(paths); return; }
  if (element?.closest('[data-skill-drop]')) { window.dispatchEvent(new CustomEvent('ai-workflow:import-skills', { detail: { paths } })); return; }
  const zone = element?.closest<HTMLElement>('[data-reference-drop]');
  const type = zone?.dataset.referenceDrop as ReferenceType | undefined;
  if (!type || !TYPES.includes(type)) { toast('請將參考資料拖到需求、PRD、任務或聊天區域'); return; }
  const options = referenceOptions(type, {
    chatId: zone?.dataset.referenceChatId || null,
    taskId: zone?.dataset.referenceTaskId,
    taskStatus: zone?.dataset.referenceTaskStatus,
    taskReferences: zone?.dataset.referenceTaskReferences ? zone.dataset.referenceTaskReferences.split(',').filter(Boolean) : [],
  });
  if (options.lock) { toast.error(options.lock); return; }
  try {
    const ids = [...options.ids];
    for (const path of paths.slice(0, MAX_IMPORT_BATCH)) ids.push((await importReference({ path })).id);
    await saveReferenceSelection(options, [...new Set(ids)]);
    toast.success('已加入參考資料');
  } catch (err) { toast.error(errorMessage(err)); }
}

export function ReferenceDropHost() {
  useEffect(() => {
    let unlisten: (() => void) | null = null, cancelled = false;
    onFileDrop((paths, position) => {
      const element = position ? document.elementFromPoint(position.x, position.y) : null;
      void handleDrop(paths, element);
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; }).catch((err) => console.warn('參考資料拖放無法啟用', err));
    return () => { cancelled = true; unlisten?.(); };
  }, []);
  return null;
}

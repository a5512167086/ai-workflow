// textarea 的參考資料輸入：貼上圖片／檔案會先建立快照再加入附件；輸入 @ 列出專案檔案與已加入的快照。
import { useEffect, type RefObject } from 'react';
import { useLatest, useRefElement } from '@/hooks/use-ref-element';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';
import { useReferences } from '@/stores/references';
import { importReference, uploadReference, saveReferenceSelection, pendingKey, kindGlyph, type ReferenceOptions } from '@/features/references/options';
import { openPopup, popupKeydown, type Popup } from '@/features/references/popup';
import type { ReferenceItem, ReferenceSuggestion } from '@/types/api';

type Row = ReferenceItem | ReferenceSuggestion;

export function useReferenceInput(ref: RefObject<HTMLTextAreaElement | null>, getOptionsProp: () => ReferenceOptions) {
  // 輸入框出現時才綁定；getOptions 每次 render 都是新的函式，用 ref 取最新的，避免重畫時把正在顯示的 @ 清單關掉。
  const input = useRefElement(ref);
  const latest = useLatest(getOptionsProp);
  useEffect(() => {
    if (!input) return;
    const getOptions = () => latest.current();
    let popup: Popup | null = null, timer: ReturnType<typeof setTimeout> | undefined, generation = 0, rows: Row[] = [], token = { start: 0, end: 0 };
    const hide = () => { popup?.remove(); popup = null; rows = []; generation++; };
    const choose = async (index: number) => {
      const row = rows[index]; if (!row) return;
      const options = getOptions(); const selected = token; hide();
      try {
        const item = 'id' in row && row.id ? (row as ReferenceItem) : await importReference({ path: (row as ReferenceSuggestion).path });
        await saveReferenceSelection(options, [...new Set([...options.ids, item.id])]);
        input.setRangeText(`@${item.name} `, selected.start, selected.end, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
      } catch (err) { toast.error(errorMessage(err)); }
    };
    const onPaste = async (event: ClipboardEvent) => {
      const files = [...(event.clipboardData?.files || [])]; if (!files.length) return;
      event.preventDefault(); const options = getOptions(); const key = pendingKey(options);
      const refs = useReferences.getState();
      if (refs.pending.has(key)) return;
      refs.setPending(key, true);
      try {
        const ids = [...options.ids];
        // 一次上傳一份：每份都要在後端建快照，依序做才不會同時佔用大量記憶體。
        for (const file of files) ids.push((await uploadReference(file)).id); // NOSONAR：刻意依序上傳
        await saveReferenceSelection(options, ids);
      } catch (err) { toast.error(errorMessage(err)); }
      finally { useReferences.getState().setPending(key, false); }
    };
    const onInput = () => {
      clearTimeout(timer); hide();
      const before = input.value.slice(0, input.selectionStart ?? input.value.length);
      const match = before.match(/(?:^|\s)@([^\s@]*)$/);
      if (!match) return;
      token = { start: before.length - match[1].length - 1, end: before.length };
      const query = match[1]; const current = generation;
      timer = setTimeout(async () => {
        try {
          const data = await useProject.getState().api<{ items?: ReferenceSuggestion[] }>('/api/references/suggest', { query });
          if (current !== generation || !input.isConnected || document.activeElement !== input) return;
          const catalog = [...useReferences.getState().catalog.values()];
          rows = [...catalog.filter((item) => item.name.toLowerCase().includes(query.toLowerCase())), ...(data.items || [])].slice(0, 12);
          if (!rows.length) return;
          popup = openPopup(input, rows.map((row) => ({ label: `${kindGlyph(row.kind)} ${row.name}${'id' in row && row.id ? ' · 已加入' : ''}` })), choose, 'reference-suggestions', '參考資料');
        } catch (err) { toast.error(errorMessage(err)); }
      }, 180);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (popupKeydown(popup, event, choose, hide)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const onBlur = () => hide();
    input.addEventListener('paste', onPaste);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown, true);
    input.addEventListener('blur', onBlur);
    return () => {
      clearTimeout(timer); hide();
      input.removeEventListener('paste', onPaste);
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown, true);
      input.removeEventListener('blur', onBlur);
    };
  }, [input, latest]);
}

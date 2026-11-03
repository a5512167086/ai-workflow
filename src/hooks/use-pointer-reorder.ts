// 拖曳排序：用 pointer events 自己做，不用 HTML5 drag and drop。
// 桌面 App 開著視窗層級的檔案拖放（拖參考資料進來）；Tauri 在 Windows 上這樣設定時，網頁裡的 HTML5 拖曳事件不會觸發。
// 用法：清單容器給 ref，每一列加 {...rowProps(id)} 與 data-reorder-id。按住列上的空白處（不是按鈕、連結、輸入框）拖動超過 4px 才開始，
// 單純點擊照常；Esc 取消；拖到清單上下緣會自動捲動。
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { useLatest } from '@/hooks/use-ref-element';

export interface DropTarget { id: string; before: boolean }

const THRESHOLD = 4;
const EDGE = 40;
const INTERACTIVE = 'button, a, input, textarea, select, label, [role="menuitem"], [contenteditable="true"], [data-no-drag]';

/** 游標所在位置要放在哪一列的前面或後面（以每列的垂直中線判斷）；沒有其他列時回傳 null。 */
export function dropTargetAt(list: HTMLElement, y: number, dragging: string): DropTarget | null {
  const rows = [...list.querySelectorAll<HTMLElement>('[data-reorder-id]')].filter((el) => el.dataset.reorderId !== dragging);
  for (const el of rows) {
    const r = el.getBoundingClientRect();
    if (y < r.top + r.height / 2) return { id: el.dataset.reorderId!, before: true };
  }
  const last = rows.at(-1);
  return last ? { id: last.dataset.reorderId!, before: false } : null;
}

export function usePointerReorder({ list, onDrop }: { list: RefObject<HTMLElement | null>; onDrop: (from: string, target: DropTarget) => void }) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const drag = useRef<{ id: string; pointer: number; x: number; y: number; active: boolean; target: DropTarget | null; el: HTMLElement } | null>(null);
  const dropRef = useLatest(onDrop);

  const finish = useCallback((commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    document.body.classList.remove('select-none', 'cursor-grabbing');
    if (d?.el.hasPointerCapture?.(d.pointer)) d.el.releasePointerCapture(d.pointer);
    setDragId(null); setDrop(null);
    if (commit && d?.active && d.target) dropRef.current(d.id, d.target);
  }, [dropRef]);

  // 拖曳中按 Esc 取消。
  useEffect(() => {
    if (!dragId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dragId, finish]);

  const rowProps = useCallback((id: string) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest(INTERACTIVE)) return;
      drag.current = { id, pointer: e.pointerId, x: e.clientX, y: e.clientY, active: false, target: null, el: e.currentTarget };
    },
    onPointerMove: (e: ReactPointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (!d || d.pointer !== e.pointerId || !list.current) return;
      if (!d.active) {
        if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) < THRESHOLD) return;
        d.active = true;
        // 開始拖曳後才抓住指標：之前抓會讓列裡的點擊失效。
        try { d.el.setPointerCapture(e.pointerId); } catch { /* jsdom、舊瀏覽器沒有 pointer capture */ }
        getSelection()?.removeAllRanges();
        document.body.classList.add('select-none', 'cursor-grabbing');
        setDragId(d.id);
      }
      e.preventDefault();
      const box = list.current.getBoundingClientRect();
      if (e.clientY < box.top + EDGE) list.current.scrollTop -= 12;
      else if (e.clientY > box.bottom - EDGE) list.current.scrollTop += 12;
      d.target = dropTargetAt(list.current, e.clientY, d.id);
      setDrop((prev) => (prev?.id === d.target?.id && prev?.before === d.target?.before ? prev : d.target));
    },
    onPointerUp: (e: ReactPointerEvent<HTMLElement>) => { if (drag.current?.pointer === e.pointerId) finish(true); },
    onPointerCancel: (e: ReactPointerEvent<HTMLElement>) => { if (drag.current?.pointer === e.pointerId) finish(false); },
  }), [list, finish]);

  return { dragId, drop, rowProps };
}

/** 把 from 移到 target 的前面或後面；回傳新的 id 順序（target 不在清單裡時原樣回傳）。 */
export function reorderIds(ids: string[], from: string, target: DropTarget): string[] {
  const rest = ids.filter((x) => x !== from);
  const at = rest.indexOf(target.id);
  if (at < 0 || from === target.id) return ids;
  rest.splice(at + (target.before ? 0 : 1), 0, from);
  return rest;
}

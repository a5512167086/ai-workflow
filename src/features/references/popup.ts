// 輸入框上方的補全清單（@ 參考、/ 技能共用）：用純 DOM 畫，掛在 body，呼叫端忽略回傳值也能正常運作。
export interface PopupRow { label: string; description?: string }

export interface Popup {
  el: HTMLDivElement;
  cursor: number;
  rows: PopupRow[];
  move: (delta: number) => void;
  remove: () => void;
}

/** 在 input 上方開一個 listbox；choose(index) 由鍵盤或滑鼠觸發。 */
export function openPopup(input: HTMLElement, rows: PopupRow[], choose: (index: number) => void, className: string, label: string): Popup {
  const el = document.createElement('div');
  el.className = `fixed z-50 max-h-64 overflow-auto rounded-md border bg-popover text-popover-foreground shadow-md ${className}`;
  el.setAttribute('role', 'listbox'); el.setAttribute('aria-label', label);
  const rect = input.getBoundingClientRect();
  el.style.left = `${rect.left}px`; el.style.bottom = `${window.innerHeight - rect.top + 4}px`; el.style.width = `${Math.min(rect.width, 550)}px`;
  const popup: Popup = {
    el, cursor: 0, rows,
    move: (delta) => {
      popup.cursor = (popup.cursor + delta + rows.length) % rows.length;
      [...el.children].forEach((child, i) => child.setAttribute('aria-selected', String(i === popup.cursor)));
      (el.children[popup.cursor] as HTMLElement | undefined)?.scrollIntoView?.({ block: 'nearest' });
    },
    remove: () => el.remove(),
  };
  rows.forEach((row, index) => {
    const button = document.createElement('button'); button.type = 'button'; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === 0));
    button.className = 'flex w-full items-baseline gap-2 px-2.5 py-1.5 text-left text-xs hover:bg-accent aria-selected:bg-accent';
    const name = document.createElement('b'); name.textContent = row.label; button.append(name);
    if (row.description) { const desc = document.createElement('span'); desc.className = 'truncate text-muted-foreground'; desc.textContent = row.description; button.append(desc); }
    button.onmousedown = (event) => { event.preventDefault(); choose(index); };
    el.append(button);
  });
  document.body.append(el);
  return popup;
}

const NAV_KEYS = ['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'];

/** 鍵盤操作：回傳 true 表示事件已處理（呼叫端要 preventDefault 與 stopImmediatePropagation）。 */
export function popupKeydown(popup: Popup | null, event: KeyboardEvent, choose: (index: number) => void, hide: () => void): boolean {
  if (!popup || event.isComposing || !NAV_KEYS.includes(event.key)) return false;
  if (event.key === 'Escape') hide();
  else if (event.key === 'Enter' || event.key === 'Tab') choose(popup.cursor);
  else popup.move(event.key === 'ArrowDown' ? 1 : -1);
  return true;
}

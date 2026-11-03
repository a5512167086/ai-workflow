// 模型選擇器（combobox）：取代瀏覽器原生的 datalist。清單來自 useModels（/api/models），可輸入任意模型 ID；
// 鍵盤：↑↓ 移動、Enter 選取（沒有選取項就用輸入的文字）、Escape 關閉。
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { useModels } from '@/stores/models';
import { cn } from '@/lib/utils';
import type { ModelInfo, Provider } from '@/types/api';

export interface ModelPickerProps {
  provider: Provider;
  value: string;
  onChange: (model: string) => void;
  placeholder?: string;
  'aria-label'?: string;
  className?: string;
  disabled?: boolean;
}

export function ModelPicker({ provider, value, onChange, placeholder, className, disabled, ...rest }: Readonly<ModelPickerProps>) {
  const options = useModels((s) => s.options);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState(false); // 剛打開時列出全部，開始輸入才篩選
  const [active, setActive] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  const all = options?.[provider]?.models || [];

  useEffect(() => { if (open) void useModels.getState().load(); }, [open]);

  const items = useMemo<ModelInfo[]>(() => {
    const query = filter ? value.trim().toLowerCase() : '';
    let list = query ? all.filter((m) => `${m.id} ${m.name} ${m.description || ''}`.toLowerCase().includes(query)) : all;
    // 輸入的值剛好是某個模型時也列出全部，方便換成別的。
    if (query && all.some((m) => m.id.toLowerCase() === query)) list = all;
    return [{ id: '', name: '沿用預設', description: (placeholder || '').replace(/^模型：/, '') }, ...list];
  }, [all, filter, value, placeholder]);

  const choose = (id: string) => { onChange(id); setOpen(false); setActive(-1); };
  const move = (delta: number) => {
    if (!open) { setOpen(true); setFilter(false); return; }
    const n = items.length; if (!n) return;
    setActive((a) => (a + delta + n) % n);
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); const item = items[active]; choose(item ? item.id : value.trim()); }
  };
  const noMatch = filter && value.trim() && items.length === 1;

  return (
    <Popover open={open && all.length > 0} onOpenChange={(o) => { setOpen(o); if (!o) setActive(-1); }}>
      <PopoverAnchor asChild>
        <Input
          ref={input}
          role="combobox"
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-label={rest['aria-label']}
          autoComplete="off"
          className={cn('mono', className)}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => { onChange(e.target.value); setFilter(true); setActive(-1); setOpen(true); }}
          onFocus={() => { setFilter(false); setOpen(true); }}
          onClick={() => { if (!open) { setFilter(false); setOpen(true); } }}
          onKeyDown={onKeyDown}
        />
      </PopoverAnchor>
      <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] min-w-[300px] p-1" onOpenAutoFocus={(e) => e.preventDefault()} onInteractOutside={(e) => { if (e.target === input.current) e.preventDefault(); }}>
        <ul id={listId} role="listbox" className="max-h-72 overflow-auto">
          {items.map((m, i) => (
            <li
              key={m.id || '__default'}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={m.id === value}
              className={cn('cursor-pointer rounded px-2 py-1 text-xs hover:bg-accent', i === active && 'bg-accent', m.id === value && 'font-semibold')}
              onMouseDown={(e) => { e.preventDefault(); choose(m.id); }}
            >
              <div className="flex items-baseline gap-2"><b>{m.name}</b>{m.id && <code className="mono text-[11px] text-muted-foreground">{m.id}</code>}</div>
              {m.description && <small className="block text-muted-foreground">{m.description}</small>}
            </li>
          ))}
          {noMatch && <li className="px-2 py-1 text-xs text-muted-foreground">沒有符合的模型，按 Enter 直接使用「{value.trim()}」</li>}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

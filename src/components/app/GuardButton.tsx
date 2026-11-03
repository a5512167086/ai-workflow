// 依後端防呆原因停用的按鈕：有原因就停用並把原因放在 tooltip。
// 有說明時用 aria-disabled 而不是 disabled：按鈕仍可用鍵盤聚焦、滑鼠停留，看得到為什麼不能按；點擊會被擋下。
import type { ComponentProps, MouseEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function GuardButton({ guard, title, children, disabled, onClick, ...props }: ComponentProps<typeof Button> & { guard?: string }) {
  const reason = guard || '';
  const off = !!reason || !!disabled;
  const tip = reason || title;
  if (!tip) return <Button {...props} disabled={off} onClick={onClick}>{children}</Button>;
  const guarded = (event: MouseEvent<HTMLButtonElement>) => {
    if (off) { event.preventDefault(); return; }
    onClick?.(event);
  };
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button {...props} aria-disabled={off || undefined} data-guarded={reason ? '1' : undefined} onClick={guarded}>{children}</Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{tip}</TooltipContent>
    </Tooltip>
  );
}

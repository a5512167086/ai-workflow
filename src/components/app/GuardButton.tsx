// 依後端防呆原因停用的按鈕：有原因就停用並把原因放在 tooltip（滑鼠停在停用的按鈕上也看得到）。
import type { ComponentProps } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

export function GuardButton({ guard, title, children, disabled, ...props }: ComponentProps<typeof Button> & { guard?: string }) {
  const reason = guard || '';
  const off = !!reason || disabled;
  const button = (
    <Button {...props} disabled={off} aria-disabled={off || undefined} title={reason ? undefined : title} data-guarded={reason ? '1' : undefined}>
      {children}
    </Button>
  );
  if (!reason && !title) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {off ? <span className="inline-flex" tabIndex={0}>{button}</span> : button}
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{reason || title}</TooltipContent>
    </Tooltip>
  );
}

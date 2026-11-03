// AI 正在打字的回覆：逐字顯示（節流後用 Markdown 畫），結尾有閃爍的游標。
// 圖表（mermaid）在打字中只顯示原始碼，等整段寫完變成正式訊息後才畫。
import { useLayoutEffect, useRef } from 'react';
import { Markdown } from '@/components/app/Markdown';
import { useThrottled } from '@/hooks/use-throttled';
import { cn } from '@/lib/utils';

export function TypingCursor({ className }: Readonly<{ className?: string }>) {
  return <span aria-hidden="true" className={cn('ml-0.5 inline-block h-[1em] w-[0.5em] translate-y-[0.15em] animate-pulse rounded-[1px] bg-primary/70', className)} />;
}

/** 最近的可捲動外層。 */
function scrollParent(el: HTMLElement | null): HTMLElement | null {
  for (let p = el?.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

export function StreamingText({ text, className, small }: Readonly<{ text: string; className?: string; small?: boolean }>) {
  const shown = useThrottled(text);
  const box = useRef<HTMLDivElement>(null);
  const prevHeight = useRef(0);
  // 跟著新文字捲到底；使用者往上捲去看前面的內容時不打擾（只在原本就貼近底部時跟隨）。
  useLayoutEffect(() => {
    const parent = scrollParent(box.current);
    if (!parent) return;
    const grew = parent.scrollHeight - prevHeight.current;
    prevHeight.current = parent.scrollHeight;
    if (parent.scrollHeight - parent.scrollTop - parent.clientHeight - Math.max(grew, 0) < 80) parent.scrollTop = parent.scrollHeight;
  }, [shown]);
  return (
    <div ref={box} className={cn('relative', className)} aria-live="polite" aria-busy="true">
      <Markdown text={shown} small={small} streaming />
      <TypingCursor />
    </div>
  );
}

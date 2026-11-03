// 狀態膠囊：圓點 + 文字（色彩與文字並用，不只靠顏色）。
import type { Tone } from '@/lib/constants';
import { cn } from '@/lib/utils';

const TONES: Record<Tone, string> = {
  idle: 'text-muted-foreground [--dot:var(--muted-foreground)]',
  queued: 'text-info bg-info-soft [--dot:var(--info)]',
  running: 'text-info bg-info-soft [--dot:var(--info)] [&>i]:animate-pulse',
  paused: 'text-warn bg-warn-soft [--dot:var(--warn)]',
  waiting: 'text-warn bg-warn-soft [--dot:var(--warn)]',
  feature_test: 'text-warn bg-warn-soft [--dot:var(--warn)]',
  stuck: 'text-danger bg-danger-soft [--dot:var(--danger)]',
  error: 'text-danger bg-danger-soft [--dot:var(--danger)]',
  complete: 'text-ok bg-ok-soft [--dot:var(--ok)]',
};

export function StatusPill({ tone, children, className, label }: { tone: Tone; children: React.ReactNode; className?: string; label?: string }) {
  return (
    <span role="status" aria-atomic="true" aria-label={label} className={cn('inline-flex items-center gap-1.5 rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONES[tone], className)}>
      <i aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-[var(--dot)]" />
      <span>{children}</span>
    </span>
  );
}

/** 小標籤（chip），例如 PRD 狀態、優先度、任務狀態。 */
export function Chip({ tone = 'neutral', children, className, title }: { tone?: 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'review'; children: React.ReactNode; className?: string; title?: string }) {
  const tones = {
    neutral: 'bg-surface-2 text-muted-foreground border-border',
    ok: 'bg-ok-soft text-ok border-transparent',
    warn: 'bg-warn-soft text-warn border-transparent',
    bad: 'bg-danger-soft text-danger border-transparent',
    info: 'bg-info-soft text-info border-transparent',
    review: 'bg-review/10 text-review border-transparent',
  };
  return <span title={title} className={cn('inline-flex items-center rounded-full border px-2 py-px text-[11px] font-medium leading-4 whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

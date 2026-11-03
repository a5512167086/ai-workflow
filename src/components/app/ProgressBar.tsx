// 細的進度條：原生 <progress>（本身就是 progressbar 角色，輔助技術讀得到數值），外觀和其他元件一致。
import { cn } from '@/lib/utils';

export function ProgressBar({ value, label, className }: Readonly<{ value: number; label: string; className?: string }>) {
  return (
    <progress
      value={value}
      max={100}
      aria-label={label}
      className={cn(
        'block h-1.5 w-full appearance-none overflow-hidden rounded bg-surface-2',
        '[&::-webkit-progress-bar]:bg-surface-2 [&::-webkit-progress-value]:bg-primary [&::-webkit-progress-value]:transition-[width] [&::-moz-progress-bar]:bg-primary',
        className,
      )}
    />
  );
}

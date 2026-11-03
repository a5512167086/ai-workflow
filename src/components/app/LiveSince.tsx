// 顯示狀態文字；since 有值時附上持續時間並每秒更新（「AI 處理中（已 1 分 23 秒）」）。
import { useEffect, useState } from 'react';
import { elapsedText } from '@/lib/format';
import { cn } from '@/lib/utils';

export function useElapsed(since?: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!since) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since ? elapsedText(since, now) : '';
}

export function LiveSince({ label, since, className, role = 'status' }: { label: string; since?: string | null; className?: string; role?: string }) {
  const elapsed = useElapsed(since);
  if (!label) return null;
  return (
    <span role={role} className={cn('text-muted-foreground', className)} data-since={since || undefined}>
      {elapsed ? `${label}（已 ${elapsed}）` : label}
    </span>
  );
}

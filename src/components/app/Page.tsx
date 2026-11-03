// 畫面骨架：固定外框、各區獨立捲動（桌面 app 不出現頁面捲軸）。
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Spinner } from '@/components/ui/spinner';

/** 每個畫面的最外層：填滿主區域、不捲動；內容自己決定哪裡捲。 */
export function Page({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <div className={cn('flex h-full min-h-0 flex-col overflow-hidden', className)}>{children}</div>;
}

/** 畫面頂端的工具列：標題、說明與動作放同一列，高度固定。 */
export function PageHeader({ title, description, actions, className, children }: Readonly<{ title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string; children?: ReactNode }>) {
  return (
    <header className={cn('flex min-h-11 shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b bg-background px-4 py-2', className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[15px] font-semibold leading-6">{title}</h1>
        {description && <p className="truncate text-xs text-muted-foreground">{description}</p>}
      </div>
      {children}
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}

/** 可捲動的內容區。 */
export function PageBody({ children, className, padded = true }: Readonly<{ children: ReactNode; className?: string; padded?: boolean }>) {
  return <div className={cn('min-h-0 flex-1 overflow-auto', padded && 'p-4', className)}>{children}</div>;
}

export function EmptyState({ title, description, action, className }: Readonly<{ title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string }>) {
  return (
    <div className={cn('flex h-full flex-col items-center justify-center gap-2 p-8 text-center', className)}>
      <p className="text-sm font-medium">{title}</p>
      {description && <p className="max-w-md text-xs text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/**
 * 讀取資料中：轉圈圖示＋說明。預設置中填滿所在區塊（整個畫面或面板還沒有內容時）；
 * inline 用在清單或一小段區域裡（靠左、一行）。
 */
export function Loading({ label = '載入中…', inline, className }: Readonly<{ label?: ReactNode; inline?: boolean; className?: string }>) {
  return (
    <div role="status" aria-live="polite" className={cn('flex items-center gap-2 text-xs text-muted-foreground', inline ? 'py-1' : 'h-full min-h-24 w-full justify-center p-8', className)}>
      <Spinner className={inline ? 'size-3.5' : 'size-5'} />
      <span>{label}</span>
    </div>
  );
}

/** 卡片區塊（Swiss style：1px 邊框、無陰影）。 */
export function Panel({ title, actions, children, className, bodyClassName }: Readonly<{ title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string }>) {
  return (
    <section className={cn('flex min-h-0 flex-col rounded-lg border bg-card', className)}>
      {(title || actions) && (
        <div className="flex min-h-9 shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
          <h2 className="truncate text-[13px] font-semibold">{title}</h2>
          {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
        </div>
      )}
      <div className={cn('min-h-0 flex-1 p-3', bodyClassName)}>{children}</div>
    </section>
  );
}

/** 小標（欄位標籤、meta）。 */
export function Eyebrow({ children, className }: Readonly<{ children: ReactNode; className?: string }>) {
  return <span className={cn('text-[11px] font-semibold uppercase tracking-wide text-muted-foreground', className)}>{children}</span>;
}

/** 提示文字。 */
export function Hint({ children, className, role }: Readonly<{ children: ReactNode; className?: string; role?: string }>) {
  return <p role={role} className={cn('text-xs text-muted-foreground', className)}>{children}</p>;
}

/** 通知列（替代舊版 .notice）。 */
export function Notice({ tone = 'info', children, className, role = 'status' }: Readonly<{ tone?: 'info' | 'warn' | 'bad' | 'ok'; children: ReactNode; className?: string; role?: string }>) {
  const tones = { info: 'bg-info-soft text-info', warn: 'bg-warn-soft text-warn', bad: 'bg-danger-soft text-danger', ok: 'bg-ok-soft text-ok' };
  return <div role={role} className={cn('rounded-md px-3 py-2 text-xs', tones[tone], className)}>{children}</div>;
}

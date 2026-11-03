// 品牌標誌：兩個循環箭頭包住一串流程節點（loop ＋ flow）。
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4.5 10a8 8 0 0 1 14.2-3" />
      <path d="M19 3.5v3.8h-3.8" />
      <path d="M19.5 14a8 8 0 0 1-14.2 3" />
      <path d="M5 20.5v-3.8h3.8" />
      <path d="M8.5 12h7" strokeWidth="1.4" />
      <circle cx="8.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="12" r="1.3" fill="currentColor" stroke="none" />
    </svg>
  );
}

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/index.css';
import App from '@/App';

// 桌面 app：不要出現瀏覽器的右鍵選單（可編輯區除外）與拖曳圖片等行為。
document.addEventListener('contextmenu', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.closest('input, textarea, [contenteditable="true"], .selectable') || t.closest('[data-allow-context]'))) return;
  if (import.meta.env.DEV) return; // 開發時保留 DevTools 的右鍵檢查
  e.preventDefault();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

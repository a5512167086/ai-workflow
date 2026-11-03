// 桌面 app 的快捷鍵：Ctrl+K 指令面板、Ctrl+1…8 切換專案畫面、Ctrl+, 設定、Ctrl+B 收合側欄、Ctrl+Shift+O 所有專案。
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { PROJECT_VIEWS } from '@/lib/constants';
import { useUi } from '@/stores/ui';
import { useProject } from '@/stores/project';

const EDITABLE = /^(INPUT|TEXTAREA|SELECT)$/;

export function useShortcuts() {
  const navigate = useNavigate();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const target = e.target as HTMLElement | null;
      const typing = !!target && (EDITABLE.test(target.tagName) || target.isContentEditable);
      const key = e.key.toLowerCase();
      if (key === 'k' || (key === 'p' && e.shiftKey)) {
        e.preventDefault();
        useUi.getState().setPaletteOpen(!useUi.getState().paletteOpen);
        return;
      }
      if (key === ',' ) { e.preventDefault(); navigate('/settings'); return; }
      if (key === 'b' && !typing) { e.preventDefault(); const ui = useUi.getState(); ui.setSidebarCollapsed(!ui.sidebarCollapsed); return; }
      if (key === 'o' && e.shiftKey) { e.preventDefault(); navigate('/'); return; }
      const n = Number(e.key);
      if (!e.shiftKey && !e.altKey && n >= 1 && n <= PROJECT_VIEWS.length) {
        const id = useProject.getState().id;
        if (!id) return;
        e.preventDefault();
        navigate(`/p/${id}/${PROJECT_VIEWS[n - 1].key}`);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate]);
}

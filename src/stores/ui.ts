import { create } from 'zustand';
import { readStorage, writeStorage } from '@/lib/storage';

export type Theme = 'system' | 'light' | 'dark';
export const THEMES: { key: Theme; label: string }[] = [
  { key: 'system', label: '跟隨系統' },
  { key: 'light', label: '淺色' },
  { key: 'dark', label: '深色' },
];

const media = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

export function resolveDark(theme: Theme) {
  return theme === 'dark' || (theme === 'system' && !!media?.matches);
}

function applyTheme(theme: Theme) {
  const root = document.documentElement;
  root.classList.toggle('dark', resolveDark(theme));
  root.dataset.theme = theme;
}

interface UiState {
  theme: Theme;
  /** 目前畫面實際是不是深色（Mermaid、圖表要用）。 */
  dark: boolean;
  sidebarCollapsed: boolean;
  paletteOpen: boolean;
  setTheme: (theme: Theme) => void;
  cycleTheme: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
}

const initialTheme = ((): Theme => {
  const t = readStorage('ai-workflow-theme', 'system');
  return t === 'light' || t === 'dark' ? t : 'system';
})();
if (typeof document !== 'undefined') applyTheme(initialTheme);

export const useUi = create<UiState>((set, get) => ({
  theme: initialTheme,
  dark: resolveDark(initialTheme),
  sidebarCollapsed: readStorage('ai-workflow-sidebar') === 'collapsed',
  paletteOpen: false,
  setTheme: (theme) => {
    writeStorage('ai-workflow-theme', theme);
    applyTheme(theme);
    set({ theme, dark: resolveDark(theme) });
  },
  cycleTheme: () => {
    const keys = THEMES.map((t) => t.key);
    get().setTheme(keys[(keys.indexOf(get().theme) + 1) % keys.length]);
  },
  setSidebarCollapsed: (collapsed) => {
    writeStorage('ai-workflow-sidebar', collapsed ? 'collapsed' : 'open');
    set({ sidebarCollapsed: collapsed });
  },
  setPaletteOpen: (open) => set({ paletteOpen: open }),
}));

media?.addEventListener?.('change', () => {
  const { theme } = useUi.getState();
  if (theme === 'system') {
    applyTheme(theme);
    useUi.setState({ dark: resolveDark(theme) });
  }
});

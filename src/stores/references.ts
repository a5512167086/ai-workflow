// 參考資料：目錄（專案快照清單）、各輸入區的草稿附件、進行中的匯入。元件在 src/features/references。
import { create } from 'zustand';
import type { Api } from '@/lib/api';
import type { ReferenceItem } from '@/types/api';

interface ReferencesState {
  catalog: Map<string, ReferenceItem>;
  /** 草稿附件：鍵是 'backlog'、`chat:<id|new>` 等。 */
  drafts: Map<string, string[]>;
  /** 正在匯入／貼上的區域（同一個鍵）。 */
  pending: Set<string>;
  refresh: (api: Api) => Promise<void>;
  put: (item: ReferenceItem) => void;
  setDraft: (key: string, ids: string[]) => void;
  clearDraft: (key: string) => void;
  draft: (key: string) => string[];
  setPending: (key: string, on: boolean) => void;
  reset: () => void;
}

export const useReferences = create<ReferencesState>((set, get) => ({
  catalog: new Map(),
  drafts: new Map(),
  pending: new Set(),
  refresh: async (api) => {
    const data = await api<{ items: ReferenceItem[] }>('/api/references');
    if (!Array.isArray(data.items)) return;
    const catalog = new Map(get().catalog);
    for (const item of data.items) catalog.set(item.id, item);
    set({ catalog });
  },
  put: (item) => {
    const catalog = new Map(get().catalog);
    catalog.set(item.id, item);
    set({ catalog });
  },
  setDraft: (key, ids) => {
    const drafts = new Map(get().drafts);
    drafts.set(key, [...ids]);
    set({ drafts });
  },
  clearDraft: (key) => {
    const drafts = new Map(get().drafts);
    drafts.delete(key);
    set({ drafts });
  },
  draft: (key) => get().drafts.get(key) || [],
  setPending: (key, on) => {
    const pending = new Set(get().pending);
    if (on) pending.add(key); else pending.delete(key);
    set({ pending });
  },
  reset: () => set({ catalog: new Map(), drafts: new Map(), pending: new Set() }),
}));

export const referenceName = (catalog: Map<string, ReferenceItem>, id: string) => catalog.get(id)?.name || `參考 ${id.slice(0, 8)}`;

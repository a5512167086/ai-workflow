// 模型清單（/api/models）：設定頁、專案對話與技能會議的模型選單共用，整個 App 只查一次（後端另有 10 分鐘快取）。
import { create } from 'zustand';
import { api } from '@/lib/api';
import { effortsFor } from '@/lib/format';
import type { ModelOptions, Provider } from '@/types/api';

interface ModelsState {
  options: ModelOptions | null;
  loading: boolean;
  error: string | null;
  load: (force?: boolean) => Promise<void>;
  efforts: (provider: Provider, model: string) => string[];
}

let inflight: Promise<void> | null = null;

export const useModels = create<ModelsState>((set, get) => ({
  options: null,
  loading: false,
  error: null,
  load: async (force = false) => {
    if (get().options && !force) return;
    if (inflight) return inflight;
    set({ loading: true });
    inflight = api<ModelOptions>('/api/models')
      .then((options) => set({ options, error: null }))
      .catch((err) => set({ error: (err as Error).message }))
      .finally(() => { set({ loading: false }); inflight = null; });
    return inflight;
  },
  efforts: (provider, model) => effortsFor(get().options, provider, model),
}));

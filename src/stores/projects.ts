// 所有專案總覽：/api/projects 與背景推送的 `projects` 事件。
import { create } from 'zustand';
import { api } from '@/lib/api';
import { listen } from '@/lib/tauri';
import type { ProjectsPayload, ProjectSummary, QueueSnapshot } from '@/types/api';

interface ProjectsState {
  projects: ProjectSummary[];
  queue: QueueSnapshot;
  loaded: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  /** 開始接收背景推送（只會訂閱一次）。 */
  connect: () => void;
}

let connected = false;

export const useProjects = create<ProjectsState>((set) => ({
  projects: [],
  queue: { max: 1, running: [], waiting: [] },
  loaded: false,
  error: null,
  refresh: async () => {
    try {
      const data = await api<ProjectsPayload>('/api/projects');
      set({ projects: data.projects, queue: data.queue, loaded: true, error: null });
    } catch (err) {
      set({ error: (err as Error).message, loaded: true });
    }
  },
  connect: () => {
    if (connected) return;
    connected = true;
    listen<ProjectsPayload>('projects', (payload) => set({ projects: payload.projects, queue: payload.queue, loaded: true, error: null })).catch((err) =>
      set({ error: String(err?.message ?? err) }),
    );
  },
}));

export const selectAttention = (s: ProjectsState) => s.projects.filter((p) => p.attention);
export const projectName = (projects: ProjectSummary[], root: string) =>
  projects.find((p) => p.path.toLowerCase() === root.toLowerCase())?.name || root.split(/[\\/]/).pop() || root;

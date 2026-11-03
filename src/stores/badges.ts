// 左側導覽的徽章：各畫面依自己的資料更新（看板進度、待核准、回覆中…），側欄只負責顯示。
import { create } from 'zustand';
import type { ProjectView } from '@/lib/constants';

export interface Badge { text: string; attention?: boolean }

interface BadgesState {
  badges: Partial<Record<ProjectView, Badge>>;
  set: (view: ProjectView, badge: Badge | null) => void;
  reset: () => void;
}

export const useBadges = create<BadgesState>((set, get) => ({
  badges: {},
  set: (view, badge) => {
    const prev = get().badges[view];
    if ((prev?.text || '') === (badge?.text || '') && !!prev?.attention === !!badge?.attention) return;
    set({ badges: { ...get().badges, [view]: badge || undefined } });
  },
  reset: () => set({ badges: {} }),
}));

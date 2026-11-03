// 「帶入需求待辦」：技能會議把會議紀錄帶到需求待辦的新增表單（跨畫面的一次性草稿）。
import { create } from 'zustand';

interface BacklogDraftState {
  title: string;
  detail: string;
  /** 是否由其他畫面帶入（需求頁讀取後清除）。 */
  pending: boolean;
  set: (title: string, detail: string) => void;
  take: () => { title: string; detail: string } | null;
}

export const useBacklogDraft = create<BacklogDraftState>((set, get) => ({
  title: '',
  detail: '',
  pending: false,
  set: (title, detail) => set({ title, detail, pending: true }),
  take: () => {
    if (!get().pending) return null;
    const { title, detail } = get();
    set({ title: '', detail: '', pending: false });
    return { title, detail };
  },
}));

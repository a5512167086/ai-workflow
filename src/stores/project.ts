// 目前開啟的專案：快照（/api/p/<id>/state 與 state-<id> 事件）、各來源的 log（log-<id> 事件）。
// 一次只開一個專案；切換專案時取消上一個的訂閱。畫面元件用 useProject()／useSnapshot() 讀取。
import { create } from 'zustand';
import { useShallow } from 'zustand/shallow';
import { projectApi, type Api } from '@/lib/api';
import { invoke, listen } from '@/lib/tauri';
import type { PrdRound, Snapshot } from '@/types/api';
import type { UnlistenFn } from '@tauri-apps/api/event';

export const LOG_LIMIT = 400_000;
export const LOG_KEEP = 300_000;

type LogListener = (scope: string, text: string) => void;

interface ProjectState {
  id: string | null;
  api: Api;
  snap: Snapshot | null;
  /** 讀取快照失敗的原因（例如專案資料夾不見了）。 */
  error: string | null;
  logs: Record<string, string>;
  /** 已經從檔案讀過完整內容（最多最後 200 KB）的 log；串流只會推送開著 App 之後新增的部分。 */
  logsFull: Set<string>;
  rounds: PrdRound[];
  /** AI 正在打的那一段文字（還沒寫完、還沒進 log），鍵是 log 的 scope（chat-<turn>、skill-<id>、task-3、prd…）。 */
  streams: Record<string, string>;
  open: (id: string) => Promise<void>;
  close: () => void;
  refresh: () => Promise<Snapshot | null>;
  setSnap: (snap: Snapshot) => void;
  /** 第一次看某個來源時讀完整檔案；串流先收到的片段已經包含在檔案裡，所以直接取代。 */
  loadLog: (scope: string) => Promise<string>;
  loadRounds: () => Promise<void>;
  /** 訂閱某個 scope 的串流（LogTree 等元件用來即時重畫）。 */
  onLog: (fn: LogListener) => () => void;
}

let unlisteners: UnlistenFn[] = [];
const logListeners = new Set<LogListener>();
let generation = 0;

export const useProject = create<ProjectState>((set, get) => ({
  id: null,
  api: projectApi(''),
  snap: null,
  error: null,
  logs: {},
  logsFull: new Set(),
  rounds: [],
  streams: {},
  open: async (id) => {
    if (get().id === id) return;
    get().close();
    const gen = ++generation;
    const api = projectApi(id);
    set({ id, api, snap: null, error: null, logs: {}, logsFull: new Set(), rounds: [], streams: {} });
    try {
      unlisteners = await Promise.all([
        listen<Snapshot>(`state-${id}`, (snap) => { if (gen === generation) get().setSnap(snap); }),
        listen<{ scope: string; text: string }>(`log-${id}`, ({ scope, text }) => {
          if (gen !== generation) return;
          const logs = { ...get().logs };
          let next = (logs[scope] || '') + text;
          if (next.length > LOG_LIMIT) next = next.slice(-LOG_KEEP);
          logs[scope] = next;
          set({ logs });
          for (const fn of logListeners) fn(scope, next);
        }),
        listen<{ message: string }>(`error-${id}`, ({ message }) => { if (gen === generation) set({ error: `讀取專案狀態失敗：${message}` }); }),
        // 逐字輸出：後端推送整段目前的文字；空字串代表這段已寫完（內容已進 log 或訊息）。
        listen<{ scope: string; text: string }>(`stream-${id}`, ({ scope, text }) => {
          if (gen !== generation) return;
          const streams = { ...get().streams };
          if (text) streams[scope] = text; else delete streams[scope];
          set({ streams });
        }),
      ]);
      // 離開專案時全部取消訂閱（state、log、error、stream）。
      await invoke('watch_project', { id });
    } catch (err) {
      set({ error: String((err as Error)?.message ?? err) });
    }
    await get().refresh();
    api('/api/projects/open', { id }).catch(() => {});
    // 固定的流程 log 先讀起來，紀錄頁一打開就有內容。
    for (const scope of ['runner', 'prd', 'tasks', 'process']) get().loadLog(scope).catch(() => {});
    get().loadRounds().catch(() => {});
  },
  close: () => {
    for (const un of unlisteners) un();
    unlisteners = [];
    generation++;
    set({ id: null, api: projectApi(''), snap: null, error: null, logs: {}, logsFull: new Set(), rounds: [], streams: {} });
  },
  refresh: async () => {
    try {
      const snap = await get().api<Snapshot>('/api/state');
      get().setSnap(snap);
      return snap;
    } catch (err) {
      set({ error: (err as Error).message });
      return null;
    }
  },
  setSnap: (snap) => {
    const prev = get().snap;
    set({ snap, error: null });
    if (prev && (prev.state.prd.rounds.length !== snap.state.prd.rounds.length || prev.state.prd.status !== snap.state.prd.status)) get().loadRounds().catch(() => {});
  },
  loadLog: async (scope) => {
    const { logsFull, api } = get();
    if (logsFull.has(scope)) return get().logs[scope] || '';
    const full = new Set(logsFull); full.add(scope); set({ logsFull: full });
    try {
      const { text } = await api<{ text: string }>(`/api/log/${scope}`);
      const logs = { ...get().logs, [scope]: text || '' };
      set({ logs });
      for (const fn of logListeners) fn(scope, logs[scope]);
      return logs[scope];
    } catch (err) {
      const again = new Set(get().logsFull); again.delete(scope); set({ logsFull: again });
      throw err;
    }
  },
  loadRounds: async () => {
    const { rounds } = await get().api<{ rounds: PrdRound[] }>('/api/prd');
    set({ rounds });
  },
  onLog: (fn) => { logListeners.add(fn); return () => logListeners.delete(fn); },
}));

/** AI 正在打字的文字（沒有就是空字串）。 */
export const useStream = (scope: string | null | undefined) => useProject((s) => (scope ? s.streams[scope] || '' : ''));

/** 目前專案的快照；還沒載入時是 null。 */
export const useSnapshot = () => useProject((s) => s.snap);
export const useProjectApi = () => useProject((s) => s.api);
/** 防呆原因（後端依流程狀態算好，放在 snap.guards）；空字串代表可以做。 */
export const useGuard = (name: string) => useProject((s) => s.snap?.guards?.[name] || '');
export const useGuards = (...names: string[]) => useProject(useShallow((s) => names.map((n) => s.snap?.guards?.[n] || '')));
/** AI 或流程是否正在工作（任何一種）。 */
export const useBusy = () => useProject((s) => !!(s.snap && (s.snap.runnerAlive || s.snap.prdBusy || s.snap.taskGenBusy || s.snap.skillBusy)));

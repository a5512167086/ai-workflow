// 桌面橋接：Tauri 的 invoke／listen。不在 Tauri 裡（瀏覽器直接開 Vite dev server 預覽畫面）時改用 src/dev/mock.ts 的假後端。
import type { UnlistenFn } from '@tauri-apps/api/event';

export const inTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

type Handler<T> = (payload: T) => void;

interface Bridge {
  invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T = unknown>(event: string, handler: Handler<T>): Promise<UnlistenFn>;
}

let bridge: Promise<Bridge> | null = null;

function loadBridge(): Promise<Bridge> {
  bridge ??= inTauri
    ? Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]).then(([core, event]) => ({
      invoke: <T,>(cmd: string, args?: Record<string, unknown>) => core.invoke<T>(cmd, args),
      listen: <T,>(name: string, handler: Handler<T>) => event.listen<T>(name, (e) => handler(e.payload)),
    }))
    : import('@/dev/mock').then((m) => m.mockBridge as Bridge);
  return bridge;
}

export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return (await loadBridge()).invoke<T>(cmd, args);
}

export async function listen<T = unknown>(event: string, handler: Handler<T>): Promise<UnlistenFn> {
  return (await loadBridge()).listen<T>(event, handler);
}

/** 原生對話框（只有桌面版有；瀏覽器預覽回傳 null）。 */
export const dialogs = {
  pickFolder: () => invoke<string | null>('pick_folder'),
  pickSkillFolder: () => invoke<string | null>('pick_skill_folder'),
  pickReferenceFiles: () => invoke<string[]>('pick_reference_files'),
  pickReferenceFolder: () => invoke<string | null>('pick_reference_folder'),
};

/** 視窗層級的檔案拖放（Tauri 的 onDragDropEvent）；瀏覽器預覽沒有。 */
export async function onFileDrop(handler: (paths: string[], position: { x: number; y: number } | null) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {};
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  return getCurrentWebview().onDragDropEvent((event) => {
    if (event.payload.type !== 'drop') return;
    const paths = event.payload.paths || [];
    if (!paths.length) return;
    const p = event.payload.position;
    handler(paths, p ? { x: p.x / devicePixelRatio, y: p.y / devicePixelRatio } : null);
  });
}

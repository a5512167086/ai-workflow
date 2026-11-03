// 後端在 Rust（Tauri command `api`），路徑與回傳格式和舊版 HTTP API 相同：
// 全域路由 /api/projects、/api/config、/api/models、/api/projects/*、/api/queue/*、/api/config/*、/api/doctor；
// 專案路由 /api/p/<id>/...。這裡的 projectApi(id) 會把 /api/xxx 自動換成 /api/p/<id>/xxx。
import { invoke } from '@/lib/tauri';
import { toast } from 'sonner';

export class ApiError extends Error {}

export type Api = <T = unknown>(path: string, body?: unknown) => Promise<T>;

/** 有 body 就是 POST，沒有就是 GET。 */
export const api: Api = async <T,>(path: string, body?: unknown): Promise<T> => {
  try {
    return await invoke<T>('api', { method: body === undefined ? 'GET' : 'POST', path, body: body ?? null });
  } catch (err) {
    throw new ApiError(String((err as { message?: string })?.message ?? err));
  }
};

const GLOBAL_ROUTE = /^\/api\/(projects|queue)(\/|$)/;

/** 專案範圍的 API；/api/projects 與 /api/queue 仍走全域路由（和舊版 common.js 的 apiUrl 相同）。 */
export function projectApi(projectId: string): Api {
  return <T,>(path: string, body?: unknown) =>
    api<T>(GLOBAL_ROUTE.test(path) ? path : path.replace(/^\/api/, `/api/p/${projectId}`), body);
}

/** 呼叫後端並以 toast 回報結果；失敗回傳 null（錯誤已顯示）。 */
export async function act<T = unknown>(call: Api, path: string, body: unknown = {}, okMsg?: string): Promise<T | null> {
  try {
    const data = await call<T>(path, body);
    if (okMsg) toast.success(okMsg);
    return data;
  } catch (err) {
    toast.error((err as Error).message);
    return null;
  }
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

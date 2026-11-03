/** localStorage 可能被停用或滿了；讀寫失敗就退回預設值，不影響功能。 */
export function readStorage(key: string, fallback = ''): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 無法儲存時只在這次頁面生效
  }
}
export function readJson<T>(key: string, fallback: T): T {
  const raw = readStorage(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
export function writeJson(key: string, value: unknown) {
  writeStorage(key, JSON.stringify(value));
}

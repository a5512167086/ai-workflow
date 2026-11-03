// 給「不會重新排序、只會整份換掉或往後加」的清單（log 行、diff 行、任務欄位）配上穩定的 React key。
// 這類清單的位置本身就是穩定的識別：同一份內容每次算出的 key 都一樣。

export interface Keyed<T> { key: string; item: T }

/** 依位置配上 `${prefix}${位置}` 的 key。 */
export function withKeys<T>(items: readonly T[], prefix: string): Keyed<T>[] {
  return items.map((item, position) => ({ key: `${prefix}${position}`, item }));
}

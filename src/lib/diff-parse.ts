// 解析 git 的 unified diff 成檔案與區塊。純函式，DiffView 元件與測試共用。

export type DiffLineType = 'add' | 'del' | 'ctx' | 'note';
export interface DiffLine { type: DiffLineType; text: string; old?: number; new?: number }
export interface DiffHunk { header: string; section: string; lines: DiffLine[] }
export type DiffStatus = 'added' | 'deleted' | 'renamed' | 'modified';
export interface DiffFile { path: string; oldPath: string; status: DiffStatus; binary: boolean; adds: number; dels: number; hunks: DiffHunk[] }

/** 會略過開頭的 --stat 摘要。 */
export function parseUnifiedDiff(text: string | null | undefined): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null, hunk: DiffHunk | null = null, oldNo = 0, newNo = 0;
  const strip = (p: string) => p.replace(/^"?(a|b)\//, '').replace(/"$/, '');
  // 去掉結尾的換行，否則 split 會多出一行空的「未變更」內容。
  for (const raw of String(text || '').replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : '', status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] };
      files.push(file); hunk = null; continue;
    }
    if (!file) continue;
    if (!hunk) {
      if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
      if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); continue; }
      if (line.startsWith('rename to ')) { file.path = line.slice(10); continue; }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') { file.binary = true; continue; }
      if (line.startsWith('--- ')) { if (line !== '--- /dev/null') file.oldPath = strip(line.slice(4)); continue; }
      if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') file.path = strip(line.slice(4)); continue; }
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); hunk = { header: line, section: h[3].trim(), lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', text: line.slice(1), new: newNo++ }); file.adds++; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', text: line.slice(1), old: oldNo++ }); file.dels++; }
    else if (line.startsWith('\\')) { hunk.lines.push({ type: 'note', text: line.slice(2) }); }
    else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ }); }
  }
  return files;
}

export type SplitRow = { left: DiffLine | null; right: DiffLine | null; note?: undefined } | { note: string; left?: undefined; right?: undefined };

/** 並排：連續的刪除與新增一對一配成同一列，多出來的那邊留空，和 GitHub 一樣。 */
export function splitRows(lines: DiffLine[]): SplitRow[] {
  const rows: SplitRow[] = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.type === 'ctx') { rows.push({ left: line, right: line }); i++; continue; }
    if (line.type === 'note') { rows.push({ note: line.text }); i++; continue; }
    const dels: DiffLine[] = [], adds: DiffLine[] = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return rows;
}

export const DIFF_STATUS_TEXT: Record<DiffStatus, string> = { added: '新增', deleted: '刪除', renamed: '改名', modified: '修改' };

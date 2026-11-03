// 解析 git 的 unified diff 成檔案與區塊。純函式，DiffView 元件與測試共用。

export type DiffLineType = 'add' | 'del' | 'ctx' | 'note';
export interface DiffLine { type: DiffLineType; text: string; old?: number; new?: number }
export interface DiffHunk { header: string; section: string; lines: DiffLine[] }
export type DiffStatus = 'added' | 'deleted' | 'renamed' | 'modified';
export interface DiffFile { path: string; oldPath: string; status: DiffStatus; binary: boolean; adds: number; dels: number; hunks: DiffHunk[] }

const DIFF_GIT_RE = /^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

const stripPrefix = (p: string) => p.replace(/^"?[ab]\//, '').replace(/"$/, '');

/** 「diff --git a/x b/y」開始一個新檔案。 */
function startFile(line: string): DiffFile {
  const m = DIFF_GIT_RE.exec(line);
  return { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : '', status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] };
}

/** 第一個 @@ 之前的檔頭行；認得就套用到檔案並回傳 true。 */
function applyFileHeader(file: DiffFile, line: string): boolean {
  if (line.startsWith('new file mode')) {
    file.status = 'added';
  } else if (line.startsWith('deleted file mode')) {
    file.status = 'deleted';
  } else if (line.startsWith('rename from ')) {
    file.status = 'renamed';
    file.oldPath = line.slice(12);
  } else if (line.startsWith('rename to ')) {
    file.path = line.slice(10);
  } else if (line.startsWith('Binary files ') || line === 'GIT binary patch') {
    file.binary = true;
  } else if (line.startsWith('--- ')) {
    if (line !== '--- /dev/null') file.oldPath = stripPrefix(line.slice(4));
  } else if (line.startsWith('+++ ')) {
    if (line !== '+++ /dev/null') file.path = stripPrefix(line.slice(4));
  } else {
    return false;
  }
  return true;
}

/** 目前所在的區塊與兩邊的行號。 */
interface HunkCursor { file: DiffFile; hunk: DiffHunk; oldNo: number; newNo: number }

/** 區塊內的一行：新增、刪除、註記（\ No newline…）或未變更。 */
function addHunkLine(cur: HunkCursor, line: string) {
  const { file, hunk } = cur;
  if (line.startsWith('+')) {
    hunk.lines.push({ type: 'add', text: line.slice(1), new: cur.newNo++ });
    file.adds++;
  } else if (line.startsWith('-')) {
    hunk.lines.push({ type: 'del', text: line.slice(1), old: cur.oldNo++ });
    file.dels++;
  } else if (line.startsWith('\\')) {
    hunk.lines.push({ type: 'note', text: line.slice(2) });
  } else if (line.startsWith(' ') || line === '') {
    hunk.lines.push({ type: 'ctx', text: line.slice(1), old: cur.oldNo++, new: cur.newNo++ });
  }
}

/** 會略過開頭的 --stat 摘要。 */
export function parseUnifiedDiff(text: string | null | undefined): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let cur: HunkCursor | null = null;
  // 去掉結尾的換行，否則 split 會多出一行空的「未變更」內容。
  for (const raw of String(text || '').replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      file = startFile(line);
      files.push(file);
      cur = null;
      continue;
    }
    if (!file || (!cur && applyFileHeader(file, line))) continue;
    const h = HUNK_RE.exec(line);
    if (h) {
      cur = { file, hunk: { header: line, section: h[3].trim(), lines: [] }, oldNo: Number(h[1]), newNo: Number(h[2]) };
      file.hunks.push(cur.hunk);
    } else if (cur) {
      addHunkLine(cur, line);
    }
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

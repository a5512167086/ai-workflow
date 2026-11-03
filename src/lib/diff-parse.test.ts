import { describe, expect, test } from 'vitest';
import { parseUnifiedDiff, splitRows } from '@/lib/diff-parse';

const DIFF = ` src/a.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const a = 1;
+export const b = 2;
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@ function x() {
 keep
-old
+new
+added
\\ No newline at end of file
diff --git a/img.png b/img.png
Binary files a/img.png and b/img.png differ
diff --git a/old-name.ts b/new-name.ts
similarity index 100%
rename from old-name.ts
rename to new-name.ts
`;

describe('parseUnifiedDiff', () => {
  test('略過 --stat 摘要，辨識新增、修改、二進位與改名，行號正確', () => {
    const files = parseUnifiedDiff(DIFF);
    expect(files.map((f) => [f.path, f.status, f.binary])).toEqual([
      ['src/new.ts', 'added', false], ['src/a.ts', 'modified', false], ['img.png', 'modified', true], ['new-name.ts', 'renamed', false],
    ]);
    expect(files[0].adds).toBe(2);
    expect(files[0].hunks[0].lines.map((l) => l.new)).toEqual([1, 2]);
    const lines = files[1].hunks[0].lines;
    expect(files[1].hunks[0].section).toBe('function x() {');
    expect(lines.map((l) => [l.type, l.old, l.new])).toEqual([
      ['ctx', 10, 10], ['del', 11, undefined], ['add', undefined, 11], ['add', undefined, 12], ['note', undefined, undefined],
    ]);
    expect([files[1].adds, files[1].dels]).toEqual([2, 1]);
    expect(files[3].oldPath).toBe('old-name.ts');
    expect(files[3].hunks).toHaveLength(0);
  });

  test('結尾換行不會多出一行；沒有 diff 標頭時沒有檔案', () => {
    const files = parseUnifiedDiff('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n');
    expect(files[0].hunks[0].lines).toHaveLength(2);
    expect(parseUnifiedDiff('just text')).toEqual([]);
  });

  test('splitRows：刪除與新增一對一配對，多出來的留空', () => {
    const lines = parseUnifiedDiff(DIFF)[1].hunks[0].lines;
    const rows = splitRows(lines);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({ left: lines[0], right: lines[0] });
    expect(rows[1]).toEqual({ left: lines[1], right: lines[2] });
    expect(rows[2]).toEqual({ left: null, right: lines[3] });
    expect(rows[3]).toEqual({ note: 'No newline at end of file' });
  });
});

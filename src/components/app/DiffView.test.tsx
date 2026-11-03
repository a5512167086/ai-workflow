import { beforeEach, describe, expect, test } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { DiffView } from '@/components/app/DiffView';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,2 @@
 keep
-<img src=x onerror="window.pwned=1">
+<b>new</b>
diff --git a/docs/b.md b/docs/b.md
new file mode 100644
--- /dev/null
+++ b/docs/b.md
@@ -0,0 +1 @@
+hi
`;

describe('DiffView', () => {
  beforeEach(() => localStorage.clear());

  test('預設並排、有檔案清單與摘要，內容不會被當成 HTML', () => {
    render(<DiffView text={DIFF} />);
    expect(screen.getByText(/2 個檔案/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: '並排' })).toHaveAttribute('aria-checked', 'true');
    const nav = screen.getByRole('navigation', { name: '變更的檔案' });
    expect(within(nav).getAllByRole('button')).toHaveLength(2);
    expect(within(nav).getByText('a.ts')).toBeInTheDocument();
    expect(within(nav).getByText('docs')).toBeInTheDocument();
    expect(screen.getByText('<b>new</b>')).toBeInTheDocument();
    expect(document.querySelector('img')).toBeNull();
    expect((window as unknown as { pwned?: number }).pwned).toBeUndefined();
    // 並排：刪除與新增在同一列的左右兩側
    const row = screen.getByText('<b>new</b>').closest('tr')!;
    expect(within(row).getByText(/onerror/)).toBeInTheDocument();
    expect(screen.getByText('新增')).toBeInTheDocument();
  });

  test('切換單欄會保存偏好；全部收合／展開', () => {
    render(<DiffView text={DIFF} />);
    fireEvent.click(screen.getByRole('radio', { name: '單欄' }));
    expect(localStorage.getItem('ai-workflow.diff-mode')).toBe('unified');
    const row = screen.getByText(/<b>new<\/b>/).closest('tr')!;
    expect(within(row).queryByText(/onerror/)).toBeNull();
    const groups = screen.getAllByRole('group');
    expect(groups.every((g) => g.hasAttribute('open'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '全部收合' }));
    expect(screen.getAllByRole('group').every((g) => !g.hasAttribute('open'))).toBe(true);
    expect(screen.getByRole('button', { name: '全部展開' })).toBeInTheDocument();
  });

  test('沒有可解析的檔案時退回原文', () => {
    render(<DiffView text="not a diff" />);
    expect(screen.getByText('not a diff').tagName).toBe('PRE');
    render(<DiffView text="" />);
    expect(screen.getByText('（尚無 diff）')).toBeInTheDocument();
  });
});

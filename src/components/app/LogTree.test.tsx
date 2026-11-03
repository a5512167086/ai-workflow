import { describe, expect, test } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LogTree } from '@/components/app/LogTree';

const RUNNING = '[10:00:02] ── 實作：claude（可編輯）開始 ──\n[10:00:05] 🔧 Read src/a.ts';
const DONE = '[09:00:00] ── 拆任務：codex（唯讀）開始 ──\n[09:00:01] 🔧 Read x\n[09:00:02] 🔧 Read y\n[09:01:00] ── 拆任務：完成（60s） ──\n';

describe('LogTree', () => {
  test('執行中的區塊預設展開、完成的收合，summary 顯示工具數與狀態', () => {
    render(<LogTree text={`${DONE}${RUNNING}`} />);
    const [done, running] = screen.getAllByRole('group');
    expect(done).not.toHaveAttribute('open');
    expect(running).toHaveAttribute('open');
    expect(screen.getByLabelText('拆任務，完成')).toHaveTextContent('2 個工具呼叫 · 60s');
    expect(screen.getByLabelText('實作，執行中')).toHaveTextContent('Claude');
    expect(screen.getByLabelText('實作，執行中')).toHaveTextContent('可編輯');
    expect(screen.getAllByText('Read')).toHaveLength(3);
    expect(screen.getByText('src/a.ts')).toBeInTheDocument();
  });

  test('手動收合的區塊在 log 更新後保持收合；openAll 強制全部', () => {
    const { rerender } = render(<LogTree text={RUNNING} />);
    const details = screen.getByRole('group') as HTMLDetailsElement;
    expect(details.open).toBe(true);
    details.open = false; fireEvent(details, new Event('toggle'));
    rerender(<LogTree text={`${RUNNING}\n[10:00:09] 🔧 Edit src/a.ts`} />);
    expect(screen.getByRole('group')).not.toHaveAttribute('open');
    rerender(<LogTree text={`${RUNNING}\n[10:00:09] 🔧 Edit src/a.ts`} openAll />);
    expect(screen.getByRole('group')).toHaveAttribute('open');
  });

  test('空的 log 顯示提示；標題與零散的行也會顯示', () => {
    const { rerender } = render(<LogTree text="" />);
    expect(screen.getByText('（尚無 log）')).toBeInTheDocument();
    rerender(<LogTree text={'[10:00:00] ═══ 任務 1 ═══\n[10:00:01] 零散\n[10:00:02] 🔧 Bash ls\n[10:00:03] ⚠ 警告\n[10:00:04] 第二行'} />);
    expect(screen.getByText('任務 1')).toBeInTheDocument();
    expect(screen.getByText('零散')).not.toHaveClass('text-warn');
    expect(screen.getByText('Bash')).toBeInTheDocument();
    expect(screen.getByText('⚠ 警告 第二行', { normalizer: (s) => s.replace(/\s+/g, ' ') })).toHaveClass('text-warn');
  });
});

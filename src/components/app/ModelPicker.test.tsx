import { beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { ModelPicker } from '@/components/app/ModelPicker';
import { useModels } from '@/stores/models';

vi.mock('@/lib/api', () => ({ api: vi.fn(async () => ({ claude: { models: [] }, codex: { models: [] } })) }));

function Harness({ onChange }: { onChange: (v: string) => void }) {
  const [value, setValue] = useState('');
  return <ModelPicker provider="claude" value={value} onChange={(v) => { setValue(v); onChange(v); }} placeholder="模型：沿用預設" aria-label="模型" />;
}

describe('ModelPicker', () => {
  beforeEach(() => {
    useModels.setState({ options: {
      claude: { models: [{ id: 'opus', name: 'Opus 5.5', description: '複雜工作', efforts: ['high'] }, { id: 'sonnet', name: 'Sonnet 5.5', efforts: [] }] },
      codex: { models: [] },
    } });
  });

  test('聚焦時列出 CLI 回報的模型與「沿用預設」，輸入會篩選', async () => {
    render(<Harness onChange={() => {}} />);
    const input = screen.getByRole('combobox', { name: '模型' });
    await act(async () => { fireEvent.focus(input); });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['沿用預設沿用預設', 'Opus 5.5opus複雜工作', 'Sonnet 5.5sonnet']);
    await act(async () => { fireEvent.change(input, { target: { value: 'son' } }); });
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('sonnet')).toBeInTheDocument();
  });

  test('方向鍵選取並按 Enter 會回傳模型 ID；點選也可以', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: '模型' });
    await act(async () => { fireEvent.focus(input); });
    await act(async () => { fireEvent.keyDown(input, { key: 'ArrowDown' }); fireEvent.keyDown(input, { key: 'ArrowDown' }); });
    expect(input).toHaveAttribute('aria-activedescendant');
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(onChange).toHaveBeenLastCalledWith('opus');
    expect(input).toHaveValue('opus');
    await act(async () => { fireEvent.click(input); });
    await act(async () => { fireEvent.mouseDown(screen.getByText('Sonnet 5.5')); });
    expect(onChange).toHaveBeenLastCalledWith('sonnet');
  });

  test('可以直接輸入清單外的模型 ID，Enter 採用輸入文字；Escape 關閉清單', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByRole('combobox', { name: '模型' });
    await act(async () => { fireEvent.change(input, { target: { value: 'claude-custom-1' } }); });
    expect(onChange).toHaveBeenLastCalledWith('claude-custom-1');
    expect(screen.getByText(/沒有符合的模型/)).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(input, { key: 'Enter' }); });
    expect(onChange).toHaveBeenLastCalledWith('claude-custom-1');
    expect(screen.queryByRole('listbox')).toBeNull();
    await act(async () => { fireEvent.focus(input); });
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await act(async () => { fireEvent.keyDown(input, { key: 'Escape' }); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { useRef } from 'react';
import { useProject } from '@/stores/project';
import { useSkillCommandInput } from '@/features/skills/use-skill-command';

function Box({ onInput }: { onInput: (v: string) => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useSkillCommandInput(ref);
  return <textarea ref={ref} aria-label="訊息" onInput={(e) => onInput(e.currentTarget.value)} />;
}

const skills = [{ name: 'grill-me', description: '釐清需求', compatible: true }, { name: 'to-spec', compatible: true }, { name: 'my-deploy', compatible: false }];

beforeEach(() => {
  vi.useFakeTimers();
  useProject.setState({ api: vi.fn(async () => ({ skills })) as never });
});
afterEach(() => { vi.useRealTimers(); document.querySelectorAll('[role=listbox]').forEach((el) => el.remove()); });

async function type(input: HTMLTextAreaElement, value: string) {
  input.focus();
  input.value = value; input.setSelectionRange(value.length, value.length);
  fireEvent.input(input);
  await act(async () => { await vi.advanceTimersByTimeAsync(200); });
}

describe('useSkillCommandInput', () => {
  it('開頭輸入 /gr 列出相容技能，Enter 補上 /grill-me 並擋住送出', async () => {
    const onInput = vi.fn();
    render(<Box onInput={onInput} />);
    const input = screen.getByLabelText('訊息') as HTMLTextAreaElement;
    await type(input, '/gr');
    const list = document.querySelector('[role=listbox]')!;
    expect(list).toBeTruthy();
    expect([...list.querySelectorAll('[role=option] b')].map((b) => b.textContent)).toEqual(['/grill-me']);
    const submit = vi.fn();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(submit).not.toHaveBeenCalled();
    expect(input.value).toBe('/grill-me ');
    expect(onInput).toHaveBeenLastCalledWith('/grill-me ');
    expect(document.querySelector('[role=listbox]')).toBeNull();
  });
  it('句子中間的 / 不會跳出選單；/ 可列出全部並以方向鍵選取', async () => {
    render(<Box onInput={() => {}} />);
    const input = screen.getByLabelText('訊息') as HTMLTextAreaElement;
    await type(input, '請看 /src/app.js');
    expect(document.querySelector('[role=listbox]')).toBeNull();
    expect(useProject.getState().api).not.toHaveBeenCalled();
    await type(input, '/');
    const options = [...document.querySelectorAll('[role=option] b')].map((b) => b.textContent);
    expect(options).toEqual(['/grill-me', '/to-spec']);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Tab' });
    expect(input.value).toBe('/to-spec ');
  });
});

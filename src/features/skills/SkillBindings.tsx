// 「工作流技能綁定」：全域設定的一張階段表，每個階段可以加入或移除技能。
import { useEffect, useRef, useState } from 'react';
import { Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Eyebrow, Hint } from '@/components/app/Page';
import { SKILL_STAGE_LABELS } from '@/lib/constants';
import { cn } from '@/lib/utils';
import type { SkillStage } from '@/types/api';
import type { Bindings } from '@/features/skills/skill-utils';

/** 加入技能的小選單：和舊版一樣是自己的浮出層（可測、不需要 pointer events）。 */
function SkillPicker({ stage, names, descriptions, onPick, onClose }: Readonly<{ stage: SkillStage; names: string[]; descriptions: Record<string, string>; onPick: (name: string) => void; onClose: () => void }>) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    (ref.current?.querySelector<HTMLElement>('button') ?? ref.current)?.focus();
    return () => { clearTimeout(t); document.removeEventListener('click', onClick); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" tabIndex={-1} aria-label={`加入技能到${SKILL_STAGE_LABELS[stage]}`} className="absolute left-0 top-full z-20 mt-1 flex min-w-44 flex-col gap-0.5 rounded-md border bg-popover p-1 shadow-md outline-none" onKeyDown={(e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') || [])];
      const at = items.indexOf(document.activeElement as HTMLButtonElement);
      items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    }}>
      {!names.length && <p className="px-2 py-1 text-xs text-muted-foreground">沒有可加入的相容技能</p>}
      {names.map((name) => (
        <button key={name} type="button" role="menuitem" title={descriptions[name] || ''} className="rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => onPick(name)}>{name}</button>
      ))}
    </div>
  );
}

/** 一個階段綁定的技能（不相容的標成警告色）、移除按鈕與加入選單。 */
function StageRow({ stage, names, compatible, descriptions, pickerOpen, onPicker, onChange }: Readonly<{
  stage: SkillStage;
  names: string[];
  compatible: string[];
  descriptions: Record<string, string>;
  pickerOpen: boolean;
  onPicker: (open: boolean) => void;
  onChange: (names: string[]) => void;
}>) {
  return (
    <tr data-stage={stage} className="border-b">
      <th scope="row" className="w-36 py-2 pr-3 text-left align-top font-medium">{SKILL_STAGE_LABELS[stage] || stage}</th>
      <td className="py-2">
        <div className="relative flex flex-wrap items-center gap-1.5">
          {names.map((name) => {
            const ok = compatible.includes(name);
            return (
              <span key={name} title={ok ? undefined : '這個技能不在技能庫或含執行器專屬欄位，執行時會失敗'} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[11.5px]', ok ? 'bg-surface-2' : 'border-warn bg-warn-soft text-warn')}>
                <span>{name}</span>
                <button type="button" aria-label={`從${SKILL_STAGE_LABELS[stage]}移除 ${name}`} className="leading-none opacity-70 hover:opacity-100" onClick={() => onChange(names.filter((n) => n !== name))}>×</button>
              </span>
            );
          })}
          <button type="button" aria-label={`為${SKILL_STAGE_LABELS[stage]}加入技能`} aria-haspopup="menu" aria-expanded={pickerOpen} className="inline-flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground hover:border-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); onPicker(!pickerOpen); }}>＋</button>
          {pickerOpen && (
            <SkillPicker stage={stage} names={compatible.filter((n) => !names.includes(n))} descriptions={descriptions} onClose={() => onPicker(false)} onPick={(name) => { onChange([...names, name]); onPicker(false); }} />
          )}
        </div>
      </td>
    </tr>
  );
}

/** 工作流技能綁定的整頁：階段表與儲存。 */
export function BindingsPanel({ stages, bindings, onBindings, compatible, descriptions, dirty, onSave }: Readonly<{
  stages: SkillStage[];
  bindings: Bindings;
  onBindings: (bindings: Bindings) => void;
  compatible: string[];
  descriptions: Record<string, string>;
  dirty: boolean;
  onSave: () => void;
}>) {
  const [picker, setPicker] = useState<SkillStage | null>(null);
  return (
    <section className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <Eyebrow>全域設定 · 所有專案共用</Eyebrow>
          <h2 className="text-[15px] font-semibold">工作流技能綁定</h2>
          <Hint>每個階段只載入綁定的技能，每次執行保存技能快照與版本；任務自己的 skills 會在實作、修正與審查時一起載入。</Hint>
        </div>
        <Button type="button" disabled={!dirty} onClick={onSave}><Save />儲存</Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <table className="w-full border-collapse text-[13px]">
          <tbody>
            {stages.map((stage) => (
              <StageRow
                key={stage}
                stage={stage}
                names={bindings[stage] || []}
                compatible={compatible}
                descriptions={descriptions}
                pickerOpen={picker === stage}
                onPicker={(open) => setPicker(open ? stage : null)}
                onChange={(names) => onBindings({ ...bindings, [stage]: names })}
              />
            ))}
          </tbody>
        </table>
        <Hint role="status" className="mt-2">{dirty ? '有未儲存的變更。' : ''}</Hint>
      </div>
    </section>
  );
}

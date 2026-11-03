// 技能內容：標題與動作、內容／會議分頁、frontmatter 與資源檔、SKILL.md 預覽與編輯器。
import type { ReactNode } from 'react';
import { Pencil, Trash2, Undo2, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Eyebrow, Hint } from '@/components/app/Page';
import { Markdown } from '@/components/app/Markdown';
import { skillFrontmatter } from '@/lib/format';
import { cn } from '@/lib/utils';
import { runActive, skillOriginText, type SkillView } from '@/features/skills/skill-utils';
import type { Skill, SkillRun } from '@/types/api';

/** 標題列：來源與相容狀態、名稱、說明，以及編輯、刪除／還原內建。 */
function SkillHeader({ skill, editing, onEdit, onDelete }: Readonly<{ skill: Skill | null; editing: boolean; onEdit: () => void; onDelete: () => void }>) {
  if (!skill) {
    return (
      <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <Eyebrow>新技能</Eyebrow>
          <h2 className="truncate font-mono text-[15px] font-semibold">新技能</h2>
          <Hint>儲存後會以 frontmatter 的 name 建立技能資料夾。</Hint>
        </div>
      </div>
    );
  }
  const { origin, compat } = skillOriginText(skill);
  const removable = !skill.hasBuiltin || !!skill.dir;
  return (
    <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
      <div className="min-w-0">
        <Eyebrow>{`${origin} · ${compat}`}</Eyebrow>
        <h2 className="truncate font-mono text-[15px] font-semibold">{skill.name}</h2>
        <Hint className={cn(skill.error && 'text-danger')}>{skill.error || skill.description || ''}</Hint>
      </div>
      {!editing && (
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="outline" disabled={!!skill.error && !skill.text} onClick={onEdit}><Pencil />編輯</Button>
          {removable && (
            <Button type="button" variant="outline" onClick={onDelete} title={skill.hasBuiltin ? '刪掉修改過的副本，回到內建版本' : '從技能庫移除整個技能資料夾'}>
              {skill.hasBuiltin ? <><Undo2 />還原內建</> : <><Trash2 />刪除</>}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/** 內容／會議分頁；會議分頁上顯示回覆中或會議數量。 */
function SkillTabs({ view, onView, runs }: Readonly<{ view: SkillView; onView: (view: SkillView) => void; runs: SkillRun[] }>) {
  const replying = runs.some(runActive);
  return (
    <Tabs value={view} onValueChange={(v) => onView(v as SkillView)} className="shrink-0 gap-0 border-b px-4">
      <TabsList variant="line" aria-label="技能內容">
        <TabsTrigger value="content">內容</TabsTrigger>
        <TabsTrigger value="meeting">
          會議
          {(replying || runs.length > 0) && (
            <span className={cn('rounded-full px-1.5 text-[10.5px] leading-4', replying ? 'bg-warn text-background' : 'bg-muted text-muted-foreground')}>{replying ? '回覆中' : runs.length}</span>
          )}
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

/** 編輯器下方的提示：新技能的格式要求，或目前技能的相容狀態。 */
function editorHint(skill: Skill | null) {
  if (!skill) return '需要 name、description 與指令本文；name 只能用小寫字母、數字與連字號。';
  if (skill.compatible) return '共用指令可供 Codex／Claude Code 使用；附帶工具仍需執行環境支援。';
  return skill.error || `需調整專屬欄位：${skill.extensions?.join(', ') || ''}`;
}

/** SKILL.md 編輯器（新增或修改）。 */
export function SkillEditor({ skill, text, onText, onCancel, onSave }: Readonly<{ skill: Skill | null; text: string; onText: (text: string) => void; onCancel: () => void; onSave: () => void }>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
      <label className="sr-only" htmlFor="skill-editor">SKILL.md</label>
      <Textarea id="skill-editor" value={text} onChange={(e) => onText(e.target.value)} spellCheck={false} aria-describedby="skill-compatibility" className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed selectable" />
      <div className="flex shrink-0 items-center justify-end gap-2">
        <Hint role="status" className="mr-auto">{editorHint(skill)}</Hint>
        <Button type="button" variant="outline" onClick={onCancel}>取消</Button>
        <Button type="button" onClick={onSave}><Save />儲存技能</Button>
      </div>
    </div>
  );
}

/** 相容性那一列的文字與顏色。 */
function compatibility(skill: Skill): { text: string; className: string } {
  if (skill.error) return { text: skill.error, className: 'text-danger' };
  if (skill.compatible) return { text: 'Codex／Claude Code 共用', className: 'text-ok' };
  return { text: `需先轉寫：${skill.extensions?.join(', ')}`, className: 'text-warn' };
}

/** 技能內容：frontmatter、相容性、資源檔與 SKILL.md 預覽。 */
export function SkillContent({ skill }: Readonly<{ skill: Skill }>) {
  const parsed = skillFrontmatter(skill.text);
  const rows: [string, string][] = parsed.length ? parsed : [['name', skill.name], ['description', skill.description || '']];
  const compat = compatibility(skill);
  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="frontmatter">
        {rows.map(([key, value]) => {
          const ext = skill.extensions?.includes(key);
          return (
            <div key={key} className={cn('contents', ext && 'text-warn')}>
              <dt className="font-mono text-muted-foreground">{ext ? `${key}（執行器專屬）` : key}</dt>
              <dd className="selectable" title={value}>{value || '（多行）'}</dd>
            </div>
          );
        })}
        <div className="contents">
          <dt className="font-mono text-muted-foreground">相容性</dt>
          <dd className={compat.className}>{compat.text}</dd>
        </div>
      </dl>
      <div className="mb-3 flex flex-wrap items-center gap-1.5" aria-label="資源檔">
        <span className="text-xs text-muted-foreground">{skill.dir ? `資源檔 · ${skill.dir}` : '內建技能只有 SKILL.md，編進執行檔'}</span>
        {(skill.files || []).map((f) => <span key={f.path} className="rounded border bg-surface-2 px-1.5 font-mono text-[11px]" title={`${f.bytes} bytes`}>{f.path}</span>)}
      </div>
      <div className="rounded-md border p-3" aria-label="SKILL.md 預覽">
        {skill.error ? <p className="text-xs text-muted-foreground">這個技能無法讀取：{skill.error}</p> : <Markdown text={skill.body || ''} />}
      </div>
    </div>
  );
}

/** 右側的技能頁：標題、分頁與分頁內容（內容、編輯器或會議由呼叫端決定）。 */
export function SkillDetail({ skill, editing, view, onView, runs, onEdit, onDelete, children }: Readonly<{
  skill: Skill | null;
  editing: boolean;
  view: SkillView;
  onView: (view: SkillView) => void;
  runs: SkillRun[];
  onEdit: () => void;
  onDelete: () => void;
  children: ReactNode;
}>) {
  return (
    <section className="flex h-full min-h-0 flex-col">
      <SkillHeader skill={skill} editing={editing} onEdit={onEdit} onDelete={onDelete} />
      {skill && <SkillTabs view={view} onView={onView} runs={runs} />}
      {children}
    </section>
  );
}

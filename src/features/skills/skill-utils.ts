// Skills 頁共用的純函式與型別（不含 React），頁面與各區塊元件共用。
import { SKILL_STAGE_LABELS } from '@/lib/constants';
import type { Skill, SkillRun, SkillStage, SkillsPayload } from '@/types/api';

export const SKILL_TEMPLATE = '---\nname: my-skill\ndescription: 說明用途及使用時機\n---\n在此撰寫技能指令。\n';
export const DEFAULT_STAGES = Object.keys(SKILL_STAGE_LABELS) as SkillStage[];
export type Bindings = Partial<Record<SkillStage, string[]>>;
/** 「工作流技能綁定」那一頁的選取值。 */
export const BINDINGS = 'bindings';
/** 選取：技能名稱、BINDINGS（工作流技能綁定）或 null（沒有選取）。 */
export type Selected = string | null;
export type SkillView = 'content' | 'meeting';

export const runActive = (run?: SkillRun | null) => !!run && run.status === 'running';

/** 技能來源與相容狀態的文字，側欄與標題共用。 */
export function skillOriginText(skill: Skill) {
  let origin = '匯入';
  if (skill.hasBuiltin) origin = skill.dir ? '內建・已修改' : '內建';
  let compat = skill.compatible ? '相容' : '需調整';
  let tone: 'ok' | 'warn' | 'bad' = skill.compatible ? 'ok' : 'warn';
  if (skill.error) { compat = '錯誤'; tone = 'bad'; }
  return { origin, compat, tone };
}

export function normalizeBindings(config: Bindings | null | undefined, stages: SkillStage[]): Bindings {
  return Object.fromEntries(stages.map((stage) => [stage, [...new Set((config?.[stage] || []).filter((name) => typeof name === 'string'))]]));
}

/** 後端回傳的階段清單；沒有或格式不對時用預設的全部階段。 */
export function stageListOf(data: SkillsPayload): SkillStage[] {
  return Array.isArray(data.stages) && data.stages.length ? data.stages : DEFAULT_STAGES;
}

/**
 * 會議清單更新後要顯示哪一場：剛送出而建立的會議（目前是新會議或接續的那場）優先；
 * 沒有明確選「新會議」時，預設顯示這個技能最近的一場會議。created 表示切到了新建立的會議。
 */
export function pickRunId(next: SkillRun[], prev: SkillRun[], sel: Selected, current: string, fresh: boolean): { id: string; created: boolean } {
  const known = new Set(prev.map((r) => r.id));
  const created = next.find((r) => !known.has(r.id) && r.name === sel);
  if (created && (!current || created.previousId === current)) return { id: created.id, created: true };
  if (!current && !fresh && sel && sel !== BINDINGS) return { id: next.find((r) => r.name === sel)?.id || '', created: false };
  return { id: current, created: false };
}

/** 技能庫更新後的選取：選取的技能不見了（且不在編輯中）就清掉；沒有選取時選第一個技能。 */
export function nextSelection(sel: Selected, skills: Skill[], editing: boolean): Selected {
  let next = sel;
  if (sel && sel !== BINDINGS && !skills.some((s) => s.name === sel) && !editing) next = null;
  if (!next && !editing && skills.length) next = skills[0].name;
  return next;
}

/** 依序匯入（避免多個資料夾同時寫入技能庫）；回傳最後一個成功匯入的技能與每個失敗的原因。 */
export async function importInOrder(
  paths: string[],
  importOne: (path: string) => Promise<Skill>,
  describeError: (error: unknown) => string,
): Promise<ImportResult> {
  const result: ImportResult = { imported: null, errors: [] };
  await importNext(paths, importOne, describeError, result);
  return result;
}

interface ImportResult { imported: Skill | null; errors: string[] }

async function importNext(paths: string[], importOne: (path: string) => Promise<Skill>, describeError: (error: unknown) => string, result: ImportResult): Promise<void> {
  const [path, ...rest] = paths;
  if (path === undefined) return;
  try {
    result.imported = await importOne(path);
  } catch (e) {
    result.errors.push(`${path}：${describeError(e)}`);
  }
  await importNext(rest, importOne, describeError, result);
}

/** 會議選單裡一場會議的文字：時間 · 狀態 · 第一則訊息開頭。 */
export function runOptionLabel(r: SkillRun, statusText: Record<string, string>) {
  const firstLine = r.messages?.[0]?.text?.split('\n')[0] || '';
  const t = r.updated_at ? new Date(r.updated_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  return [t, statusText[r.status] || r.status, firstLine.slice(0, 40)].join(' · ');
}

/** 帶入需求待辦的內容：會議紀錄全文加上前言。 */
export function meetingTranscript(run: SkillRun) {
  const messages = run.messages || [];
  const transcript = messages.map((m) => `${m.role}: ${m.text}`).join('\n\n');
  return {
    title: messages[0]?.text.split('\n')[0].slice(0, 200) || '技能會議需求',
    body: '以下是需求釐清／設計會議紀錄。以使用者回答為準，AI 建議仍需區分假設與待決策事項。\n\n' + transcript,
  };
}

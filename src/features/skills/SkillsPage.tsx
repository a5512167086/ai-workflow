// Skills：左側技能清單（搜尋、匯入、新增），右側技能內容（frontmatter、資源檔、SKILL.md 預覽／編輯）與技能會議；
// 「工作流技能綁定」固定在清單最上方，是全域設定的一張階段表。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw, Pencil, Trash2, Undo2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Page, Eyebrow, Hint, Notice, EmptyState, Loading } from '@/components/app/Page';
import { Chip } from '@/components/app/StatusPill';
import { Markdown } from '@/components/app/Markdown';
import { StreamingText } from '@/components/app/StreamingReply';
import { LogTree } from '@/components/app/LogTree';
import { LiveSince } from '@/components/app/LiveSince';
import { confirmDialog, promptDialog } from '@/components/app/confirm';
import { dialogs, inTauri } from '@/lib/tauri';
import { errorMessage } from '@/lib/api';
import { PROVIDER_LABEL, PROVIDER_LONG, SKILL_RUN_STATUS, SKILL_STAGE_LABELS } from '@/lib/constants';
import { shortTime, skillFrontmatter } from '@/lib/format';
import { readJson, writeJson } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { useProject, useProjectApi, useSnapshot } from '@/stores/project';
import { useBadges } from '@/stores/badges';
import { useBacklogDraft } from '@/stores/backlog-draft';
import { useSkillCommandInput } from '@/features/skills/use-skill-command';
import type { Provider, Skill, SkillRun, SkillStage, SkillsPayload } from '@/types/api';

const SKILL_TEMPLATE = '---\nname: my-skill\ndescription: 說明用途及使用時機\n---\n在此撰寫技能指令。\n';
const DEFAULT_STAGES = Object.keys(SKILL_STAGE_LABELS) as SkillStage[];
const LAYOUT_KEY = 'ai-workflow.skills';
type Bindings = Partial<Record<SkillStage, string[]>>;
type Selected = string | 'bindings' | null;

const runActive = (run?: SkillRun | null) => !!run && run.status === 'running';

/** 技能會議 AI 正在打的回覆（逐字）。 */
function SkillTyping({ runId }: { runId: string }) {
  const typing = useProject((s) => s.streams[`skill-${runId}`] || '');
  if (!typing) return null;
  return (
    <article className="mr-8 rounded-lg border bg-card p-3" data-testid="skill-typing">
      <div className="mb-1 text-xs text-muted-foreground">正在回覆…</div>
      <StreamingText text={typing} />
    </article>
  );
}

/** 技能來源與相容狀態的文字，側欄與標題共用。 */
export function skillOriginText(skill: Skill) {
  const origin = skill.hasBuiltin ? (skill.dir ? '內建・已修改' : '內建') : '匯入';
  const compat = skill.error ? '錯誤' : skill.compatible ? '相容' : '需調整';
  const tone: 'ok' | 'warn' | 'bad' = skill.error ? 'bad' : skill.compatible ? 'ok' : 'warn';
  return { origin, compat, tone };
}

function normalizeBindings(config: Bindings | null | undefined, stages: SkillStage[]): Bindings {
  return Object.fromEntries(stages.map((stage) => [stage, [...new Set((config?.[stage] || []).filter((name) => typeof name === 'string'))]]));
}

/** 加入技能的小選單：和舊版一樣是自己的浮出層（可測、不需要 pointer events）。 */
function SkillPicker({ stage, names, descriptions, onPick, onClose }: { stage: SkillStage; names: string[]; descriptions: Record<string, string>; onPick: (name: string) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onClick = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) onClose(); };
    const t = setTimeout(() => document.addEventListener('click', onClick), 0);
    ref.current?.querySelector('button')?.focus();
    return () => { clearTimeout(t); document.removeEventListener('click', onClick); };
  }, [onClose]);
  return (
    <div ref={ref} role="menu" aria-label={`加入技能到${SKILL_STAGE_LABELS[stage]}`} className="absolute left-0 top-full z-20 mt-1 flex min-w-44 flex-col gap-0.5 rounded-md border bg-popover p-1 shadow-md" onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }}>
      {!names.length && <p className="px-2 py-1 text-xs text-muted-foreground">沒有可加入的相容技能</p>}
      {names.map((name) => (
        <button key={name} type="button" role="menuitem" title={descriptions[name] || ''} className="rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" onClick={() => onPick(name)}>{name}</button>
      ))}
    </div>
  );
}

export function SkillsPage() {
  const api = useProjectApi();
  const snap = useSnapshot()!;
  const logs = useProject((s) => s.logs);
  const navigate = useNavigate();

  const [library, setLibrary] = useState<Skill[]>([]);
  const [stages, setStages] = useState<SkillStage[]>(DEFAULT_STAGES);
  const [bindings, setBindings] = useState<Bindings>({});
  const [bindingsSaved, setBindingsSaved] = useState<Bindings>({});
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [editing, setEditing] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [view, setView] = useState<'content' | 'meeting'>('content');
  const [runId, setRunId] = useState('');
  const [runFresh, setRunFresh] = useState(false); // 使用者明確選了「新會議」，不要自動跳回最近一場
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>('claude');
  const [query, setQuery] = useState('');
  const [picker, setPicker] = useState<SkillStage | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);

  // 非同步載入時要讀到最新的選取狀態，用 ref 鏡射。
  const live = useRef({ selected, runId, runFresh, editing, runs, bindings, bindingsSaved });
  live.current = { selected, runId, runFresh, editing, runs, bindings, bindingsSaved };

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  useSkillCommandInput(inputRef);

  const skillOf = useCallback((name: string | null) => (name && name !== 'bindings' ? library.find((s) => s.name === name) || null : null), [library]);
  const runsOf = useCallback((name: string, list: SkillRun[] = runs) => list.filter((r) => r.name === name), [runs]);
  const dirty = JSON.stringify(bindings) !== JSON.stringify(bindingsSaved);

  const loadRuns = useCallback(async () => {
    const { runs: list } = await api<{ runs: SkillRun[] }>('/api/skills/runs');
    const next = Array.isArray(list) ? list : [];
    const { selected: sel, runId: current, runFresh: fresh, runs: prev } = live.current;
    const known = new Set(prev.map((r) => r.id));
    // 剛送出的回覆：目前是新會議或接續的那場，就自動切到新建立的會議。
    const created = next.find((r) => !known.has(r.id) && r.name === sel);
    let id = current;
    if (created && (!current || created.previousId === current)) { id = created.id; setRunFresh(false); }
    // 沒有明確選「新會議」時，預設顯示這個技能最近的一場會議。
    else if (!current && !fresh && sel && sel !== 'bindings') id = next.find((r) => r.name === sel)?.id || '';
    setRuns(next);
    setRunId(id);
  }, [api]);

  const loadSkills = useCallback(async () => {
    const data = await api<SkillsPayload>('/api/skills');
    const skills = data.skills || [];
    const stageList = Array.isArray(data.stages) && data.stages.length ? data.stages : DEFAULT_STAGES;
    const saved = normalizeBindings(data.config, stageList);
    const { bindings: b, bindingsSaved: bs, selected: sel, editing: ed } = live.current;
    const wasDirty = JSON.stringify(b) !== JSON.stringify(bs);
    setLibrary(skills); setStages(stageList); setBindingsSaved(saved); setLoaded(true);
    if (!wasDirty) setBindings(structuredClone(saved));
    let nextSel = sel;
    if (sel && sel !== 'bindings' && !skills.some((s) => s.name === sel) && !ed) nextSel = null;
    if (!nextSel && !ed && skills.length) nextSel = skills[0].name;
    if (nextSel !== sel) { setSelected(nextSel); live.current.selected = nextSel; }
    setLoadError('');
    await loadRuns();
  }, [api, loadRuns]);

  useEffect(() => { loadSkills().catch((e) => { setLoadError(errorMessage(e)); toast.error(errorMessage(e)); }); }, [loadSkills]);

  // 技能會議的背景工作變了（開始或結束）就重讀會議。
  const jobId = snap.state.skill_job?.id, busy = snap.skillBusy;
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    loadRuns().catch((e) => toast.error(errorMessage(e)));
  }, [jobId, busy, loadRuns]);

  useEffect(() => {
    const active = runs.some(runActive);
    useBadges.getState().set('skills', active ? { text: '回覆中', attention: true } : null);
  }, [runs]);

  useEffect(() => { setProvider((snap.config.roles?.interviewer || snap.config.roles?.author || 'claude') as Provider); }, [snap.config.roles]);

  /** 匯入技能資料夾（按鈕、拖放或視窗事件）；缺 SKILL.md 時後端會拒絕，只顯示原因並保持原本選取。 */
  const importSkillFolders = useCallback(async (paths: string[]) => {
    let imported: Skill | null = null; const errors: string[] = [];
    for (const path of paths.slice(0, 8)) {
      try { imported = (await api<{ skill: Skill }>('/api/skills/import', { path })).skill; }
      catch (e) { errors.push(`${path}：${errorMessage(e)}`); }
    }
    if (imported) {
      setEditing(false); setSelected(imported.name); setRunId(''); setRunFresh(false);
      live.current.selected = imported.name; live.current.editing = false; live.current.runId = '';
      await loadSkills(); toast.success(`已匯入技能 ${imported.name}`);
    }
    if (errors.length) toast.error(errors.join('\n'));
    return imported;
  }, [api, loadSkills]);

  useEffect(() => {
    const onImport = (e: Event) => { const paths = (e as CustomEvent<{ paths?: string[] }>).detail?.paths; if (paths?.length) importSkillFolders(paths).catch((err) => toast.error(errorMessage(err))); };
    window.addEventListener('ai-workflow:import-skills', onImport);
    return () => window.removeEventListener('ai-workflow:import-skills', onImport);
  }, [importSkillFolders]);

  const select = (name: Selected) => {
    if (selected === name && !editing) return;
    setSelected(name); setEditing(false); setEditingName(null); setRunFresh(false); setView('content');
    setRunId(name && name !== 'bindings' ? runsOf(name)[0]?.id || '' : '');
    setPicker(null);
  };
  const handle = (fn: () => Promise<unknown>) => () => { fn().catch((e) => toast.error(errorMessage(e))); };

  const skill = skillOf(selected);
  const draft = editing && !skill; // 新增技能
  const run = runs.find((r) => r.id === runId) || null;
  const skillRuns = skill ? runsOf(skill.name) : [];
  const effectiveRunId = run && skill && run.name === skill.name ? runId : '';
  const anyBusy = !!(snap.skillBusy || snap.runnerAlive || snap.prdBusy || snap.taskGenBusy);

  useEffect(() => { const host = messagesRef.current; if (host) host.scrollTop = host.scrollHeight; }, [effectiveRunId, run?.messages?.length, run?.status]);

  const sendSkill = async () => {
    if (!skill || sending) return;
    const text = input.trim(); if (!text) return;
    if (run && effectiveRunId && run.status !== 'done') { toast.error('請選擇已完成的回覆或新會議'); return; }
    setSending(true);
    try {
      await api('/api/skills/run', { name: skill.name, input: text, provider, previousId: effectiveRunId });
      setInput(''); toast.success('已開始技能會議');
      setTimeout(() => loadRuns().catch(() => {}), 1200);
    } catch (e) { toast.error(errorMessage(e)); }
    finally { setSending(false); }
  };

  const toBacklog = handle(async () => {
    if (!run || run.status !== 'done') throw new Error('請選擇已完成的技能會議');
    if (useBacklogDraft.getState().pending && !(await confirmDialog({ title: '以此會議取代目前尚未新增的需求說明？', confirmText: '取代' }))) return;
    const messages = run.messages || [];
    useBacklogDraft.getState().set(
      messages[0]?.text.split('\n')[0].slice(0, 200) || '技能會議需求',
      `以下是需求釐清／設計會議紀錄。以使用者回答為準，AI 建議仍需區分假設與待決策事項。\n\n${messages.map((m) => `${m.role}: ${m.text}`).join('\n\n')}`,
    );
    toast.success('已帶入需求待辦，確認後按新增');
    navigate(`/p/${snap.project.id}/backlog`);
  });

  const saveBindings = handle(async () => {
    const skills = structuredClone(bindings);
    await api('/api/skills/config', { skills });
    setBindingsSaved(structuredClone(skills)); toast.success('已儲存階段技能');
  });

  const deleteSkill = handle(async () => {
    if (!skill) return;
    const ok = await confirmDialog({
      title: skill.hasBuiltin ? `還原內建的 ${skill.name}？` : `刪除技能 ${skill.name}？`,
      description: skill.hasBuiltin ? '你修改的副本會刪除。' : '整個技能資料夾會從技能庫移除。',
      confirmText: skill.hasBuiltin ? '還原' : '刪除', destructive: !skill.hasBuiltin,
    });
    if (!ok) return;
    const result = await api<{ restored?: boolean }>('/api/skills/delete', { name: skill.name });
    if (!result.restored) { setSelected(null); live.current.selected = null; }
    await loadSkills(); toast.success(result.restored ? `已還原內建的 ${skill.name}` : `已刪除技能 ${skill.name}`);
  });

  const saveSkill = handle(async () => {
    const { skill: saved } = await api<{ skill: Skill }>('/api/skills/save', { text: editorText, name: editingName });
    setEditing(false); setSelected(saved.name); live.current.selected = saved.name; live.current.editing = false;
    await loadSkills(); toast.success('已儲存技能');
  });

  const importClick = handle(async () => {
    const path = inTauri ? await dialogs.pickSkillFolder() : await promptDialog({ title: '技能資料夾完整路徑（包含 SKILL.md）' });
    if (path) await importSkillFolders([path]);
  });

  const compatible = library.filter((s) => s.compatible).map((s) => s.name);
  const descriptions = Object.fromEntries(library.map((s) => [s.name, s.description || '']));
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return library.filter((s) => !q || `${s.name} ${s.description || ''}`.toLocaleLowerCase().includes(q));
  }, [library, query]);
  const defaultLayout = useMemo(() => readJson<Record<string, number> | null>(LAYOUT_KEY, null) || undefined, []);

  // ---------- 會議的狀態文字 ----------
  const active = runActive(run) && !!effectiveRunId;
  const blocked = sending || anyBusy || (!!effectiveRunId && run?.status !== 'done');
  const statusText = active ? 'AI 正在回覆，下方可展開執行紀錄'
    : effectiveRunId && run?.status === 'error' ? '這次回覆失敗，請開新會議'
    : sending ? '正在送出…'
    : snap.skillBusy ? '另一場技能會議正在回覆，完成後才能送出'
    : anyBusy ? '流程執行中，結束後才能開會議'
    : effectiveRunId ? '可以接續這場會議，每次回覆以紀錄交接到新的 session'
    : '新會議：描述需求或問題，AI 會依技能指令回覆';

  return (
    <Page>
      <div className="h-full" data-skill-drop>
        <ResizablePanelGroup orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={(layout) => writeJson(LAYOUT_KEY, layout)} className="h-full">
          <ResizablePanel id="skills-sidebar" defaultSize="26" minSize={220} className="flex min-h-0 flex-col border-r bg-sidebar/40">
            <aside className="flex h-full min-h-0 flex-col" aria-label="技能庫">
              <div className="flex shrink-0 items-center gap-2 border-b p-2">
                <Input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜尋技能" aria-label="搜尋技能" className="h-7" />
                <Button type="button" variant="outline" size="sm" onClick={importClick} title="選擇包含 SKILL.md 的資料夾，整個資料夾（含資源檔）會複製進技能庫"><Plus />匯入技能</Button>
              </div>
              <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2" aria-label="技能與設定">
                <button type="button" aria-current={selected === 'bindings'} onClick={() => select('bindings')} className={cn('mb-2 flex flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left hover:bg-accent', selected === 'bindings' ? 'border-primary bg-accent' : 'border-border')}>
                  <strong className="text-[13px]">工作流技能綁定</strong>
                  <span className="text-xs text-muted-foreground">每個階段各載入哪些技能</span>
                </button>
                <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">技能</div>
                <ul className="flex flex-col gap-1" aria-label="共用技能">
                  {!visible.length && (!loaded && !loadError
                    ? <li><Loading inline label="讀取技能…" className="px-2 py-3" /></li>
                    : <li className="px-2 py-3 text-xs text-muted-foreground">{library.length ? '沒有符合的技能' : loadError || '還沒有技能'}</li>)}
                  {visible.map((s) => {
                    const { origin, compat, tone } = skillOriginText(s);
                    const on = s.name === selected && !draft;
                    return (
                      <li key={s.name}>
                        <button type="button" data-skill={s.name} aria-current={on} onClick={() => select(s.name)} className={cn('flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left hover:bg-accent', on ? 'border-primary bg-accent' : 'border-border')}>
                          <strong className="font-mono text-[12.5px]">{s.name}</strong>
                          <span className={cn('line-clamp-1 text-xs', s.error ? 'text-danger' : 'text-muted-foreground')}>{s.error || s.description || ''}</span>
                          <span className="mt-0.5 flex gap-1"><Chip>{origin}</Chip><Chip tone={tone}>{compat}</Chip></span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </nav>
              <div className="flex shrink-0 flex-wrap items-center gap-2 border-t p-2">
                <Button type="button" variant="outline" size="sm" onClick={() => { setSelected(null); setEditing(true); setEditingName(null); setView('content'); setEditorText(SKILL_TEMPLATE); setPicker(null); }}>新增技能</Button>
                <Button type="button" variant="ghost" size="icon-sm" onClick={handle(loadSkills)} aria-label="重新整理技能庫" title="重新整理技能庫"><RefreshCw /></Button>
                <span className="text-[11px] text-muted-foreground">也可以把技能資料夾拖放到這裡</span>
              </div>
            </aside>
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="skills-main" minSize={320} className="flex min-h-0 flex-col">
            {selected === 'bindings' ? (
              <section className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <Eyebrow>全域設定 · 所有專案共用</Eyebrow>
                    <h2 className="text-[15px] font-semibold">工作流技能綁定</h2>
                    <Hint>每個階段只載入綁定的技能，每次執行保存技能快照與版本；任務自己的 skills 會在實作、修正與審查時一起載入。</Hint>
                  </div>
                  <Button type="button" disabled={!dirty} onClick={saveBindings}><Save />儲存</Button>
                </div>
                <div className="min-h-0 flex-1 overflow-auto p-4">
                  <table className="w-full border-collapse text-[13px]">
                    <tbody>
                      {stages.map((stage) => (
                        <tr key={stage} data-stage={stage} className="border-b">
                          <th scope="row" className="w-36 py-2 pr-3 text-left align-top font-medium">{SKILL_STAGE_LABELS[stage] || stage}</th>
                          <td className="py-2">
                            <div className="relative flex flex-wrap items-center gap-1.5">
                              {(bindings[stage] || []).map((name) => {
                                const ok = compatible.includes(name);
                                return (
                                  <span key={name} title={ok ? undefined : '這個技能不在技能庫或含執行器專屬欄位，執行時會失敗'} className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-px font-mono text-[11.5px]', ok ? 'bg-surface-2' : 'border-warn bg-warn-soft text-warn')}>
                                    <span>{name}</span>
                                    <button type="button" aria-label={`從${SKILL_STAGE_LABELS[stage]}移除 ${name}`} className="leading-none opacity-70 hover:opacity-100" onClick={() => setBindings({ ...bindings, [stage]: (bindings[stage] || []).filter((n) => n !== name) })}>×</button>
                                  </span>
                                );
                              })}
                              <button type="button" aria-label={`為${SKILL_STAGE_LABELS[stage]}加入技能`} aria-haspopup="menu" aria-expanded={picker === stage} className="inline-flex size-6 items-center justify-center rounded-full border border-dashed text-muted-foreground hover:border-foreground hover:text-foreground" onClick={(e) => { e.stopPropagation(); setPicker(picker === stage ? null : stage); }}>＋</button>
                              {picker === stage && (
                                <SkillPicker stage={stage} names={compatible.filter((n) => !(bindings[stage] || []).includes(n))} descriptions={descriptions} onClose={() => setPicker(null)} onPick={(name) => { setBindings({ ...bindings, [stage]: [...(bindings[stage] || []), name] }); setPicker(null); }} />
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <Hint role="status" className="mt-2">{dirty ? '有未儲存的變更。' : ''}</Hint>
                </div>
              </section>
            ) : skill || draft ? (
              <section className="flex h-full min-h-0 flex-col">
                <div className="flex shrink-0 items-start justify-between gap-3 border-b px-4 py-3">
                  <div className="min-w-0">
                    <Eyebrow>{skill ? `${skillOriginText(skill).origin} · ${skillOriginText(skill).compat}` : '新技能'}</Eyebrow>
                    <h2 className="truncate font-mono text-[15px] font-semibold">{skill ? skill.name : '新技能'}</h2>
                    <Hint className={cn(skill?.error && 'text-danger')}>{skill ? skill.error || skill.description || '' : '儲存後會以 frontmatter 的 name 建立技能資料夾。'}</Hint>
                  </div>
                  {skill && !editing && (
                    <div className="flex shrink-0 gap-2">
                      <Button type="button" variant="outline" disabled={!!skill.error && !skill.text} onClick={() => { setEditing(true); setEditingName(skill.name); setEditorText(skill.text || ''); }}><Pencil />編輯</Button>
                      {(!skill.hasBuiltin || !!skill.dir) && (
                        <Button type="button" variant="outline" onClick={deleteSkill} title={skill.hasBuiltin ? '刪掉修改過的副本，回到內建版本' : '從技能庫移除整個技能資料夾'}>
                          {skill.hasBuiltin ? <><Undo2 />還原內建</> : <><Trash2 />刪除</>}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
                {!draft && (
                  <Tabs value={view} onValueChange={(v) => setView(v as 'content' | 'meeting')} className="shrink-0 gap-0 border-b px-4">
                    <TabsList variant="line" aria-label="技能內容">
                      <TabsTrigger value="content">內容</TabsTrigger>
                      <TabsTrigger value="meeting">
                        會議
                        {(skillRuns.some(runActive) || skillRuns.length > 0) && (
                          <span className={cn('rounded-full px-1.5 text-[10.5px] leading-4', skillRuns.some(runActive) ? 'bg-warn text-background' : 'bg-muted text-muted-foreground')}>{skillRuns.some(runActive) ? '回覆中' : skillRuns.length}</span>
                        )}
                      </TabsTrigger>
                    </TabsList>
                  </Tabs>
                )}
                {(view === 'content' || draft) ? (
                  editing ? (
                    <div className="flex min-h-0 flex-1 flex-col gap-2 p-4">
                      <label className="sr-only" htmlFor="skill-editor">SKILL.md</label>
                      <Textarea id="skill-editor" value={editorText} onChange={(e) => setEditorText(e.target.value)} spellCheck={false} aria-describedby="skill-compatibility" className="min-h-0 flex-1 resize-none font-mono text-xs leading-relaxed selectable" />
                      <div className="flex shrink-0 items-center justify-end gap-2">
                        <Hint role="status" className="mr-auto">
                          {skill ? (skill.compatible ? '共用指令可供 Codex／Claude Code 使用；附帶工具仍需執行環境支援。' : skill.error || `需調整專屬欄位：${skill.extensions?.join(', ') || ''}`) : '需要 name、description 與指令本文；name 只能用小寫字母、數字與連字號。'}
                        </Hint>
                        <Button type="button" variant="outline" onClick={() => { setEditing(false); setEditingName(null); if (!selected) { const n = library[0]?.name || null; setSelected(n); } }}>取消</Button>
                        <Button type="button" onClick={saveSkill}><Save />儲存技能</Button>
                      </div>
                    </div>
                  ) : skill && (
                    <div className="min-h-0 flex-1 overflow-auto p-4" tabIndex={0}>
                      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs" aria-label="frontmatter">
                        {(skillFrontmatter(skill.text).length ? skillFrontmatter(skill.text) : [['name', skill.name], ['description', skill.description || '']] as [string, string][]).map(([key, value]) => {
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
                          <dd className={cn(skill.error ? 'text-danger' : skill.compatible ? 'text-ok' : 'text-warn')}>{skill.error ? skill.error : skill.compatible ? 'Codex／Claude Code 共用' : `需先轉寫：${skill.extensions?.join(', ')}`}</dd>
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
                  )
                ) : skill && (
                  <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
                      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">會議
                        <select aria-label="會議" value={effectiveRunId} onChange={(e) => { setRunId(e.target.value); setRunFresh(!e.target.value); }} className="h-7 max-w-72 rounded-md border border-input bg-transparent px-2 text-[12.5px] text-foreground">
                          <option value="">新會議</option>
                          {skillRuns.map((r) => {
                            const firstLine = r.messages?.[0]?.text?.split('\n')[0] || '';
                            const t = r.updated_at ? new Date(r.updated_at).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
                            return <option key={r.id} value={r.id}>{`${t} · ${SKILL_RUN_STATUS[r.status] || r.status} · ${firstLine.slice(0, 40)}`}</option>;
                          })}
                        </select>
                      </label>
                      <Button type="button" variant="outline" size="sm" disabled={!effectiveRunId} onClick={() => { setRunId(''); setRunFresh(true); inputRef.current?.focus(); }}>新會議</Button>
                      <Button type="button" variant="outline" size="sm" disabled={!run || !effectiveRunId || run.status !== 'done'} onClick={toBacklog}>帶入需求待辦</Button>
                    </div>
                    <div ref={messagesRef} className="min-h-0 flex-1 overflow-auto p-4" role="log" aria-live="polite" tabIndex={0}>
                      {!effectiveRunId || !run ? (
                        <div className="mx-auto max-w-lg py-10 text-center">
                          <Eyebrow>技能會議</Eyebrow>
                          <h3 className="mt-1 text-base font-semibold">與 {skill.name} 開一場會議</h3>
                          <p className="mt-2 text-xs text-muted-foreground">{skill.description || ''} 會議是唯讀的釐清對話，AI 不會修改專案；確認的需求可帶入需求待辦。</p>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3">
                          {(run.messages || []).map((m, i) => (
                            <article key={m.id || i} className={cn('rounded-lg border p-3', m.role === 'user' ? 'ml-8 bg-surface-2' : 'mr-8 bg-card')}>
                              <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
                                <b className="text-foreground">{m.role === 'user' ? '你' : PROVIDER_LABEL[m.provider || run.provider || ''] || skill.name}</b>
                                <span>{shortTime(m.at)}</span>
                                <button type="button" className="ml-auto hover:text-foreground" onClick={async () => { try { await navigator.clipboard.writeText(m.text); toast.success('已複製訊息'); } catch { toast.error('無法存取剪貼簿，請選取文字複製'); } }}>複製</button>
                              </div>
                              {m.role === 'user' ? <div className="selectable whitespace-pre-wrap text-[13px]">{m.text}</div> : <Markdown text={m.text} />}
                            </article>
                          ))}
                          {run.status === 'error' && <Notice tone="bad">這次回覆失敗：{run.error || '未知錯誤'}。請開新會議，或選擇已完成的會議接續。</Notice>}
                          {runActive(run) && <SkillTyping runId={run.id} />}
                          {runActive(run) && (
                            <details open className="rounded-lg border bg-surface-2 p-2 text-xs">
                              <summary className="cursor-pointer"><LiveSince label="正在回覆 · 查看執行紀錄" since={run.created_at || run.updated_at} /></summary>
                              <div className="mt-2 max-h-80 overflow-auto rounded bg-card p-2"><LogTree text={logs[`skill-${run.id}`] || '正在準備 CLI 與技能快照…'} /></div>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                    <div className="shrink-0 border-t px-4 py-2">
                      <LiveSince label={statusText} since={active ? run?.created_at || run?.updated_at : null} className="block text-xs" />
                    </div>
                    <form className="flex shrink-0 flex-col gap-2 px-4 pb-3" onSubmit={(e) => { e.preventDefault(); void sendSkill(); }}>
                      <label className="sr-only" htmlFor="skill-input">需求或回答</label>
                      <Textarea id="skill-input" ref={inputRef} rows={3} maxLength={20000} value={input} onChange={(e) => setInput(e.target.value)} placeholder="描述需求或回答 AI 的問題…" className="min-h-16 selectable" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void sendSkill(); } }} />
                      <div className="flex flex-wrap items-center gap-2">
                        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">AI
                          <select aria-label="會議使用的 AI" value={provider} onChange={(e) => setProvider(e.target.value as Provider)} className="h-7 rounded-md border border-input bg-transparent px-2 text-[12.5px] text-foreground">
                            <option value="claude">{PROVIDER_LONG.claude}</option><option value="codex">{PROVIDER_LONG.codex}</option>
                          </select>
                        </label>
                        <span className="text-[11px] text-muted-foreground">Enter 傳送 · Shift+Enter 換行 · 每次回覆是新的 CLI session，以會議紀錄交接</span>
                        <Button type="submit" className="ml-auto" disabled={blocked}>送出</Button>
                      </div>
                    </form>
                  </div>
                )}
              </section>
            ) : (
              <EmptyState
                title={<><Eyebrow className="block">共用技能庫</Eyebrow><span className="mt-1 block text-base">選擇左側的技能，或匯入一個資料夾</span></>}
                description={<>技能資料夾像 Claude Code 的 <span className="font-mono">.claude/skills/&lt;name&gt;/</span>：含 SKILL.md（YAML frontmatter 加 Markdown 指令），其餘檔案當資源一起複製。同一份技能可交給 Codex 或 Claude Code。</>}
              />
            )}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Page>
  );
}

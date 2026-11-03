// Skills：左側技能清單（搜尋、匯入、新增），右側技能內容（frontmatter、資源檔、SKILL.md 預覽／編輯）與技能會議；
// 「工作流技能綁定」固定在清單最上方，是全域設定的一張階段表。
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Page, Eyebrow, EmptyState, Loading } from '@/components/app/Page';
import { Chip } from '@/components/app/StatusPill';
import { confirmDialog, promptDialog } from '@/components/app/confirm';
import { dialogs, inTauri } from '@/lib/tauri';
import { errorMessage, type Api } from '@/lib/api';
import { readJson, writeJson } from '@/lib/storage';
import { cn } from '@/lib/utils';
import { useProjectApi, useSnapshot } from '@/stores/project';
import { useBadges } from '@/stores/badges';
import { useBacklogDraft } from '@/stores/backlog-draft';
import { useSkillCommandInput } from '@/features/skills/use-skill-command';
import { BindingsPanel } from '@/features/skills/SkillBindings';
import { SkillContent, SkillDetail, SkillEditor } from '@/features/skills/SkillDetail';
import { SkillMeeting } from '@/features/skills/SkillMeeting';
import {
  BINDINGS, DEFAULT_STAGES, SKILL_TEMPLATE, importInOrder, meetingTranscript, nextSelection, normalizeBindings, pickRunId, runActive, skillOriginText, stageListOf,
  type Bindings, type Selected, type SkillView,
} from '@/features/skills/skill-utils';
import type { Provider, Skill, SkillRun, SkillStage, SkillsPayload, Snapshot } from '@/types/api';

export { skillOriginText } from '@/features/skills/skill-utils';

const LAYOUT_KEY = 'ai-workflow.skills';

/** 選取的技能；BINDINGS 或沒有選取時是 null。 */
function findSkill(library: Skill[], selected: Selected) {
  if (!selected || selected === BINDINGS) return null;
  return library.find((s) => s.name === selected) || null;
}

/** 選一個技能時預設顯示的會議：這個技能最近的一場。 */
function latestRunId(runs: SkillRun[], name: Selected) {
  if (!name || name === BINDINGS) return '';
  return runs.find((r) => r.name === name)?.id || '';
}

/** 技能庫、階段綁定、會議清單與選取；非同步載入時用 ref 讀最新的選取狀態。 */
function useSkillLibrary(api: Api) {
  const [library, setLibrary] = useState<Skill[]>([]);
  const [stages, setStages] = useState<SkillStage[]>(DEFAULT_STAGES);
  const [bindings, setBindings] = useState<Bindings>({});
  const [bindingsSaved, setBindingsSaved] = useState<Bindings>({});
  const [runs, setRuns] = useState<SkillRun[]>([]);
  const [selected, setSelected] = useState<Selected>(null);
  const [editing, setEditing] = useState(false);
  const [runId, setRunId] = useState('');
  const [runFresh, setRunFresh] = useState(false); // 使用者明確選了「新會議」，不要自動跳回最近一場
  const [loadError, setLoadError] = useState('');
  const [loaded, setLoaded] = useState(false);

  // 非同步載入時要讀到最新的選取狀態，用 ref 鏡射。
  const live = useRef({ selected, runId, runFresh, editing, runs, bindings, bindingsSaved });
  live.current = { selected, runId, runFresh, editing, runs, bindings, bindingsSaved };

  const loadRuns = useCallback(async () => {
    const { runs: list } = await api<{ runs: SkillRun[] }>('/api/skills/runs');
    const next = Array.isArray(list) ? list : [];
    const { selected: sel, runId: current, runFresh: fresh, runs: prev } = live.current;
    const pick = pickRunId(next, prev, sel, current, fresh);
    if (pick.created) setRunFresh(false);
    setRuns(next);
    setRunId(pick.id);
  }, [api]);

  const loadSkills = useCallback(async () => {
    const data = await api<SkillsPayload>('/api/skills');
    const skills = data.skills || [];
    const stageList = stageListOf(data);
    const saved = normalizeBindings(data.config, stageList);
    const { bindings: b, bindingsSaved: bs, selected: sel, editing: ed } = live.current;
    const wasDirty = JSON.stringify(b) !== JSON.stringify(bs);
    setLibrary(skills); setStages(stageList); setBindingsSaved(saved); setLoaded(true);
    if (!wasDirty) setBindings(structuredClone(saved));
    const nextSel = nextSelection(sel, skills, ed);
    if (nextSel !== sel) { setSelected(nextSel); live.current.selected = nextSel; }
    setLoadError('');
    await loadRuns();
  }, [api, loadRuns]);

  useEffect(() => { loadSkills().catch((e) => { setLoadError(errorMessage(e)); toast.error(errorMessage(e)); }); }, [loadSkills]);

  return {
    library, stages, bindings, setBindings, bindingsSaved, setBindingsSaved, runs, selected, setSelected, editing, setEditing,
    runId, setRunId, setRunFresh, loadError, loaded, live, loadRuns, loadSkills,
  };
}

type SkillLibrary = ReturnType<typeof useSkillLibrary>;

/** 匯入技能資料夾（按鈕、拖放或視窗事件）；缺 SKILL.md 時後端會拒絕，只顯示原因並保持原本選取。 */
function useSkillImport(api: Api, lib: SkillLibrary) {
  const { setEditing, setSelected, setRunId, setRunFresh, live, loadSkills } = lib;
  const importSkillFolders = useCallback(async (paths: string[]) => {
    const importOne = async (path: string) => (await api<{ skill: Skill }>('/api/skills/import', { path })).skill;
    const { imported, errors } = await importInOrder(paths.slice(0, 8), importOne, errorMessage);
    if (imported) {
      setEditing(false); setSelected(imported.name); setRunId(''); setRunFresh(false);
      live.current.selected = imported.name; live.current.editing = false; live.current.runId = '';
      await loadSkills(); toast.success(`已匯入技能 ${imported.name}`);
    }
    if (errors.length) toast.error(errors.join('\n'));
    return imported;
  }, [api, loadSkills, live, setEditing, setRunFresh, setRunId, setSelected]);

  useEffect(() => {
    const onImport = (e: Event) => { const paths = (e as CustomEvent<{ paths?: string[] }>).detail?.paths; if (paths?.length) importSkillFolders(paths).catch((err) => toast.error(errorMessage(err))); };
    window.addEventListener('ai-workflow:import-skills', onImport);
    return () => window.removeEventListener('ai-workflow:import-skills', onImport);
  }, [importSkillFolders]);

  return importSkillFolders;
}

/** 技能會議的背景工作變了（開始或結束）就重讀會議；有會議在回覆時側欄顯示徽章。 */
function useRunsRefresh(snap: Snapshot, runs: SkillRun[], loadRuns: () => Promise<void>) {
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
}

/** 會議輸入區上方的狀態文字。 */
function meetingStatusText(s: { active: boolean; failed: boolean; sending: boolean; skillBusy: boolean; anyBusy: boolean; hasRun: boolean }) {
  if (s.active) return 'AI 正在回覆，下方可展開執行紀錄';
  if (s.failed) return '這次回覆失敗，請開新會議';
  if (s.sending) return '正在送出…';
  if (s.skillBusy) return '另一場技能會議正在回覆，完成後才能送出';
  if (s.anyBusy) return '流程執行中，結束後才能開會議';
  return s.hasRun ? '可以接續這場會議，每次回覆以紀錄交接到新的 session' : '新會議：描述需求或問題，AI 會依技能指令回覆';
}

/** 包成按鈕用的處理函式：錯誤以 toast 顯示。 */
const handle = (fn: () => Promise<unknown>) => () => { fn().catch((e) => toast.error(errorMessage(e))); };

/** 技能會議的輸入、送出與「帶入需求待辦」；狀態放在頁面層，切換分頁不會遺失輸入。 */
function useSkillMeetingState(api: Api, snap: Snapshot, skill: Skill | null, run: SkillRun | null, effectiveRunId: string, loadRuns: () => Promise<void>) {
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState('');
  const [provider, setProvider] = useState<Provider>('claude');
  useEffect(() => { setProvider((snap.config.roles?.interviewer || snap.config.roles?.author || 'claude') as Provider); }, [snap.config.roles]);

  const sendSkill = async () => {
    const text = input.trim();
    if (!skill || sending || !text) return;
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
    if (run?.status !== 'done') throw new Error('請選擇已完成的技能會議');
    if (useBacklogDraft.getState().pending && !(await confirmDialog({ title: '以此會議取代目前尚未新增的需求說明？', confirmText: '取代' }))) return;
    const { title, body } = meetingTranscript(run);
    useBacklogDraft.getState().set(title, body);
    toast.success('已帶入需求待辦，確認後按新增');
    void navigate(`/p/${snap.project.id}/backlog`);
  });

  const anyBusy = !!(snap.skillBusy || snap.runnerAlive || snap.prdBusy || snap.taskGenBusy);
  const active = runActive(run) && !!effectiveRunId;
  const blocked = sending || anyBusy || (!!effectiveRunId && run?.status !== 'done');
  const statusText = meetingStatusText({ active, failed: !!effectiveRunId && run?.status === 'error', sending, skillBusy: !!snap.skillBusy, anyBusy, hasRun: !!effectiveRunId });
  return { input, setInput, provider, setProvider, sendSkill, toBacklog, active, blocked, statusText };
}

/** 左側的技能庫：搜尋、匯入、工作流技能綁定入口、技能清單與新增。 */
function SkillSidebar({ lib, query, onQuery, visible, draft, onSelect, onImport, onNew }: Readonly<{
  lib: SkillLibrary;
  query: string;
  onQuery: (query: string) => void;
  visible: Skill[];
  draft: boolean;
  onSelect: (name: Selected) => void;
  onImport: () => void;
  onNew: () => void;
}>) {
  const { selected, library, loaded, loadError } = lib;
  let empty: ReactNode = null;
  if (!visible.length) {
    empty = !loaded && !loadError
      ? <li><Loading inline label="讀取技能…" className="px-2 py-3" /></li>
      : <li className="px-2 py-3 text-xs text-muted-foreground">{library.length ? '沒有符合的技能' : loadError || '還沒有技能'}</li>;
  }
  return (
    <aside className="flex h-full min-h-0 flex-col" aria-label="技能庫">
      <div className="flex shrink-0 items-center gap-2 border-b p-2">
        <Input type="search" value={query} onChange={(e) => onQuery(e.target.value)} placeholder="搜尋技能" aria-label="搜尋技能" className="h-7" />
        <Button type="button" variant="outline" size="sm" onClick={onImport} title="選擇包含 SKILL.md 的資料夾，整個資料夾（含資源檔）會複製進技能庫"><Plus />匯入技能</Button>
      </div>
      <nav className="flex min-h-0 flex-1 flex-col overflow-y-auto p-2" aria-label="技能與設定">
        <button type="button" aria-current={selected === BINDINGS} onClick={() => onSelect(BINDINGS)} className={cn('mb-2 flex flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left hover:bg-accent', selected === BINDINGS ? 'border-primary bg-accent' : 'border-border')}>
          <strong className="text-[13px]">工作流技能綁定</strong>
          <span className="text-xs text-muted-foreground">每個階段各載入哪些技能</span>
        </button>
        <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">技能</div>
        <ul className="flex flex-col gap-1" aria-label="共用技能">
          {empty}
          {visible.map((s) => {
            const { origin, compat, tone } = skillOriginText(s);
            const on = s.name === selected && !draft;
            return (
              <li key={s.name}>
                <button type="button" data-skill={s.name} aria-current={on} onClick={() => onSelect(s.name)} className={cn('flex w-full flex-col gap-0.5 rounded-md border px-2.5 py-2 text-left hover:bg-accent', on ? 'border-primary bg-accent' : 'border-border')}>
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
        <Button type="button" variant="outline" size="sm" onClick={onNew}>新增技能</Button>
        <Button type="button" variant="ghost" size="icon-sm" onClick={handle(lib.loadSkills)} aria-label="重新整理技能庫" title="重新整理技能庫"><RefreshCw /></Button>
        <span className="text-[11px] text-muted-foreground">也可以把技能資料夾拖放到這裡</span>
      </div>
    </aside>
  );
}

const SKILLS_EMPTY = (
  <EmptyState
    title={<><Eyebrow className="block">共用技能庫</Eyebrow><span className="mt-1 block text-base">選擇左側的技能，或匯入一個資料夾</span></>}
    description={<>技能資料夾像 Claude Code 的 <span className="font-mono">.claude/skills/&lt;name&gt;/</span>：含 SKILL.md（YAML frontmatter 加 Markdown 指令），其餘檔案當資源一起複製。同一份技能可交給 Codex 或 Claude Code。</>}
  />
);

export function SkillsPage() {
  const api = useProjectApi();
  const snap = useSnapshot()!;
  const lib = useSkillLibrary(api);
  const { library, runs, selected, setSelected, editing, setEditing, runId, setRunId, setRunFresh, live, loadRuns, loadSkills } = lib;
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editorText, setEditorText] = useState('');
  const [view, setView] = useState<SkillView>('content');
  const [query, setQuery] = useState('');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  useSkillCommandInput(inputRef);
  useRunsRefresh(snap, runs, loadRuns);
  const importSkillFolders = useSkillImport(api, lib);

  const skill = findSkill(library, selected);
  const draft = editing && !skill; // 新增技能
  const run = runs.find((r) => r.id === runId) || null;
  const skillRuns = skill ? runs.filter((r) => r.name === skill.name) : [];
  const effectiveRunId = skill && run?.name === skill.name ? runId : '';
  const meeting = useSkillMeetingState(api, snap, skill, run, effectiveRunId, loadRuns);

  useEffect(() => { const host = messagesRef.current; if (host) host.scrollTop = host.scrollHeight; }, [effectiveRunId, run?.messages?.length, run?.status]);

  const select = (name: Selected) => {
    if (selected === name && !editing) return;
    setSelected(name); setEditing(false); setEditingName(null); setRunFresh(false); setView('content');
    setRunId(latestRunId(runs, name));
  };

  const saveBindings = handle(async () => {
    const skills = structuredClone(lib.bindings);
    await api('/api/skills/config', { skills });
    lib.setBindingsSaved(structuredClone(skills)); toast.success('已儲存階段技能');
  });

  const deleteSkill = handle(async () => {
    if (!skill) return;
    const builtin = !!skill.hasBuiltin;
    const ok = await confirmDialog({
      title: builtin ? `還原內建的 ${skill.name}？` : `刪除技能 ${skill.name}？`,
      description: builtin ? '你修改的副本會刪除。' : '整個技能資料夾會從技能庫移除。',
      confirmText: builtin ? '還原' : '刪除', destructive: !builtin,
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

  const newSkill = () => { setSelected(null); setEditing(true); setEditingName(null); setView('content'); setEditorText(SKILL_TEMPLATE); };
  const cancelEdit = () => { setEditing(false); setEditingName(null); if (!selected) { setSelected(library[0]?.name || null); } };

  const compatible = library.filter((s) => s.compatible).map((s) => s.name);
  const descriptions = Object.fromEntries(library.map((s) => [s.name, s.description || '']));
  const visible = useMemo(() => {
    const q = query.trim().toLocaleLowerCase();
    return library.filter((s) => !q || `${s.name} ${s.description || ''}`.toLocaleLowerCase().includes(q));
  }, [library, query]);
  const defaultLayout = useMemo(() => readJson<Record<string, number> | null>(LAYOUT_KEY, null) || undefined, []);

  // ---------- 右側：工作流技能綁定、技能內容（或編輯器、會議），或空白說明 ----------
  let body: ReactNode = null;
  if (view === 'content' || draft) {
    body = editing
      ? <SkillEditor skill={skill} text={editorText} onText={setEditorText} onCancel={cancelEdit} onSave={saveSkill} />
      : skill && <SkillContent skill={skill} />;
  } else if (skill) {
    body = (
      <SkillMeeting
        skill={skill}
        inputRef={inputRef}
        messagesRef={messagesRef}
        meeting={{ run, runs: skillRuns, runId: effectiveRunId, statusText: meeting.statusText, active: meeting.active, blocked: meeting.blocked, input: meeting.input, provider: meeting.provider }}
        actions={{
          onRunId: (id) => { setRunId(id); setRunFresh(!id); },
          onNewRun: () => { setRunId(''); setRunFresh(true); inputRef.current?.focus(); },
          onToBacklog: meeting.toBacklog,
          onInput: meeting.setInput,
          onProvider: meeting.setProvider,
          onSend: () => void meeting.sendSkill(),
        }}
      />
    );
  }
  let main: ReactNode = SKILLS_EMPTY;
  if (selected === BINDINGS) {
    main = <BindingsPanel stages={lib.stages} bindings={lib.bindings} onBindings={lib.setBindings} compatible={compatible} descriptions={descriptions} dirty={JSON.stringify(lib.bindings) !== JSON.stringify(lib.bindingsSaved)} onSave={saveBindings} />;
  } else if (skill || draft) {
    const startEdit = () => { if (skill) { setEditing(true); setEditingName(skill.name); setEditorText(skill.text || ''); } };
    main = <SkillDetail skill={skill} editing={editing} view={view} onView={setView} runs={skillRuns} onEdit={startEdit} onDelete={deleteSkill}>{body}</SkillDetail>;
  }

  return (
    <Page>
      <div className="h-full" data-skill-drop>
        <ResizablePanelGroup orientation="horizontal" defaultLayout={defaultLayout} onLayoutChanged={(layout) => writeJson(LAYOUT_KEY, layout)} className="h-full">
          <ResizablePanel id="skills-sidebar" defaultSize="26" minSize={220} className="flex min-h-0 flex-col border-r bg-sidebar/40">
            <SkillSidebar lib={lib} query={query} onQuery={setQuery} visible={visible} draft={draft} onSelect={select} onImport={importClick} onNew={newSkill} />
          </ResizablePanel>
          <ResizableHandle />
          <ResizablePanel id="skills-main" minSize={320} className="flex min-h-0 flex-col">
            {main}
          </ResizablePanel>
        </ResizablePanelGroup>
      </div>
    </Page>
  );
}

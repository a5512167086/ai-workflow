// 全域設定（只有一份，所有專案共用）：工作流程模式、同時執行上限、AI 角色與模型、節省 Token、流程參數、CLI 執行環境。
// 資料在 ~/.ai-workflow/config.json，透過 /api/config 讀寫；每張卡各自有未儲存的草稿，重畫時不覆蓋。
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Save, Stethoscope, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Page, PageHeader, PageBody, Panel, Hint, Loading } from '@/components/app/Page';
import { ModelPicker } from '@/components/app/ModelPicker';
import { api, errorMessage } from '@/lib/api';
import { PROVIDER_LABEL, PROVIDER_LONG, REVIEW_ROLES, ROLE_HINTS, ROLE_LABELS, ROLE_ORDER } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useModels } from '@/stores/models';
import type { ConfigPayload, DoctorPayload, GlobalConfig, Provider, QueueSnapshot, Role, RoleChoice, TokenSaving } from '@/types/api';

/** 原生 select（設定頁有十幾個選單，原生下拉在桌面上最輕、鍵盤也最直覺）。 */
function NativeSelect({ className, ...props }: React.ComponentProps<'select'>) {
  return (
    <select
      {...props}
      className={cn('h-8 min-w-0 rounded-md border border-input bg-background px-2 text-[13px] text-foreground outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-input/30', className)}
    />
  );
}

const SAVING_ITEMS: [keyof TokenSaving & string, string, string][] = [
  ['review_diff_filter', '審查略過 lockfile 與產生檔', 'package-lock.json、Cargo.lock、dist/、*.min.js 等只列檔名，內容不送審查。'],
  ['prd_excerpt', '實作只附相關的 PRD', '只附任務對應的使用者故事、測試決策與不做的事，並給完整 PRD 路徑；對不到使用者故事時照舊附全文。'],
  ['dedupe_skills', '內建技能不重複附加', 'tdd、to-spec、to-tickets、grill-me 的方法已寫在該階段的提示詞裡；沒改過的內建技能就不再附一次。'],
  ['code_map', '專案圖譜', '以 tree-sitter 建立定義、匯入、呼叫與繼承的圖譜（參考 graphify），實作與修正前依任務內容把相關的節點與關係附給 AI，不用整個專案搜尋；專案頁的「架構圖」分頁可以檢視。'],
];
const TERSE_ROLES: [keyof NonNullable<TokenSaving['terse']>, string][] = [['reviewer', 'PRD 審查'], ['implementer', '實作'], ['fixer', '修正'], ['code_reviewer', '程式碼審查']];
const LIMIT_FIELDS: [keyof GlobalConfig & string, string, 'number' | 'text', number?, number?][] = [
  ['max_fix_rounds', '每個任務最多修正幾輪', 'number', 1, 10],
  ['max_prd_rounds', 'PRD 審查最多幾輪', 'number', 1, 10],
  ['num_tasks', '拆成幾個任務', 'number', 0, 50],
  ['branch_prefix', '自動模式分支前綴', 'text'],
];
const RUNTIME_OPTIONS: [string, string][] = [['auto', '自動（依專案位置）'], ['windows', 'Windows'], ['wsl', 'WSL']];
/** 新角色沒有設定時沿用的上層角色（與舊版 settings.js 相同）。 */
const ROLE_PARENT: Partial<Record<Role, Role>> = { interviewer: 'author', task_planner: 'author', fixer: 'implementer', handover: 'implementer', chat: 'author' };

interface ModelDraft { roles: Partial<Record<Role, RoleChoice>>; models: Partial<Record<Role, Partial<Record<Provider, { model: string; effort: string }>>>> }

function draftFrom(config: GlobalConfig): ModelDraft {
  const roles = { ...(config.roles || {}) } as ModelDraft['roles'];
  const models = structuredClone(config.models || {}) as ModelDraft['models'];
  for (const [role, parent] of Object.entries(ROLE_PARENT) as [Role, Role][]) {
    roles[role] ??= roles[parent] || 'claude';
    models[role] ??= structuredClone(models[parent] || {}) as ModelDraft['models'][Role];
  }
  return { roles, models };
}

function SaveButton({ onClick, disabled, label = '儲存' }: { onClick: () => void; disabled?: boolean; label?: string }) {
  return <Button size="sm" onClick={onClick} disabled={disabled}><Save className="size-3.5" />{label}</Button>;
}

/** 工作流程模式與全域同時執行上限。 */
function WorkflowCard({ config, queue, onConfig, onQueue }: { config: GlobalConfig; queue: QueueSnapshot | null; onConfig: (c: GlobalConfig) => void; onQueue: (q: QueueSnapshot) => void }) {
  const setMode = async (mode: string) => {
    if (!mode || mode === config.mode) return;
    try {
      const res = await api<{ config?: GlobalConfig }>('/api/config/mode', { mode });
      if (res?.config) onConfig(res.config); else onConfig({ ...config, mode: mode as GlobalConfig['mode'] });
      toast.success(`已切換為${mode === 'auto' ? '自動' : '手動'}模式`);
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const setMax = async (max: number) => {
    try {
      const res = await api<{ queue: QueueSnapshot }>('/api/queue/config', { max });
      if (res?.queue) onQueue(res.queue);
      toast.success('已更新全域執行佇列');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  return (
    <Panel className="xl:col-span-2" bodyClassName="grid gap-6 md:grid-cols-2">
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold">工作流程模式</h2>
        <Hint>自動：驗證與審查通過後自動 commit。手動：不自動 commit，每個任務完成後等待你測試。適用所有專案，與 Windows／WSL 執行環境無關。</Hint>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" id="mode-label">模式</span>
          <ToggleGroup type="single" variant="outline" value={config.mode} onValueChange={setMode} aria-labelledby="mode-label">
            <ToggleGroupItem value="auto" aria-label="自動">自動</ToggleGroupItem>
            <ToggleGroupItem value="manual" aria-label="手動">手動</ToggleGroupItem>
          </ToggleGroup>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold">全域同時執行上限</h2>
        <Hint>適用所有專案；其他專案會排隊，等待人工驗收的專案不占名額。</Hint>
        <div className="flex items-center gap-3">
          <Label htmlFor="max-runs" className="text-xs text-muted-foreground">上限</Label>
          <NativeSelect id="max-runs" value={String(queue?.max ?? config.max_concurrent_runs ?? 1)} onChange={(e) => void setMax(Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} 個</option>)}
          </NativeSelect>
          {queue && <Hint>執行中 {queue.running.length} 個，排隊 {queue.waiting.length} 個</Hint>}
        </div>
      </div>
    </Panel>
  );
}

/** 九個角色排成 3×3 小卡：角色、AI、模型、推理強度。 */
function RolesCard({ config, onConfig }: { config: GlobalConfig; onConfig: (c: GlobalConfig) => void }) {
  const options = useModels((s) => s.options);
  const modelsError = useModels((s) => s.error);
  const loading = useModels((s) => s.loading);
  const efforts = useModels((s) => s.efforts);
  const [draft, setDraft] = useState<ModelDraft>(() => draftFrom(config));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(draftFrom(config)); }, [config, dirty]);

  const update = (fn: (d: ModelDraft) => void) => {
    setDraft((prev) => { const next = structuredClone(prev); fn(next); return next; });
    setDirty(true);
  };
  const save = async () => {
    try {
      const res = await api<{ config?: GlobalConfig }>('/api/config/models', { roles: draft.roles, models: draft.models });
      setDirty(false);
      if (res?.config) onConfig(res.config); else onConfig({ ...config, roles: draft.roles, models: draft.models });
      toast.success('已儲存角色與模型');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const status = [options?.claude?.error, options?.codex?.error].filter(Boolean).join(' ') || modelsError || (loading ? '正在從 CLI 讀取可用的模型…' : '');

  return (
    <Panel className="xl:col-span-2" title="AI 角色與模型" actions={<SaveButton onClick={() => void save()} disabled={!dirty} />} bodyClassName="flex flex-col gap-3">
      <Hint>九個階段各自選擇 AI、模型與推理強度；空白＝CLI 預設。PRD 審查與程式碼審查可以選「雙人審查」：Claude 與 Codex 各審一次，兩份都通過才算通過。只有一個 AI 可用或額度用完改用另一個 AI 時，套用那個 AI 的設定。</Hint>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3" data-testid="role-grid">
        {ROLE_ORDER.map((role) => {
          const label = ROLE_LABELS[role];
          const choice = draft.roles[role] || 'claude';
          const providers: Provider[] = choice === 'both' ? ['claude', 'codex'] : [choice];
          return (
            <fieldset key={role} data-role={role} className="flex flex-col gap-2 rounded-md border bg-surface-2/40 p-3">
              <legend className="px-1 text-[12.5px] font-semibold">{label}</legend>
              <Hint>{ROLE_HINTS[role]}</Hint>
              <NativeSelect aria-label={`${label} 使用的 AI`} value={choice} onChange={(e) => update((d) => { d.roles[role] = e.target.value as RoleChoice; })}>
                <option value="claude">{PROVIDER_LONG.claude}</option>
                <option value="codex">{PROVIDER_LONG.codex}</option>
                {REVIEW_ROLES.includes(role) && <option value="both">雙人審查（Claude ＋ Codex）</option>}
              </NativeSelect>
              {providers.map((p) => {
                const cur = draft.models[role]?.[p] || { model: '', effort: '' };
                const list = efforts(p, cur.model);
                const extra = cur.effort && !list.includes(cur.effort) ? [cur.effort] : [];
                return (
                  <div key={p} className="grid grid-cols-[auto_1fr_auto] items-center gap-1.5">
                    <span className={cn('rounded px-1.5 text-[11px] font-semibold', p === 'claude' ? 'bg-ok-soft text-ok' : 'bg-info-soft text-info')}>{PROVIDER_LABEL[p]}</span>
                    <ModelPicker
                      provider={p}
                      value={cur.model}
                      placeholder="模型：沿用預設"
                      aria-label={`${label}：${PROVIDER_LABEL[p]} 模型`}
                      className="mono min-w-0"
                      onChange={(model) => update((d) => { d.models[role] ??= {}; d.models[role]![p] = { model: model.trim(), effort: cur.effort }; })}
                    />
                    <NativeSelect aria-label={`${label}：${PROVIDER_LABEL[p]} 推理強度`} value={cur.effort} onChange={(e) => update((d) => { d.models[role] ??= {}; d.models[role]![p] = { model: cur.model, effort: e.target.value }; })}>
                      <option value="">推理強度：預設</option>
                      {[...list, ...extra].map((e) => <option key={e} value={e}>{e}</option>)}
                    </NativeSelect>
                  </div>
                );
              })}
            </fieldset>
          );
        })}
      </div>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground" aria-label="預設模型">
        {(['claude', 'codex'] as Provider[]).map((p) => {
          const info = options?.[p];
          const entry = info?.models?.find((m) => m.default);
          const model = config[p]?.model || info?.defaultModel || entry?.id;
          const effort = config[p]?.effort || info?.defaultEffort || entry?.defaultEffort;
          return <li key={p}>{PROVIDER_LABEL[p]} 預設模型：{model || 'CLI 依帳號決定（未回報）'}；預設推理強度：{effort || 'CLI 依模型決定（未回報）'}。來源：{config[p]?.model || config[p]?.effort ? '全域設定' : info?.defaultSource || 'CLI 模型清單'}。</li>;
        })}
      </ul>
      <Hint>模型清單直接向 Claude Code 與 Codex CLI 查詢，就是這個帳號可用的模型；Pro 訂閱使用 Fable 可能需要額外 usage credits。Handover 是給下一個 AI session 的交接紀錄。</Hint>
      {loading && status === '正在從 CLI 讀取可用的模型…' ? <Loading inline label={status} /> : status && <Hint role="status">{status}</Hint>}
    </Panel>
  );
}

/** 節省 Token：4 個開關與精簡回覆的角色。 */
function SavingCard({ config, onConfig }: { config: GlobalConfig; onConfig: (c: GlobalConfig) => void }) {
  const fromConfig = useCallback((c: GlobalConfig): TokenSaving => {
    const s = c.token_saving || {};
    return {
      review_diff_filter: s.review_diff_filter === true, prd_excerpt: s.prd_excerpt === true, dedupe_skills: s.dedupe_skills === true, code_map: s.code_map === true,
      terse: Object.fromEntries(TERSE_ROLES.map(([r]) => [r, s.terse?.[r] === true])),
    };
  }, []);
  const [draft, setDraft] = useState<TokenSaving>(() => fromConfig(config));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(fromConfig(config)); }, [config, dirty, fromConfig]);
  const save = async () => {
    try {
      const res = await api<{ config?: GlobalConfig }>('/api/config/token_saving', { token_saving: draft });
      setDirty(false);
      if (res?.config) onConfig(res.config); else onConfig({ ...config, token_saving: draft });
      toast.success('已儲存節省 Token 設定');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  return (
    <Panel className="xl:col-span-2" title="節省 Token" actions={<SaveButton onClick={() => void save()} disabled={!dirty} />} bodyClassName="flex flex-col gap-3">
      <Hint>縮小每次送給 AI 的內容。AI 在一個 session 裡每發一次請求都會重讀整份 prompt，所以 prompt 少一點，整個 session 就少很多。適用所有專案；各專案的「用量」分頁會顯示估計省下多少。</Hint>
      <div className="grid gap-2 md:grid-cols-2">
        {SAVING_ITEMS.map(([key, title, hint]) => (
          <label key={key} className="flex cursor-pointer items-start gap-2 rounded-md border p-2.5 hover:bg-accent/50">
            <Checkbox className="mt-0.5" checked={draft[key] === true} aria-label={title} onCheckedChange={(v) => { setDraft((d) => ({ ...d, [key]: v === true })); setDirty(true); }} />
            <span className="flex flex-col gap-0.5"><strong className="text-[12.5px] font-semibold">{title}</strong><Hint>{hint}</Hint></span>
          </label>
        ))}
      </div>
      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-[12.5px] font-semibold">精簡回覆</legend>
        <Hint>要求 AI 結論先行、不寒暄、不重述，程式碼、路徑與錯誤訊息保留原文。只套用在下列角色的回覆；PRD、任務清單、handover 與需求釐清不套用。</Hint>
        <div className="flex flex-wrap gap-4">
          {TERSE_ROLES.map(([role, label]) => (
            <label key={role} className="flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox checked={draft.terse?.[role] === true} aria-label={`精簡回覆：${label}`} onCheckedChange={(v) => { setDraft((d) => ({ ...d, terse: { ...d.terse, [role]: v === true } })); setDirty(true); }} />
              {label}
            </label>
          ))}
        </div>
      </fieldset>
    </Panel>
  );
}

/** 流程參數：修正輪數、PRD 審查輪數、任務數、分支前綴。 */
function LimitsCard({ config, onConfig }: { config: GlobalConfig; onConfig: (c: GlobalConfig) => void }) {
  const fromConfig = (c: GlobalConfig) => Object.fromEntries(LIMIT_FIELDS.map(([k]) => [k, String(c[k] ?? '')])) as Record<string, string>;
  const [draft, setDraft] = useState<Record<string, string>>(() => fromConfig(config));
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (!dirty) setDraft(fromConfig(config)); }, [config, dirty]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    const body: Record<string, unknown> = {};
    for (const [key, , type] of LIMIT_FIELDS) body[key] = type === 'number' ? Number(draft[key]) : draft[key];
    try {
      const res = await api<{ config?: GlobalConfig }>('/api/config/limits', body);
      setDirty(false);
      if (res?.config) onConfig(res.config); else onConfig({ ...config, ...body });
      toast.success('已儲存流程參數');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  return (
    <Panel title="流程參數" actions={<SaveButton onClick={() => void save()} disabled={!dirty} />} bodyClassName="flex flex-col gap-3">
      <Hint>適用所有專案。任務數 0＝交給 AI 決定；自動模式的分支名稱是「前綴＋功能」。</Hint>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {LIMIT_FIELDS.map(([key, label, type, min, max]) => (
          <div key={key} className="contents">
            <Label htmlFor={`limit-${key}`} className="text-xs">{label}</Label>
            <Input id={`limit-${key}`} type={type} min={min} max={max} className={cn(type === 'text' && 'mono', 'max-w-60')} spellCheck={false} value={draft[key] ?? ''} onChange={(e) => { setDraft((d) => ({ ...d, [key]: e.target.value })); setDirty(true); }} />
          </div>
        ))}
      </div>
    </Panel>
  );
}

/** CLI 執行環境與 doctor。 */
function RuntimeCard({ config, onConfig }: { config: GlobalConfig; onConfig: (c: GlobalConfig) => void }) {
  const fromConfig = (c: GlobalConfig) => ({ claude: c.runtime?.claude || 'auto', codex: c.runtime?.codex || 'auto' });
  const [draft, setDraft] = useState(() => fromConfig(config));
  const [dirty, setDirty] = useState(false);
  const [doctor, setDoctor] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  useEffect(() => { if (!dirty) setDraft(fromConfig(config)); }, [config, dirty]);
  const save = async () => {
    try {
      const res = await api<{ config?: GlobalConfig }>('/api/config/runtime', { runtime: draft });
      setDirty(false);
      if (res?.config) onConfig(res.config); else onConfig({ ...config, runtime: draft as GlobalConfig['runtime'] });
      toast.success('已儲存執行環境');
    } catch (err) { toast.error(errorMessage(err)); }
  };
  const runDoctor = async () => {
    setChecking(true); setDoctor('檢查中…（每個 CLI 最多 60 秒）');
    try {
      const { lines } = await api<DoctorPayload>('/api/doctor', {});
      setDoctor(lines.join('\n'));
    } catch (err) { setDoctor(`失敗：${errorMessage(err)}`); }
    finally { setChecking(false); }
  };
  return (
    <Panel title="CLI 執行環境" bodyClassName="flex flex-col gap-3">
      <Hint>預設依專案位置自動選擇：專案在 Windows 磁碟就用 Windows 的 CLI，在 WSL（\\wsl.localhost…）就用該發行版裡的 CLI，也可以手動指定。只有一個 AI 可用時，以獨立對話完成實作與審查。</Hint>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
        {(['claude', 'codex'] as Provider[]).map((p) => (
          <div key={p} className="contents">
            <Label htmlFor={`rt-${p}`} className="mono text-xs">{p}</Label>
            <NativeSelect id={`rt-${p}`} className="max-w-60" value={draft[p]} onChange={(e) => { setDraft((d) => ({ ...d, [p]: e.target.value })); setDirty(true); }}>
              {RUNTIME_OPTIONS.map(([v, t]) => <option key={v} value={v}>{t}</option>)}
            </NativeSelect>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <SaveButton onClick={() => void save()} disabled={!dirty} />
        <Button size="sm" variant="outline" onClick={() => void runDoctor()} disabled={checking}><Stethoscope className="size-3.5" />檢查 CLI（doctor）</Button>
      </div>
      {doctor !== null && <pre role="status" className="mono selectable max-h-72 overflow-auto rounded-md border bg-surface-2 p-3 text-xs whitespace-pre-wrap">{doctor}</pre>}
    </Panel>
  );
}

function ConfigCard({ home, text, config }: { home: string; text?: string; config: GlobalConfig }) {
  const path = home ? `${home}${home.includes('\\') ? '\\' : '/'}config.json` : 'config.json';
  return (
    <Collapsible className="xl:col-span-2 rounded-lg border bg-card">
      <CollapsibleTrigger className="group flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <span className="text-[13px] font-semibold">目前設定</span>
        <span className="mono truncate text-xs text-muted-foreground">{path}</span>
        <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-2 border-t p-3">
        <Hint>CLI 路徑（cli）、WSL 發行版與指令（wsl_distro、wsl_cli）、逾時與 Claude 允許的工具等欄位可以直接在這個檔案裡修改。</Hint>
        <pre className="mono selectable max-h-96 overflow-auto rounded-md bg-surface-2 p-3 text-xs">{text || JSON.stringify(config, null, 2)}</pre>
      </CollapsibleContent>
    </Collapsible>
  );
}

export function SettingsPage() {
  const [payload, setPayload] = useState<ConfigPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadModels = useModels((s) => s.load);
  const load = useCallback(async () => {
    try {
      const data = await api<ConfigPayload>('/api/config');
      setPayload(data); setError(null);
    } catch (err) { setError(errorMessage(err)); toast.error(errorMessage(err)); }
  }, []);
  useEffect(() => { void load(); void loadModels(); }, [load, loadModels]);
  const onConfig = useCallback((config: GlobalConfig) => setPayload((p) => (p ? { ...p, config } : { config, home: '' })), []);
  const onQueue = useCallback((queue: QueueSnapshot) => setPayload((p) => (p ? { ...p, queue } : p)), []);
  const config = payload?.config;
  const body: ReactNode = useMemo(() => {
    if (!config) return error ? <Hint role="alert" className="text-danger">{error}</Hint> : <Loading label="載入設定…" />;
    return (
      <div className="grid gap-4 xl:grid-cols-2">
        <WorkflowCard config={config} queue={payload?.queue ?? null} onConfig={onConfig} onQueue={onQueue} />
        <RolesCard config={config} onConfig={onConfig} />
        <SavingCard config={config} onConfig={onConfig} />
        <LimitsCard config={config} onConfig={onConfig} />
        <RuntimeCard config={config} onConfig={onConfig} />
        <ConfigCard home={payload?.home || ''} text={payload?.text} config={config} />
      </div>
    );
  }, [config, error, payload?.queue, payload?.home, payload?.text, onConfig, onQueue]);
  return (
    <Page>
      <PageHeader title="設定" description="一份設定給所有專案；build／test／lint 指令與 context 檔在各專案的任務看板修改。" />
      <PageBody>{body}</PageBody>
    </Page>
  );
}

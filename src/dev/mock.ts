// 瀏覽器預覽用的假後端（不在 Tauri 裡時才載入）：讓 `npm run dev:web` 直接在瀏覽器看畫面、跑 UI 測試。
// 只模擬畫面需要的路由與事件；資料都在記憶體裡。
import type { BacklogItem, ChatSession, ChatSummary, GlobalConfig, ModelOptions, ProjectsPayload, Snapshot, TaskDetail, ReferenceItem, Skill, SkillRun } from '@/types/api';

type Handler<T> = (payload: T) => void;
const listeners = new Map<string, Set<Handler<unknown>>>();
function emit(event: string, payload: unknown) {
  for (const fn of listeners.get(event) || []) fn(payload);
}

const now = () => new Date().toISOString();
const PID = '0123456789';
const PID2 = 'abcdef0123';

const config: GlobalConfig = {
  mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'ai-workflow/',
  roles: { interviewer: 'claude', author: 'claude', reviewer: 'both', task_planner: 'claude', implementer: 'claude', fixer: 'claude', code_reviewer: 'both', handover: 'claude', chat: 'claude' },
  models: { author: { claude: { model: 'opus', effort: 'high' } } },
  runtime: { claude: 'auto', codex: 'auto' },
  claude: {}, codex: {},
  token_saving: { review_diff_filter: true, prd_excerpt: true, dedupe_skills: true, code_map: false, terse: { reviewer: true } },
  skills: { prd: ['to-spec'], tasks: ['to-tickets'], implement: ['tdd'], interview: ['grill-me'] },
};

const models: ModelOptions = {
  claude: { models: [
    { id: 'opus', name: 'Opus 5.5', description: '複雜工作', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
    { id: 'sonnet', name: 'Sonnet 5.5', description: '日常工作', efforts: ['low', 'medium', 'high'] },
    { id: 'haiku', name: 'Haiku 5.5', description: '快速', efforts: [] },
  ], defaultModel: 'opus', defaultEffort: 'high', defaultSource: 'Claude CLI 模型清單（依帳號）', error: null },
  codex: { models: [
    { id: 'gpt-5.1-codex', name: 'gpt-5.1-codex', efforts: ['low', 'medium', 'high', 'xhigh'], default: true, defaultEffort: 'medium' },
    { id: 'gpt-5.1-codex-mini', name: 'gpt-5.1-codex-mini', efforts: ['low', 'medium', 'high'] },
  ], error: null },
};

const prd = `# PRD：報表匯出 CSV

## 問題
使用者需要把報表帶到 Excel 分析，目前只能截圖。

## 解法
在報表頁加入「匯出 CSV」按鈕，可選欄位與日期範圍。

## 使用者故事
- **US-1** 身為分析師，我可以選擇日期範圍匯出報表，以便在 Excel 分析。
- **US-2** 身為分析師，我可以選擇要匯出的欄位。

## 實作決策
| 項目 | 決定 |
| --- | --- |
| 編碼 | UTF-8 with BOM |
| 時區 | 依使用者設定 |

## 測試接縫
\`\`\`mermaid
flowchart LR
  UI[報表頁] --> API["/api/export"]
  API --> CSV[CSV 產生器]
\`\`\`
`;

const tasks = [
  { id: 1, title: '新增匯出 API 端點', status: 'done', priority: 'high', description: '提供 `/api/export`，依日期範圍回傳 CSV。', acceptanceCriteria: ['回傳 200 與 text/csv', '日期範圍錯誤回 400'], manualChecks: ['用 Excel 開啟確認中文沒有亂碼'], testStrategy: '整合測試打 API 驗證內容', dependencies: [], subtasks: [{ id: 1, title: '路由與參數驗證', status: 'done' }, { id: 2, title: 'CSV 產生器', status: 'done' }], skills: ['tdd'], requirement_ids: ['US-1'] },
  { id: 2, title: '報表頁匯出按鈕與日期選擇', status: 'in-progress', priority: 'medium', description: '在報表頁加入按鈕與日期範圍選擇器。', dependencies: [1], acceptanceCriteria: ['點擊後下載檔案'], subtasks: [] },
  { id: 3, title: '欄位選擇對話框', status: 'pending', priority: 'medium', dependencies: [2], acceptanceCriteria: ['可勾選欄位'], subtasks: [] },
  { id: 4, title: '匯出紀錄與錯誤提示', status: 'pending', priority: 'low', dependencies: [2, 3], subtasks: [] },
];

// 預覽「PRD 錯誤通知」：關掉通知後清掉。
let prdError = 'PRD 修訂時程序已結束（可能是 App 重新啟動或程序被關閉），已保留目前版本。可按「只重新審查目前版本」或附意見「要求再改」繼續。';

function snapshot(): Snapshot {
  return {
    root: 'C:\\code\\my-app', dataDir: 'C:\\Users\\me\\.ai-workflow\\projects\\0123456789', project: { id: PID, name: 'my-app' },
    config: { ...config, feature: '報表匯出 CSV', commands: { build: 'npm run build', test: 'npm test', lint: '' }, context_files: ['docs/architecture.md'] },
    runnerAlive: true, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null,
    prd, tasks: tasks as Snapshot['tasks'], taskTag: 'csv-export', taskRevision: 'r3', taskReferences: ['ref-1'],
    usage: {
      totalTokens: 1234567, measuredSessions: 12, unknownSessions: 1, savedEstimate: 84000,
      providers: [
        { provider: 'claude', runtime: 'windows', tokens: 1000000, latest: { label: '任務 2 實作', status: 'running', tokens: { inputTokens: 52000, outputTokens: 3200, cacheReadTokens: 40000, cacheWriteTokens: 2000 }, context: { remainingPercent: 71.2, remainingTokens: 142000, capacity: 200000, estimated: false } }, limits: { windows: [{ name: 'Current session', remainingPercent: 62, windowMinutes: 300, resetsText: '今天 18:00' }, { name: 'Current week (all models)', remainingPercent: 48, windowMinutes: 10080, resetsText: '11/6 6pm' }], checkedAt: now() } },
        { provider: 'codex', runtime: 'windows', tokens: 234567, latest: { label: '任務 1 審查', status: 'done', tokens: { inputTokens: 30000, outputTokens: 1500 } }, limits: { windows: [], error: '未知：按「更新訂閱額度」查詢' } },
      ],
      recent: [
        { label: '任務 2 實作', provider: 'claude', runtime: 'windows', status: 'running', tokens: { inputTokens: 52000, outputTokens: 3200, totalTokens: 55200 }, savedEstimate: 12000 },
        { label: '任務 1 審查（Codex）', provider: 'codex', runtime: 'windows', status: 'done', tokens: { inputTokens: 30000, outputTokens: 1500, totalTokens: 31500 }, terse: true },
      ],
      tokenSaving: config.token_saving,
      byStage: [{ stage: 'implement', sessions: 4, tokens: 600000, savedEstimate: 40000 }, { stage: 'code_review', sessions: 4, tokens: 300000, savedEstimate: 24000 }, { stage: 'prd', sessions: 2, tokens: 200000 }, { stage: 'chat', sessions: 2, tokens: 134567 }],
    },
    permissions: [],
    state: {
      prd: { status: 'approved', error: prdError, idea: '報表匯出 CSV', version: 3, reviewed_version: 3, reference_scope: 'csv-export', references: ['ref-1'], archive_dir: 'archive/2026-11-01-csv-export', rounds: [
        { round: 1, kind: 'draft', provider: 'claude', version: 1, text: '初稿內容…' },
        { round: 1, kind: 'review', provider: 'codex', verdict: 'REVISE', version: 1, text: '[必須修正] 缺少時區處理\n[建議] 加入檔名規則' },
        { round: 2, kind: 'revise', provider: 'claude', version: 2, text: '修訂內容…' },
        { round: 2, kind: 'review', provider: 'codex', verdict: 'APPROVE', version: 2, text: 'VERDICT: APPROVE' },
      ] },
      pipeline: { status: 'running', reason: '任務 2 實作中' },
      control: {},
      tasks: {
        '1': { phase: 'done', step: '人工測試通過', fix_round: 1, attempts: 1, last_check_ok: true, review_verdict: 'PASS', review_verdicts: { claude: 'PASS', codex: 'PASS' }, commit: 'a1b2c3d4e5f6' },
        '1.1': { phase: 'done' }, '1.2': { phase: 'done' },
        '2': { phase: 'implementing', step: '實作中（Claude）', fix_round: 0, attempts: 1 },
      },
      runner: { pid: 4242, started_at: new Date(Date.now() - 95_000).toISOString() },
      task_gen: { status: 'done', count: 4 },
      task_approval: { revision: 'r3' },
    },
    guards: { 'prd.approve': 'PRD 已核准', 'prd.revise': '', 'prd.edit': '流程執行中', 'prd.review': '流程執行中', 'tasks.generate': 'PRD 已有任務', 'tasks.approve': '任務已核准', 'run.start': '流程執行中', 'project.settings': '流程執行中', 'task.rerun': '流程執行中', 'task.edit': '流程執行中', 'backlog.draft': '流程執行中', 'prd.references': '', 'tasks.references': '' },
  };
}

const backlog: BacklogItem[] = [
  { id: '0aff2c310e', title: '報表可以匯出 CSV', detail: '分析師需要把報表帶到 **Excel**。', status: 'in_progress', references: ['ref-1'], lock: '這項需求已產生目前的 PRD，不能再修改', created_at: now(), updated_at: now() },
  { id: '1bcc3d421f', title: '通知中心', detail: '', status: 'open', references: [], created_at: now(), updated_at: now() },
  { id: '2cdd4e532a', title: '深色模式', detail: '跟隨系統。', status: 'open', references: [], created_at: now(), updated_at: now() },
];

const chats: ChatSession[] = [
  { id: 'chat-1', title: '目前進度？', status: 'done', updated_at: now(), provider: 'claude', messages: [
    { id: 'm1', role: 'user', text: '目前專案執行到哪裡？', at: now() },
    { id: 'm2', role: 'assistant', provider: 'claude', text: '目前在 **任務 2**：報表頁匯出按鈕。\n\n```mermaid\nflowchart TD\n  A[任務 1 完成] --> B[任務 2 實作中]\n  B --> C[任務 3 待辦]\n```', at: now() },
  ] },
];

const references: ReferenceItem[] = [
  { id: 'ref-1', name: 'spec.md', kind: 'file', sourcePath: 'C:\\docs\\spec.md', fileCount: 1, totalBytes: 2048, excludedCount: 0, warnings: [] },
  { id: 'ref-2', name: 'design', kind: 'folder', sourcePath: 'C:\\docs\\design', fileCount: 12, totalBytes: 204800, excludedCount: 3, warnings: [] },
];

const skills: Skill[] = [
  { name: 'grill-me', description: '以決策樹釐清需求，每輪把能問的問題一次問完', compatible: true, hasBuiltin: true, text: '---\nname: grill-me\ndescription: 釐清需求\n---\n# Grill me\n每輪提出 1–4 個問題。', body: '# Grill me\n每輪提出 1–4 個問題。', files: [] },
  { name: 'to-spec', description: '把需求寫成 PRD', compatible: true, hasBuiltin: true, text: '---\nname: to-spec\ndescription: 寫 PRD\n---\n# To spec', body: '# To spec', files: [] },
  { name: 'tdd', description: '紅→綠循環', compatible: true, hasBuiltin: true, dir: 'C:\\Users\\me\\.ai-workflow\\skills\\tdd', text: '---\nname: tdd\n---\n# TDD', body: '# TDD', files: [{ path: 'SKILL.md', bytes: 120 }] },
  { name: 'my-deploy', description: '部署流程', compatible: false, extensions: ['allowed-tools'], text: '---\nname: my-deploy\nallowed-tools: Bash\n---\n# Deploy', body: '# Deploy', dir: 'C:\\skills\\my-deploy', files: [{ path: 'SKILL.md', bytes: 80 }, { path: 'scripts/deploy.sh', bytes: 400 }] },
];
const skillRuns: SkillRun[] = [
  { id: 'run-1', name: 'grill-me', status: 'done', provider: 'claude', created_at: now(), updated_at: now(), messages: [{ role: 'user', text: '我想做匯出報表', at: now() }, { role: 'assistant', text: '1. 誰會用？\n2. 格式？', at: now() }] },
];

const projects: ProjectsPayload = {
  projects: [
    { id: PID, name: 'my-app', path: 'C:\\code\\my-app', status: 'running', attention: false, feature: '報表匯出 CSV', progress: { done: 1, total: 4 } },
    { id: PID2, name: 'api-server', path: 'C:\\code\\api-server', status: 'waiting', attention: true, feature: '通知中心', reason: '任務 3 等待人工測試', progress: { done: 2, total: 5 } },
  ],
  queue: { max: 1, running: [{ root: 'C:\\code\\my-app' }], waiting: [{ root: 'C:\\code\\api-server' }] },
};

const logs: Record<string, string> = {
  runner: `[10:00:01] ═══ 任務 1：新增匯出 API 端點 ═══\n[10:00:02] ── 實作：claude（可編輯）開始，session abc ──\n[10:00:05] 🔧 Read src/api/export.ts\n[10:00:09] 🔧 Edit src/api/export.ts\n[10:00:20] 完成實作\n[10:01:30] ── 實作：完成（88s） ──\n[10:01:31] $ npm test\n[10:01:50] test：通過\n[10:02:00] ═══ 任務 2：報表頁匯出按鈕 ═══\n[10:02:01] ── 實作：claude（可編輯）開始 ──\n[10:02:05] 🔧 Read src/pages/report.tsx\n[10:02:30] ⚠ 找不到日期元件，改用原生 input`,
  prd: '[09:00:00] ── PRD 起草：claude（唯讀）開始 ──\n[09:00:30] 🔧 Read docs/spec.md\n[09:03:00] ── PRD 起草：完成（180s） ──',
  tasks: '[09:30:00] ── 拆任務：claude（唯讀）開始 ──\n[09:31:00] ── 拆任務：完成（60s） ──',
  process: '',
  'task-1': '[10:00:02] ── 實作：claude（可編輯）開始 ──\n[10:00:05] 🔧 Read src/api/export.ts\n[10:01:30] ── 實作：完成（88s） ──',
  'task-2': '[10:02:01] ── 實作：claude（可編輯）開始 ──\n[10:02:05] 🔧 Read src/pages/report.tsx',
};

const diff = `diff --git a/src/api/export.ts b/src/api/export.ts
new file mode 100644
--- /dev/null
+++ b/src/api/export.ts
@@ -0,0 +1,6 @@
+export function exportCsv(rows: string[][]) {
+  return rows.map((r) => r.join(',')).join('\\n');
+}
+
+export const BOM = '\\uFEFF';
+
diff --git a/src/pages/report.tsx b/src/pages/report.tsx
--- a/src/pages/report.tsx
+++ b/src/pages/report.tsx
@@ -10,7 +10,8 @@ export function Report() {
   const data = useReport();
-  return <Table data={data} />;
+  const onExport = () => download(exportCsv(data));
+  return <><Button onClick={onExport}>匯出 CSV</Button><Table data={data} /></>;
 }
`;

function taskDetail(id: string): TaskDetail {
  const snap = snapshot();
  const [parentId, subId] = id.split('.');
  const parent = snap.tasks.find((t) => String(t.id) === parentId);
  if (!parent) throw new Error('找不到這個任務');
  const task = subId ? { ...parent.subtasks!.find((s) => String(s.id) === subId)!, id, parent } : parent;
  return {
    id, revision: snap.taskRevision, tag: snap.taskTag, state: snap.state.tasks[id] || null, task: task as TaskDetail['task'],
    checks: parentId === '1' ? '$ npm test\n\n> my-app@1.0.0 test\n\n PASS  src/api/export.test.ts\nTests: 3 passed' : '',
    diff: parentId === '1' ? diff : '', implement: parentId === '1' ? '已新增 `/api/export` 與 CSV 產生器，測試通過。' : '',
    log: logs[`task-${parentId}`] || '',
    reviews: parentId === '1' ? [
      { name: 'review-1-claude.md', round: 1, provider: 'claude', text: '## 審查\n[建議] 加上檔名日期\n\nVERDICT: PASS' },
      { name: 'review-1-codex.md', round: 1, provider: 'codex', text: '## Review\n[P2] consider streaming\n\nVERDICT: PASS' },
    ] : [],
  };
}

let tick = 0;
setInterval(() => {
  tick++;
  const line = `\n[10:0${tick % 10}:${String(tick % 60).padStart(2, '0')}] 🔧 Read src/pages/report.tsx（第 ${tick} 次）`;
  logs.runner += line; logs['task-2'] += line;
  emit(`log-${PID}`, { scope: 'runner', text: line });
  emit(`log-${PID}`, { scope: 'task-2', text: line });
}, 4000);

async function handleApi(method: string, path: string, body: Record<string, unknown> | null): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 60));
  const clean = path.split('?')[0];
  if (method === 'GET') {
    if (clean === '/api/projects') return projects;
    if (clean === '/api/config') return { config, home: 'C:\\Users\\me\\.ai-workflow', text: JSON.stringify(config, null, 2), queue: projects.queue };
    if (clean === '/api/models') return models;
  }
  const p = clean.match(/^\/api\/p\/([0-9a-f]{10})\/(.+)$/);
  const rest = p ? p[2] : clean.replace(/^\/api\//, '');
  if (method === 'GET') {
    if (rest === 'state') return snapshot();
    if (rest === 'prd') { const s = snapshot(); return { prd, status: s.state.prd, rounds: s.state.prd.rounds }; }
    if (rest === 'backlog') return { items: backlog, path: 'C:\\Users\\me\\.ai-workflow\\projects\\0123456789\\backlog.json' };
    if (rest === 'chats') return { items: chats.map(({ messages: _m, ...c }) => c as ChatSummary) };
    if (rest.startsWith('chat/')) return chats.find((c) => c.id === decodeURIComponent(rest.slice(5))) || Promise.reject(new Error('找不到對話'));
    if (rest.startsWith('requirements/')) return { session: { id: 'req-1', status: 'done', messages: [{ role: 'assistant', text: '1. 誰會使用匯出？\n2. 需要哪些欄位？', at: now() }], requirementsReady: true, requirementsSummary: '# 需求摘要\n- 分析師匯出 CSV\n- 可選日期範圍' }, confirmed: false, stale: false };
    if (rest === 'references') return { items: references };
    if (rest === 'usage') return snapshot().usage;
    if (rest === 'skills') return { skills, stages: ['interview', 'prd', 'prd_review', 'tasks', 'implement', 'code_review', 'fix', 'handover'], config: config.skills };
    if (rest === 'skills/runs') return { runs: skillRuns };
    if (rest === 'models') return models;
    if (rest === 'graph') return { exists: true, stats: { files: 42, nodes: 310, edges: 520, communities: 6 }, builtAt: now(), commit: 'a1b2c3d4e5', paths: { report: 'C:\\...\\GRAPH_REPORT.md' }, report: '# 專案圖譜\n\n## 分群\n- api（12 個檔案）\n- pages（20 個檔案）', html: '<!doctype html><html><body style="font-family:sans-serif;padding:20px">互動圖（預覽）</body></html>' };
    if (rest === 'archive') return { items: [{ name: '2026-10-20-login-oauth', feature: '登入 OAuth', progress: { done: 3, total: 3 }, completed_at: now() }], dir: 'C:\\Users\\me\\.ai-workflow\\projects\\0123456789\\archive' };
    if (rest.startsWith('archive/')) return { name: decodeURIComponent(rest.slice(8)), path: 'C:\\...\\archive\\2026-10-20-login-oauth', meta: { feature: '登入 OAuth', approved_at: now(), completed_at: now(), tm_tag: 'login-oauth', progress: { done: 3, total: 3 } }, prd: '# PRD：登入 OAuth\n\n舊功能的 PRD。', rounds: [{ name: '1-draft-claude.md', text: '初稿' }, { name: '1-review-codex-approve.md', text: 'VERDICT: APPROVE' }], tasks: [{ id: 1, title: 'OAuth 回呼', status: 'done', priority: 'high' }] };
    if (rest.startsWith('task/')) return taskDetail(rest.slice(5));
    if (rest.startsWith('log/')) return { text: logs[rest.slice(4)] || '' };
    throw new Error(`mock：沒有 GET ${clean}`);
  }
  // POST
  const b = body || {};
  switch (rest) {
    case 'projects/add': return { project: { id: 'ffffffffff', name: String(b.path).split(/[\\/]/).pop() }, needs_init: false, path: b.path };
    case 'projects/remove': return { removed: true };
    case 'projects/open': return { ok: true };
    case 'queue/config': projects.queue.max = Number(b.max); return { queue: projects.queue };
    case 'config/mode': config.mode = b.mode as GlobalConfig['mode']; return { config };
    case 'config/models': Object.assign(config, { roles: b.roles, models: b.models }); return { config };
    case 'config/runtime': config.runtime = b.runtime as GlobalConfig['runtime']; return { config };
    case 'config/limits': Object.assign(config, b); return { config };
    case 'config/token_saving': config.token_saving = b.token_saving as GlobalConfig['token_saving']; return { config };
    case 'config/project': return { config: { ...config, ...b } };
    case 'skills/config': config.skills = (b.skills as GlobalConfig['skills']); return { config };
    case 'doctor': return { lines: ['Windows', '  claude 2.1.0（已登入）', '  codex 0.60（已登入）', 'WSL', '  未安裝'] };
    case 'usage/refresh': return snapshot().usage;
    case 'graph/build': return handleApi('GET', path.replace('graph/build', 'graph'), null);
    case 'backlog/add': { const item: BacklogItem = { id: Math.random().toString(16).slice(2, 12), title: String(b.title), detail: String(b.detail || ''), status: 'open', references: (b.references as string[]) || [], created_at: now(), updated_at: now() }; backlog.push(item); return { item }; }
    case 'backlog/update': { const item = backlog.find((i) => i.id === b.id); if (item) Object.assign(item, { title: b.title, detail: b.detail, updated_at: now() }); return { item }; }
    case 'backlog/delete': { const i = backlog.findIndex((x) => x.id === b.id); if (i >= 0) backlog.splice(i, 1); return { items: backlog }; }
    case 'backlog/reorder': { const ids = b.ids as string[]; backlog.sort((x, y) => ids.indexOf(x.id) - ids.indexOf(y.id)); return { items: backlog }; }
    case 'backlog/interview': return { session: { id: 'req-1', status: 'done', messages: [{ role: 'assistant', text: '1. 誰會使用匯出？', at: now() }, ...(b.input ? [{ role: 'user', text: String(b.input), at: now() }, { role: 'assistant', text: '了解。還有：欄位要可選嗎？', at: now() }] : [])], requirementsReady: !!b.input, requirementsSummary: '# 需求摘要\n- 分析師匯出 CSV' }, confirmed: false, stale: false };
    case 'backlog/confirm': return { session: { id: 'req-1', status: 'done', messages: [], requirementsReady: true, confirmedSummary: b.summary }, confirmed: true };
    case 'backlog/draft': return { ok: true };
    case 'chat/send': { const id = (b.chatId as string) || `chat-${chats.length + 1}`; let s = chats.find((c) => c.id === id); if (!s) { s = { id, title: String(b.input).slice(0, 30), status: 'running', provider: b.provider as 'claude', messages: [], updated_at: now() }; chats.unshift(s); } s.status = 'running'; s.turn = `t${Date.now()}`; s.messages.push({ id: `m${Date.now()}`, role: 'user', text: String(b.input), at: now(), references: b.references as string[] }); setTimeout(() => { s!.status = 'done'; s!.messages.push({ id: `m${Date.now()}`, role: 'assistant', provider: 'claude', text: `（假回覆）你問的是：${b.input}`, at: now() }); }, 2500); return s; }
    case 'chat/cancel': { const s = chats.find((c) => c.id === b.chatId); if (s) { s.status = 'cancelled'; s.cancelRequested = true; } return s; }
    case 'chat/rename': { const s = chats.find((c) => c.id === b.chatId); if (s) s.title = String(b.title); return s; }
    case 'chat/delete': { const i = chats.findIndex((c) => c.id === b.chatId); if (i >= 0) chats.splice(i, 1); return { ok: true }; }
    case 'references/import': { const item: ReferenceItem = { id: `ref-${Date.now()}`, name: String(b.name || String(b.path).split(/[\\/]/).pop()), kind: 'file', sourcePath: String(b.path || b.name), fileCount: 1, totalBytes: 1024, excludedCount: 0, warnings: [] }; references.push(item); return item; }
    case 'references/suggest': return { items: [{ name: 'README.md', kind: 'file', path: 'C:\\code\\my-app\\README.md' }, { name: 'docs', kind: 'folder', path: 'C:\\code\\my-app\\docs' }].filter((i) => i.name.toLowerCase().includes(String(b.query || '').toLowerCase())) };
    case 'references/assign': return { ok: true };
    case 'permissions/answer': return { ok: true };
    case 'prd/save': return { ok: true, version: 4 };
    case 'prd/dismiss_error': prdError = ''; return { ok: true };
    case 'prd/approve': case 'prd/revise': case 'prd/review': case 'prd/new': case 'tasks/generate': case 'tasks/approve': case 'task/save': case 'task/accept': case 'task/rerun': case 'run/start': case 'run/pause': case 'run/continue': return { ok: true };
    case 'skills/import': return { skill: { name: 'imported-skill', compatible: true } };
    case 'skills/save': return { skill: { name: 'my-skill' } };
    case 'skills/delete': return { restored: false };
    case 'skills/run': { const run: SkillRun = { id: `run-${Date.now()}`, name: String(b.name), status: 'running', provider: b.provider as 'claude', previousId: b.previousId as string, created_at: now(), updated_at: now(), messages: [{ role: 'user', text: String(b.input), at: now() }] }; skillRuns.unshift(run); setTimeout(() => { run.status = 'done'; run.messages!.push({ role: 'assistant', text: '（假回覆）1. 使用者是誰？', at: now() }); }, 2000); return run; }
    default: throw new Error(`mock：沒有 POST ${clean}`);
  }
}

export const mockBridge = {
  async invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    if (cmd === 'api') return handleApi(String(args?.method), String(args?.path), (args?.body as Record<string, unknown>) ?? null) as Promise<T>;
    if (cmd === 'watch_project') return undefined as T;
    if (cmd === 'pick_folder' || cmd === 'pick_skill_folder' || cmd === 'pick_reference_folder') return null as T;
    if (cmd === 'pick_reference_files') return [] as T;
    throw new Error(`mock：沒有 command ${cmd}`);
  },
  async listen<T>(event: string, handler: Handler<T>) {
    const set = listeners.get(event) || new Set();
    set.add(handler as Handler<unknown>);
    listeners.set(event, set);
    return () => { set.delete(handler as Handler<unknown>); };
  },
};

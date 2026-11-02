const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function page() {
  const dom = new JSDOM(fs.readFileSync('src/index.html', 'utf8'), {
    url: 'https://ai-workflow.test/index.html?p=0123456789', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.__TAURI__ = { core: { invoke: async () => ({}) } };
  const common = fs.readFileSync('src/common.js', 'utf8');
  const chat = ['markdown.js', 'diagrams.js', 'references.js', 'chat.js', 'diffview.js', 'human.js'].map(name => fs.readFileSync(`src/${name}`, 'utf8')).join('\n');
  const app = fs.readFileSync('src/app.js', 'utf8').split('\nbind();')[0];
  w.eval(`${common}\n${chat}\n${app}\nwindow.ui = {
    bindReferences, bindReferenceInput, renderReferenceWidgets, openReferenceDialog, referenceDraft, saveReferenceSelection,
    setReferenceDraft(key, ids) { referenceDrafts.set(key, ids); },
    catalog(items) { referenceCatalog = new Map(items.map(item => [item.id, item])); },
    bind, parseLog, renderLogTree, setLogTreeOpen, renderProjectSettings, saveProjectSettings,
    openArchive, openCurrent, renderRecords, reviewsView,
    setSnap(value) { snap = value; },
    setApi(fn) { api = fn; },
    setArchive(value) { recArchive = value; },
    archive() { return recArchive; }, renderUsage, runAction, renderPrd,
    renderBoard, boardFacts, selectTask, renderTaskGates,
    sendChat, openChat, newChat, renderChatMessages, renderChatMarkdown,
    setChat(value) { chatId = value?.id || null; chatSession = value; chatMessagesKey = ''; renderChatMessages(); renderChatControls(); },
    chat() { return chatSession; },
    renderHumanControls, editHumanPrd, editHumanTask, approveHumanPrd, openInterview,
    parseUnifiedDiff, splitRows, diffView,
    renderPermissions,
    renderBacklog, setBacklog(value) { backlog = value; },
    setDetail(value) { detail = value; },
    bindSkills, loadSkills, loadSkillRuns, selectSkill, renderSkills, importSkillFolders, sendSkill, skillFrontmatter,
    skillState() { return { selected: skillSelected, runId: skillRunId, editing: skillEditing, bindings: skillBindings }; },
    setLog(scope, text) { logs[scope] = text; }
  };`);
  return { dom, w, ui: w.ui, doc: w.document };
}
/** 總覽頁（含全域設定）。 */
function settingsPage() {
  const dom = new JSDOM(fs.readFileSync('src/overview.html', 'utf8'), {
    url: 'https://ai-workflow.test/overview.html', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.__TAURI__ = { core: { invoke: async () => ({}) } };
  const common = fs.readFileSync('src/common.js', 'utf8');
  const settings = fs.readFileSync('src/settings.js', 'utf8');
  w.eval(`${common}\n${settings}\nwindow.ui = {
    renderSettings, renderModels, bindSettings, loadSettings, effortsFor,
    setConfig(value) { globalConfig = value; },
    setModels(value) { modelOptions = value; },
    draft() { return modelDraft; },
    setApi(fn) { api = fn; },
  };`);
  return { dom, w, ui: w.ui, doc: w.document };
}
const snapshot = () => ({ config: {
  feature: '測試功能', roles: { author: 'claude', reviewer: 'both', implementer: 'claude', code_reviewer: 'both' },
  models: {}, runtime: {}, commands: { build: '', test: 'npm test', lint: '' }, context_files: ['docs/a.md'],
}, state: { prd: { status: 'approved' }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, tasks: [] });
const globalConfig = () => ({
  mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'ai-workflow/',
  roles: { interviewer: 'claude', author: 'claude', reviewer: 'both', task_planner: 'claude', implementer: 'claude', fixer: 'claude', code_reviewer: 'both', handover: 'claude', chat: 'claude' },
  models: {}, runtime: { claude: 'auto', codex: 'wsl' }, claude: {}, codex: {},
});

test('全域設定頁：九個角色排成 3×3 小卡，模型輸入在重畫後保留焦點、內容與待儲存值', () => {
  const { dom, ui, doc, w } = settingsPage();
  doc.querySelector('#overview-settings').hidden = false;
  ui.setConfig(globalConfig()); ui.renderSettings();
  const cards = doc.querySelectorAll('#role-models .role-card');
  assert.equal(cards.length, 9);
  assert.deepEqual([...cards].map(card => card.dataset.role), ['interviewer', 'author', 'reviewer', 'task_planner', 'implementer', 'fixer', 'code_reviewer', 'handover', 'chat']);
  assert.ok(doc.querySelector('#role-models').classList.contains('role-grid'));
  for (const card of cards) {
    assert.ok(card.querySelector('legend').textContent);
    assert.ok(card.querySelector('select.role-provider'));
    assert.ok(card.querySelector('.model-line input[role=combobox]'));
    assert.equal(card.querySelector('.model-line input').hasAttribute('list'), false);
    assert.ok(card.querySelector('.model-line select'));
  }
  // 只有兩個審查角色可以選雙人審查；雙人時顯示兩行模型。
  const both = [...cards].filter(card => [...card.querySelector('select.role-provider').options].some(option => option.value === 'both'));
  assert.deepEqual(both.map(card => card.dataset.role), ['reviewer', 'code_reviewer']);
  assert.equal(cards[2].querySelectorAll('.model-line').length, 2);
  assert.equal(cards[1].querySelectorAll('.model-line').length, 1);
  const input = cards[1].querySelector('.model-line input');
  input.focus(); input.value = 'custom-model';
  input.dispatchEvent(new w.Event('input'));
  ui.renderSettings();
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, 'custom-model');
  assert.equal(ui.draft().models.author.claude.model, 'custom-model');
  const reviewer = cards[2].querySelector('select.role-provider');
  reviewer.focus(); reviewer.value = 'codex';
  reviewer.dispatchEvent(new w.Event('change'));
  assert.equal(doc.querySelectorAll('#role-models .role-card')[2].querySelectorAll('.model-line').length, 1);
  // 模式、執行環境與流程參數都來自全域設定；頁面上沒有專案選單。
  assert.equal(doc.querySelector('[data-mode="manual"]').getAttribute('aria-checked'), 'true');
  assert.equal(doc.querySelector('#rt-codex').value, 'wsl');
  assert.equal(doc.querySelector('#limit-prefix').value, 'ai-workflow/');
  assert.equal(doc.querySelector('#settings-project'), null);
  assert.equal(doc.querySelector('#wsl-distro'), null);
  dom.window.close();
});

test('全域設定從 /api/config 讀取、儲存時只呼叫全域路由', async () => {
  const { dom, ui, doc } = settingsPage();
  const requests = [];
  ui.setApi(async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/config') return { config: globalConfig(), text: '{}', home: 'C:\\Users\\me\\.ai-workflow', queue: { max: 2, running: [], waiting: [] } };
    if (path === '/api/models') return { claude: { models: [] }, codex: { models: [], error: '' } };
    return { config: { ...globalConfig(), roles: { ...globalConfig().roles, author: 'codex' } } };
  });
  ui.bindSettings();
  await ui.loadSettings();
  assert.equal(requests[0].path, '/api/config');
  assert.equal(doc.querySelector('#max-runs').value, '2');
  assert.match(doc.querySelector('#config-path').textContent, /\.ai-workflow\\config\.json$/);
  const author = doc.querySelectorAll('#role-models .role-card')[1].querySelector('select.role-provider');
  author.value = 'codex'; author.dispatchEvent(new dom.window.Event('change'));
  await doc.querySelector('#btn-save-models').onclick();
  const save = requests.find(r => r.path === '/api/config/models');
  assert.equal(save.body.roles.author, 'codex');
  assert.equal(requests.some(r => /\/api\/p\//.test(r.path)), false);
  dom.window.close();
});

test('專案頁只剩這個專案的指令與 context 欄位，儲存只送專案欄位', async () => {
  const { dom, ui, doc } = page();
  assert.equal(doc.querySelector('#tab-settings'), null);
  assert.equal(doc.querySelector('#role-models'), null);
  const state = snapshot(); state.dataDir = 'C:\\Users\\me\\.ai-workflow\\projects\\0123456789';
  ui.setSnap(state); ui.bind(); ui.renderProjectSettings();
  assert.equal(doc.querySelector('#pc-test').value, 'npm test');
  assert.equal(doc.querySelector('#pc-context').value, 'docs/a.md');
  assert.match(doc.querySelector('#pc-data-dir').textContent, /\.ai-workflow/);
  let request;
  ui.setApi(async (path, body) => { request = { path, body }; return { config: { ...state.config, commands: body.commands } }; });
  doc.querySelector('#pc-lint').value = 'npm run lint';
  doc.querySelector('#pc-context').value = 'docs/a.md\n\nREADME.md';
  await ui.saveProjectSettings();
  assert.equal(request.path, '/api/config/project');
  assert.deepEqual(JSON.parse(JSON.stringify(request.body)), { commands: { build: '', test: 'npm test', lint: 'npm run lint' }, feature: '測試功能', context_files: ['docs/a.md', 'README.md'] });
  dom.window.close();
});

test('看板的功能參考與專案指令收在對話框，不佔看板版面；取消會放棄未儲存的輸入', async () => {
  const { dom, ui, doc, w } = page();
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const state = snapshot(); state.root = 'C:/p'; state.state.prd.rounds = [];
  state.tasks = [{ id: 1, title: '登入', status: 'pending' }]; state.taskReferences = ['r1', 'r2'];
  ui.setSnap(state); ui.bind(); ui.renderBoard();
  // 兩塊內容都在對話框裡，預設關閉；按鈕顯示參考數量。
  assert.ok(doc.querySelector('#board-refs-dialog #board-references'));
  assert.ok(doc.querySelector('#project-settings-dialog #pc-build'));
  assert.equal(doc.querySelector('#board-refs-dialog').open, false);
  assert.equal(doc.querySelector('.project-settings-card'), null);
  assert.equal(doc.querySelector('#btn-board-refs').textContent.trim(), '參考 2');
  doc.querySelector('#btn-board-refs').click();
  assert.equal(doc.querySelector('#board-refs-dialog').open, true);
  doc.querySelector('#board-refs-dialog [data-close]').click();
  assert.equal(doc.querySelector('#board-refs-dialog').open, false);
  // 專案指令：改了沒儲存就取消，再打開時恢復原值；儲存成功會關閉對話框。
  doc.querySelector('#btn-project-settings').click();
  assert.equal(doc.querySelector('#project-settings-dialog').open, true);
  assert.equal(doc.querySelector('#pc-test').value, 'npm test');
  doc.querySelector('#pc-test').value = 'npm run broken'; doc.querySelector('#pc-test').dispatchEvent(new w.Event('input'));
  doc.querySelector('#project-settings-dialog [data-close]').click();
  doc.querySelector('#btn-project-settings').click();
  assert.equal(doc.querySelector('#pc-test').value, 'npm test');
  ui.setApi(async (path, body) => ({ config: { ...state.config, commands: body.commands } }));
  doc.querySelector('#pc-lint').value = 'npm run lint'; doc.querySelector('#pc-lint').dispatchEvent(new w.Event('input'));
  await ui.saveProjectSettings();
  assert.equal(doc.querySelector('#project-settings-dialog').open, false);
  dom.window.close();
});

test('紀錄方向鍵只切換紀錄子頁，不改變任務詳情子頁', () => {
  const { dom, ui, doc, w } = page();
  doc.querySelector('#tab-records').hidden = false;
  ui.setSnap(snapshot()); ui.bind(); ui.renderRecords();
  const log = doc.querySelector('[data-rec="log"]');
  log.focus();
  log.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(doc.activeElement.dataset.rec, 'prd');
  assert.equal(doc.querySelector('[data-rec="prd"]').getAttribute('aria-selected'), 'true');
  dom.window.close();
});

test('可展開 log 解析工具與完成狀態，重畫保留手動收合', () => {
  const { dom, ui, doc } = page();
  const text = '[12:00:00] ── 實作：claude（可編輯）開始 ──\n🔧 Read file.rs\n[12:00:02] ── 實作：完成（2s） ──';
  const box = doc.querySelector('#rec-body');
  ui.renderLogTree(box, text);
  assert.equal(box.querySelectorAll('details.done').length, 1);
  assert.equal(box.querySelector('.lg-tool-name').textContent, 'Read');
  ui.setLogTreeOpen(box, true); ui.renderLogTree(box, text);
  assert.equal(box.querySelector('details').open, true);
  ui.setLogTreeOpen(box, false); ui.renderLogTree(box, text);
  assert.equal(box.querySelector('details').open, false);
  dom.window.close();
});

test('慢速封存回應不覆蓋後來選取的目前功能', async () => {
  const { dom, ui } = page();
  ui.setSnap(snapshot());
  let resolve;
  ui.setApi(() => new Promise(done => { resolve = done; }));
  const pending = ui.openArchive('old');
  ui.openCurrent();
  resolve({ name: 'old', meta: {}, rounds: [], tasks: [] });
  await pending;
  assert.equal(ui.archive(), null);
  dom.window.close();
});

test('雙人審查按輪次分開顯示兩份意見', () => {
  const { dom, ui } = page();
  const view = ui.reviewsView([
    { round: 1, provider: 'claude', text: 'VERDICT: PASS' },
    { round: 1, provider: 'codex', text: 'VERDICT: FAIL' },
  ]);
  assert.equal(view.querySelectorAll('.review-pair.cols-2').length, 1);
  assert.equal(view.querySelectorAll('.review-col').length, 2);
  dom.window.close();
});

test('未知 context 隱藏，已有數據才顯示', () => {
  const { dom, ui, doc } = page();
  const usage = { providers: [{ provider: 'codex', latest: {} }], recent: [] };
  ui.renderUsage(usage);
  assert.doesNotMatch(doc.querySelector('#usage-providers').textContent, /context 剩餘|容量與占用資料/);
  usage.providers[0].latest.context = { remainingPercent: 50, remainingTokens: 100, capacity: 200 };
  ui.renderUsage(usage);
  assert.match(doc.querySelector('#usage-providers').textContent, /50.0%/);
  dom.window.close();
});

test('額度切換先確認，取消不執行，同意僅帶本次 provider', async () => {
  const { dom, ui, w } = page();
  const state = snapshot(); state.state.pipeline.status = 'stuck';
  state.state.usage_blocked = { provider: 'claude' };
  ui.setSnap(state);
  let request;
  ui.setApi(async (path, body) => { request = { path, body }; return {}; });
  w.confirm = () => false;
  await ui.runAction('/api/run/start');
  assert.equal(request, undefined);
  w.confirm = () => true;
  await ui.runAction('/api/run/start');
  assert.equal(request.path, '/api/run/continue');
  assert.equal(request.body.useProvider, 'codex');
  assert.equal(state.config.roles.code_reviewer, 'both');
  dom.window.close();
});

test('PRD 僅在拆任務失敗時顯示重試，不再有新想法表單', () => {
  const { dom, ui, doc } = page();
  const state = snapshot(); state.state.prd.status = 'approved';
  ui.setSnap(state); ui.renderPrd();
  assert.equal(doc.querySelector('#idea'), null);
  assert.equal(doc.querySelector('#btn-tasks').hidden, true);
  state.state.task_gen = { status: 'error', error: 'failed' };
  ui.renderPrd();
  assert.equal(doc.querySelector('#btn-tasks').hidden, false);
  dom.window.close();
});

test('取消額度通知不啟動任務，也不清除額度紀錄', () => {
  const { dom, ui, doc } = page();
  const state = snapshot(); state.state.usage_blocked = { provider: 'claude' };
  ui.setSnap(state); ui.bind();
  doc.querySelector('#quota-cancel').click();
  assert.equal(doc.querySelector('#quota-notice').hidden, true);
  assert.equal(state.state.usage_blocked.provider, 'claude');
  dom.window.close();
});

test('搜尋與篩選保留完整任務資料，依賴包含子任務完成狀態', () => {
  const { dom, ui, doc } = page();
  const state = snapshot();
  state.tasks = [{ id: 1, title: '登入', status: 'done' }, { id: 2, title: '匯出', dependencies: [1, '3.1'], status: 'pending' }, { id: 3, title: '報表', subtasks: [{ id: 1, title: '查詢資料', status: 'done' }] }];
  ui.setSnap(state); ui.renderBoard();
  assert.equal(ui.boardFacts().unmet(state.tasks[1]).length, 0);
  doc.querySelector('#board-search').value = '查詢'; ui.renderBoard();
  assert.equal(doc.querySelectorAll('#board .task').length, 1);
  assert.equal(doc.querySelector('#board .title').textContent, '報表');
  doc.querySelector('#board-search').value = '找不到'; ui.renderBoard();
  assert.equal(doc.querySelector('#board-empty').hidden, false);
  assert.equal(state.tasks.length, 3);
  dom.window.close();
});

test('藍圖可從鍵盤切換，子任務可開啟詳情並在關閉後恢復焦點', async () => {
  const { dom, ui, doc, w } = page();
  doc.querySelector('#tab-board').hidden = false;
  const state = snapshot();
  state.tasks = [{ id: 1, title: '安全 <img src=x onerror=alert(1)>', subtasks: [{ id: 1, title: '子任務', status: 'pending' }] }];
  ui.setSnap(state); ui.bind(); ui.renderBoard();
  const view = doc.querySelector('#board-view-kanban'); view.focus();
  view.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(doc.querySelector('#task-roadmap').hidden, false);
  assert.equal(doc.querySelector('#task-roadmap img'), null);
  ui.setApi(async () => ({ id: '1.1', task: { id: '1.1', title: '子任務' }, state: {}, log: '', reviews: [] }));
  await ui.selectTask('1.1');
  assert.equal(doc.querySelector('#d-title').textContent, '#1.1 子任務');
  doc.querySelector('#d-close').click();
  assert.equal(doc.activeElement.dataset.taskId, '1.1');
  dom.window.close();
});

test('自動完成與未設定驗證指令不會顯示成已人工驗收或驗證通過', () => {
  const { dom, ui, doc } = page();
  const state = snapshot(); state.state.pipeline.status = 'feature_test';
  state.config.commands = { build: '', test: '', lint: '' };
  ui.setSnap(state);
  ui.renderTaskGates({ id: 1, status: 'done' }, { phase: 'done', last_check_ok: true, review_verdict: 'PASS' });
  assert.match(doc.querySelector('#d-gates').textContent, /未設定驗證指令/);
  assert.match(doc.querySelector('#d-gates').textContent, /等待人工確認/);
  assert.equal(doc.querySelectorAll('#d-gates .gate-pass').length, 2);
  dom.window.close();
});

test('慢速任務詳情回應不覆蓋後來選取的任務', async () => {
  const { dom, ui, doc } = page();
  ui.setSnap(snapshot());
  const resolvers = {};
  ui.setApi(path => new Promise(resolve => { resolvers[path] = resolve; }));
  const first = ui.selectTask('1'); const second = ui.selectTask('2');
  resolvers['/api/task/2']({ id: '2', task: { title: 'second' }, state: {}, log: '', reviews: [] }); await second;
  resolvers['/api/task/1']({ id: '1', task: { title: 'first' }, state: {}, log: '', reviews: [] }); await first;
  assert.equal(doc.querySelector('#d-title').textContent, '#2 second');
  dom.window.close();
});

test('專案對話只呼叫聊天 API，不啟動 PRD 或任務；失敗仍保留輸入', async () => {
  const { dom, ui, doc } = page(); ui.setSnap(snapshot()); ui.bind();
  doc.querySelector('#chat-input').value = '目前進度如何？';
  const requests = [];
  ui.setApi(async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/chat/send') return { id: 'chat1', title: '進度', status: 'done', messages: [{ id: 'u1', role: 'user', text: body.input }, { id: 'a1', role: 'assistant', text: '**正在測試**', provider: 'codex' }] };
    return { items: [] };
  });
  await ui.sendChat();
  assert.equal(requests[0].path, '/api/chat/send');
  assert.equal(requests.some(request => /prd|run\/start|tasks\/generate/.test(request.path)), false);
  assert.equal(doc.querySelector('.from-ai strong').textContent, '正在測試');
  assert.equal(doc.querySelector('#chat-input').value, '');
  doc.querySelector('#chat-input').value = '保留這個問題';
  ui.setApi(async () => { throw new Error('CLI unavailable'); });
  await ui.sendChat(); assert.equal(doc.querySelector('#chat-input').value, '保留這個問題');
  dom.window.close();
});

test('對話切換保存草稿，原始 HTML 不會執行', async () => {
  const { dom, ui, doc } = page(); ui.setSnap(snapshot()); ui.bind();
  doc.querySelector('#chat-input').value = '新對話草稿';
  ui.setApi(async () => ({ id: 'old', title: '舊對話', status: 'done', messages: [{ id: 'u', role: 'user', text: '<img src=x onerror=alert(1)>' }, { id: 'a', role: 'assistant', text: '<script>alert(1)</script>' }] }));
  await ui.openChat('old'); assert.equal(doc.querySelector('#chat-messages img'), null); assert.equal(doc.querySelector('#chat-messages script'), null);
  doc.querySelector('#chat-input').value = '追問草稿'; ui.newChat();
  assert.equal(doc.querySelector('#chat-input').value, '新對話草稿');
  await ui.openChat('old'); assert.equal(doc.querySelector('#chat-input').value, '追問草稿');
  dom.window.close();
});

test('聊天的停止按鈕不會暫停專案任務', async () => {
  const { dom, ui, doc } = page(); ui.setSnap(snapshot()); ui.bind();
  const session = { id: 'active', title: '測試', status: 'running', turn: 'turn1', messages: [] }; ui.setChat(session);
  const calls = []; ui.setApi(async (path, body) => { calls.push(path); return { ...session, cancelRequested: true }; });
  await doc.querySelector('#chat-stop').onclick();
  assert.deepEqual(calls, ['/api/chat/cancel']); assert.equal(doc.querySelector('#chat-stop').disabled, true);
  dom.window.close();
});

test('Mermaid 使用 strict 模式繪圖，保留原始碼並且不把一般程式碼當成圖', async () => {
  const { dom, ui, doc, w } = page();
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  let configuration, rendered = 0;
  w.mermaid = { initialize(value) { configuration = value; }, async render() { rendered++; return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Architecture</text></svg>' }; } };
  const host = doc.createElement('div'); doc.body.append(host);
  await ui.renderChatMarkdown(host, '```mermaid\nflowchart LR\nA-->B\n```\n```js\nconst x=1;\n```');
  assert.equal(configuration.securityLevel, 'strict'); assert.equal(rendered, 1);
  assert.equal(host.querySelectorAll('svg').length, 1); assert.match(host.querySelector('.diagram-source').textContent, /A-->B/);
  assert.equal(host.querySelectorAll('pre[data-lang="js"]').length, 1);
  dom.window.close();
});


test('附件跟隨聊天草稿，只有附件也可傳送；失敗保留附件', async () => {
  const { dom, ui, doc } = page(); ui.setSnap(snapshot());
  const reference = { id: 'ref-image', name: '設計.png', kind: 'file' }; ui.catalog([reference]);
  ui.setReferenceDraft('chat:new', ['ref-image']); ui.renderReferenceWidgets();
  assert.match(doc.querySelector('#chat-references').textContent, /設計.png/);
  let request;
  ui.setApi(async (path, body) => { if (path === '/api/chat/send') { request = body; throw Error('無法啟動'); } return { items: [] }; });
  await ui.sendChat(); assert.deepEqual([...request.references], ['ref-image']);
  assert.deepEqual([...ui.referenceDraft('chat:new')], ['ref-image']);
  ui.setChat({id:'existing',messages:[],status:'done'}); ui.renderReferenceWidgets();
  assert.doesNotMatch(doc.querySelector('#chat-references').textContent, /設計.png/);
  ui.newChat(); assert.match(doc.querySelector('#chat-references').textContent, /設計.png/);
  dom.window.close();
});

test('參考資料取消不套用，套用和移除只影響選取的草稿', async () => {
  const { dom, ui, doc, w } = page(); ui.setSnap(snapshot());
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const reference = {id:'ref-1',name:'規格.md',kind:'file',fileCount:1,totalBytes:12,sourcePath:'C:/spec.md'};
  ui.catalog([reference]); ui.setApi(async () => ({items:[reference]}));
  await ui.openReferenceDialog({title:'需求參考',key:'backlog',ids:[]});
  const dialog=doc.querySelector('dialog.reference-dialog'); dialog.querySelector('input[type=checkbox]').click(); dialog.close();
  assert.equal(ui.referenceDraft('backlog').length,0);
  await ui.openReferenceDialog({title:'需求參考',key:'backlog',ids:[]});
  doc.querySelector('dialog.reference-dialog input[type=checkbox]').click(); doc.querySelector('[data-apply]').click();
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual([...ui.referenceDraft('backlog')],['ref-1']);
  doc.querySelector('#bl-references .reference-chip button').click(); await new Promise(r=>setTimeout(r,0));
  assert.equal(ui.referenceDraft('backlog').length,0); dom.window.close();
});

test('@ 選取專案檔案會加入快照，不會同時送出聊天', async () => {
  const { dom, ui, doc, w } = page(); ui.setSnap(snapshot());
  let sent=0;
  ui.setApi(async (path, body) => {
    if(path==='/api/references/suggest') return {items:[{name:'docs/spec.md',path:'C:/project/docs/spec.md',kind:'file'}]};
    if(path==='/api/references/import') return {id:'snapshot-1',name:'spec.md',kind:'file'};
    if(path==='/api/chat/send') sent++;
    return {items:[]};
  });
  ui.bindReferences(); const input=doc.querySelector('#chat-input');
  input.onkeydown=event=>{if(event.key==='Enter') sent++;};
  input.focus(); input.value='請看 @spec'; input.setSelectionRange(input.value.length,input.value.length); input.dispatchEvent(new w.Event('input'));
  await new Promise(r=>setTimeout(r,220));
  assert.ok(doc.querySelector('.reference-suggestions'));
  input.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true})); await new Promise(r=>setTimeout(r,0));
  assert.equal(sent,0); assert.match(input.value,/@spec.md/); assert.deepEqual([...ui.referenceDraft('chat:new')],['snapshot-1']);
  dom.window.close();
});


test('貼上圖片傳送真正檔案內容並建立附件，不只插入檔名', async () => {
  const { dom, ui, doc, w } = page(); ui.setSnap(snapshot());
  let uploaded;
  ui.setApi(async (path, body) => { if(path==='/api/references/import') { uploaded=body; return {id:'paste-1',name:body.name,kind:'file'}; } return {items:[]}; });
  ui.bindReferences();
  const event=new w.Event('paste',{bubbles:true,cancelable:true});
  Object.defineProperty(event,'clipboardData',{value:{files:[new w.File([new Uint8Array([137,80,78,71])],'clipboard.png',{type:'image/png'})]}});
  doc.querySelector('#chat-input').dispatchEvent(event); await new Promise(r=>setTimeout(r,30));
  assert.equal(uploaded.data,'iVBORw=='); assert.equal(uploaded.name,'clipboard.png');
  assert.deepEqual([...ui.referenceDraft('chat:new')],['paste-1']); assert.equal(event.defaultPrevented,true);
  dom.window.close();
});


test('原生拖放使用真實路徑，綁定到游標所在的聊天區域', async () => {
  const { dom, ui, doc, w } = page(); ui.setSnap(snapshot());
  let dropped; const paths=[];
  w.__TAURI__.webview={getCurrentWebview:()=>({onDragDropEvent: callback=>{dropped=callback;return Promise.resolve(()=>{});}})};
  doc.elementFromPoint=()=>doc.querySelector('#chat-input');
  ui.setApi(async (path,body)=>{if(path==='/api/references/import'){paths.push(body.path);return {id:`file-${paths.length}`,name:body.path,kind:'file'};} return {items:[]};});
  ui.bindReferences();
  await dropped({payload:{type:'drop',paths:['C:/external/設計.png','C:/external/source'],position:{x:100,y:100}}});
  assert.deepEqual(paths,['C:/external/設計.png','C:/external/source']);
  assert.deepEqual([...ui.referenceDraft('chat:new')],['file-1','file-2']);
  assert.equal(ui.referenceDraft('backlog').length,0); dom.window.close();
});

// jsdom 視窗裡建立的物件和測試程序不是同一個 realm，deepEqual 前先轉成純資料。
const plain = value => JSON.parse(JSON.stringify(value));

test('任務要先人工核准才能開始，核准後開始按鈕解鎖，內容改版後核准失效', async () => {
  const { dom, ui, doc } = page();
  const base = snapshot(); base.root = 'C:/p'; base.state.prd.rounds = [];
  base.tasks = [{ id: 1, title: '登入', status: 'pending' }]; base.taskRevision = 'rev-1';
  ui.setSnap(base); ui.bind(); ui.renderBoard();
  assert.equal(doc.querySelector('#btn-start').disabled, true);
  assert.equal(doc.querySelector('#btn-task-approve').disabled, false);
  assert.equal(doc.querySelector('#btn-task-approve').textContent, '檢視後核准任務');
  assert.match(doc.querySelector('#task-human-note').textContent, /單獨展示與手動測試.*依賴是否只列真正擋住它的任務.*核准後照清單順序執行/);
  const requests = [];
  const approved = { ...base, state: { ...base.state, task_approval: { revision: 'rev-1' } } };
  ui.setApi(async (path, body) => { requests.push({ path, body }); return path === '/api/state' ? approved : {}; });
  await doc.querySelector('#btn-task-approve').onclick();
  assert.deepEqual(plain(requests[0]), { path: '/api/tasks/approve', body: { revision: 'rev-1' } });
  assert.equal(doc.querySelector('#btn-start').disabled, false);
  assert.equal(doc.querySelector('#btn-task-approve').disabled, true);
  assert.equal(doc.querySelector('#btn-task-approve').textContent, '任務已核准');
  ui.setSnap({ ...approved, taskRevision: 'rev-2' }); ui.renderBoard();
  assert.equal(doc.querySelector('#btn-start').disabled, true);
  assert.equal(doc.querySelector('#btn-task-approve').disabled, false);
  dom.window.close();
});

test('需求待辦的「釐清需求」開啟 Grill Me 會議並以該需求啟動，不直接起草 PRD', async () => {
  const { dom, ui, doc, w } = page(); ui.setSnap(snapshot());
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const requests = [];
  // AI 訊息裡的 Mermaid 決策樹要和專案對話一樣畫成圖；Mermaid 本身用假物件。
  w.URL.createObjectURL = () => 'blob:test'; w.URL.revokeObjectURL = () => {};
  w.mermaid = { initialize() {}, async render() { return { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>tree</text></svg>' }; } };
  const session = { id: 's1', status: 'done', turn: 't1', requirementsReady: true, requirementsSummary: '已確認：**匯出 CSV**', messages: [{ role: 'user', text: '請先釐清 <b>x</b>' }, { role: 'assistant', text: '**問題一**\n```mermaid\nflowchart TD\nA-->B\n```' }] };
  ui.setApi(async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/requirements/item-1') return { item: { id: 'item-1', title: '匯出' }, session: null, stale: false, confirmed: false };
    if (path === '/api/backlog/interview') return { item: { id: 'item-1' }, session, stale: false, confirmed: false };
    if (path === '/api/backlog/confirm') return { item: { id: 'item-1' }, session: { ...session, confirmedSummary: body.summary }, stale: false, confirmed: true };
    return {};
  });
  await ui.openInterview('item-1');
  assert.equal(requests[0].path, '/api/requirements/item-1');
  assert.equal(requests[1].path, '/api/backlog/interview');
  assert.equal(requests[1].body.id, 'item-1');
  assert.equal(requests.some(r => /backlog\/draft|\/prd/.test(r.path)), false);
  const dialog = doc.querySelector('dialog.interview-dialog');
  assert.equal(dialog.querySelector('.from-ai strong').textContent, '問題一');
  assert.ok(dialog.querySelector('.from-ai .chat-diagram'), 'Mermaid 區塊應轉成圖表容器');
  await new Promise(r => setTimeout(r, 0));
  assert.match(dialog.querySelector('.from-ai .diagram-source').textContent, /A-->B/);
  assert.equal(dialog.querySelector('.from-user .md b'), null);
  assert.match(dialog.querySelector('.from-user .md').textContent, /<b>x<\/b>/);
  // 摘要在右側預覽（Markdown 渲染），「開始寫 PRD」要先確認摘要才出現。
  const panel = dialog.querySelector('.interview-summary');
  assert.equal(panel.hidden, false);
  assert.equal(panel.querySelector('textarea').hidden, true);
  assert.equal(panel.querySelector('.summary-preview strong').textContent, '匯出 CSV');
  assert.equal(panel.querySelector('[data-draft]').hidden, true);
  assert.equal(panel.querySelector('[data-confirm]').textContent, '確認需求摘要');
  panel.querySelector('[data-summary-view="edit"]').click();
  assert.equal(panel.querySelector('textarea').hidden, false);
  panel.querySelector('textarea').value = '已確認：匯出 CSV，含日期範圍'; panel.querySelector('textarea').dispatchEvent(new w.Event('input'));
  await panel.querySelector('[data-confirm]').onclick();
  const confirm = requests.find(r => r.path === '/api/backlog/confirm');
  assert.deepEqual(plain(confirm.body), { id: 'item-1', sessionId: 's1', turn: 't1', summary: '已確認：匯出 CSV，含日期範圍' });
  assert.equal(requests.some(r => r.path === '/api/backlog/draft'), false, '確認摘要不會直接起草');
  assert.equal(panel.querySelector('[data-confirm]').textContent, '已確認');
  assert.equal(panel.querySelector('[data-draft]').hidden, false);
  // 確認後再改摘要就要重新確認，起草按鈕先停用。
  panel.querySelector('textarea').value = '又改了一下'; panel.querySelector('textarea').dispatchEvent(new w.Event('input'));
  assert.equal(panel.querySelector('[data-confirm]').textContent, '重新確認摘要');
  assert.equal(panel.querySelector('[data-draft]').disabled, true);
  panel.querySelector('textarea').value = '已確認：匯出 CSV，含日期範圍'; panel.querySelector('textarea').dispatchEvent(new w.Event('input'));
  assert.equal(panel.querySelector('[data-draft]').disabled, false);
  await panel.querySelector('[data-draft]').onclick();
  assert.equal(requests.findIndex(r => r.path === '/api/backlog/draft') > requests.indexOf(confirm), true);
  assert.equal(doc.querySelector('dialog.interview-dialog'), null);
  dom.window.close();
});

test('人工編輯 PRD 以目前版本儲存，核准時帶版本避免核准到過期內容', async () => {
  const { dom, ui, doc, w } = page();
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const state = snapshot(); state.root = 'C:/p'; state.prd = '# 舊 PRD';
  state.state.prd = { status: 'awaiting_approval', version: 3, reference_scope: 'scope-a', rounds: [] };
  ui.setSnap(state); ui.bind(); ui.renderPrd();
  assert.equal(doc.querySelector('#btn-prd-edit').disabled, false);
  assert.equal(doc.querySelector('#btn-prd-review').disabled, false);
  const requests = [];
  ui.setApi(async (path, body) => { requests.push({ path, body }); return path === '/api/state' ? state : {}; });
  ui.editHumanPrd();
  const dialog = doc.querySelector('dialog.human-dialog');
  const input = dialog.querySelector('textarea'); input.value = '# 新 PRD'; input.dispatchEvent(new w.Event('input'));
  assert.match(dialog.querySelector('.human-preview').textContent, /新 PRD/);
  await dialog.querySelector('[data-save]').onclick();
  assert.deepEqual(plain(requests[0]), { path: '/api/prd/save', body: { text: '# 新 PRD', version: 3, scope: 'scope-a' } });
  assert.equal(doc.querySelector('dialog.human-dialog'), null);
  await ui.approveHumanPrd();
  assert.deepEqual(plain(requests.find(r => r.path === '/api/prd/approve').body), { version: 3, scope: 'scope-a' });
  dom.window.close();
});

test('AI 工作中的狀態文字會顯示持續時間，結束後不再顯示', () => {
  const { dom, ui, doc } = page(); ui.setSnap(snapshot()); ui.bind();
  const started = new Date(Date.now() - 65000).toISOString();
  ui.setChat({ id: 'c1', title: '測試', status: 'running', turn: 't1', messages: [{ id: 'u1', role: 'user', text: '分析專案', at: started }] });
  assert.match(doc.querySelector('#chat-status').textContent, /已 1 分 \d 秒/);
  assert.match(doc.querySelector('.chat-activity summary').textContent, /正在回覆.*已 1 分/);
  ui.setChat({ id: 'c1', title: '測試', status: 'done', turn: 't1', messages: [{ id: 'u1', role: 'user', text: '分析專案', at: started }, { id: 'a1', role: 'assistant', text: '完成' }] });
  assert.doesNotMatch(doc.querySelector('#chat-status').textContent, /已 /);
  assert.equal(doc.querySelector('#chat-status').dataset.since, undefined);
  const state = snapshot(); state.root = 'C:/p'; state.prdBusy = true; state.state.prd = { status: 'drafting', rounds: [], started_at: started };
  ui.setSnap(state); ui.renderPrd();
  assert.match(doc.querySelector('#prd-busy').textContent, /AI 處理中.*已 1 分/);
  dom.window.close();
});

// ---------- Skills 頁 ----------
const skillFixture = () => ({
  stages: ['prd', 'prd_review', 'tasks', 'implement', 'code_review', 'fix', 'handover'],
  config: { implement: ['uiux-design'] },
  skills: [
    { name: 'grill-me', description: 'Challenge a product idea.', body: 'Ask **one** question.', text: '---\nname: grill-me\ndescription: Challenge a product idea.\n---\nAsk **one** question.\n', extensions: [], builtin: true, hasBuiltin: true, compatible: true, files: [{ path: 'SKILL.md', bytes: 80 }] },
    { name: 'uiux-design', description: 'Design interfaces.', body: 'Start from the user.', text: '---\nname: uiux-design\ndescription: Design interfaces.\n---\nStart from the user.\n', extensions: [], builtin: true, hasBuiltin: true, compatible: true, files: [{ path: 'SKILL.md', bytes: 70 }] },
    { name: 'report-export', description: 'Export reports as CSV.', body: '# 匯出\n\n讀 references/spec.md。', text: '---\nname: report-export\ndescription: Export reports as CSV.\nlicense: MIT\nhooks: {}\n---\n# 匯出\n\n讀 references/spec.md。', extensions: ['hooks'], builtin: false, hasBuiltin: false, compatible: false, dir: 'C:/data/skills/report-export', files: [{ path: 'SKILL.md', bytes: 120 }, { path: 'references/spec.md', bytes: 10 }, { path: 'scripts/export.py', bytes: 30 }] },
  ],
});
function skillsPage(fixture = skillFixture()) {
  const { dom, ui, doc, w } = page();
  doc.querySelector('#tab-skills').hidden = false;
  const requests = [];
  let runs = [];
  ui.setApi(async (path, body) => {
    requests.push({ path, body: body === undefined ? undefined : plain(body) });
    if (path === '/api/skills') return fixture;
    if (path === '/api/skills/runs') return { runs };
    return {};
  });
  ui.setSnap(snapshot()); ui.bind(); ui.bindSkills();
  return { dom, ui, doc, w, requests, setRuns(value) { runs = value; } };
}

test('Skills 側欄列出技能與來源／相容狀態，點選後右側顯示 Markdown 預覽、frontmatter 與資源檔，搜尋會篩選清單', async () => {
  const { dom, ui, doc, w } = skillsPage();
  await ui.loadSkills();
  const items = [...doc.querySelectorAll('#skill-list .skill-item')];
  assert.deepEqual(items.map(item => item.querySelector('strong').textContent), ['grill-me', 'uiux-design', 'report-export']);
  assert.deepEqual([...items[0].querySelectorAll('.chip')].map(chip => chip.textContent), ['內建', '相容']);
  assert.deepEqual([...items[2].querySelectorAll('.chip')].map(chip => chip.textContent), ['匯入', '需調整']);
  assert.equal(items[2].querySelector('.skill-item-desc').textContent, 'Export reports as CSV.');
  // 預設選第一個：內建技能不能刪除，Markdown 預覽來自 body。
  assert.equal(items[0].getAttribute('aria-current'), 'true');
  assert.equal(doc.querySelector('#skill-title').textContent, 'grill-me');
  assert.equal(doc.querySelector('#skill-preview strong').textContent, 'one');
  assert.equal(doc.querySelector('#skill-delete').hidden, true);
  items[2].click();
  assert.equal(ui.skillState().selected, 'report-export');
  assert.equal(doc.querySelector('#skill-list .skill-item[data-skill="report-export"]').getAttribute('aria-current'), 'true');
  assert.equal(doc.querySelector('#skill-origin').textContent, '匯入 · 需調整');
  assert.equal(doc.querySelector('#skill-preview .md-h1').textContent, '匯出');
  const meta = Object.fromEntries([...doc.querySelectorAll('#skill-meta div')].map(div => [div.querySelector('dt').textContent, div.querySelector('dd').textContent]));
  assert.equal(meta.license, 'MIT');
  assert.equal(meta['hooks（執行器專屬）'], '{}');
  assert.match(meta['相容性'], /hooks/);
  assert.deepEqual([...doc.querySelectorAll('#skill-files .skill-file')].map(el => el.textContent), ['SKILL.md', 'references/spec.md', 'scripts/export.py']);
  assert.equal(doc.querySelector('#skill-delete').hidden, false);
  assert.match(doc.querySelector('#skill-delete').textContent, /刪除/);
  // 編輯切到文字框並帶入 SKILL.md 全文；取消回到預覽。
  doc.querySelector('#skill-edit').click();
  assert.equal(doc.querySelector('#skill-editing').hidden, false);
  assert.match(doc.querySelector('#skill-editor').value, /^---\nname: report-export/);
  doc.querySelector('#skill-cancel-edit').click();
  assert.equal(doc.querySelector('#skill-editing').hidden, true);
  // 搜尋只影響側欄清單，不改變選取。
  doc.querySelector('#skill-search').value = 'design'; doc.querySelector('#skill-search').dispatchEvent(new w.Event('input'));
  assert.deepEqual([...doc.querySelectorAll('#skill-list .skill-item strong')].map(el => el.textContent), ['uiux-design']);
  assert.equal(ui.skillState().selected, 'report-export');
  assert.deepEqual(plain(ui.skillFrontmatter('---\nname: a\ndescription: |\n  two\n  lines\n---\nbody')), [['name', 'a'], ['description', 'two lines']]);
  dom.window.close();
});

test('拖放資料夾到 Skills 頁會匯入技能；缺 SKILL.md 時顯示後端的拒絕原因並保持原本選取', async () => {
  const { dom, ui, doc, w, requests } = skillsPage();
  await ui.loadSkills();
  let dropped;
  w.__TAURI__.webview = { getCurrentWebview: () => ({ onDragDropEvent: callback => { dropped = callback; return Promise.resolve(() => {}); } }) };
  doc.elementFromPoint = () => doc.querySelector('#skill-list');
  const fixture = skillFixture();
  ui.setApi(async (path, body) => {
    requests.push({ path, body: body === undefined ? undefined : plain(body) });
    if (path === '/api/skills/import') {
      if (/no-skill/.test(body.path)) throw new Error('請選擇包含 SKILL.md 的資料夾');
      const skill = { name: 'new-skill', description: 'Imported.', body: 'Do it.', text: '---\nname: new-skill\ndescription: Imported.\n---\nDo it.', extensions: [], builtin: false, hasBuiltin: false, compatible: true, dir: 'C:/data/skills/new-skill', files: [{ path: 'SKILL.md', bytes: 50 }] };
      fixture.skills.push(skill); return { skill };
    }
    if (path === '/api/skills') return fixture;
    if (path === '/api/skills/runs') return { runs: [] };
    return {};
  });
  ui.bindReferences();
  await dropped({ payload: { type: 'drop', paths: ['C:/external/no-skill'], position: { x: 10, y: 10 } } });
  assert.deepEqual(plain(requests.at(-1)), { path: '/api/skills/import', body: { path: 'C:/external/no-skill' } });
  assert.match(doc.querySelector('#toast').textContent, /SKILL\.md/);
  assert.ok(doc.querySelector('#toast').classList.contains('bad'));
  assert.equal(ui.skillState().selected, 'grill-me');
  assert.equal(requests.some(r => r.path === '/api/references/import'), false, '拖到 Skills 頁不會當成參考資料');
  await dropped({ payload: { type: 'drop', paths: ['C:/external/.claude/skills/new-skill'], position: { x: 10, y: 10 } } });
  assert.equal(ui.skillState().selected, 'new-skill');
  assert.equal(doc.querySelector('#skill-list .skill-item[aria-current="true"] strong').textContent, 'new-skill');
  assert.equal(doc.querySelector('#skill-title').textContent, 'new-skill');
  dom.window.close();
});

test('工作流技能綁定是一張階段表：＋ 從清單加入、× 移除，只有變更時才能儲存，儲存送出全部七個階段', async () => {
  const { dom, ui, doc, requests } = skillsPage();
  await ui.loadSkills();
  doc.querySelector('#skill-nav-bindings').click();
  assert.equal(doc.querySelector('#skill-bindings-pane').hidden, false);
  assert.equal(doc.querySelector('#skill-pane').hidden, true);
  const rows = [...doc.querySelectorAll('#skill-bindings tr')];
  assert.deepEqual(rows.map(row => row.dataset.stage), ['prd', 'prd_review', 'tasks', 'implement', 'code_review', 'fix', 'handover']);
  assert.equal(rows[0].querySelector('th').textContent, 'PRD 起草／修訂');
  const chipsOf = stage => [...doc.querySelectorAll(`#skill-bindings tr[data-stage="${stage}"] .skill-binding-chip > span`)].map(el => el.textContent);
  assert.deepEqual(chipsOf('implement'), ['uiux-design']);
  assert.equal(doc.querySelector('#skill-bindings-save').disabled, true);
  // ＋ 只列出相容且尚未綁定的技能（report-export 含 hooks 不相容）。
  doc.querySelector('#skill-bindings tr[data-stage="implement"] .skill-binding-add').click();
  assert.deepEqual([...doc.querySelectorAll('.skill-pick button')].map(el => el.textContent), ['grill-me']);
  doc.querySelector('.skill-pick button').click();
  assert.deepEqual(chipsOf('implement'), ['uiux-design', 'grill-me']);
  assert.equal(doc.querySelector('.skill-pick'), null);
  assert.equal(doc.querySelector('#skill-bindings-save').disabled, false);
  doc.querySelector('#skill-bindings tr[data-stage="implement"] .skill-binding-chip button[aria-label*="grill-me"]').click();
  assert.deepEqual(chipsOf('implement'), ['uiux-design']);
  assert.equal(doc.querySelector('#skill-bindings-save').disabled, true, '改回原樣就沒有變更');
  doc.querySelector('#skill-bindings tr[data-stage="prd_review"] .skill-binding-add').click();
  doc.querySelector('.skill-pick button').click();
  assert.deepEqual(chipsOf('prd_review'), ['grill-me']);
  await doc.querySelector('#skill-bindings-save').onclick();
  const saved = requests.find(r => r.path === '/api/skills/config');
  assert.deepEqual(saved.body, { skills: { prd: [], prd_review: ['grill-me'], tasks: [], implement: ['uiux-design'], code_review: [], fix: [], handover: [] } });
  assert.equal(doc.querySelector('#skill-bindings-save').disabled, true);
  assert.match(doc.querySelector('#toast').textContent, /已儲存/);
  dom.window.close();
});

test('技能會議：送出只呼叫 skills/run 並帶 AI 與接續 id，回覆中顯示持續時間，完成後以 Markdown 顯示訊息', async () => {
  const { dom, ui, doc, w, requests, setRuns } = skillsPage();
  await ui.loadSkills();
  doc.querySelector('[data-skill-view="meeting"]').click();
  assert.equal(doc.querySelector('#skill-meeting').hidden, false);
  assert.equal(doc.querySelector('#skill-content').hidden, true);
  assert.match(doc.querySelector('#skill-messages').textContent, /與 grill-me 開一場會議/);
  doc.querySelector('#skill-provider').value = 'codex';
  doc.querySelector('#skill-input').value = '我要做報表工具';
  doc.querySelector('#skill-input').dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await new Promise(r => setTimeout(r, 0));
  const run = requests.find(r => r.path === '/api/skills/run');
  assert.deepEqual(run.body, { name: 'grill-me', input: '我要做報表工具', provider: 'codex', previousId: '' });
  assert.equal(requests.some(r => /chat\/send|backlog\/draft|\/prd/.test(r.path)), false);
  assert.equal(doc.querySelector('#skill-input').value, '');
  const started = new Date(Date.now() - 65000).toISOString();
  setRuns([{ id: 'r1', name: 'grill-me', status: 'running', provider: 'codex', created_at: started, updated_at: started, messages: [{ role: 'user', text: '我要做報表工具', at: started }] }]);
  ui.setLog('skill-r1', '[12:00:00] ── Skill grill-me：codex（唯讀）開始 ──\n🔧 Read README.md');
  await ui.loadSkillRuns();
  assert.equal(ui.skillState().runId, 'r1');
  assert.equal(doc.querySelector('#skill-run-history').value, 'r1');
  assert.equal(doc.querySelector('#skill-messages .from-user').textContent.includes('我要做報表工具'), true);
  assert.match(doc.querySelector('#skill-status').textContent, /AI 正在回覆.*已 1 分/);
  assert.equal(doc.querySelector('#skill-run').disabled, true);
  assert.equal(doc.querySelector('#skill-live .lg-tool-name').textContent, 'Read');
  assert.equal(doc.querySelector('#skill-meeting-badge').textContent, '回覆中');
  setRuns([{ id: 'r1', name: 'grill-me', status: 'done', provider: 'codex', created_at: started, updated_at: started, messages: [{ role: 'user', text: '我要做報表工具', at: started }, { role: 'assistant', provider: 'codex', text: '**目標使用者**是誰？\n```mermaid\nflowchart TD\nA-->B\n```', at: started }] }]);
  await ui.loadSkillRuns();
  assert.equal(doc.querySelector('#skill-messages .from-ai strong').textContent, '目標使用者');
  assert.equal(doc.querySelector('#skill-messages .from-ai .chat-message-head b').textContent, 'Codex');
  assert.ok(doc.querySelector('#skill-messages .from-ai .chat-diagram'), 'Mermaid 區塊和專案對話一樣轉成圖表容器');
  assert.doesNotMatch(doc.querySelector('#skill-status').textContent, /已 /);
  assert.equal(doc.querySelector('#skill-run').disabled, false);
  assert.equal(doc.querySelector('#skill-to-prd').disabled, false);
  assert.equal(doc.querySelector('#skill-meeting-badge').textContent, '1');
  // 接續這場會議：previousId 帶上目前會議。
  doc.querySelector('#skill-input').value = '使用者是財務人員';
  await ui.sendSkill();
  assert.equal(requests.filter(r => r.path === '/api/skills/run').at(-1).body.previousId, 'r1');
  // 新會議按鈕回到空白會議。
  doc.querySelector('#skill-run-new').click();
  assert.equal(ui.skillState().runId, '');
  assert.equal(doc.querySelector('#skill-run-history').value, '');
  dom.window.close();
});

test('模型選擇器取代原生清單：列出 CLI 回報的模型、可篩選與鍵盤選取，推理強度跟著模型', () => {
  const { dom, ui, doc, w } = settingsPage();
  doc.querySelector('#overview-settings').hidden = false;
  ui.setModels({
    claude: { models: [
      { id: 'opus', name: 'Opus 5.5', description: '複雜工作', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5', description: '最快', efforts: [] },
    ] },
    codex: { models: [{ id: 'gpt-5', name: 'GPT-5', efforts: ['low', 'high'], default: true }] },
  });
  ui.setConfig(globalConfig()); ui.renderSettings();
  const input = doc.querySelectorAll('#role-models .role-card')[1].querySelector('.model-line input');
  input.dispatchEvent(new w.Event('focus'));
  let popup = doc.querySelector('body > ul.model-picker');
  assert.ok(popup, '聚焦時顯示清單');
  assert.equal(input.getAttribute('aria-expanded'), 'true');
  const options = [...popup.querySelectorAll('[role=option]')];
  assert.deepEqual(options.map(li => li.dataset.value), ['', 'opus', 'claude-haiku-4-5-20251001']);
  assert.equal(options[1].querySelector('b').textContent, 'Opus 5.5');
  assert.equal(options[1].querySelector('code').textContent, 'opus');
  // 點選 Haiku 4.5：寫入 ID、關閉清單、存進草稿；這個模型沒有推理強度選項。
  options[2].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
  assert.equal(input.value, 'claude-haiku-4-5-20251001');
  assert.equal(doc.querySelector('body > ul.model-picker'), null);
  assert.equal(ui.draft().models.author.claude.model, 'claude-haiku-4-5-20251001');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.effortsFor('claude', 'claude-haiku-4-5-20251001'))), []);
  assert.equal(ui.effortsFor('claude', 'opus').length, 5);
  assert.equal(ui.effortsFor('claude', 'custom-id').length, 5, '不認得的 ID 列出全部推理強度');
  // 鍵盤：往下兩次選到 Opus、Enter 確認；Esc 關閉。
  input.dispatchEvent(new w.Event('focus'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  assert.equal(input.value, 'opus');
  input.dispatchEvent(new w.Event('focus'));
  input.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(doc.querySelector('body > ul.model-picker'), null);
  dom.window.close();
});

test('點任務以對話框顯示詳情，不改變看板版面；Esc 與關閉都會清掉選取', async () => {
  const { dom, ui, doc, w } = page();
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  doc.querySelector('#tab-board').hidden = false;
  const state = snapshot(); state.tasks = [{ id: 1, title: '登入', status: 'pending' }];
  ui.setSnap(state); ui.bind(); ui.renderBoard();
  const dialog = doc.querySelector('#detail');
  assert.equal(dialog.tagName, 'DIALOG');
  assert.equal(dialog.open, false);
  assert.ok(!dialog.closest('.board-canvas'), '詳情不在看板欄位裡');
  ui.setApi(async () => ({ id: '1', task: { id: 1, title: '登入' }, state: {}, log: '', reviews: [] }));
  await ui.selectTask('1');
  assert.equal(dialog.open, true);
  assert.equal(doc.querySelector('#d-title').textContent, '#1 登入');
  dialog.dispatchEvent(new w.Event('cancel', { cancelable: true }));
  assert.equal(dialog.open, false);
  assert.equal(doc.querySelector('#board .task.selected'), null);
  dom.window.close();
});

const SAMPLE_DIFF = [
  ' src/a.js | 4 ++--', ' 3 files changed', '',
  'diff --git a/src/a.js b/src/a.js', 'index 1111111..2222222 100644', '--- a/src/a.js', '+++ b/src/a.js',
  '@@ -1,4 +1,4 @@ function main() {', ' const a = 1;', '-const b = 2;', '-const c = 3;', '+const b = 20;', ' const d = 4;', '+const e = "<img src=x onerror=alert(1)>";',
  'diff --git a/new.txt b/new.txt', 'new file mode 100644', 'index 0000000..3333333', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1,2 @@', '+hello', '+world',
  'diff --git a/logo.png b/logo.png', 'new file mode 100644', 'index 0000000..4444444', 'Binary files /dev/null and b/logo.png differ',
  'diff --git a/old.md b/docs/new.md', 'similarity index 100%', 'rename from old.md', 'rename to docs/new.md', '',
].join('\n');

test('diff 解析：略過 --stat 摘要，辨識新增、修改、二進位與改名，行號正確', () => {
  const { dom, ui } = page();
  const files = JSON.parse(JSON.stringify(ui.parseUnifiedDiff(SAMPLE_DIFF)));
  assert.deepEqual(files.map(f => [f.path, f.status, f.adds, f.dels, f.binary]), [
    ['src/a.js', 'modified', 2, 2, false], ['new.txt', 'added', 2, 0, false], ['logo.png', 'added', 0, 0, true], ['docs/new.md', 'renamed', 0, 0, false],
  ]);
  assert.equal(files[3].oldPath, 'old.md');
  const lines = files[0].hunks[0].lines;
  assert.deepEqual(lines.map(l => [l.type, l.old ?? null, l.new ?? null]), [['ctx', 1, 1], ['del', 2, null], ['del', 3, null], ['add', null, 2], ['ctx', 4, 3], ['add', null, 4]]);
  // 並排：兩行刪除配一行新增，右邊空一格。
  const rows = JSON.parse(JSON.stringify(ui.splitRows(lines)));
  assert.equal(rows.length, 5);
  assert.equal(rows[1].left.text, 'const b = 2;'); assert.equal(rows[1].right.text, 'const b = 20;');
  assert.equal(rows[2].left.text, 'const c = 3;'); assert.equal(rows[2].right, null);
  assert.equal(rows[4].left, null); assert.equal(rows[4].right.type, 'add');
  dom.window.close();
});

test('diff 檢視：預設左右並排、可切換單欄，有檔案清單與摘要，內容不會被當成 HTML', () => {
  const { dom, ui, doc } = page();
  const host = doc.createElement('div'); doc.body.append(host);
  host.append(ui.diffView(SAMPLE_DIFF));
  assert.match(host.querySelector('.diff-summary').textContent, /4 個檔案.*\+4.*−2/);
  assert.equal(host.querySelectorAll('.diff-nav li').length, 4);
  assert.equal(host.querySelectorAll('.diff-file').length, 4);
  const table = host.querySelector('.diff-table');
  assert.ok(table.classList.contains('diff-split'));
  assert.equal(table.querySelector('tr:not(.diff-hunk)').children.length, 4, '並排每列有左右兩組行號與內容');
  assert.equal(host.querySelector('img'), null);
  assert.ok([...host.querySelectorAll('td.code.add')].some(td => td.textContent.includes('<img src=x')));
  assert.match(host.querySelectorAll('.diff-empty')[0].textContent, /二進位/);
  assert.match(host.querySelectorAll('.diff-empty')[1].textContent, /只有改名/);
  host.querySelector('[data-diff-mode="unified"]').click();
  const unified = host.querySelector('.diff-table');
  assert.ok(unified.classList.contains('diff-unified'));
  assert.equal(unified.querySelector('tr:not(.diff-hunk)').children.length, 3);
  host.querySelector('[data-diff-mode="split"]').click();
  // 沒有可解析的檔案時顯示原文。
  const plain = ui.diffView('只是一段文字');
  assert.equal(plain.querySelector('pre').textContent, '只是一段文字');
  dom.window.close();
});

test('AI 要求權限時跳出對話框：顯示指令與規則，回答送到後端；稍後決定會留下提示可再打開', async () => {
  const { dom, ui, doc, w } = page();
  w.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  w.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new w.Event('close')); };
  const ask = id => ({ id, scope: 'task-1', label: '實作任務 1', provider: 'claude', tool: 'Bash', display_name: 'Bash', input: { command: 'npm init -y <b>x</b>' }, description: '建立 package.json', reason: 'This command requires approval', suggestions: [{ rules: [{ toolName: 'Bash', ruleContent: 'npm init *' }] }] });
  const state = snapshot(); state.permissions = [ask('p1'), ask('p2')];
  ui.setSnap(state);
  const requests = [];
  ui.setApi(async (path, body) => { requests.push({ path, body: JSON.parse(JSON.stringify(body)) }); return {}; });
  ui.renderPermissions();
  let dialog = doc.querySelector('dialog.permission-dialog');
  assert.ok(dialog && dialog.open);
  assert.equal(dialog.querySelector('.permission-code').textContent, 'npm init -y <b>x</b>');
  assert.equal(dialog.querySelector('.permission-code b'), null, '指令以純文字顯示');
  assert.match(dialog.querySelector('.permission-who').textContent, /實作任務 1.*Claude.*Bash/);
  assert.match(dialog.querySelector('.permission-count').textContent, /還有 1 個/);
  const session = dialog.querySelector('[data-decision="allow_session"]');
  assert.equal(session.hidden, false); assert.match(session.textContent, /Bash\(npm init \*\)/);
  // 允許這一次：送出回答、關掉對話框，接著顯示下一個請求。
  await dialog.querySelector('[data-decision="allow"]').onclick();
  assert.deepEqual(requests[0], { path: '/api/permissions/answer', body: { id: 'p1', decision: 'allow', message: '' } });
  dialog = doc.querySelector('dialog.permission-dialog');
  assert.equal(dialog.dataset.id, 'p2');
  // 拒絕時帶上原因。
  dialog.querySelector('textarea').value = '請改用 pnpm';
  await dialog.querySelector('[data-decision="deny"]').onclick();
  assert.deepEqual(requests[1].body, { id: 'p2', decision: 'deny', message: '請改用 pnpm' });
  assert.equal(doc.querySelector('dialog.permission-dialog'), null);
  // 稍後決定：關掉對話框但留下提示，按「檢視」再打開；請求失效時對話框自動關閉。
  state.permissions = [ask('p3')]; ui.setSnap(state); ui.renderPermissions();
  doc.querySelector('dialog.permission-dialog [data-later]').click();
  assert.equal(doc.querySelector('dialog.permission-dialog'), null);
  assert.match(doc.querySelector('#permission-notice').textContent, /等待你允許 1 個操作/);
  ui.renderPermissions();
  assert.equal(doc.querySelector('dialog.permission-dialog'), null, '稍後決定的請求不會馬上又跳出來');
  doc.querySelector('#permission-notice button').click();
  assert.ok(doc.querySelector('dialog.permission-dialog'));
  state.permissions = []; ui.setSnap(state); ui.renderPermissions();
  assert.equal(doc.querySelector('dialog.permission-dialog'), null);
  assert.equal(doc.querySelector('#permission-notice'), null);
  dom.window.close();
});

test('防呆：已產生目前 PRD 的需求只能排序，按鈕停用並顯示原因；點擊也會被擋下', async () => {
  const { dom, ui, doc } = page();
  ui.setSnap(snapshot()); ui.bind();
  const lock = '這項需求已產生目前的 PRD，不能再修改或重新釐清；要調整請到 PRD 頁人工編輯或要求再改';
  ui.setBacklog([
    { id: 'a', title: '目前功能', status: 'in_progress', references: [], lock },
    { id: 'b', title: '下一個', status: 'open', references: [], lock: null },
  ]);
  ui.renderBacklog();
  const [locked, open] = doc.querySelectorAll('#backlog .bl-item');
  for (const act of ['references', 'edit', 'delete', 'draft']) {
    const button = locked.querySelector(`[data-act="${act}"]`);
    assert.equal(button.disabled, true, act);
    assert.equal(button.title, lock, act);
    assert.equal(open.querySelector(`[data-act="${act}"]`).disabled, false, act);
  }
  assert.equal(locked.querySelector('[data-act="down"]').disabled, false, '排序不受影響');
  assert.match(locked.querySelector('.bl-lock').textContent, /目前的 PRD/);
  const requests = [];
  ui.setApi(async (path) => { requests.push(path); return {}; });
  locked.querySelector('[data-act="delete"]').disabled = false; // 模擬畫面還沒更新時被點到
  locked.querySelector('[data-act="delete"]').click();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(requests.length, 0);
  dom.window.close();
});

test('防呆：按鈕依後端 guards 停用並顯示原因，參考資料被鎖住時不能加入或移除', () => {
  const { dom, ui, doc } = page();
  const state = snapshot(); state.root = 'C:/p'; state.prd = '# PRD';
  state.state.prd = { status: 'approved', rounds: [], references: ['r1'] };
  state.state.pipeline.status = 'complete';
  state.tasks = [{ id: 1, title: '登入', status: 'done' }];
  const done = '這個功能已完成並封存；要再修改請從需求待辦開始新的需求';
  state.guards = { 'prd.edit': done, 'prd.revise': done, 'prd.review': done, 'prd.approve': 'PRD 目前不是等待核准', 'prd.references': done, 'tasks.generate': done, 'tasks.approve': done, 'tasks.references': done, 'task.edit': done, 'task.rerun': done, 'run.start': done, 'project.settings': null, 'backlog.draft': null };
  ui.catalog([{ id: 'r1', name: '規格.md', kind: 'file' }]);
  ui.setSnap(state); ui.bind(); ui.renderPrd(); ui.renderBoard(); ui.renderHumanControls(); ui.renderReferenceWidgets();
  for (const id of ['#btn-prd-edit', '#btn-prd-review', '#btn-prd-revise', '#btn-start']) {
    assert.equal(doc.querySelector(id).disabled, true, id);
    assert.equal(doc.querySelector(id).title, done, id);
  }
  assert.equal(doc.querySelector('#btn-project-settings').disabled, false);
  const feature = doc.querySelector('#prd-references');
  assert.equal(feature.querySelector('.reference-add').disabled, true);
  assert.equal(feature.querySelector('.reference-chip button'), null, '鎖住時不顯示移除按鈕');
  assert.match(feature.querySelector('.reference-lock').textContent, /已完成/);
  // 原因消失（例如重新開始新需求）後恢復可用，提示文字也清掉。
  state.guards = Object.fromEntries(Object.keys(state.guards).map(key => [key, null]));
  ui.setSnap(state); ui.renderPrd(); ui.renderHumanControls();
  assert.equal(doc.querySelector('#btn-prd-edit').disabled, false);
  assert.equal(doc.querySelector('#btn-prd-edit').title, '');
  dom.window.close();
});

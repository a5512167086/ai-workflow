const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function page() {
  const dom = new JSDOM(fs.readFileSync('src/index.html', 'utf8'), {
    url: 'https://aipipe.test/index.html', runScripts: 'outside-only',
  });
  const w = dom.window;
  w.structuredClone = structuredClone;
  w.__TAURI__ = { core: { invoke: async () => ({}) } };
  const common = fs.readFileSync('src/common.js', 'utf8');
  const chat = ['markdown.js', 'diagrams.js', 'references.js', 'chat.js', 'human.js'].map(name => fs.readFileSync(`src/${name}`, 'utf8')).join('\n');
  const app = fs.readFileSync('src/app.js', 'utf8').split('\nbind();')[0];
  w.eval(`${common}\n${chat}\n${app}\nwindow.ui = {
    bindReferences, bindReferenceInput, renderReferenceWidgets, openReferenceDialog, referenceDraft, saveReferenceSelection,
    setReferenceDraft(key, ids) { referenceDrafts.set(key, ids); },
    catalog(items) { referenceCatalog = new Map(items.map(item => [item.id, item])); },
    bind, parseLog, renderLogTree, setLogTreeOpen, renderModels, renderSettings,
    openArchive, openCurrent, renderRecords, reviewsView,
    setSnap(value) { snap = value; },
    draft() { return modelDraft; },
    setApi(fn) { api = fn; },
    setArchive(value) { recArchive = value; },
    archive() { return recArchive; }, renderUsage, runAction, renderPrd,
    renderBoard, boardFacts, selectTask, renderTaskGates,
    sendChat, openChat, newChat, renderChatMessages, renderChatMarkdown,
    setChat(value) { chatId = value?.id || null; chatSession = value; chatMessagesKey = ''; renderChatMessages(); renderChatControls(); },
    chat() { return chatSession; },
    renderHumanControls, editHumanPrd, editHumanTask, approveHumanPrd, openInterview,
    setDetail(value) { detail = value; }
  };`);
  return { dom, w, ui: w.ui, doc: w.document };
}
const snapshot = () => ({ config: {
  feature: '測試功能', roles: { author: 'claude', reviewer: 'both', implementer: 'claude', code_reviewer: 'both' },
  models: {}, runtime: {},
}, state: { prd: { status: 'approved' }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, tasks: [] });

test('模型輸入在狀態更新後保留焦點、內容與待儲存值', () => {
  const { dom, ui, doc, w } = page();
  doc.querySelector('#tab-settings').hidden = false;
  ui.setSnap(snapshot()); ui.renderSettings();
  const input = doc.querySelector('#role-models input');
  input.focus(); input.value = 'custom-model';
  input.dispatchEvent(new w.Event('input'));
  ui.renderSettings();
  assert.equal(doc.activeElement, input);
  assert.equal(input.value, 'custom-model');
  assert.equal(ui.draft().models.author.claude.model, 'custom-model');
  const reviewer = doc.querySelectorAll('.role-row > select')[1];
  reviewer.focus(); reviewer.value = 'codex';
  reviewer.dispatchEvent(new w.Event('change'));
  assert.equal(doc.querySelectorAll('.role-row')[1].querySelectorAll('.model-line').length, 1);
  assert.equal(doc.querySelector('#wsl-distro'), null);
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
  const dialog=doc.querySelector('dialog'); dialog.querySelector('input[type=checkbox]').click(); dialog.close();
  assert.equal(ui.referenceDraft('backlog').length,0);
  await ui.openReferenceDialog({title:'需求參考',key:'backlog',ids:[]});
  doc.querySelector('dialog input[type=checkbox]').click(); doc.querySelector('[data-apply]').click();
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
  assert.match(doc.querySelector('#task-human-note').textContent, /核准後才會開始執行/);
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
  const session = { id: 's1', status: 'done', turn: 't1', requirementsReady: true, requirementsSummary: '已確認：匯出 CSV', messages: [{ role: 'user', text: '請先釐清 <b>x</b>' }, { role: 'assistant', text: '**問題一**' }] };
  ui.setApi(async (path, body) => {
    requests.push({ path, body });
    if (path === '/api/requirements/item-1') return { item: { id: 'item-1', title: '匯出' }, session: null, stale: false, confirmed: false };
    if (path === '/api/backlog/interview') return { item: { id: 'item-1' }, session, stale: false, confirmed: false };
    return {};
  });
  await ui.openInterview('item-1');
  assert.equal(requests[0].path, '/api/requirements/item-1');
  assert.equal(requests[1].path, '/api/backlog/interview');
  assert.equal(requests[1].body.id, 'item-1');
  assert.equal(requests.some(r => /backlog\/draft|\/prd/.test(r.path)), false);
  const dialog = doc.querySelector('dialog.interview-dialog');
  assert.equal(dialog.querySelector('.from-ai strong').textContent, '問題一');
  assert.equal(dialog.querySelector('.from-user .md b'), null);
  assert.match(dialog.querySelector('.from-user .md').textContent, /<b>x<\/b>/);
  assert.equal(dialog.querySelector('.interview-summary').hidden, false);
  assert.equal(dialog.querySelector('.interview-summary textarea').value, '已確認：匯出 CSV');
  dialog.querySelector('.interview-summary textarea').value = '已確認：匯出 CSV，含日期範圍';
  await dialog.querySelector('[data-confirm]').onclick({ target: dialog.querySelector('[data-confirm]') });
  const confirm = requests.find(r => r.path === '/api/backlog/confirm');
  assert.deepEqual(plain(confirm.body), { id: 'item-1', sessionId: 's1', turn: 't1', summary: '已確認：匯出 CSV，含日期範圍' });
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

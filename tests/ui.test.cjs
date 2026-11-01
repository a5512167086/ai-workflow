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
  const app = fs.readFileSync('src/app.js', 'utf8').split('\nbind();')[0];
  w.eval(`${common}\n${app}\nwindow.ui = {
    bind, parseLog, renderLogTree, setLogTreeOpen, renderModels, renderSettings,
    openArchive, openCurrent, renderRecords, reviewsView,
    setSnap(value) { snap = value; },
    draft() { return modelDraft; },
    setApi(fn) { api = fn; },
    setArchive(value) { recArchive = value; },
    archive() { return recArchive; }, renderUsage, runAction, renderPrd
  };`);
  return { dom, w, ui: w.ui, doc: w.document };
}
const snapshot = () => ({ config: {
  feature: '測試功能', roles: { author: 'claude', reviewer: 'both', implementer: 'claude', code_reviewer: 'both' },
  models: {}, runtime: {},
}, state: { prd: { status: 'approved' }, pipeline: { status: 'idle' }, tasks: {} }, tasks: [] });

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

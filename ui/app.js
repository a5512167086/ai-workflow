'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const STATUS_TEXT = {
  idle: '閒置', running: '執行中', paused: '已暫停', waiting: '等待人工測試',
  feature_test: '功能待測試', stuck: '需要人工處理', error: '錯誤', complete: '已完成',
};
const PRD_TEXT = {
  none: '尚無', drafting: '起草中', reviewing: '審查中', revising: '修訂中',
  awaiting_approval: '等待核准', approved: '已核准',
};
const PRIORITY_TEXT = { high: '高', medium: '中', low: '低' };
const COLUMNS = [
  ['todo', '待辦'], ['doing', '進行中'], ['review', '審查中'], ['test', '等待測試'], ['done', '完成'],
];
// 需要人回應的流程狀態：「我測完了，繼續」在這些狀態下變成主要按鈕。
const NEEDS_HUMAN = ['waiting', 'feature_test', 'stuck', 'error'];

let snap = null;
let selected = null;
let subtab = 'log';
let detail = null;
const logs = {};
let prdView = (() => {
  try {
    return localStorage.getItem('aipipe-prd-view') === 'raw' ? 'raw' : 'preview';
  } catch {
    return 'preview';
  }
})();
let rounds = [];

const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Aipipe': '1' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, bad = false) {
  const el = $('#toast');
  el.innerHTML = `${icon(bad ? 'alert' : 'check')}<span></span>`;
  el.querySelector('span').textContent = msg;
  el.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), bad ? 7000 : 4000);
}

async function act(path, body, okMsg) {
  try {
    await api(path, body ?? {});
    if (okMsg) toast(okMsg);
  } catch (err) {
    toast(err.message, true);
  }
}

function column(task, ts) {
  const phase = ts?.phase;
  // aipipe 自己的階段優先；沒跑過的任務才看 Task Master 的狀態。
  if (phase === 'awaiting_test') return 'test';
  if (phase === 'reviewing') return 'review';
  if (phase === 'implementing' || phase === 'stuck') return 'doing';
  if (phase === 'done' || task.status === 'done') return 'done';
  if (task.status === 'review') return 'review';
  if (task.status === 'in-progress') return 'doing';
  return 'todo';
}

function renderTop() {
  const { state, config, root } = snap;
  $('#project').textContent = root;
  $('#project').title = root;
  const st = state.pipeline.status;
  const pill = $('#pipeline-status');
  pill.querySelector('.pill-text').textContent = STATUS_TEXT[st] || st;
  pill.className = `pill ${st}`;
  pill.setAttribute('aria-label', `流程狀態：${STATUS_TEXT[st] || st}`);
  $('#pipeline-reason').textContent = state.pipeline.reason || '';
  $('#pipeline-reason').title = state.pipeline.reason || '';
  for (const b of $$('[data-mode]')) {
    const on = b.dataset.mode === config.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
}

function renderStepper() {
  const { state, tasks } = snap;
  const ps = state.prd.status;
  const tg = state.task_gen;
  const tasksDone = tg?.status === 'done' || tasks.length > 0;
  const order = ['draft', 'review', 'approve', 'tasks'];
  let current;
  if (ps === 'none' || ps === 'drafting') current = 'draft';
  else if (ps === 'reviewing' || ps === 'revising') current = 'review';
  else if (ps === 'awaiting_approval') current = 'approve';
  else current = tasksDone ? null : 'tasks';
  const idx = current ? order.indexOf(current) : order.length;
  for (const li of $$('#prd-stepper li')) {
    const i = order.indexOf(li.dataset.step);
    li.classList.toggle('done', i < idx);
    li.classList.toggle('current', i === idx);
    if (i === idx) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
  }
}

function renderPrd() {
  const { state, prd } = snap;
  const chip = $('#prd-status');
  chip.textContent = PRD_TEXT[state.prd.status] || state.prd.status;
  chip.className = `chip ${state.prd.status}`;
  const busyEl = $('#prd-busy');
  const busyText = snap.prdBusy ? 'AI 處理中，log 在「流程 log」的 prd' : state.prd.error ? `上次錯誤：${state.prd.error}` : '';
  busyEl.textContent = busyText;
  busyEl.classList.toggle('hidden', !busyText);
  busyEl.classList.toggle('bad', !snap.prdBusy && !!state.prd.error);
  renderPrdBody();
  const busy = snap.prdBusy || snap.runnerAlive || snap.taskGenBusy;
  $('#btn-prd-new').disabled = busy;
  $('#btn-prd-approve').disabled = busy || state.prd.status !== 'awaiting_approval';
  $('#btn-prd-revise').disabled = busy || !prd;
  $('#btn-tasks').disabled = busy || state.prd.status !== 'approved';
  const tg = state.task_gen;
  $('#task-gen').textContent = snap.taskGenBusy ? 'Task Master 產生任務中…'
    : tg?.status === 'done' ? `已產生 ${tg.count} 個任務` : tg?.status === 'error' ? `失敗：${tg.error}` : '';
  const badge = $('#tab-prd-badge');
  badge.textContent = state.prd.status === 'awaiting_approval' ? '待核准' : '';
  badge.classList.toggle('attn', state.prd.status === 'awaiting_approval');
  renderStepper();
}

// PRD 與每輪紀錄都是 Markdown：預覽用 markdown.js 安全渲染（不允許原始 HTML），原始模式顯示原文。
// 舊版 aipipe ui 程序還沒提供 /markdown.js 時，退回只顯示原文。
const canRender = () => typeof window.renderMarkdown === 'function';

function renderPrdBody() {
  const prd = snap?.prd || '';
  const raw = prdView === 'raw' || !canRender();
  $('#prd-text').textContent = prd || '（尚無）';
  const md = $('#prd-md');
  if (!raw && md.dataset.src !== prd) {
    md.innerHTML = prd ? window.renderMarkdown(prd) : '<p class="empty">（尚無）</p>';
    md.dataset.src = prd;
  }
  $('#prd-text').classList.toggle('hidden', !raw);
  md.classList.toggle('hidden', raw);
  for (const b of $$('[data-view]')) {
    const on = b.dataset.view === prdView;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
    b.disabled = !canRender();
  }
  $('#btn-prd-copy').disabled = !prd;
}

function renderRounds() {
  const box = $('#prd-rounds');
  const open = new Set($$('#prd-rounds details[open]').map((d) => d.dataset.key));
  box.innerHTML = '';
  if (!rounds.length) box.innerHTML = '<p class="empty">（尚無）</p>';
  const KIND = { draft: '初稿', review: '審查', revise: '修訂', user_feedback: '使用者意見' };
  for (const r of rounds) {
    const d = document.createElement('details');
    d.className = `round ${r.verdict || ''}`;
    d.dataset.key = `${r.round}-${r.kind}-${r.version || ''}`;
    d.open = open.has(d.dataset.key);
    const s = document.createElement('summary');
    s.textContent = `第 ${r.round} 輪・${KIND[r.kind] || r.kind}・${r.provider}${r.verdict ? `・${r.verdict}` : ''}${r.version ? `・v${r.version}` : ''}`;
    let body;
    if (prdView === 'raw' || !canRender()) {
      body = document.createElement('pre');
      body.textContent = r.text;
    } else {
      body = document.createElement('div');
      body.className = 'md md-sm';
      body.innerHTML = r.text ? window.renderMarkdown(r.text) : '<p class="empty">（無內容）</p>';
    }
    d.append(s, body);
    box.append(d);
  }
}

async function loadRounds() {
  try {
    rounds = (await api('/api/prd')).rounds;
    renderRounds();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBoard() {
  const { tasks, state } = snap;
  const board = $('#board');
  board.innerHTML = '';
  const cols = Object.fromEntries(COLUMNS.map(([k, label]) => {
    const el = document.createElement('section');
    el.className = 'col';
    el.dataset.col = k;
    el.setAttribute('aria-label', label);
    el.innerHTML = `<h3><span>${label}</span><span class="count"></span></h3>`;
    board.append(el);
    return [k, el];
  }));
  const doneIds = new Set(tasks.filter((t) => column(t, state.tasks[String(t.id)]) === 'done').map((t) => String(t.id)));
  const counts = {};
  for (const t of tasks) {
    const ts = state.tasks[String(t.id)];
    const col = column(t, ts);
    counts[col] = (counts[col] || 0) + 1;
    const stuck = ts?.phase === 'stuck';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `task${stuck ? ' stuck' : ''}${selected === String(t.id) ? ' selected' : ''}`;
    el.setAttribute('aria-pressed', String(selected === String(t.id)));
    el.innerHTML = '<div class="t-top"><span class="id"></span><span class="tag prio"></span><span class="tag tm"></span></div>'
      + '<div class="title"></div><div class="deps"></div><div class="step"></div><div class="err"></div>';
    el.querySelector('.id').textContent = `#${t.id}`;
    const prio = el.querySelector('.prio');
    if (t.priority) {
      prio.textContent = `${PRIORITY_TEXT[t.priority] || t.priority}優先`;
      prio.classList.add(t.priority);
    } else prio.remove();
    el.querySelector('.tm').textContent = `TM:${t.status}`;
    el.querySelector('.title').textContent = t.title;
    if (t.dependencies?.length) {
      const deps = el.querySelector('.deps');
      deps.innerHTML = `${icon('link')}<span>依賴</span>`;
      for (const d of t.dependencies) {
        const chip = document.createElement('span');
        const met = doneIds.has(String(d));
        chip.className = `dep${met ? ' met' : ''}`;
        chip.textContent = `#${d}`;
        chip.title = met ? `#${d} 已完成` : `#${d} 尚未完成`;
        deps.append(chip);
      }
    }
    if (ts?.step) {
      const step = el.querySelector('.step');
      step.textContent = `${ts.step}${ts.fix_round ? `（修正 ${ts.fix_round}/${snap.config.max_fix_rounds}）` : ''}`;
      if (ts.fix_round) {
        const pct = Math.min(100, Math.round((ts.fix_round / (snap.config.max_fix_rounds || 1)) * 100));
        step.insertAdjacentHTML('afterend', `<div class="bar" aria-hidden="true"><span style="width:${pct}%"></span></div>`);
      }
    }
    if (ts?.error || stuck) {
      const err = el.querySelector('.err');
      err.innerHTML = `${icon('alert')}<span></span>`;
      err.querySelector('span').textContent = ts.error || '需要處理';
    }
    el.onclick = () => selectTask(String(t.id));
    cols[col].append(el);
  }
  for (const [k, el] of Object.entries(cols)) {
    el.querySelector('h3 .count').textContent = counts[k] || 0;
    if (!counts[k]) el.insertAdjacentHTML('beforeend', '<p class="empty">（無）</p>');
  }

  const alive = snap.runnerAlive;
  const busy = alive || snap.prdBusy || snap.taskGenBusy;
  const st = state.pipeline.status;
  const needsHuman = NEEDS_HUMAN.includes(st);
  $('#btn-start').disabled = busy || !tasks.length || state.prd.status !== 'approved';
  $('#btn-pause').disabled = !alive || state.control.pause_requested;
  $('#btn-continue').disabled = busy || !needsHuman;
  // 每個畫面只有一個主要按鈕：等待人工時換成「繼續」。
  $('#btn-continue').classList.toggle('primary', needsHuman && !busy);
  $('#btn-start').classList.toggle('primary', !(needsHuman && !busy));
  $('#runner-info').textContent = alive
    ? `runner pid ${state.runner.pid}${state.control.pause_requested ? '・將在目前任務結束後暫停' : ''}`
    : !tasks.length ? '還沒有任務：先在 PRD 頁核准並產生任務' : '';
  const badge = $('#tab-board-badge');
  badge.textContent = tasks.length ? `${counts.done || 0}/${tasks.length}` : '';
  badge.classList.toggle('attn', needsHuman);
}

async function selectTask(id) {
  const first = selected !== id;
  selected = id;
  $('#detail').classList.remove('hidden');
  renderBoard();
  await loadDetail();
  if (first) $('#detail').scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
}

async function loadDetail() {
  if (!selected) return;
  try {
    detail = await api(`/api/task/${selected}`);
    logs[`task-${selected}`] = detail.log;
    renderDetail();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderDetail() {
  if (!detail) return;
  const ts = detail.state || {};
  const t = detail.task || {};
  $('#d-title').textContent = `#${detail.id} ${t.title || ''}`;
  const check = ts.last_check_ok == null ? ['—', ''] : ts.last_check_ok ? ['通過', 'ok'] : ['失敗', 'bad'];
  const meta = [
    ['步驟', ts.step || ts.phase || '未開始'],
    ['修正輪數', `${ts.fix_round || 0} / ${snap.config.max_fix_rounds}`],
    ['嘗試次數', ts.attempts || 0],
    ['驗證', ...check],
    ['審查', ts.review_verdict || '—', ts.review_verdict === 'PASS' || ts.review_verdict === 'APPROVE' ? 'ok' : ts.review_verdict ? 'bad' : ''],
    ['commit', ts.commit ? ts.commit.slice(0, 8) : '—', 'mono'],
  ];
  const dl = $('#d-meta');
  dl.innerHTML = '';
  for (const [k, v, cls] of meta) {
    const box = document.createElement('div');
    box.innerHTML = '<dt></dt><dd></dd>';
    box.querySelector('dt').textContent = k;
    const dd = box.querySelector('dd');
    dd.textContent = v;
    dd.title = String(v);
    if (cls) dd.className = cls;
    dl.append(box);
  }
  $('#d-rerun').disabled = snap.runnerAlive;
  $('#d-revert').parentElement.title = ts.commit ? `會 git revert ${ts.commit.slice(0, 8)}` : '手動模式沒有 commit：會把這個任務改過的檔案還原到任務開始前（之後任務對同檔案的修改也會一起還原）';
  for (const b of $$('.subtabs button')) {
    const on = b.dataset.sub === subtab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const body = $('#d-body');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  body.textContent = {
    log: logs[`task-${detail.id}`] || '（尚無 log）',
    checks: detail.checks || '（尚未執行驗證）',
    reviews: detail.reviews.map((r) => `===== ${r.name} =====\n${r.text}`).join('\n\n') || '（尚無審查意見）',
    diff: detail.diff || '（尚無 diff）',
    task: JSON.stringify(t, null, 2) + (detail.implement ? `\n\n===== 實作回報 =====\n${detail.implement}` : ''),
  }[subtab];
  if (subtab === 'log' && atBottom) body.scrollTop = body.scrollHeight;
}

function renderLogSelect() {
  const sel = $('#log-scope');
  const scopes = Object.keys(logs).sort();
  const cur = sel.value || 'runner';
  sel.innerHTML = '';
  for (const s of scopes) {
    const o = document.createElement('option');
    o.value = o.textContent = s;
    sel.append(o);
  }
  if (scopes.includes(cur)) sel.value = cur;
  renderLog();
}

function renderLog() {
  const body = $('#log-body');
  const atBottom = body.scrollTop + body.clientHeight >= body.scrollHeight - 30;
  body.textContent = logs[$('#log-scope').value] || '（尚無 log）';
  if (atBottom) body.scrollTop = body.scrollHeight;
}

let settingsDirty = false;
function renderSettings() {
  const { config } = snap;
  $('#config-json').textContent = JSON.stringify(config, null, 2);
  if (settingsDirty) return; // 不覆蓋使用者還沒儲存的選擇
  for (const s of $$('[data-runtime]')) s.value = config.runtime?.[s.dataset.runtime] || 'windows';
  $('#wsl-distro').value = config.wsl_distro || '';
}

let detailTimer = null;
function onState(data) {
  const prevPrd = snap?.state.prd.rounds.length;
  const prevStatus = snap?.state.prd.status;
  snap = data;
  renderSettings();
  renderTop();
  renderPrd();
  renderBoard();
  if (prevPrd !== data.state.prd.rounds.length || prevStatus !== data.state.prd.status) loadRounds();
  clearTimeout(detailTimer);
  detailTimer = setTimeout(loadDetail, 300);
}

async function loadInitialLogs() {
  for (const scope of ['runner', 'prd', 'tasks', 'process']) {
    try {
      const { text } = await api(`/api/log/${scope}`);
      if (text) logs[scope] = text;
    } catch {
      // 沒有這個 log 檔
    }
  }
  renderLogSelect();
}

function connect() {
  const es = new EventSource('/api/events');
  es.addEventListener('state', (e) => onState(JSON.parse(e.data)));
  es.addEventListener('log', (e) => {
    const { scope, text } = JSON.parse(e.data);
    const isNew = !(scope in logs);
    logs[scope] = (logs[scope] || '') + text;
    if (logs[scope].length > 400000) logs[scope] = logs[scope].slice(-300000);
    if (isNew) renderLogSelect();
    else if ($('#log-scope').value === scope) renderLog();
    if (detail && scope === `task-${detail.id}` && subtab === 'log') renderDetail();
  });
  es.addEventListener('error', () => {
    $('#pipeline-reason').textContent = '與 aipipe 連線中斷，重新連線中…';
  });
}

// ---------- 主題：系統 → 淺色 → 深色 ----------
const THEMES = [['system', '跟隨系統', 'monitor'], ['light', '淺色', 'sun'], ['dark', '深色', 'moon']];
function getTheme() {
  try {
    return localStorage.getItem('aipipe-theme') || 'system';
  } catch {
    return 'system';
  }
}
function applyTheme(theme) {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const [, label, ic] = THEMES.find(([k]) => k === theme) || THEMES[0];
  const btn = $('#btn-theme');
  btn.innerHTML = icon(ic);
  btn.title = `主題：${label}（點擊切換）`;
  btn.setAttribute('aria-label', btn.title);
}

// 方向鍵在 tablist 內移動焦點並切換（WAI-ARIA tabs pattern）。
function tabKeys(buttons, activate) {
  for (const b of buttons) {
    b.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(b);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const target = buttons[(next + buttons.length) % buttons.length];
      target.focus();
      activate(target);
    });
  }
}

function showTab(b) {
  for (const x of $$('.tabs button')) {
    const on = x === b;
    x.classList.toggle('active', on);
    x.setAttribute('aria-selected', String(on));
    x.tabIndex = on ? 0 : -1;
  }
  for (const s of $$('.tab')) {
    const on = s.id === `tab-${b.dataset.tab}`;
    s.classList.toggle('active', on);
    s.hidden = !on;
  }
}

function bind() {
  let theme = getTheme();
  applyTheme(theme);
  $('#btn-theme').onclick = () => {
    const keys = THEMES.map(([k]) => k);
    const next = keys[(keys.indexOf(theme) + 1) % keys.length];
    theme = next;
    try {
      localStorage.setItem('aipipe-theme', next);
    } catch {
      // 無法儲存時只在這次頁面生效
    }
    applyTheme(next);
  };
  const tabButtons = $$('.tabs button');
  for (const b of tabButtons) b.onclick = () => showTab(b);
  tabKeys(tabButtons, showTab);
  for (const b of $$('[data-mode]')) {
    b.onclick = () => act('/api/config/mode', { mode: b.dataset.mode }, `已切換為${b.textContent}模式`);
  }
  const subButtons = $$('.subtabs button');
  const showSub = (b) => {
    subtab = b.dataset.sub;
    renderDetail();
  };
  for (const b of subButtons) b.onclick = () => showSub(b);
  tabKeys(subButtons, showSub);
  for (const el of [...$$('[data-runtime]'), $('#wsl-distro')]) {
    el.addEventListener('input', () => {
      settingsDirty = true;
    });
  }
  $('#btn-save-runtime').onclick = async () => {
    const runtime = Object.fromEntries($$('[data-runtime]').map((s) => [s.dataset.runtime, s.value]));
    try {
      await api('/api/config/runtime', { runtime, wsl_distro: $('#wsl-distro').value });
      settingsDirty = false;
      toast('已儲存執行環境');
    } catch (err) {
      toast(err.message, true);
    }
  };
  $('#btn-doctor').onclick = async () => {
    const out = $('#doctor-out');
    out.classList.remove('hidden');
    out.textContent = '檢查中…（每個 CLI 最多 60 秒）';
    $('#btn-doctor').disabled = true;
    try {
      const { lines } = await api('/api/doctor', {});
      out.textContent = lines.join('\n');
    } catch (err) {
      out.textContent = `失敗：${err.message}`;
    } finally {
      $('#btn-doctor').disabled = false;
    }
  };
  $('#btn-prd-new').onclick = () => {
    if (snap?.prd && !confirm('會取代目前的 PRD 草稿，確定？')) return;
    act('/api/prd/new', { idea: $('#idea').value }, '已開始起草 PRD');
  };
  $('#btn-prd-approve').onclick = () => act('/api/prd/approve', {}, 'PRD 已核准');
  $('#btn-prd-revise').onclick = () => act('/api/prd/revise', { feedback: $('#feedback').value }, '已送出修改意見');
  $('#btn-tasks').onclick = () => act('/api/tasks/generate', {}, '已開始產生任務');
  $('#btn-start').onclick = () => act('/api/run/start', {}, '流程已開始');
  $('#btn-pause').onclick = () => act('/api/run/pause', {}, '目前任務結束後會暫停');
  $('#btn-continue').onclick = () => act('/api/run/continue', {}, '繼續');
  $('#d-close').onclick = () => {
    const id = selected;
    selected = null;
    detail = null;
    $('#detail').classList.add('hidden');
    renderBoard();
    // 關閉後把焦點還給原本的任務卡
    const cards = $$('#board .task');
    const card = cards.find((c) => c.querySelector('.id').textContent === `#${id}`);
    card?.focus();
  };
  $('#d-rerun').onclick = () => {
    const revert = $('#d-revert').checked;
    if (revert && !confirm('會還原這個任務的變更後重跑，確定？')) return;
    act('/api/task/rerun', { id: selected, revert }, `任務 ${selected} 重跑中`);
  };
  $('#log-scope').onchange = renderLog;
  for (const b of $$('[data-view]')) {
    b.onclick = () => {
      prdView = b.dataset.view;
      try {
        localStorage.setItem('aipipe-prd-view', prdView);
      } catch {
        // 無法儲存時只在這次頁面生效
      }
      renderPrdBody();
      renderRounds();
    };
  }
  $('#btn-prd-copy').onclick = async () => {
    try {
      await navigator.clipboard.writeText(snap?.prd || '');
      toast('已複製 PRD 原文');
    } catch {
      // 剪貼簿不可用時切到原始模式並選取全文，讓使用者自己複製
      $('[data-view="raw"]').click();
      getSelection().selectAllChildren($('#prd-text'));
      toast('無法存取剪貼簿，已選取原文，請按 Ctrl+C', true);
    }
  };
}

bind();
api('/api/state').then(onState).catch((err) => toast(err.message, true));
loadInitialLogs();
connect();

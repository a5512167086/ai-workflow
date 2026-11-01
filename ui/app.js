'use strict';

// 共用的 $、api、toast、主題等在 common.js。

const STATUS_TEXT = {
  idle: '閒置', queued: '排隊中', running: '執行中', paused: '已暫停', waiting: '等待人工測試',
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
  if (snap.project) document.title = `${snap.project.name} — aipipe`;
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
  $('#prd-md-missing').classList.toggle('hidden', canRender());
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
  $('#runner-info').textContent = alive && st === 'queued'
    ? `排隊等其他專案跑完${state.control.pause_requested ? '・將取消排隊' : '・可以按暫停取消排隊'}`
    : alive
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
  renderBacklog();
  if (prevPrd !== data.state.prd.rounds.length || prevStatus !== data.state.prd.status) {
    loadRounds();
    loadBacklog();
    if (!$('#tab-history').hidden) loadHistory();
  }
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
  const es = new EventSource(apiUrl('/api/events'));
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

// ---------- 需求待辦清單 ----------
const BACKLOG_STATUS = { open: '待辦', in_progress: '進行中', done: '已完成' };
let backlog = [];
let editingId = null;
let dragId = null;

async function loadBacklog() {
  try {
    const data = await api('/api/backlog');
    backlog = data.items;
    $('#bl-path').textContent = data.path;
    renderBacklog();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBacklog() {
  const list = $('#backlog');
  list.innerHTML = '';
  const open = backlog.filter((i) => i.status !== 'done').length;
  $('#tab-backlog-badge').textContent = open || '';
  if (!backlog.length) {
    list.innerHTML = '<li class="empty">還沒有需求，從左邊新增一個</li>';
    return;
  }
  const busy = snap && (snap.prdBusy || snap.runnerAlive || snap.taskGenBusy);
  backlog.forEach((item, i) => {
    const li = document.createElement('li');
    li.className = `bl-item ${item.status}`;
    li.dataset.id = item.id;
    if (editingId === item.id) {
      li.innerHTML = `<div class="bl-edit">
        <label class="field-label" for="ed-title">標題</label><input id="ed-title" type="text" maxlength="200">
        <label class="field-label" for="ed-detail">說明（Markdown）</label><textarea id="ed-detail" rows="5"></textarea>
        <div class="row end"><button type="button" data-act="cancel">取消</button><button type="button" class="primary" data-act="save">${icon('save')}儲存</button></div>
      </div>`;
      li.querySelector('#ed-title').value = item.title;
      li.querySelector('#ed-detail').value = item.detail || '';
      list.append(li);
      li.querySelector('#ed-title').focus();
      return;
    }
    li.draggable = true;
    li.innerHTML = `<span class="grip" aria-hidden="true">${icon('grip')}</span>
      <div class="bl-main">
        <div class="bl-head"><span class="bl-num"></span><b class="bl-title"></b><span class="chip"></span></div>
        <div class="bl-detail md md-sm"></div>
      </div>
      <div class="bl-actions">
        <button type="button" class="icon-btn" data-act="up" aria-label="往上移">${icon('up')}</button>
        <button type="button" class="icon-btn" data-act="down" aria-label="往下移">${icon('down')}</button>
        <button type="button" class="icon-btn" data-act="edit" aria-label="編輯">${icon('edit')}</button>
        <button type="button" class="icon-btn" data-act="delete" aria-label="刪除">${icon('trash')}</button>
        <button type="button" data-act="draft">${icon('sparkle')}起草 PRD</button>
      </div>`;
    li.querySelector('.bl-num').textContent = i + 1;
    li.querySelector('.bl-title').textContent = item.title;
    const chip = li.querySelector('.chip');
    chip.textContent = BACKLOG_STATUS[item.status] || item.status;
    chip.className = `chip bl-${item.status}`;
    const det = li.querySelector('.bl-detail');
    if (item.detail) det.innerHTML = canRender() ? window.renderMarkdown(item.detail) : `<p>${escapeHtml(item.detail)}</p>`;
    else det.remove();
    li.querySelector('[data-act="up"]').disabled = i === 0;
    li.querySelector('[data-act="down"]').disabled = i === backlog.length - 1;
    for (const b of li.querySelectorAll('.bl-actions button')) b.setAttribute('aria-label', `${b.getAttribute('aria-label') || b.textContent.trim()}：${item.title}`);
    li.querySelector('[data-act="draft"]').disabled = busy || item.status === 'done';
    list.append(li);
  });
}

async function moveBacklog(id, delta) {
  const ids = backlog.map((i) => i.id);
  const from = ids.indexOf(id);
  const to = Math.max(0, Math.min(ids.length - 1, from + delta));
  if (from === to) return;
  ids.splice(to, 0, ...ids.splice(from, 1));
  await saveOrder(ids);
  // 鍵盤操作後焦點跟著項目走
  $(`#backlog [data-id="${id}"] [data-act="${delta < 0 ? 'up' : 'down'}"]`)?.focus();
}

async function saveOrder(ids) {
  const data = await act('/api/backlog/reorder', { ids });
  if (data) {
    backlog = data.items;
    renderBacklog();
  }
}

function bindBacklog() {
  $('#bl-add').onclick = async () => {
    const data = await act('/api/backlog/add', { title: $('#bl-title').value, detail: $('#bl-detail').value }, '已新增需求');
    if (data) {
      $('#bl-title').value = '';
      $('#bl-detail').value = '';
      await loadBacklog();
      $('#bl-title').focus();
    }
  };
  $('#bl-title').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) $('#bl-add').click();
  });
  const list = $('#backlog');
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = btn.closest('.bl-item').dataset.id;
    const item = backlog.find((i) => i.id === id);
    switch (btn.dataset.act) {
      case 'up':
        return moveBacklog(id, -1);
      case 'down':
        return moveBacklog(id, 1);
      case 'edit':
        editingId = id;
        return renderBacklog();
      case 'cancel':
        editingId = null;
        return renderBacklog();
      case 'save': {
        const data = await act('/api/backlog/update', { id, title: $('#ed-title').value, detail: $('#ed-detail').value }, '已儲存');
        if (data) {
          editingId = null;
          await loadBacklog();
        }
        return;
      }
      case 'delete':
        if (!confirm(`刪除需求「${item.title}」？`)) return;
        if (await act('/api/backlog/delete', { id }, '已刪除')) await loadBacklog();
        return;
      case 'draft': {
        const msg = snap?.prd
          ? `用「${item.title}」開始新功能並起草 PRD？\n目前的 PRD 會被取代（已核准的 PRD 已保存在封存裡）。`
          : `用「${item.title}」起草 PRD？`;
        if (!confirm(msg)) return;
        if (await act('/api/backlog/draft', { id }, '已開始起草 PRD')) {
          await loadBacklog();
          showTab($('#tabbtn-prd'));
        }
      }
    }
  });
  // 拖曳排序（滑鼠）；鍵盤與觸控用上／下按鈕。
  list.addEventListener('dragstart', (e) => {
    const li = e.target.closest('.bl-item');
    if (!li) return;
    dragId = li.dataset.id;
    li.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', dragId);
  });
  list.addEventListener('dragover', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const over = e.target.closest('.bl-item');
    for (const x of list.querySelectorAll('.drop-before, .drop-after')) x.classList.remove('drop-before', 'drop-after');
    if (!over || over.dataset.id === dragId) return;
    const r = over.getBoundingClientRect();
    over.classList.add(e.clientY < r.top + r.height / 2 ? 'drop-before' : 'drop-after');
  });
  list.addEventListener('dragend', () => {
    dragId = null;
    for (const x of list.querySelectorAll('.dragging, .drop-before, .drop-after')) x.classList.remove('dragging', 'drop-before', 'drop-after');
  });
  list.addEventListener('drop', async (e) => {
    e.preventDefault();
    const over = e.target.closest('.bl-item');
    const id = dragId;
    if (!id || !over || over.dataset.id === id) return;
    const before = over.classList.contains('drop-before');
    const ids = backlog.map((i) => i.id).filter((x) => x !== id);
    ids.splice(ids.indexOf(over.dataset.id) + (before ? 0 : 1), 0, id);
    await saveOrder(ids);
  });
}

// ---------- 歷史功能（封存） ----------
let archives = [];
let currentArchive = null;

async function loadHistory() {
  try {
    const data = await api('/api/archive');
    archives = data.items;
    $('#hist-dir').textContent = data.dir;
    renderHistoryList();
    if (!currentArchive && archives.length) openArchive(archives[0].name);
  } catch (err) {
    toast(err.message, true);
  }
}

function renderHistoryList() {
  const ul = $('#hist-list');
  ul.innerHTML = '';
  if (!archives.length) {
    ul.innerHTML = '<li class="empty">還沒有封存的功能：核准 PRD 後會自動封存</li>';
    return;
  }
  for (const a of archives) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hist-item${currentArchive === a.name ? ' active' : ''}`;
    b.setAttribute('aria-current', currentArchive === a.name ? 'true' : 'false');
    const title = (a.feature || a.idea || a.name).split('\n')[0];
    const prog = a.progress?.total ? `${a.progress.done}/${a.progress.total} 任務` : '尚未產生任務';
    b.innerHTML = '<span class="hist-title"></span><span class="hist-meta"></span>';
    b.querySelector('.hist-title').textContent = title;
    b.querySelector('.hist-meta').textContent = `${a.name.slice(0, 10)}・${prog}${a.completed_at ? '・已完成' : ''}`;
    b.onclick = () => openArchive(a.name);
    li.append(b);
    ul.append(li);
  }
}

async function openArchive(name) {
  currentArchive = name;
  renderHistoryList();
  const box = $('#hist-detail');
  try {
    const a = await api(`/api/archive/${encodeURIComponent(name)}`);
    const m = a.meta || {};
    const title = (m.feature || m.idea || a.name).split('\n')[0];
    const KIND = { draft: '初稿', review: '審查', revise: '修訂', 'user-feedback': '使用者意見' };
    box.innerHTML = `<div class="card-head"><h2 id="hist-title"></h2><span class="hint mono" id="hist-path"></span></div>
      <dl class="meta" id="hist-meta"></dl>
      <h3 class="sub-h">PRD</h3><div class="md doc-frame" id="hist-prd"></div>
      <h3 class="sub-h">每輪紀錄</h3><div class="rounds" id="hist-rounds"></div>
      <h3 class="sub-h">任務清單</h3><div id="hist-tasks"></div>`;
    box.querySelector('#hist-title').textContent = title;
    box.querySelector('#hist-path').textContent = a.path;
    const meta = [
      ['核准時間', m.approved_at ? new Date(m.approved_at).toLocaleString('zh-TW') : '—'],
      ['完成時間', m.completed_at ? new Date(m.completed_at).toLocaleString('zh-TW') : '—'],
      ['Task Master tag', m.tm_tag || '—'],
      ['進度', m.progress?.total ? `${m.progress.done} / ${m.progress.total}` : '—'],
    ];
    for (const [k, v] of meta) {
      const d = document.createElement('div');
      d.innerHTML = '<dt></dt><dd></dd>';
      d.querySelector('dt').textContent = k;
      d.querySelector('dd').textContent = v;
      d.querySelector('dd').title = v;
      box.querySelector('#hist-meta').append(d);
    }
    box.querySelector('#hist-prd').innerHTML = canRender() ? window.renderMarkdown(a.prd) : `<pre>${escapeHtml(a.prd)}</pre>`;
    const rbox = box.querySelector('#hist-rounds');
    if (!a.rounds.length) rbox.innerHTML = '<p class="empty">（沒有紀錄）</p>';
    for (const r of a.rounds) {
      const parts = r.name.replace(/\.md$/, '').split('-');
      const kind = parts[1] === 'user' ? 'user-feedback' : parts[1];
      const d = document.createElement('details');
      d.className = `round ${/approve|pass/i.test(r.name) ? 'APPROVE' : /revise|fail/i.test(r.name) ? 'REVISE' : ''}`;
      const s = document.createElement('summary');
      s.textContent = `${KIND[kind] || kind}・${r.name.replace(/\.md$/, '')}`;
      const body = document.createElement('div');
      body.className = 'md md-sm';
      body.innerHTML = canRender() ? window.renderMarkdown(r.text) : `<pre>${escapeHtml(r.text)}</pre>`;
      d.append(s, body);
      rbox.append(d);
    }
    const tbox = box.querySelector('#hist-tasks');
    if (!a.tasks.length) tbox.innerHTML = '<p class="empty">（沒有任務清單）</p>';
    else {
      const rows = a.tasks
        .map((t) => `<tr><td class="mono">#${escapeHtml(t.id)}</td><td>${escapeHtml(t.title)}</td><td>${escapeHtml(PRIORITY_TEXT[t.priority] || t.priority || '')}</td><td><span class="chip tm-${escapeHtml(t.status)}">${escapeHtml(t.status)}</span></td></tr>`)
        .join('');
      tbox.innerHTML = `<div class="md"><div class="md-table"><table><thead><tr><th>#</th><th>標題</th><th>優先</th><th>狀態</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    }
  } catch (err) {
    box.innerHTML = '';
    toast(err.message, true);
  }
}

function showTab(b) {
  if (b.dataset.tab === 'backlog') loadBacklog();
  if (b.dataset.tab === 'history') loadHistory();
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
  bindTheme();
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
bindBacklog();
api('/api/state').then(onState).catch((err) => toast(err.message, true));
loadInitialLogs();
connect();
loadBacklog();
if (PROJECT_ID) api('/api/projects/open', { id: PROJECT_ID }).catch(() => {});

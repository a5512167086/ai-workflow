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
const COLUMNS = [
  ['todo', '待辦'], ['doing', '進行中'], ['review', '審查中'], ['test', '等待測試'], ['done', '完成'],
];

let snap = null;
let selected = null;
let subtab = 'log';
let detail = null;
const logs = {};

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
  el.textContent = msg;
  el.className = `toast${bad ? ' bad' : ''}`;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.add('hidden'), 4000);
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
  const st = state.pipeline.status;
  const pill = $('#pipeline-status');
  pill.textContent = STATUS_TEXT[st] || st;
  pill.className = `pill ${st}`;
  $('#pipeline-reason').textContent = state.pipeline.reason || '';
  for (const b of $$('.seg button')) b.classList.toggle('on', b.dataset.mode === config.mode);
}

function renderPrd() {
  const { state, prd } = snap;
  $('#prd-status').textContent = PRD_TEXT[state.prd.status] || state.prd.status;
  $('#prd-busy').textContent = snap.prdBusy ? '（AI 處理中，log 在「流程 log」的 prd）' : state.prd.error ? `上次錯誤：${state.prd.error}` : '';
  $('#prd-text').textContent = prd || '（尚無）';
  const busy = snap.prdBusy || snap.runnerAlive || snap.taskGenBusy;
  $('#btn-prd-new').disabled = busy;
  $('#btn-prd-approve').disabled = busy || state.prd.status !== 'awaiting_approval';
  $('#btn-prd-revise').disabled = busy || !prd;
  $('#btn-tasks').disabled = busy || state.prd.status !== 'approved';
  const tg = state.task_gen;
  $('#task-gen').textContent = snap.taskGenBusy ? 'Task Master 產生任務中…'
    : tg?.status === 'done' ? `已產生 ${tg.count} 個任務` : tg?.status === 'error' ? `失敗：${tg.error}` : '';
}

async function loadRounds() {
  try {
    const data = await api('/api/prd');
    const box = $('#prd-rounds');
    box.innerHTML = '';
    if (!data.rounds.length) box.textContent = '（尚無）';
    const KIND = { draft: '初稿', review: '審查', revise: '修訂', user_feedback: '使用者意見' };
    for (const r of data.rounds) {
      const d = document.createElement('details');
      d.className = `round ${r.verdict || ''}`;
      const s = document.createElement('summary');
      s.textContent = `第 ${r.round} 輪・${KIND[r.kind] || r.kind}・${r.provider}${r.verdict ? `・${r.verdict}` : ''}${r.version ? `・v${r.version}` : ''}`;
      const pre = document.createElement('pre');
      pre.textContent = r.text;
      d.append(s, pre);
      box.append(d);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBoard() {
  const { tasks, state } = snap;
  const board = $('#board');
  board.innerHTML = '';
  const cols = Object.fromEntries(COLUMNS.map(([k, label]) => {
    const el = document.createElement('div');
    el.className = 'col';
    el.innerHTML = `<h4><span>${label}</span><span class="muted"></span></h4>`;
    board.append(el);
    return [k, el];
  }));
  const counts = {};
  for (const t of tasks) {
    const ts = state.tasks[String(t.id)];
    const col = column(t, ts);
    counts[col] = (counts[col] || 0) + 1;
    const el = document.createElement('div');
    el.className = `task${ts?.phase === 'stuck' ? ' stuck' : ''}${selected === String(t.id) ? ' selected' : ''}`;
    el.innerHTML = '<div class="id"></div><div class="title"></div><div class="deps"></div><div class="step"></div><div class="err"></div>';
    el.querySelector('.id').textContent = `#${t.id}・${t.priority || ''}・TM:${t.status}`;
    el.querySelector('.title').textContent = t.title;
    el.querySelector('.deps').textContent = t.dependencies?.length ? `依賴：${t.dependencies.map((d) => '#' + d).join(' ')}` : '';
    el.querySelector('.step').textContent = ts?.step ? `${ts.step}${ts.fix_round ? `（修正 ${ts.fix_round}/${snap.config.max_fix_rounds}）` : ''}` : '';
    el.querySelector('.err').textContent = ts?.error || '';
    el.onclick = () => selectTask(String(t.id));
    cols[col].append(el);
  }
  for (const [k, el] of Object.entries(cols)) el.querySelector('h4 .muted').textContent = counts[k] || 0;
  if (!tasks.length) board.insertAdjacentHTML('beforebegin', '');

  const alive = snap.runnerAlive;
  const busy = alive || snap.prdBusy || snap.taskGenBusy;
  const st = state.pipeline.status;
  $('#btn-start').disabled = busy || !tasks.length || state.prd.status !== 'approved';
  $('#btn-pause').disabled = !alive || state.control.pause_requested;
  $('#btn-continue').disabled = busy || !['waiting', 'feature_test', 'stuck', 'error'].includes(st);
  $('#runner-info').textContent = alive
    ? `runner pid ${state.runner.pid}${state.control.pause_requested ? '・將在目前任務結束後暫停' : ''}`
    : !tasks.length ? '還沒有任務：先在 PRD 頁核准並產生任務' : '';
}

async function selectTask(id) {
  selected = id;
  $('#detail').classList.remove('hidden');
  renderBoard();
  await loadDetail();
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
  const meta = [
    ['步驟', ts.step || ts.phase || '未開始'],
    ['修正輪數', `${ts.fix_round || 0} / ${snap.config.max_fix_rounds}`],
    ['嘗試次數', ts.attempts || 0],
    ['驗證', ts.last_check_ok == null ? '—' : ts.last_check_ok ? '通過' : '失敗'],
    ['審查', ts.review_verdict || '—'],
    ['commit', ts.commit ? ts.commit.slice(0, 8) : '—'],
  ];
  $('#d-meta').innerHTML = '';
  for (const [k, v] of meta) {
    const span = document.createElement('span');
    span.innerHTML = `${k}：<b></b>`;
    span.querySelector('b').textContent = v;
    $('#d-meta').append(span);
  }
  $('#d-rerun').disabled = snap.runnerAlive;
  $('#d-revert').parentElement.title = ts.commit ? `會 git revert ${ts.commit.slice(0, 8)}` : '手動模式沒有 commit：會把這個任務改過的檔案還原到任務開始前（之後任務對同檔案的修改也會一起還原）';
  for (const b of $$('.subtabs button')) b.classList.toggle('active', b.dataset.sub === subtab);
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
  body.textContent = logs[$('#log-scope').value] || '';
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

function bind() {
  for (const b of $$('.tabs button')) {
    b.onclick = () => {
      for (const x of $$('.tabs button')) x.classList.toggle('active', x === b);
      for (const s of $$('.tab')) s.classList.toggle('active', s.id === `tab-${b.dataset.tab}`);
    };
  }
  for (const b of $$('.seg button')) {
    b.onclick = () => act('/api/config/mode', { mode: b.dataset.mode }, `已切換為${b.textContent}模式`);
  }
  for (const b of $$('.subtabs button')) {
    b.onclick = () => {
      subtab = b.dataset.sub;
      renderDetail();
    };
  }
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
    selected = null;
    detail = null;
    $('#detail').classList.add('hidden');
    renderBoard();
  };
  $('#d-rerun').onclick = () => {
    const revert = $('#d-revert').checked;
    if (revert && !confirm('會還原這個任務的變更後重跑，確定？')) return;
    act('/api/task/rerun', { id: selected, revert }, `任務 ${selected} 重跑中`);
  };
  $('#log-scope').onchange = renderLog;
}

bind();
api('/api/state').then(onState).catch((err) => toast(err.message, true));
loadInitialLogs();
connect();

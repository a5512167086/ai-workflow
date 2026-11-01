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

const SETTINGS_ONLY = new URLSearchParams(location.search).has('settings');
if (SETTINGS_ONLY) document.body.classList.add('settings-only');
let quotaDismissed = '';
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
let boardView = (() => { try { return localStorage.getItem('aipipe-board-view') === 'roadmap' ? 'roadmap' : 'kanban'; } catch { return 'kanban'; } })();
const COLUMN_LABELS = Object.fromEntries(COLUMNS);

function childTasks(task) {
  return (task.subtasks || []).map(sub => ({ ...sub, id: `${task.id}.${sub.id}`, dependencies: [
    ...(task.dependencies || []), ...(sub.dependencies || []).map(id => String(id).includes('.') ? id : `${task.id}.${id}`),
  ] }));
}

function boardFacts() {
  const all = snap.tasks.flatMap(task => [task, ...childTasks(task)]);
  const stateFor = task => snap.state.tasks[String(task.id)] || {};
  const done = new Set(all.filter(task => column(task, stateFor(task)) === 'done').map(task => String(task.id)));
  const unmet = task => (task.dependencies || []).filter(id => !done.has(String(id)));
  const attention = task => stateFor(task).phase === 'stuck' || task.status === 'blocked' || column(task, stateFor(task)) === 'test';
  const query = $('#board-search').value.trim().toLocaleLowerCase();
  const filter = $('#board-filter').value;
  const matches = task => {
    const state = stateFor(task), stage = column(task, state);
    const text = `${task.id} ${task.title || ''} ${task.description || ''} ${state.step || ''}`.toLocaleLowerCase();
    return (!query || text.includes(query)) && (filter === 'all'
      || filter === 'attention' && attention(task)
      || filter === 'blocked' && stage !== 'done' && unmet(task).length > 0
      || filter === 'active' && ['doing', 'review'].includes(stage)
      || filter === 'done' && stage === 'done');
  };
  return { all, stateFor, done, unmet, attention, matches, visible: snap.tasks.filter(task => [task, ...childTasks(task)].some(matches)), filtered: !!query || filter !== 'all' };
}

function renderBoardOverview(facts) {
  const tasks = snap.tasks;
  $('#board-feature-title').textContent = snap.config.feature || snap.state.prd.idea?.split('\n')[0] || '目前功能';
  const completed = tasks.filter(task => facts.done.has(String(task.id))).length;
  const percent = tasks.length ? Math.round(completed / tasks.length * 100) : 0;
  $('#board-progress').setAttribute('aria-valuenow', percent);
  $('#board-progress').querySelector('span').style.width = `${percent}%`;
  const metrics = [
    ['主線完成', `${completed} / ${tasks.length}`],
    ['進行與審查', tasks.filter(task => facts.stateFor(task).phase !== 'stuck' && ['doing', 'review'].includes(column(task, facts.stateFor(task)))).length],
    ['等待驗收', tasks.filter(task => column(task, facts.stateFor(task)) === 'test').length],
    ['卡住任務', tasks.filter(task => [task, ...childTasks(task)].some(item => facts.stateFor(item).phase === 'stuck' || item.status === 'blocked')).length],
  ];
  $('#board-metrics').innerHTML = metrics.map(([label, value], index) => `<div${index === 3 && value ? ' class="attention"' : ''}><dt>${label}</dt><dd>${value}</dd></div>`).join('');
}

function renderTaskRoadmap(facts) {
  const host = $('#task-roadmap'), keep = host.scrollTop;
  host.replaceChildren();
  for (const task of facts.visible) {
    const children = childTasks(task);
    const state = facts.stateFor(task), stage = column(task, state);
    const completed = children.filter(sub => facts.done.has(String(sub.id))).length;
    const percent = children.length ? Math.round(completed / children.length * 100) : facts.done.has(String(task.id)) ? 100 : 0;
    const group = document.createElement('article'); group.className = 'roadmap-group';
    group.innerHTML = `<button type="button" class="roadmap-parent"><span class="roadmap-heading"><span class="mono roadmap-id">#${escapeHtml(task.id)}</span><strong>${escapeHtml(task.title)}</strong></span><span class="stage-chip stage-${stage}">${COLUMN_LABELS[stage]}</span></button><div class="roadmap-progress" role="progressbar" aria-label="${escapeHtml(task.title)}完成度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${percent}"><span style="width:${percent}%"></span></div><p class="hint roadmap-count">${children.length ? `${completed} / ${children.length} 子任務完成` : '獨立任務'}${facts.unmet(task).length ? ` · ${facts.unmet(task).length} 項依賴未完成` : ''}</p>`;
    const parent = group.querySelector('button');
    parent.dataset.taskId = String(task.id); parent.classList.toggle('selected', selected === String(task.id));
    parent.onclick = () => selectTask(String(task.id));
    for (const sub of children) {
      if (facts.filtered && !facts.matches(sub) && !facts.matches(task)) continue;
      const subState = facts.stateFor(sub), subStage = column(sub, subState);
      const row = document.createElement('button'); row.type = 'button'; row.className = 'roadmap-child'; row.dataset.taskId = sub.id;
      row.classList.toggle('selected', selected === sub.id);
      row.innerHTML = `<span class="stage-dot stage-${subStage}" aria-hidden="true"></span><span class="mono roadmap-id">#${escapeHtml(sub.id)}</span><span class="roadmap-name">${escapeHtml(sub.title)}</span><span class="stage-chip stage-${subStage}">${subState.phase === 'stuck' ? '需要處理' : COLUMN_LABELS[subStage]}</span>`;
      row.onclick = () => selectTask(sub.id); group.append(row);
    }
    host.append(group);
  }
  host.scrollTop = keep;
}

function renderBoardView(facts) {
  const roadmap = boardView === 'roadmap';
  $('.board-wrap').hidden = roadmap;
  $('#task-roadmap').hidden = !roadmap;
  $('.board-canvas').inert = selected !== null && !!window.matchMedia?.('(max-width: 999px)')?.matches;
  for (const button of $$('[data-board-view]')) {
    const active = button.dataset.boardView === boardView;
    button.classList.toggle('on', active); button.setAttribute('aria-checked', String(active));
    button.tabIndex = active ? 0 : -1;
  }
  $('#board-results').textContent = `顯示 ${facts.visible.length} / ${snap.tasks.length} 項主線任務`;
  $('#board-clear').hidden = !facts.filtered;
  const empty = $('#board-empty');
  empty.hidden = !!facts.visible.length;
  empty.textContent = snap.tasks.length ? '沒有符合條件的任務，請調整搜尋或篩選。' : '尚未產生任務。核准 PRD 後會自動建立任務看板與藍圖。';
  if (roadmap) renderTaskRoadmap(facts);
}

function column(task, ts) {
  const phase = ts?.phase;
  // aipipe 自己的階段優先；沒跑過的任務才看 任務引擎的狀態。
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

const tokenNumber = value => typeof value === 'number' ? value.toLocaleString('zh-TW') : '未知';
const WINDOW_NAMES = {
  'Current session': '目前 session（5 小時）', 'Current week (all models)': '本週（所有模型）',
  'Current week (Opus)': '本週（Opus）', 'Current week (Sonnet only)': '本週（Sonnet）',
};
const usageTime = value => value ? new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '（台北）' : '未提供';
function renderUsage(usage = snap?.usage) {
  if (!usage) return;
  $('#usage-short').textContent = `Tokens：${tokenNumber(usage.totalTokens)}`;
  $('#usage-total').textContent = tokenNumber(usage.totalTokens);
  $('#usage-coverage').textContent = `／${usage.measuredSessions} 次有統計，${usage.unknownSessions} 次未回報`;
  const host = $('#usage-providers'); host.replaceChildren();
  const paragraph = (parent, text, className = '') => {
    const element = document.createElement('p'); element.textContent = text; element.className = className; parent.append(element); return element;
  };
  for (const provider of usage.providers) {
    const card = document.createElement('section'); card.className = 'card';
    const heading = document.createElement('h2'); heading.textContent = `${provider.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${provider.runtime}${provider.distro ? ` / ${provider.distro}` : ''}`; card.append(heading);
    paragraph(card, `本專案處理量：${tokenNumber(provider.tokens)} tokens`);
    const latest = provider.latest;
    paragraph(card, `最近執行：${latest?.label || '尚無紀錄'}${latest?.status === 'running' ? '（執行中）' : ''}`);
    paragraph(card, `本次輸入 ${tokenNumber(latest?.tokens?.inputTokens)} ／輸出 ${tokenNumber(latest?.tokens?.outputTokens)} tokens`);
    paragraph(card, `輸入內含快取讀取 ${tokenNumber(latest?.tokens?.cacheReadTokens)} ／快取寫入 ${tokenNumber(latest?.tokens?.cacheWriteTokens)}`, 'hint');
    const quotaHeading = document.createElement('h3'); quotaHeading.textContent = '訂閱額度剩餘'; card.append(quotaHeading);
    const windows = provider.limits?.windows || [];
    if (!windows.length) paragraph(card, provider.limits?.error || '未知：按「更新訂閱額度」查詢', 'hint');
    for (const window of windows) {
      const remaining = window.expired ? null : window.remainingPercent;
      const duration = window.windowMinutes ? `（${window.windowMinutes % 1440 === 0 ? window.windowMinutes / 1440 + ' 天' : window.windowMinutes % 60 === 0 ? window.windowMinutes / 60 + ' 小時' : window.windowMinutes + ' 分鐘'}視窗）` : '';
      const name = WINDOW_NAMES[window.name] || window.name;
      paragraph(card, `${name}${duration}：${typeof remaining === 'number' ? remaining.toFixed(1) + '%' : '未知'}${window.status === 'rejected' && !window.expired ? ' · 已觸及限額' : ''}`);
      if (typeof remaining === 'number') {
        const meter = document.createElement('progress'); meter.max = 100; meter.value = remaining;
        meter.setAttribute('aria-label', `${name} 訂閱額度剩餘百分比`); card.append(meter);
      }
      paragraph(card, `重設：${window.resetsText || usageTime(window.resetsAt)}${window.expired ? '；視窗已過期，請更新' : ''}`, 'hint');
    }
    if (provider.limits?.checkedAt) paragraph(card, `額度資料擷取：${usageTime(provider.limits.checkedAt)} · ${provider.provider === 'codex' ? 'Codex 官方查詢' : 'Claude CLI'}・所有專案共用`, 'hint');
    const context = latest?.context;
    if (context && Number.isFinite(context.remainingPercent)) {
      const contextHeading = document.createElement('h3'); contextHeading.textContent = '最近一次請求的 context 剩餘'; card.append(contextHeading);
      paragraph(card, `${context.remainingPercent.toFixed(1)}% · ${tokenNumber(context.remainingTokens)} / ${tokenNumber(context.capacity)} tokens${context.estimated ? '（依最後一次模型請求估算）' : '（CLI 回報）'}`, 'hint');
    }
    host.append(card);
  }
  const rows = $('#usage-recent'); rows.replaceChildren();
  for (const session of usage.recent) {
    const row = document.createElement('tr');
    for (const value of [session.label, `${session.provider} / ${session.runtime}`, session.status === 'running' ? '執行中' : session.status === 'done' ? '完成' : '失敗', tokenNumber(session.tokens?.inputTokens), tokenNumber(session.tokens?.outputTokens), tokenNumber(session.tokens?.totalTokens)]) {
      const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
    }
    rows.append(row);
  }
}
let usageRefreshBusy = false, lastUsageRefresh = 0;
async function refreshUsage() {
  if (usageRefreshBusy) return;
  usageRefreshBusy = true; $('#btn-usage-refresh').disabled = true;
  $('#usage-refresh-status').textContent = '正在查詢 Claude 與 Codex 的訂閱額度（不會啟動模型對話、不耗額度）…';
  try {
    const usage = await api('/api/usage/refresh', {}); lastUsageRefresh = Date.now();
    if (snap) snap.usage = usage; renderUsage(usage);
    $('#usage-refresh-status').textContent = '查詢結果如下；百分比是擷取當時的快照，其他工具的使用也會影響訂閱額度。';
  } catch (error) { $('#usage-refresh-status').textContent = error.message; }
  finally { usageRefreshBusy = false; $('#btn-usage-refresh').disabled = false; }
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
  const busyText = snap.prdBusy ? 'AI 處理中，可在「紀錄 → Log → PRD」查看輸出' : state.prd.error ? `上次錯誤：${state.prd.error}` : '';
  busyEl.textContent = busyText;
  busyEl.classList.toggle('hidden', !busyText);
  busyEl.classList.toggle('bad', !snap.prdBusy && !!state.prd.error);
  renderPrdBody();
  const busy = snap.prdBusy || snap.runnerAlive || snap.taskGenBusy;

  $('#btn-prd-approve').disabled = busy || state.prd.status !== 'awaiting_approval';
  $('#btn-prd-revise').disabled = busy || !prd;
  $('#btn-tasks').disabled = busy || state.prd.status !== 'approved';
  $('#btn-tasks').hidden = state.task_gen?.status !== 'error';
  const tg = state.task_gen;
  $('#task-gen').textContent = (snap.taskGenBusy || tg?.status === 'running') ? 'AI 產生任務中…'
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
    if (!$('#tab-records').hidden && recSel === null && recSub === 'rounds') renderRecords();
  } catch (err) {
    toast(err.message, true);
  }
}

function renderBoard() {
  const { tasks, state } = snap;
  const focusedTask = document.activeElement?.dataset.taskId;
  const facts = boardFacts();
  renderBoardOverview(facts);
  const board = $('#board');
  // 重畫前記下捲動位置：點任務卡或收到狀態更新時不要跳回最上面。
  const scrolls = Object.fromEntries($$('#board .col').map((c) => [c.dataset.col, c.scrollTop]));
  const wrapLeft = $('.board-wrap').scrollLeft;
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
  const doneIds = facts.done;
  const counts = {};
  for (const t of tasks) {
    const ts = state.tasks[String(t.id)];
    const col = column(t, ts);
    counts[col] = (counts[col] || 0) + 1;
    if (!facts.visible.includes(t)) continue;
    const stuck = ts?.phase === 'stuck';
    const el = document.createElement('button');
    el.type = 'button';
    el.className = `task${stuck ? ' stuck' : ''}${selected === String(t.id) ? ' selected' : ''}`;
    el.dataset.taskId = String(t.id);
    el.dataset.priority = ['high', 'medium', 'low'].includes(t.priority) ? t.priority : 'medium';
    el.setAttribute('aria-pressed', String(selected === String(t.id)));
    el.innerHTML = '<div class="t-top"><span class="id"></span><span class="tag prio"></span><span class="tag tm"></span></div>'
      + '<div class="title"></div><div class="deps"></div><div class="step"></div><div class="err"></div>';
    el.querySelector('.id').textContent = `#${t.id}`;
    const prio = el.querySelector('.prio');
    if (t.priority) {
      prio.textContent = `${PRIORITY_TEXT[t.priority] || t.priority}優先`;
      prio.classList.add(t.priority);
    } else prio.remove();
    el.querySelector('.tm').textContent = stuck ? '需要處理' : COLUMN_LABELS[col];
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
    const flags = document.createElement('div'); flags.className = 'card-flags';
    const children = childTasks(t), remaining = facts.unmet(t).length;
    if (remaining && col !== 'done') flags.innerHTML += `<span class="flag blocked">${remaining} 項依賴未完成</span>`;
    if (col === 'test') flags.innerHTML += '<span class="flag human">需要人工驗收</span>';
    if (children.length) flags.innerHTML += `<span class="flag">子任務 ${children.filter(sub => doneIds.has(sub.id)).length}/${children.length}</span>`;
    if (ts?.last_check_ok != null) flags.innerHTML += `<span class="flag ${ts.last_check_ok ? 'passed' : 'blocked'}">驗證${ts.last_check_ok ? '通過' : '失敗'}</span>`;
    el.append(flags);
    el.onclick = () => selectTask(String(t.id));
    cols[col].append(el);
  }
  for (const [k, el] of Object.entries(cols)) {
    const visible = el.querySelectorAll('.task').length;
    el.querySelector('h3 .count').textContent = facts.filtered ? `${visible} / ${counts[k] || 0}` : counts[k] || 0;
    if (!visible) el.insertAdjacentHTML('beforeend', `<p class="empty">${facts.filtered ? '此欄沒有符合的任務' : '此階段尚無任務'}</p>`);
    if (scrolls[k]) el.scrollTop = scrolls[k];
  }
  $('.board-wrap').scrollLeft = wrapLeft;

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
  renderBoardView(facts);
  if (focusedTask) {
    const host = boardView === 'roadmap' ? $('#task-roadmap') : $('#board');
    $$('[data-task-id]', host).find(button => button.dataset.taskId === focusedTask)?.focus({ preventScroll: true });
  }
}

async function selectTask(id) {
  const first = selected !== id;
  selected = id;
  if (first) {
    detail = null;
    $('#d-title').textContent = `載入任務 #${id}`;
    $('#d-meta').replaceChildren(); $('#d-gates').replaceChildren();
    $('#d-body').textContent = '載入中…'; $('#d-rerun').disabled = true;
  }
  $('#detail').classList.remove('hidden');
  renderBoard();
  await loadDetail();
  if (first && selected === id) $('#d-title').focus({ preventScroll: true });
}

async function loadDetail() {
  if (!selected) return;
  const id = selected;
  try {
    const data = await api(`/api/task/${id}`);
    if (selected !== id) return;
    detail = data;
    logs[`task-${id}`] = detail.log;
    renderDetail();
  } catch (err) {
    if (selected !== id) return;
    $('#d-title').textContent = `任務 #${id} 載入失敗`;
    const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = '重新讀取'; retry.onclick = loadDetail;
    $('#d-body').replaceChildren(document.createTextNode(`${err.message} `), retry);
    toast(err.message, true);
  }
}

function renderDetail() {
  if (!detail) return;
  if (typeof renderReferenceWidgets === 'function') renderReferenceWidgets();
  const ts = detail.state || {};
  const t = detail.task || {};
  $('#d-title').textContent = `#${detail.id} ${t.title || ''}`;
  const hasChecks = Object.values(snap.config.commands || {}).some(value => typeof value === 'string' && value.trim()) || !!detail.checks?.trim();
  const check = !hasChecks ? ['未設定指令', ''] : ts.last_check_ok == null ? ['尚未執行', ''] : ts.last_check_ok ? ['通過', 'ok'] : ['失敗', 'bad'];
  const meta = [
    ['步驟', ts.step || ts.phase || '未開始'],
    ['修正輪數', `${ts.fix_round || 0} / ${snap.config.max_fix_rounds}`],
    ['嘗試次數', ts.attempts || 0],
    ['驗證', ...check],
    ['審查', ts.review_verdict && ts.review_verdicts ? Object.entries(ts.review_verdicts).map(([p, v]) => `${PROVIDER_LABEL[p] || p} ${v}`).join(' · ') : ts.review_verdict || '—',
      ts.review_verdict === 'PASS' || ts.review_verdict === 'APPROVE' ? 'ok' : ts.review_verdict ? 'bad' : ''],
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
  renderTaskGates(t, ts);
  for (const b of $$('[data-sub]')) {
    const on = b.dataset.sub === subtab;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  const body = $('#d-body');
  body.classList.toggle('lg-host', subtab === 'log');
  if (subtab === 'log') return renderLogTree(body, logs[`task-${detail.id}`]);
  if (subtab === 'reviews') return body.replaceChildren(reviewsView(detail.reviews));
  const pre = document.createElement('pre');
  pre.className = 'plain';
  pre.textContent = {
    checks: detail.checks || '（尚未執行驗證）',
    diff: detail.diff || '（尚無 diff）',
    task: JSON.stringify(t, null, 2) + (detail.implement ? `\n\n===== 實作回報 =====\n${detail.implement}` : ''),
  }[subtab];
  body.replaceChildren(pre);
}

function renderTaskGates(task, state) {
  const done = boardFacts().done;
  const missing = (task.dependencies || []).filter(id => !done.has(String(id)));
  const checksConfigured = Object.values(snap.config.commands || {}).some(value => typeof value === 'string' && value.trim());
  const verified = state.last_check_ok != null && (checksConfigured || detail?.checks?.trim());
  const review = state.review_verdict;
  const humanDone = state.step === '人工測試通過' || snap.state.pipeline.status === 'complete' && column(task, state) === 'done';
  const gates = [
    ['依賴', missing.length ? `尚有 ${missing.length} 項未完成` : '已滿足', missing.length ? 'pending' : 'pass'],
    ['驗證', verified ? state.last_check_ok ? '通過' : '失敗' : checksConfigured ? '尚未執行' : '未設定驗證指令', verified ? state.last_check_ok ? 'pass' : 'fail' : 'pending'],
    ['審查', review ? ['PASS', 'APPROVE'].includes(review) ? '通過' : '未通過' : '尚未審查', review ? ['PASS', 'APPROVE'].includes(review) ? 'pass' : 'fail' : 'pending'],
    ['人工驗收', humanDone ? '已確認' : '等待人工確認', humanDone ? 'pass' : 'pending'],
  ];
  $('#d-gates').innerHTML = gates.map(([label, text, status]) => `<li class="gate-${status}"><span class="gate-mark" aria-hidden="true">${status === 'pass' ? icon('check') : status === 'fail' ? icon('alert') : '—'}</span><span><b>${label}</b><span>${text}</span></span></li>`).join('');
}

function verdictOf(text) {
  return [...String(text || '').matchAll(/VERDICT\s*\**\s*[:：]\s*\**\s*([A-Z_]+)/gi)].at(-1)?.[1].toUpperCase() || '';
}

function markdownBlock(text) {
  const div = document.createElement('div');
  div.className = 'md md-sm';
  div.innerHTML = canRender() ? window.renderMarkdown(text || '') : `<pre>${escapeHtml(text || '')}</pre>`;
  return div;
}

/** 每次審查一列（最新的在上面）；雙人審查時 Claude 與 Codex 的意見並排。 */
function reviewsView(reviews) {
  const frag = document.createDocumentFragment();
  if (!reviews.length) {
    frag.append(Object.assign(document.createElement('p'), { className: 'empty', textContent: '（尚無審查意見）' }));
    return frag;
  }
  const byRound = new Map();
  for (const r of reviews) byRound.set(r.round, [...(byRound.get(r.round) || []), r]);
  for (const [round, list] of [...byRound].reverse()) {
    const sec = document.createElement('section');
    sec.className = 'review-round';
    const h = document.createElement('h4');
    h.textContent = `第 ${round} 次審查${list.length > 1 ? '・雙人審查' : ''}`;
    const pair = document.createElement('div');
    pair.className = `review-pair cols-${list.length}`;
    for (const r of list) {
      const col = document.createElement('div');
      const verdict = verdictOf(r.text);
      col.className = `review-col ${verdict}`;
      const head = document.createElement('div');
      head.className = 'review-head';
      head.innerHTML = '<span class="lg-who"></span><span class="chip"></span>';
      const who = head.querySelector('.lg-who');
      who.textContent = PROVIDER_LABEL[r.provider] || '審查者';
      if (r.provider) who.classList.add(r.provider);
      head.querySelector('.chip').textContent = verdict || '未判定';
      col.append(head, markdownBlock(r.text));
      pair.append(col);
    }
    sec.append(h, pair);
    frag.append(sec);
  }
  return frag;
}

function renderLogSelect() {
  const sel = $('#log-scope');
  const scopes = Object.keys(logs).sort();
  const cur = sel.value || 'runner';
  sel.innerHTML = '';
  for (const s of scopes) {
    const o = document.createElement('option');
    o.value = s;
    o.textContent = LOG_SCOPE_LABELS[s] || s.replace(/^task-/, '任務 ').replace(/^skill-.*/, 'Skill 會議');
    sel.append(o);
  }
  if (scopes.includes(cur)) sel.value = cur;
  renderLog();
}

function renderLog() {
  if ($('#tab-records').hidden || recSel !== null || recSub !== 'log') return;
  renderLogTree($('#rec-body'), logs[$('#log-scope').value]);
}

let settingsDirty = false;
function renderSettings() {
  const { config } = snap;
  $('#config-json').textContent = JSON.stringify(config, null, 2);
  if (settingsDirty) return; // 不覆蓋使用者還沒儲存的選擇
  for (const s of $$('[data-runtime]')) s.value = config.runtime?.[s.dataset.runtime] || 'auto';
  renderModels();
}

let detailTimer = null;
function onState(data) {
  const skillChanged = snap?.state.skill_job?.id !== data.state.skill_job?.id || snap?.skillBusy !== data.skillBusy;
  const prevPrd = snap?.state.prd.rounds.length;
  const prevStatus = snap?.state.prd.status;
  snap = data;
  if (typeof renderReferenceWidgets === 'function') renderReferenceWidgets();
  if (typeof renderChatContext === 'function') renderChatContext();
  const blocked = data.state.usage_blocked;
  $('#quota-notice').hidden = !blocked || quotaDismissed === JSON.stringify(blocked) || data.runnerAlive || !['stuck', 'error'].includes(data.state.pipeline.status);
  $('#quota-message').textContent = blocked ? `${blocked.message}。可確認後改用另一個 AI 繼續；實作與審查會分開建立 session。` : '';
  if (skillChanged) loadSkillRuns().catch(err => toast(err.message, true));
  $('#skill-run').disabled = !!(data.skillBusy || data.runnerAlive || data.prdBusy || data.taskGenBusy);
  renderSettings();
  renderTop();
  renderUsage();
  renderPrd();
  renderBoard();
  renderBacklog();
  if (prevPrd !== data.state.prd.rounds.length || prevStatus !== data.state.prd.status) {
    loadRounds();
    loadBacklog();
    if (!$('#tab-records').hidden) loadHistory();
  }
  if (!$('#tab-records').hidden && recSel === null && recSub !== 'log') renderRecords();
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
  subscribe({
    state: onState,
    log: ({ scope, text }) => {
      const isNew = !(scope in logs);
      logs[scope] = (logs[scope] || '') + text;
      if (logs[scope].length > 400000) logs[scope] = logs[scope].slice(-300000);
      if (isNew) renderLogSelect();
      else if ($('#log-scope').value === scope) renderLog();
      if (scope.startsWith('chat-') && typeof renderChatLive === 'function') renderChatLive();
      if (detail && scope === `task-${detail.id}` && subtab === 'log') renderDetail();
    },
    error: ({ message }) => {
      $('#pipeline-reason').textContent = `讀取專案狀態失敗：${message}`;
    },
  }).catch((err) => toast(err.message ?? String(err), true));
}

// ---------- 需求待辦清單 ----------
const BACKLOG_STATUS = { open: '待辦', in_progress: '進行中', done: '已完成' };
let backlog = [];
let editingId = null;
let dragId = null;

async function loadBacklog() {
  try {
    const data = await api('/api/backlog');
    $('#bl-error').hidden = true;
    backlog = data.items;
    $('#bl-path').textContent = data.path;
    renderBacklog();
  } catch (err) {
    $('#bl-error').hidden = false;
    $('#bl-error').textContent = err.message;
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
        <button type="button" data-act="references">參考</button>
        <button type="button" class="icon-btn" data-act="edit" aria-label="編輯">${icon('edit')}</button>
        <button type="button" class="icon-btn" data-act="delete" aria-label="刪除">${icon('trash')}</button>
        <button type="button" data-act="draft">${icon('sparkle')}起草 PRD</button>
      </div>`;
    li.querySelector('.bl-num').textContent = i + 1;
    li.querySelector('.bl-title').textContent = item.title;
    li.querySelector('[data-act=references]').textContent = `參考 ${item.references?.length || 0}`;
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
    const data = await act('/api/backlog/add', { title: $('#bl-title').value, detail: $('#bl-detail').value, references: referenceDraft('backlog') }, '已新增需求');
    if (data) {
      $('#bl-title').value = '';
      $('#bl-detail').value = '';
      referenceDrafts.delete('backlog'); renderReferenceWidgets();
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
      case 'references':
        return openReferenceDialog({ title: `需求參考：${item.title}`, target: 'backlog', id, ids: item.references || [] });
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

const LOG_SCOPE_LABELS = { runner: '流程', prd: 'PRD', tasks: '拆任務', process: '背景程序' };
let recSel = null; // null＝目前功能，否則是封存資料夾名稱
let recSub = 'log';
let recArchive = null;

async function loadHistory() {
  try {
    const data = await api('/api/archive');
    archives = data.items;
    $('#hist-dir').textContent = data.dir;
    renderHistoryList();
    renderRecords();
  } catch (err) {
    toast(err.message, true);
  }
}

function histButton(title, meta, active, onclick) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hist-item${active ? ' active' : ''}`;
  b.setAttribute('aria-current', active ? 'true' : 'false');
  b.innerHTML = '<span class="hist-title"></span><span class="hist-meta"></span>';
  b.querySelector('.hist-title').textContent = title;
  b.querySelector('.hist-meta').textContent = meta;
  b.onclick = onclick;
  li.append(b);
  return li;
}

function currentTitle() {
  return (snap?.config.feature || snap?.state.prd.idea || '目前功能').split('\n')[0];
}

function renderHistoryList() {
  const ul = $('#hist-list');
  ul.innerHTML = '';
  if (snap) {
    const done = snap.tasks.filter((x) => x.status === 'done').length;
    const prog = snap.tasks.length ? `${done}/${snap.tasks.length} 任務` : '尚未產生任務';
    ul.append(histButton(currentTitle(), `目前功能・${prog}`, recSel === null, () => openCurrent()));
  }
  // 目前功能核准後也會有封存，避免重複列出。
  const currentDir = snap?.state.prd.archive_dir || '';
  const past = archives.filter((a) => !currentDir.endsWith(`/${a.name}`));
  const sep = document.createElement('li');
  sep.className = 'hist-sep';
  sep.textContent = past.length ? '歷史功能' : '還沒有歷史功能：核准 PRD 後會自動封存';
  ul.append(sep);
  for (const a of past) {
    const title = (a.feature || a.idea || a.name).split('\n')[0];
    const prog = a.progress?.total ? `${a.progress.done}/${a.progress.total} 任務` : '尚未產生任務';
    ul.append(histButton(title, `${a.name.slice(0, 10)}・${prog}${a.completed_at ? '・已完成' : ''}`, recSel === a.name, () => openArchive(a.name)));
  }
}

function openCurrent() {
  recSel = null;
  recArchive = null;
  renderHistoryList();
  renderRecords();
}

async function openArchive(name) {
  recSel = name;
  recArchive = null;
  if (recSub === 'log') recSub = 'prd';
  renderHistoryList();
  try {
    const archive = await api(`/api/archive/${encodeURIComponent(name)}`);
    if (recSel !== name) return;
    recArchive = archive;
    renderRecords();
  } catch (err) {
    toast(err.message, true);
  }
}

function setMeta(dl, rows) {
  dl.innerHTML = '';
  for (const [k, v] of rows) {
    const d = document.createElement('div');
    d.innerHTML = '<dt></dt><dd></dd>';
    d.querySelector('dt').textContent = k;
    d.querySelector('dd').textContent = v;
    d.querySelector('dd').title = v;
    dl.append(d);
  }
}

function roundsView(list) {
  const box = document.createElement('div');
  box.className = 'rounds';
  if (!list.length) box.innerHTML = '<p class="empty">（沒有紀錄）</p>';
  for (const r of list) {
    const d = document.createElement('details');
    d.className = `round ${r.verdict || ''}`;
    const s = document.createElement('summary');
    s.textContent = r.title;
    d.append(s, markdownBlock(r.text));
    box.append(d);
  }
  return box;
}

function tasksView(tasks, states = {}) {
  const box = document.createElement('div');
  if (!tasks.length) {
    box.innerHTML = '<p class="empty">（沒有任務清單）</p>';
    return box;
  }
  const rows = tasks.map((x) => {
    const ts = states[String(x.id)];
    const step = ts ? `${ts.phase}${ts.step ? `：${ts.step}` : ''}` : '';
    return `<tr><td class="mono">#${escapeHtml(x.id)}</td><td>${escapeHtml(x.title)}</td><td>${escapeHtml(PRIORITY_TEXT[x.priority] || x.priority || '')}</td><td><span class="chip tm-${escapeHtml(x.status)}">${escapeHtml(x.status)}</span></td><td>${escapeHtml(step)}</td></tr>`;
  }).join('');
  box.innerHTML = `<div class="md"><div class="md-table"><table><thead><tr><th>#</th><th>標題</th><th>優先</th><th>狀態</th><th>目前步驟</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
  return box;
}

const ROUND_KIND = { draft: '初稿', review: '審查', revise: '修訂', user_feedback: '使用者意見', 'user-feedback': '使用者意見' };

/** 紀錄分頁右側：目前功能（含即時 log）或某個封存的歷史功能。 */
function renderRecords() {
  if (!snap) return;
  const current = recSel === null;
  if (!current && !recArchive) return;
  const m = current ? {} : recArchive.meta || {};
  $('#rec-title').textContent = current ? currentTitle() : (m.feature || m.idea || recArchive.name).split('\n')[0];
  $('#rec-path').textContent = current ? (snap.state.prd.archive_dir || '') : recArchive.path;
  const time = (v) => (v ? new Date(v).toLocaleString('zh-TW') : '—');
  setMeta($('#rec-meta'), current ? [
    ['PRD', snap.state.prd.status],
    ['流程', snap.state.pipeline.status],
    ['進度', snap.tasks.length ? `${snap.tasks.filter((x) => x.status === 'done').length} / ${snap.tasks.length}` : '—'],
  ] : [
    ['核准時間', time(m.approved_at)],
    ['完成時間', time(m.completed_at)],
    ['任務群組', m.tm_tag || '—'],
    ['進度', m.progress?.total ? `${m.progress.done} / ${m.progress.total}` : '—'],
  ]);
  if (!current && recSub === 'log') recSub = 'prd';
  for (const b of $$('[data-rec]')) {
    const on = b.dataset.rec === recSub;
    b.hidden = b.dataset.rec === 'log' && !current; // 封存的功能沒有 log
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
    b.tabIndex = on ? 0 : -1;
  }
  $('#rec-log-tools').hidden = recSub !== 'log';
  const body = $('#rec-body');
  body.classList.toggle('lg-host', recSub === 'log');
  if (recSub === 'log') return renderLogTree(body, logs[$('#log-scope').value]);
  const keep = body.scrollTop;
  if (recSub === 'prd') {
    const text = current ? snap.prd : recArchive.prd;
    const doc = markdownBlock(text || '（還沒有 PRD）');
    doc.classList.remove('md-sm');
    body.replaceChildren(doc);
  } else if (recSub === 'rounds') {
    const list = current
      ? rounds.map((r) => ({
        title: `第 ${r.round} 輪・${ROUND_KIND[r.kind] || r.kind}・${PROVIDER_LABEL[r.provider] || r.provider}${r.verdict ? `・${r.verdict}` : ''}${r.version ? `・v${r.version}` : ''}`,
        verdict: r.verdict, text: r.text,
      }))
      : recArchive.rounds.map((r) => {
        const parts = r.name.replace(/\.md$/, '').split('-');
        const kind = parts[1] === 'user' ? 'user-feedback' : parts[1];
        return { title: `${ROUND_KIND[kind] || kind}・${r.name.replace(/\.md$/, '')}`, verdict: /approve|pass/i.test(r.name) ? 'APPROVE' : /revise|fail/i.test(r.name) ? 'REVISE' : '', text: r.text };
      });
    body.replaceChildren(roundsView(list));
  } else {
    body.replaceChildren(current ? tasksView(snap.tasks, snap.state.tasks) : tasksView(recArchive.tasks));
  }
  body.scrollTop = keep;
}

// ---------- 設定：AI 角色與模型 ----------
const ROLE_LABELS = { author: 'PRD 作者', reviewer: 'PRD 審查', task_planner: '拆任務', implementer: '實作', fixer: '修正', code_reviewer: '程式碼審查', handover: 'Handover（交接紀錄）', chat: '專案對話' };
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
let modelOptions = null;
let modelDraft = null;
let modelsDirty = false;

async function loadModels() {
  if (modelOptions) return;
  $('#models-status').textContent = '正在從 CLI 讀取可用的模型…';
  try {
    modelOptions = await api('/api/models');
    for (const p of ['claude', 'codex']) {
      $(`#models-${p}`).replaceChildren(...modelOptions[p].models.map((m) => Object.assign(document.createElement('option'), { value: m.id, label: m.name })));
    }
    $('#models-status').textContent = modelOptions.codex.error || '';
    renderModels();
    if (typeof renderChatOptions === 'function') renderChatOptions();
  } catch (err) {
    $('#models-status').textContent = err.message;
  }
}

function effortsFor(provider, model) {
  if (provider === 'claude') return CLAUDE_EFFORTS;
  const list = modelOptions?.codex.models || [];
  const found = list.find((m) => m.id === model) || list.find((m) => m.default);
  return found?.efforts?.length ? found.efforts : [...new Set(list.flatMap((m) => m.efforts || []))];
}

function renderModels(force = false) {
  if (!snap) return;
  if (!force && $('#role-models').contains(document.activeElement)) return;
  if (!modelsDirty) {
    modelDraft = { roles: structuredClone(snap.config.roles), models: structuredClone(snap.config.models || {}) };
    for (const [role, parent] of [['task_planner', 'author'], ['fixer', 'implementer'], ['handover', 'implementer'], ['chat', 'author']]) {
      modelDraft.roles[role] ??= modelDraft.roles[parent];
      modelDraft.models[role] ??= structuredClone(modelDraft.models[parent] || {});
    }
  }
  const box = $('#role-models');
  box.replaceChildren();
  for (const [role, label] of Object.entries(ROLE_LABELS)) {
    const row = document.createElement('fieldset');
    row.className = 'role-row';
    const legend = document.createElement('legend');
    legend.textContent = label;
    const pick = document.createElement('select');
    pick.setAttribute('aria-label', `${label} 使用的 AI`);
    const choices = [['claude', 'Claude Code'], ['codex', 'Codex']];
    if (role === 'reviewer' || role === 'code_reviewer') choices.push(['both', '雙人審查（Claude ＋ Codex）']);
    for (const [v, text] of choices) pick.append(new Option(text, v, false, modelDraft.roles[role] === v));
    pick.onchange = () => {
      modelDraft.roles[role] = pick.value;
      modelsDirty = true;
      renderModels(true);
    };
    row.append(legend, pick);
    const providers = modelDraft.roles[role] === 'both' ? ['claude', 'codex'] : [modelDraft.roles[role]];
    for (const p of providers) {
      const cur = modelDraft.models?.[role]?.[p] || { model: '', effort: '' };
      const line = document.createElement('div');
      line.className = 'model-line';
      const who = document.createElement('span');
      who.className = `lg-who ${p}`;
      who.textContent = PROVIDER_LABEL[p];
      const model = document.createElement('input');
      model.type = 'text';
      model.setAttribute('list', `models-${p}`);
      model.placeholder = `預設（${snap.config[p]?.model || 'CLI 預設'}）`;
      model.placeholder = '沿用預設';
      model.title = '可選擇完整版本或直接輸入模型 ID';
      model.value = cur.model || '';
      model.setAttribute('aria-label', `${label}：${PROVIDER_LABEL[p]} 模型`);
      const effort = document.createElement('select');
      effort.setAttribute('aria-label', `${label}：${PROVIDER_LABEL[p]} 推理強度`);
      const fillEfforts = () => {
        const options = effortsFor(p, model.value);
        effort.replaceChildren(new Option('推理強度：預設', ''), ...options.map((e) => new Option(e, e)));
        if (cur.effort && !options.includes(cur.effort)) effort.append(new Option(cur.effort, cur.effort));
        effort.value = cur.effort || '';
      };
      fillEfforts();
      const save = () => {
        modelDraft.models[role] ??= {};
        modelDraft.models[role][p] = { model: model.value.trim(), effort: effort.value };
        cur.model = model.value.trim();
        cur.effort = effort.value;
        modelsDirty = true;
      };
      model.addEventListener('input', save);
      model.addEventListener('change', () => { save(); fillEfforts(); });
      effort.addEventListener('change', save);
      const defaults = document.createElement('p');
      defaults.className = 'hint model-defaults';
      const providerInfo = modelOptions?.[p];
      const defaultEntry = providerInfo?.models.find(m => m.default);
      const defaultModel = snap.config[p]?.model || providerInfo?.defaultModel || defaultEntry?.id;
      const defaultEffort = snap.config[p]?.effort || providerInfo?.defaultEffort || defaultEntry?.defaultEffort;
      defaults.textContent = `預設模型：${defaultModel || 'CLI 依帳號決定（未回報）'}；預設推理強度：${defaultEffort || 'CLI 依模型決定（未回報）'}。來源：${snap.config[p]?.model || snap.config[p]?.effort ? '.aipipe.json' : providerInfo?.defaultSource || 'CLI 模型清單'}。`;
      line.append(who, model, effort);
      row.append(line);
      row.append(defaults);
    }
    box.append(row);
  }
}
function showTab(b) {
  if (!b) return;
  if (b.dataset.tab === 'settings' && !SETTINGS_ONLY) { location.href = `overview.html#settings=${PROJECT_ID}`; return; }
  if (b.dataset.tab === 'chat' && typeof loadChatHome === 'function') { loadChatHome(); loadModels(); }
  if (b.dataset.tab === 'settings') loadQueue();
  if (b.dataset.tab === 'usage' && Date.now() - lastUsageRefresh > 60000) refreshUsage();
  if (b.dataset.tab === 'skills') loadSkills().catch(err => toast(err.message, true));
  if (b.dataset.tab === 'backlog') loadBacklog();
  if (b.dataset.tab === 'records') loadHistory();
  if (b.dataset.tab === 'settings') loadModels();
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

async function loadQueue() {
  try {
    const { queue } = await api('/api/projects');
    $('#max-runs').value = String(queue.max);
    $('#queue-line').textContent = `執行中 ${queue.running.length} 個，排隊 ${queue.waiting.length} 個`;
  } catch (err) { toast(err.message, true); }
}

let skillLibrary = [], skillRuns = [], skillEditingName = null;
const SKILL_STAGE_LABELS = { prd: 'PRD 起草／修訂', prd_review: 'PRD 審查', tasks: '拆解任務', implement: '實作', code_review: '程式碼審查', fix: '修正', handover: '交接' };
function renderSkillEditor() {
  const selected = skillLibrary.find(skill => skill.name === $('#skill-name').value);
  skillEditingName = selected?.name || null;
  $('#skill-editor').value = selected?.text || '';
  $('#skill-compatibility').textContent = selected?.compatible ? '共用指令可供 Codex／Claude Code 使用；附帶工具仍需執行環境支援。'
    : selected?.error || `需調整專屬欄位：${selected?.extensions?.join(', ') || ''}`;
  renderSkillHistory();
}
async function loadSkills() {
  const data = await api('/api/skills');
  skillLibrary = data.skills;
  const previous = $('#skill-name').value;
  $('#skill-name').replaceChildren(...skillLibrary.map(skill => new Option(skill.name, skill.name)));
  if (skillLibrary.some(skill => skill.name === previous)) $('#skill-name').value = previous;
  renderSkillEditor();
  $('#skill-bindings').replaceChildren();
  for (const stage of data.stages) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend'); legend.textContent = SKILL_STAGE_LABELS[stage]; group.append(legend);
    for (const skill of skillLibrary.filter(skill => skill.compatible)) {
      const label = document.createElement('label');
      const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.skillStage = stage; input.value = skill.name;
      input.checked = (data.config?.[stage] || []).includes(skill.name);
      label.append(input, document.createTextNode(` ${skill.name} `)); group.append(label);
    }
    $('#skill-bindings').append(group);
  }
  await loadSkillRuns();
}
function renderSkillHistory() {
  const select = $('#skill-run-history'), previous = select.value;
  select.replaceChildren(new Option('新會議', ''));
  for (const run of skillRuns.filter(run => run.name === $('#skill-name').value)) {
    select.append(new Option(`${run.updated_at.slice(0, 19)} · ${run.status} · ${run.messages[0]?.text.slice(0, 25)}`, run.id));
  }
  if (skillRuns.some(run => run.id === previous && run.name === $('#skill-name').value)) select.value = previous;
}
function renderSkillOutput() {
  const run = skillRuns.find(run => run.id === $('#skill-run-history').value);
  $('#skill-output').textContent = run ? `${run.messages.map(message => `${message.role === 'user' ? '你' : run.provider || 'AI'}：${message.text}`).join('\n\n')}\n\n${run.error || run.status}` : '';
}
async function loadSkillRuns() {
  const { runs } = await api('/api/skills/runs');
  const previousCount = skillRuns.length;
  skillRuns = runs;
  renderSkillHistory();
  if (runs.length > previousCount && runs[0]?.name === $('#skill-name').value) $('#skill-run-history').value = runs[0].id;
  renderSkillOutput();
}
function bindSkills() {
  const handle = fn => async () => { try { await fn(); } catch (error) { toast(error.message, true); } };
  $('#skills-refresh').onclick = handle(loadSkills);
  $('#skill-name').onchange = () => { renderSkillEditor(); renderSkillOutput(); };
  $('#skill-run-history').onchange = renderSkillOutput;
  $('#skill-to-prd').onclick = handle(async () => {
    const run = skillRuns.find(run => run.id === $('#skill-run-history').value);
    if (!run || run.status !== 'done') throw new Error('請選擇已完成的技能會議');
    if ($('#bl-detail').value.trim() && !confirm('以此會議取代目前尚未新增的需求說明？')) return;
    $('#bl-title').value = run.messages[0]?.text.split('\n')[0].slice(0, 200) || '技能會議需求';
    $('#bl-detail').value = `以下是需求釐清／設計會議紀錄。以使用者回答為準，AI 建議仍需區分假設與待決策事項。\n\n${run.messages.map(m => `${m.role}: ${m.text}`).join('\n\n')}`;
    showTab($('#tabbtn-backlog')); toast('已帶入需求待辦，確認後按新增');
  });
  $('#skill-new').onclick = () => { skillEditingName = null; $('#skill-editor').value = '---\nname: my-skill\ndescription: 說明用途及使用時機\n---\n在此撰寫技能指令。\n'; };
  $('#skill-save').onclick = handle(async () => {
    const { skill } = await api('/api/skills/save', { text: $('#skill-editor').value, name: skillEditingName });
    await loadSkills(); $('#skill-name').value = skill.name; renderSkillEditor(); toast('已儲存 Skill');
  });
  $('#skill-import').onclick = handle(async () => {
    const { skill } = await api('/api/skills/import', { path: $('#skill-source').value });
    await loadSkills(); $('#skill-name').value = skill.name; renderSkillEditor(); toast('已匯入 Skill');
  });
  $('#skill-bindings-save').onclick = handle(async () => {
    const skills = Object.fromEntries(Object.keys(SKILL_STAGE_LABELS).map(stage => [stage, []]));
    for (const input of $$('[data-skill-stage]:checked')) skills[input.dataset.skillStage].push(input.value);
    await api('/api/skills/config', { skills }); toast('已儲存階段技能');
  });
  $('#skill-run').onclick = handle(async () => {
    const previousId = $('#skill-run-history').value;
    const previous = skillRuns.find(run => run.id === previousId);
    if (previous && previous.status !== 'done') throw new Error('請選擇已完成的回覆或新會議');
    $('#skill-run').disabled = true;
    try {
      await api('/api/skills/run', { name: $('#skill-name').value, input: $('#skill-input').value, provider: $('#skill-provider').value, previousId });
      $('#skill-input').value = ''; toast('已開始技能會議');
    } catch (error) { $('#skill-run').disabled = false; throw error; }
  });
}

async function runAction(path, body = {}, message) {
  const blocked = snap?.state.usage_blocked;
  const exhausted = snap?.usage?.providers?.filter(p => p.limits?.windows?.some(w => !w.expired && w.remainingPercent === 0)) || [];
  const provider = blocked?.provider || exhausted[0]?.provider;
  if (provider) {
    const other = provider === 'claude' ? 'codex' : 'claude';
    if (exhausted.some(p => p.provider === other)) {
      toast('兩個 AI 的額度都已用完，請等待重設後更新額度。', true);
      return;
    }
    if (!confirm(`${PROVIDER_LABEL[provider]} 曾回報額度不足。要只用 ${PROVIDER_LABEL[other]} 繼續這次執行嗎？\n\n實作與審查會使用不同 session；雙人審查暫時改為單人。會保留現有檔案並重新驗證，不會還原變更。原本角色設定不變，下次執行會再詢問。若另一個 AI 也沒有額度，流程會停止。\n\n若額度已重設，可先到用量頁更新。`)) return;
    body = { ...body, useProvider: other };
    if (path === '/api/run/start' && ['stuck', 'error'].includes(snap.state.pipeline.status)) path = '/api/run/continue';
  }
  return act(path, body, message);
}

function bind() {
  if (typeof bindReferences === 'function') bindReferences();
  if (typeof bindChat === 'function') bindChat();
  tabKeys($$('[data-board-view]'), button => button.click());
  window.addEventListener('resize', () => {
    $('.board-canvas').inert = selected !== null && !!window.matchMedia?.('(max-width: 999px)')?.matches;
  });
  for (const button of $$('[data-board-view]')) button.onclick = () => {
    boardView = button.dataset.boardView;
    try { localStorage.setItem('aipipe-board-view', boardView); } catch { /* 僅保留本次選擇 */ }
    if (snap) renderBoard();
  };
  $('#board-search').oninput = $('#board-filter').onchange = () => { if (snap) renderBoard(); };
  $('#board-clear').onclick = () => { $('#board-search').value = ''; $('#board-filter').value = 'all'; renderBoard(); $('#board-search').focus(); };
  $('#detail').addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); $('#d-close').click(); } });
  $('#quota-cancel').onclick = () => { quotaDismissed = JSON.stringify(snap?.state.usage_blocked); $('#quota-notice').hidden = true; };
  $('#quota-retry').onclick = () => runAction('/api/run/continue', {}, '已改用另一個 AI 繼續');
  $('#max-runs').onchange = async (event) => {
    await act('/api/queue/config', { max: Number(event.target.value) }, '已更新全域執行佇列');
    loadQueue();
  };
  $('#usage-short').onclick = () => showTab($('#tabbtn-usage'));
  $('#btn-usage-refresh').onclick = refreshUsage;
  bindTheme();
  const tabButtons = $$('.tabs button');
  for (const b of tabButtons) b.onclick = () => showTab(b);
  tabKeys(tabButtons, showTab);
  for (const b of $$('[data-mode]')) {
    b.onclick = () => act('/api/config/mode', { mode: b.dataset.mode }, `已切換為${b.textContent}模式`);
  }
  const subButtons = $$('[data-sub]');
  const showSub = (b) => {
    subtab = b.dataset.sub;
    renderDetail();
  };
  for (const b of subButtons) b.onclick = () => showSub(b);
  tabKeys(subButtons, showSub);
  for (const el of $$('[data-runtime]')) {
    el.addEventListener('input', () => {
      settingsDirty = true;
    });
  }
  $('#btn-save-runtime').onclick = async () => {
    const runtime = Object.fromEntries($$('[data-runtime]').map((s) => [s.dataset.runtime, s.value]));
    try {
      await api('/api/config/runtime', { runtime });
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
  $('#btn-prd-approve').onclick = () => act('/api/prd/approve', {}, 'PRD 已核准，正在自動產生任務');
  $('#btn-prd-revise').onclick = () => act('/api/prd/revise', { feedback: $('#feedback').value }, '已送出修改意見');
  $('#btn-tasks').onclick = () => act('/api/tasks/generate', {}, '已開始產生任務');
  $('#btn-start').onclick = () => runAction('/api/run/start', {}, '流程已開始');
  $('#btn-pause').onclick = () => act('/api/run/pause', {}, '目前任務結束後會暫停');
  $('#btn-continue').onclick = () => runAction('/api/run/continue', {}, '繼續');
  $('#d-close').onclick = () => {
    const id = selected;
    selected = null;
    detail = null;
    $('#detail').classList.add('hidden');
    renderBoard();
    // 關閉後把焦點還給原本的任務卡
    const cards = $$('#tab-board [data-task-id]');
    const card = cards.find(c => c.dataset.taskId === id && (boardView === 'roadmap' ? c.closest('#task-roadmap') : c.closest('#board')));
    card?.focus();
  };
  $('#d-rerun').onclick = () => {
    const revert = $('#d-revert').checked;
    if (revert && !confirm('會還原這個任務的變更後重跑，確定？')) return;
    runAction('/api/task/rerun', { id: selected, revert }, `任務 ${selected} 重跑中`);
  };
  $('#log-scope').onchange = renderLog;
  $('#log-expand').onclick = () => setLogTreeOpen($('#rec-body'), true);
  $('#log-collapse').onclick = () => setLogTreeOpen($('#rec-body'), false);
  const recButtons = $$('[data-rec]');
  const showRec = (b) => {
    recSub = b.dataset.rec;
    renderRecords();
  };
  for (const b of recButtons) b.onclick = () => showRec(b);
  tabKeys(recButtons, showRec);
  $('#btn-save-models').onclick = async () => {
    try {
      await api('/api/config/models', modelDraft);
      modelsDirty = false;
      toast('已儲存角色與模型');
    } catch (err) {
      toast(err.message, true);
    }
  };
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
bindSkills();
bindBacklog();
if (SETTINGS_ONLY || location.hash === '#settings') showTab($('#tabbtn-settings'));
api('/api/state').then(data => {
  onState(data);
  if (!$('#tab-chat').hidden && typeof loadChatHome === 'function') { loadChatHome(); loadModels(); }
}).catch((err) => toast(err.message, true));
loadInitialLogs();
connect();
loadBacklog();
if (PROJECT_ID) api('/api/projects/open', { id: PROJECT_ID }).catch(() => {});

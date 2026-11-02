'use strict';

// 內嵌頁沿用同源父視窗的桌面橋接。
if (!window.__TAURI__ && window.parent !== window) window.__TAURI__ = window.parent.__TAURI__;

// 專案頁（app.js）與總覽（overview.js）共用的小工具。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// 專案頁是 index.html?p=<id>，API 路徑用 /api/p/<id>/...。
const PROJECT_ID = new URLSearchParams(location.search).get('p')?.match(/^[0-9a-f]{10}$/)?.[0] || null;
const API_BASE = `/api/p/${PROJECT_ID}`;
const projectHref = (id) => `index.html?p=${id}`;

/** path 一律寫成 /api/...；專案頁上專案範圍的 API 會自動換成目前專案的前綴，總覽（沒有專案）直接呼叫全域路由。 */
function apiUrl(path) {
  if (!PROJECT_ID || /^\/api\/(projects|queue)(\/|$)/.test(path)) return path;
  return path.replace(/^\/api/, API_BASE);
}

/** 後端在 Rust（Tauri command `api`），路徑與回傳格式和舊版 HTTP API 相同。 */
async function api(path, body) {
  try {
    return await window.__TAURI__.core.invoke('api', { method: body === undefined ? 'GET' : 'POST', path: apiUrl(path), body: body ?? null });
  } catch (err) {
    throw new Error(String(err?.message ?? err));
  }
}

/**
 * 訂閱後端推送的事件（取代 EventSource）。handlers 的鍵是事件名稱；專案頁的 state／log 會自動加上專案 id。
 * 專案頁要先呼叫 watch_project 讓後端開始監看。
 */
async function subscribe(handlers) {
  const { listen } = window.__TAURI__.event;
  for (const [name, fn] of Object.entries(handlers)) {
    const event = name === 'projects' ? name : `${name}-${PROJECT_ID}`;
    const unlisten = await listen(event, (e) => fn(e.payload));
    window.addEventListener('pagehide', unlisten, { once: true });
  }
  if (PROJECT_ID && !('projects' in handlers)) await window.__TAURI__.core.invoke('watch_project', { id: PROJECT_ID });
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
    const data = await api(path, body ?? {});
    if (okMsg) toast(okMsg);
    return data;
  } catch (err) {
    toast(err.message, true);
    return null;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- 主題：系統 → 淺色 → 深色 ----------
const THEMES = [['system', '跟隨系統', 'monitor'], ['light', '淺色', 'sun'], ['dark', '深色', 'moon']];
function getTheme() {
  try {
    return localStorage.getItem('ai-workflow-theme') || 'system';
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
function bindTheme() {
  let theme = getTheme();
  applyTheme(theme);
  $('#btn-theme').onclick = () => {
    const keys = THEMES.map(([k]) => k);
    theme = keys[(keys.indexOf(theme) + 1) % keys.length];
    try {
      localStorage.setItem('ai-workflow-theme', theme);
    } catch {
      // 無法儲存時只在這次頁面生效
    }
    applyTheme(theme);
  };
}

// 方向鍵在 tablist 內移動焦點並切換（WAI-ARIA tabs pattern）。
function tabKeys(buttons, activate) {
  for (const b of buttons) {
    b.addEventListener('keydown', (e) => {
      const i = buttons.indexOf(b);
      const next = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: buttons.length - 1 }[e.key];
      if (next === undefined) return;
      e.preventDefault();
      const visible = buttons.filter(button => !button.hidden);
      const current = visible.indexOf(b);
      const offset = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: visible.length - 1 }[e.key];
      const target = visible[(offset + visible.length) % visible.length];
      if (!target) return;
      target.focus();
      activate(target);
    });
  }
}

/** 桌面版（Tauri）提供的原生功能。 */
const desktop = { invoke: window.__TAURI__.core.invoke };

// ---------- 可展開的 log（像 Claude Code：每段工作包成一個區塊） ----------
const PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

/** 把 log 文字整理成區塊：AI 工作（── 標記 ── 開始／完成）、驗證指令（$ cmd → 通過／失敗）、任務標題與零散的行。 */
function parseLog(text) {
  const items = [];
  let group = null;
  for (const raw of String(text || '').split('\n')) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\[(\d\d:\d\d:\d\d)\] ?([\s\S]*)$/);
    const time = m ? m[1] : '';
    const msg = m ? m[2] : raw;
    let s;
    if ((s = msg.match(/^── (.+?)：(claude|codex)（(可編輯|唯讀)）開始(?:，session (\S+))? ──$/))) {
      group = { kind: 'agent', title: s[1], provider: s[2], mode: s[3], time, status: 'running', lines: [] };
      items.push(group);
    } else if (group?.kind === 'agent' && (s = msg.match(/^── (.+?)：(完成|失敗)（(\d+)s）\s?([\s\S]*?) ──$/))) {
      Object.assign(group, { status: s[2] === '完成' ? 'done' : 'error', secs: Number(s[3]), error: s[4], end: time });
      group = null;
    } else if (!group && msg.startsWith('$ ')) {
      group = { kind: 'check', title: msg.slice(2), time, status: 'running', lines: [] };
      items.push(group);
    } else if (group?.kind === 'check' && (s = msg.match(/^(build|lint|test)：(通過|失敗[\s\S]*)$/))) {
      Object.assign(group, { status: s[2] === '通過' ? 'done' : 'error', result: `${s[1]}：${s[2]}`, end: time });
      group = null;
    } else if ((s = msg.match(/^═══ (.+) ═══$/))) {
      group = null;
      items.push({ kind: 'header', text: s[1], time });
    } else {
      (group ? group.lines : items).push({ kind: 'line', time, text: msg });
    }
  }
  return items;
}

function logLines(lines) {
  const frag = document.createDocumentFragment();
  let text = null;
  for (const l of lines) {
    const tool = l.text.match(/^🔧 (\S+)\s?(.*)$/);
    if (tool) {
      text = null;
      const row = document.createElement('div');
      row.className = 'lg-tool';
      row.innerHTML = `<span class="lg-tool-name"></span><span class="lg-tool-arg"></span>`;
      row.querySelector('.lg-tool-name').textContent = tool[1];
      row.querySelector('.lg-tool-arg').textContent = tool[2];
      frag.append(row);
    } else {
      // 連續的文字行合成一段
      if (!text) {
        text = document.createElement('div');
        text.className = `lg-text${l.text.startsWith('⚠') || l.text.startsWith('✖') ? ' warn' : ''}`;
        frag.append(text);
      } else text.textContent += '\n';
      text.textContent += l.text;
    }
  }
  return frag;
}

/**
 * 在 box 裡畫出可展開的 log。執行中的區塊預設展開、完成的收合；使用者手動展開／收合過的區塊重畫時保留。
 * 捲到最底時自動跟隨新輸出。
 */
function renderLogTree(box, text) {
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
  const toggled = new Map($$('details[data-key]', box).filter((d) => d.dataset.user).map((d) => [d.dataset.key, d.open]));
  const items = parseLog(text);
  box.replaceChildren();
  if (!items.length) {
    box.innerHTML = '<p class="empty">（尚無 log）</p>';
    return;
  }
  const stray = [];
  const flush = () => {
    if (!stray.length) return;
    const div = document.createElement('div');
    div.className = 'lg-loose';
    div.append(logLines(stray.splice(0)));
    box.append(div);
  };
  items.forEach((it, i) => {
    if (it.kind === 'line') return stray.push(it);
    flush();
    if (it.kind === 'header') {
      const h = document.createElement('div');
      h.className = 'lg-header';
      h.textContent = it.text;
      box.append(h);
      return;
    }
    const d = document.createElement('details');
    d.className = `lg ${it.status}`;
    d.dataset.key = `${it.time}|${it.title}|${i}`;
    d.open = toggled.has(d.dataset.key) ? toggled.get(d.dataset.key) : it.status === 'running';
    if (toggled.has(d.dataset.key)) d.dataset.user = '1';
    const s = document.createElement('summary');
    // 只記錄使用者自己點的（程式設定 open 也會觸發 toggle 事件）
    s.addEventListener('click', () => { d.dataset.user = '1'; });
    const icon = { running: '●', done: '✓', error: '✕' }[it.status];
    const who = it.kind === 'agent' ? `<span class="lg-who ${it.provider}"></span><span class="lg-mode"></span>` : '<span class="lg-who check">指令</span>';
    s.innerHTML = `<span class="lg-icon" aria-hidden="true"></span><span class="lg-title"></span>${who}<span class="lg-meta"></span>`;
    s.querySelector('.lg-icon').textContent = icon;
    s.querySelector('.lg-title').textContent = it.title;
    if (it.kind === 'agent') {
      s.querySelector('.lg-who').textContent = PROVIDER_LABEL[it.provider] || it.provider;
      s.querySelector('.lg-mode').textContent = it.mode;
    }
    const tools = it.lines.filter((l) => l.text.startsWith('🔧')).length;
    s.querySelector('.lg-meta').textContent = [
      it.result, tools ? `${tools} 個工具呼叫` : '', it.secs != null ? `${it.secs}s` : it.status === 'running' ? '執行中' : '', it.time,
    ].filter(Boolean).join(' · ');
    s.setAttribute('aria-label', `${it.title}，${{ running: '執行中', done: '完成', error: '失敗' }[it.status]}`);
    const body = document.createElement('div');
    body.className = 'lg-body';
    if (it.error) {
      const e = document.createElement('div');
      e.className = 'lg-text warn';
      e.textContent = it.error;
      body.append(e);
    }
    body.append(it.lines.length ? logLines(it.lines) : Object.assign(document.createElement('p'), { className: 'empty', textContent: '（沒有輸出）' }));
    d.append(s, body);
    box.append(d);
  });
  flush();
  if (atBottom) box.scrollTop = box.scrollHeight;
}

/** 全部展開或收合（之後重畫也維持）。 */
function setLogTreeOpen(box, open) {
  for (const d of $$('details[data-key]', box)) {
    d.open = open;
    d.dataset.user = '1';
  }
}

/** AI 工作中的持續時間文字，例如「1 分 23 秒」；時間無效回傳空字串。 */
function elapsedText(since) {
  const ms = since ? Date.now() - new Date(since).getTime() : NaN;
  if (!Number.isFinite(ms) || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s} 秒` : s < 3600 ? `${Math.floor(s / 60)} 分 ${s % 60} 秒` : `${Math.floor(s / 3600)} 小時 ${Math.floor((s % 3600) / 60)} 分`;
}

/** 顯示狀態文字；since 有值時附上持續時間並每秒更新，沒有就只顯示文字並停止計時。 */
let liveSinceTimer = null;
function liveSince(el, label, since) {
  const elapsed = since ? elapsedText(since) : '';
  if (!elapsed) { delete el.dataset.since; delete el.dataset.label; el.textContent = label; return; }
  el.dataset.since = since; el.dataset.label = label; el.textContent = `${label}（已 ${elapsed}）`;
  liveSinceTimer ??= setInterval(() => { for (const node of $$('[data-since]')) node.textContent = `${node.dataset.label}（已 ${elapsedText(node.dataset.since)}）`; }, 1000);
}

/**
 * 模型選擇器：取代瀏覽器原生的 datalist（WebView2 的原生清單無法套樣式，寬度與位置也會跑版）。
 * 清單來自全域的 modelOptions（/api/models），可輸入任意模型 ID；選取後觸發 input 與 change 事件。
 * provider 可以是字串或回傳字串的函式（聊天的 AI 會切換）。
 */
let modelPickerPopup = null;
function closeModelPicker() {
  if (!modelPickerPopup) return;
  modelPickerPopup.input.setAttribute('aria-expanded', 'false');
  modelPickerPopup.input.removeAttribute('aria-activedescendant');
  modelPickerPopup.el.remove(); modelPickerPopup = null;
}
function attachModelPicker(input, provider) {
  input._modelProvider = provider;
  if (input._modelPicker) return;
  input._modelPicker = true;
  input.removeAttribute('list'); input.autocomplete = 'off';
  input.setAttribute('role', 'combobox'); input.setAttribute('aria-autocomplete', 'list'); input.setAttribute('aria-expanded', 'false');
  const models = () => {
    const p = typeof input._modelProvider === 'function' ? input._modelProvider() : input._modelProvider;
    return (typeof modelOptions !== 'undefined' && modelOptions?.[p]?.models) || [];
  };
  const choose = id => {
    input.value = id; closeModelPicker();
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const open = (filter = true) => {
    const query = filter ? input.value.trim().toLowerCase() : '';
    const all = models();
    let list = query ? all.filter(m => `${m.id} ${m.name} ${m.description || ''}`.toLowerCase().includes(query)) : all;
    // 輸入的值剛好是某個模型時也列出全部，方便換成別的。
    if (query && all.some(m => m.id.toLowerCase() === query)) list = all;
    closeModelPicker();
    if (!all.length) return;
    const el = document.createElement('ul'); el.className = 'model-picker'; el.setAttribute('role', 'listbox');
    el.id = `model-picker-${Math.random().toString(36).slice(2, 8)}`; input.setAttribute('aria-controls', el.id);
    const items = [{ id: '', name: '沿用預設', description: input.placeholder?.replace(/^模型：/, '') || '' }, ...list];
    items.forEach((model, index) => {
      const li = document.createElement('li'); li.setAttribute('role', 'option'); li.id = `${el.id}-${index}`;
      li.dataset.value = model.id; li.setAttribute('aria-selected', String(model.id === input.value));
      li.classList.toggle('current', model.id === input.value);
      const head = document.createElement('div'); head.className = 'model-picker-head';
      const name = document.createElement('b'); name.textContent = model.name;
      head.append(name);
      if (model.id) { const id = document.createElement('code'); id.textContent = model.id; head.append(id); }
      li.append(head);
      if (model.description) { const desc = document.createElement('small'); desc.textContent = model.description; li.append(desc); }
      li.onmousedown = event => event.preventDefault();
      li.onclick = () => choose(model.id);
      el.append(li);
    });
    if (query && !list.length) {
      const empty = document.createElement('li'); empty.className = 'model-picker-empty'; empty.textContent = `沒有符合的模型，按 Enter 直接使用「${input.value.trim()}」`;
      el.append(empty);
    }
    document.body.append(el);
    const rect = input.getBoundingClientRect();
    const width = Math.max(rect.width, 300);
    const below = innerHeight - rect.bottom - 8, above = rect.top - 8;
    const maxHeight = Math.max(160, Math.min(360, below >= 220 || below >= above ? below : above));
    Object.assign(el.style, { left: `${Math.max(8, Math.min(rect.left, innerWidth - width - 8))}px`, width: `${width}px`, maxHeight: `${maxHeight}px` });
    if (below >= 220 || below >= above) el.style.top = `${rect.bottom + 4}px`; else el.style.bottom = `${innerHeight - rect.top + 4}px`;
    modelPickerPopup = { el, input, active: -1 };
    input.setAttribute('aria-expanded', 'true');
  };
  const move = delta => {
    if (!modelPickerPopup || modelPickerPopup.input !== input) { open(false); return; }
    const options = [...modelPickerPopup.el.querySelectorAll('[role=option]')];
    if (!options.length) return;
    modelPickerPopup.active = (modelPickerPopup.active + delta + options.length) % options.length;
    options.forEach((li, i) => li.classList.toggle('active', i === modelPickerPopup.active));
    const current = options[modelPickerPopup.active];
    input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' });
  };
  input.addEventListener('focus', () => open(false));
  input.addEventListener('click', () => { if (!modelPickerPopup) open(false); });
  input.addEventListener('input', event => { if (event.isTrusted) open(true); });
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Escape' && modelPickerPopup) { event.preventDefault(); event.stopPropagation(); closeModelPicker(); }
    else if (event.key === 'Enter' && modelPickerPopup?.input === input) {
      event.preventDefault();
      const active = modelPickerPopup.el.querySelectorAll('[role=option]')[modelPickerPopup.active];
      choose(active ? active.dataset.value : input.value.trim());
    }
  });
  input.addEventListener('blur', () => { if (modelPickerPopup?.input === input) { closeModelPicker(); input.dispatchEvent(new Event('change', { bubbles: true })); } });
}
// 捲動或改變視窗大小時關閉，避免清單留在錯的位置。
addEventListener('scroll', event => { if (modelPickerPopup && !modelPickerPopup.el.contains(event.target)) closeModelPicker(); }, true);
addEventListener('resize', closeModelPicker);

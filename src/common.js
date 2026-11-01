'use strict';

// 專案頁（app.js）與總覽（overview.js）共用的小工具。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// 專案頁是 index.html?p=<id>，API 路徑用 /api/p/<id>/...。
const PROJECT_ID = new URLSearchParams(location.search).get('p')?.match(/^[0-9a-f]{10}$/)?.[0] || null;
const API_BASE = `/api/p/${PROJECT_ID}`;
const projectHref = (id) => `index.html?p=${id}`;

/** path 一律寫成 /api/...；專案範圍的 API 會自動換成目前專案的前綴。 */
function apiUrl(path) {
  if (/^\/api\/(projects|queue)(\/|$)/.test(path)) return path;
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
    await listen(event, (e) => fn(e.payload));
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
function bindTheme() {
  let theme = getTheme();
  applyTheme(theme);
  $('#btn-theme').onclick = () => {
    const keys = THEMES.map(([k]) => k);
    theme = keys[(keys.indexOf(theme) + 1) % keys.length];
    try {
      localStorage.setItem('aipipe-theme', theme);
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

'use strict';

// 專案頁（app.js）與總覽（overview.js）共用的小工具。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

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
      const target = buttons[(next + buttons.length) % buttons.length];
      target.focus();
      activate(target);
    });
  }
}

/** 桌面版（Tauri）提供的原生功能。 */
const desktop = { invoke: window.__TAURI__.core.invoke };

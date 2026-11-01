'use strict';

// 專案頁（app.js）與總覽（overview.js）共用的小工具。

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const icon = (name, cls = 'ic') => `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;

// 從 /p/<id>/ 開的專案頁用 /api/p/<id>/...；舊網址（aipipe ui --cwd 的首頁）用 /api/...。
const PROJECT_ID = location.pathname.match(/^\/p\/([0-9a-f]{10})\/?$/)?.[1] || null;
const API_BASE = PROJECT_ID ? `/api/p/${PROJECT_ID}` : '/api';

/** path 一律寫成 /api/...；專案範圍的 API 會自動換成目前專案的前綴。 */
function apiUrl(path) {
  if (/^\/api\/(projects|queue)(\/|$)/.test(path)) return path;
  return path.replace(/^\/api/, API_BASE);
}

async function api(path, body) {
  const res = await fetch(apiUrl(path), body === undefined ? {} : {
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

/** 桌面版（Tauri）提供的原生功能；在一般瀏覽器裡是 null。 */
const desktop = window.__TAURI__?.core?.invoke ? { invoke: window.__TAURI__.core.invoke } : null;

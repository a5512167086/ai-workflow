'use strict';

// 全域設定頁（總覽的「設定」）。設定只有一份，不按專案：AI 角色與模型、工作流程模式、同時執行上限、
// 流程參數、CLI 執行環境。資料在 ~/.ai-workflow/config.json，透過 /api/config 讀寫。共用工具在 common.js。

const ROLE_ORDER = ['interviewer', 'author', 'reviewer', 'task_planner', 'implementer', 'fixer', 'code_reviewer', 'handover', 'chat'];
const ROLE_LABELS = {
  interviewer: '需求釐清（Grill Me）', author: 'PRD 作者', reviewer: 'PRD 審查', task_planner: '拆任務', implementer: '實作',
  fixer: '修正', code_reviewer: '程式碼審查', handover: 'Handover（交接紀錄）', chat: '專案對話',
};
const ROLE_HINTS = {
  interviewer: '主持需求會議，每輪提問', author: '起草與修訂 PRD', reviewer: '審查 PRD，可雙人', task_planner: '把 PRD 拆成任務',
  implementer: '在新對話裡實作任務', fixer: '修驗證錯誤與審查意見', code_reviewer: '審 git diff，可雙人', handover: '寫下一個 session 的交接', chat: '唯讀的專案助理',
};
const REVIEW_ROLES = ['reviewer', 'code_reviewer'];
const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SETTINGS_PROVIDER_LABEL = { claude: 'Claude', codex: 'Codex' };

let globalConfig = null;
let settingsHome = '';
let modelOptions = null;
let modelDraft = null;
let modelsDirty = false;
let runtimeDirty = false;
let limitsDirty = false;

async function loadSettings() {
  try {
    const payload = await api('/api/config');
    globalConfig = payload.config;
    settingsHome = payload.home;
    renderSettings(payload);
  } catch (err) {
    toast(err.message, true);
  }
  loadModels();
}

/** 畫出整頁（不覆蓋使用者還沒儲存的選擇）。 */
function renderSettings(payload) {
  if (!globalConfig) return;
  const config = globalConfig;
  $('#config-json').textContent = payload?.text || JSON.stringify(config, null, 2);
  $('#config-path').textContent = settingsHome ? `${settingsHome}${settingsHome.includes('\\') ? '\\' : '/'}config.json` : 'config.json';
  for (const b of $$('[data-mode]')) {
    const on = b.dataset.mode === config.mode;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  }
  if (payload?.queue) renderQueue(payload.queue);
  if (!runtimeDirty) for (const s of $$('[data-runtime]')) s.value = config.runtime?.[s.dataset.runtime] || 'auto';
  if (!limitsDirty) {
    for (const input of $$('[data-limit]')) input.value = config[input.dataset.limit] ?? '';
  }
  renderModels();
}

function renderQueue(queue) {
  $('#max-runs').value = String(queue.max);
  $('#settings-queue-line').textContent = `執行中 ${queue.running.length} 個，排隊 ${queue.waiting.length} 個`;
}

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

/** 九個角色排成 3×3 格子，每格一張小卡：角色、AI、模型、推理強度。視窗窄時由 CSS 退成 2 欄或 1 欄。 */
function renderModels(force = false) {
  if (!globalConfig) return;
  const box = $('#role-models');
  if (!force && box.contains(document.activeElement)) return;
  if (!modelsDirty) {
    modelDraft = { roles: structuredClone(globalConfig.roles || {}), models: structuredClone(globalConfig.models || {}) };
    for (const [role, parent] of [['interviewer', 'author'], ['task_planner', 'author'], ['fixer', 'implementer'], ['handover', 'implementer'], ['chat', 'author']]) {
      modelDraft.roles[role] ??= modelDraft.roles[parent] || 'claude';
      modelDraft.models[role] ??= structuredClone(modelDraft.models[parent] || {});
    }
  }
  box.replaceChildren();
  for (const role of ROLE_ORDER) {
    const label = ROLE_LABELS[role];
    const card = document.createElement('fieldset');
    card.className = 'role-card';
    card.dataset.role = role;
    const legend = document.createElement('legend');
    legend.textContent = label;
    const hint = document.createElement('p');
    hint.className = 'hint role-hint';
    hint.textContent = ROLE_HINTS[role] || '';
    const pick = document.createElement('select');
    pick.className = 'role-provider';
    pick.setAttribute('aria-label', `${label} 使用的 AI`);
    const choices = [['claude', 'Claude Code'], ['codex', 'Codex']];
    if (REVIEW_ROLES.includes(role)) choices.push(['both', '雙人審查（Claude ＋ Codex）']);
    for (const [v, text] of choices) pick.append(new Option(text, v, false, modelDraft.roles[role] === v));
    pick.onchange = () => {
      modelDraft.roles[role] = pick.value;
      modelsDirty = true;
      renderModels(true);
    };
    card.append(legend, hint, pick);
    const providers = modelDraft.roles[role] === 'both' ? ['claude', 'codex'] : [modelDraft.roles[role]];
    for (const p of providers) {
      const cur = modelDraft.models?.[role]?.[p] || { model: '', effort: '' };
      const line = document.createElement('div');
      line.className = 'model-line';
      const who = document.createElement('span');
      who.className = `lg-who ${p}`;
      who.textContent = SETTINGS_PROVIDER_LABEL[p];
      const model = document.createElement('input');
      model.type = 'text';
      model.setAttribute('list', `models-${p}`);
      model.placeholder = '模型：沿用預設';
      model.title = '可選擇完整版本或直接輸入模型 ID';
      model.value = cur.model || '';
      model.setAttribute('aria-label', `${label}：${SETTINGS_PROVIDER_LABEL[p]} 模型`);
      const effort = document.createElement('select');
      effort.setAttribute('aria-label', `${label}：${SETTINGS_PROVIDER_LABEL[p]} 推理強度`);
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
      line.append(who, model, effort);
      card.append(line);
    }
    box.append(card);
  }
  const defaults = $('#model-defaults');
  defaults.replaceChildren();
  for (const p of ['claude', 'codex']) {
    const info = modelOptions?.[p];
    const entry = info?.models?.find(m => m.default);
    const model = globalConfig[p]?.model || info?.defaultModel || entry?.id;
    const effort = globalConfig[p]?.effort || info?.defaultEffort || entry?.defaultEffort;
    const li = document.createElement('li');
    li.textContent = `${SETTINGS_PROVIDER_LABEL[p]} 預設模型：${model || 'CLI 依帳號決定（未回報）'}；預設推理強度：${effort || 'CLI 依模型決定（未回報）'}。來源：${globalConfig[p]?.model || globalConfig[p]?.effort ? '全域設定' : info?.defaultSource || 'CLI 模型清單'}。`;
    defaults.append(li);
  }
}

async function saveGlobal(path, body, message) {
  const result = await api(path, body);
  if (result?.config) globalConfig = result.config;
  toast(message);
}

function bindSettings() {
  for (const b of $$('[data-mode]')) {
    b.onclick = async () => {
      try {
        await saveGlobal('/api/config/mode', { mode: b.dataset.mode }, `已切換為${b.textContent}模式`);
        renderSettings();
      } catch (err) { toast(err.message, true); }
    };
  }
  $('#max-runs').onchange = async (event) => {
    const res = await act('/api/queue/config', { max: Number(event.target.value) }, '已更新全域執行佇列');
    if (res?.queue) renderQueue(res.queue);
  };
  for (const el of $$('[data-runtime]')) el.addEventListener('input', () => { runtimeDirty = true; });
  $('#btn-save-runtime').onclick = async () => {
    const runtime = Object.fromEntries($$('[data-runtime]').map((s) => [s.dataset.runtime, s.value]));
    try {
      await saveGlobal('/api/config/runtime', { runtime }, '已儲存執行環境');
      runtimeDirty = false;
      renderSettings();
    } catch (err) { toast(err.message, true); }
  };
  for (const el of $$('[data-limit]')) el.addEventListener('input', () => { limitsDirty = true; });
  $('#btn-save-limits').onclick = async () => {
    const body = {};
    for (const input of $$('[data-limit]')) {
      const key = input.dataset.limit;
      body[key] = input.type === 'number' ? Number(input.value) : input.value;
    }
    try {
      await saveGlobal('/api/config/limits', body, '已儲存流程參數');
      limitsDirty = false;
      renderSettings();
    } catch (err) { toast(err.message, true); }
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
  $('#btn-save-models').onclick = async () => {
    try {
      await saveGlobal('/api/config/models', modelDraft, '已儲存角色與模型');
      modelsDirty = false;
      renderSettings();
    } catch (err) { toast(err.message, true); }
  };
}

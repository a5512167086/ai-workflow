'use strict';

let chatItems = [], chatId = null, chatSession = null, chatSending = false, chatDefaultsReady = false;
let chatTimer = null, chatPollBusy = false, chatSelection = 0, chatMessagesKey = '';
const chatDrafts = new Map();
const CHAT_STATUS = { pending: '準備中', running: '回覆中', done: '已回覆', error: '未完成', cancelled: '已停止' };
const chatActive = session => session && ['pending', 'running'].includes(session.status);

function renderChatContext() {
  if (!snap) return;
  if (!chatDefaultsReady) {
    $('#chat-provider').value = snap.config.roles.chat || snap.config.roles.author || 'claude';
    chatDefaultsReady = true; renderChatOptions();
  }
  $('#chat-context').textContent = `帶入最新流程、任務、PRD 與交接文件 · 目前：${STATUS_TEXT[snap.state.pipeline.status] || snap.state.pipeline.status}${chatSession?.contextTruncated ? ` · 最近 ${chatSession.contextMessages} 則帶入模型，完整紀錄仍保留` : ''}${chatSession?.contextReferencesTruncated ? ' · 參考資料帶入最近 24 份，較早的附件仍保留' : ''}`;
}
function renderChatOptions() {
  const provider = $('#chat-provider').value, model = $('#chat-model');
  model.setAttribute('list', `models-${provider}`);
  const current = $('#chat-effort').value;
  const options = typeof effortsFor === 'function' ? effortsFor(provider, model.value) : [];
  $('#chat-effort').replaceChildren(new Option('預設', ''), ...options.map(e => new Option(e, e)));
  if (current && !options.includes(current)) $('#chat-effort').append(new Option(current, current));
  $('#chat-effort').value = current;
  const defaults = snap?.config.models?.chat?.[provider];
  model.placeholder = defaults?.model || snap?.config[provider]?.model || '沿用對話角色預設';
  const info = typeof modelOptions !== 'undefined' ? modelOptions?.[provider] : null;
  const entry = info?.models?.find(model => model.default);
  $('#chat-model-hint').textContent = `空白沿用首頁「專案對話」角色設定。預設模型：${defaults?.model || snap?.config[provider]?.model || info?.defaultModel || entry?.id || 'CLI 依帳號決定（未回報）'}；推理強度：${defaults?.effort || snap?.config[provider]?.effort || info?.defaultEffort || entry?.defaultEffort || 'CLI 依模型決定（未回報）'}。`;
}
function renderChatHistory() {
  const list = $('#chat-history'); list.replaceChildren();
  if (!chatItems.length) list.innerHTML = '<li class="empty">還沒有對話。從右邊問一個問題開始。</li>';
  for (const session of chatItems) {
    const item = document.createElement('li'), button = document.createElement('button'); button.type = 'button';
    button.className = `chat-history-item${session.id === chatId ? ' active' : ''}`; button.setAttribute('aria-current', String(session.id === chatId));
    button.innerHTML = '<strong></strong><span></span>';
    button.querySelector('strong').textContent = session.title || '未命名對話';
    button.querySelector('span').textContent = `${CHAT_STATUS[session.status] || session.status} · ${session.updated_at ? new Date(session.updated_at).toLocaleDateString('zh-TW') : '檔案需要檢查'}`;
    button.onclick = () => openChat(session.id); item.append(button); list.append(item);
  }
  $('#tab-chat-badge').textContent = chatItems.some(chatActive) ? '回覆中' : '';
  const mobile = $('#chat-mobile-history');
  if (document.activeElement !== mobile) {
    mobile.replaceChildren(new Option('新對話', ''), ...chatItems.map(session => new Option(session.title || '未命名對話', session.id)));
    mobile.value = chatId || '';
  }
}
function renderChatControls() {
  if (typeof renderReferenceWidgets === 'function') renderReferenceWidgets();
  const active = chatActive(chatSession);
  const anyActive = active || chatItems.some(chatActive);
  $('#chat-send').disabled = chatSending || !!anyActive || referencePending.has(`chat:${chatId || 'new'}`);
  $('#chat-stop').hidden = !active;
  $('#chat-stop').disabled = !!chatSession?.cancelRequested;
  $('#chat-stop').textContent = chatSession?.cancelRequested ? '正在停止…' : '停止回覆';
  $('#chat-retry').hidden = !chatSession || !['error', 'cancelled'].includes(chatSession.status) || chatSession.messages?.at(-1)?.role !== 'user';
  $('#chat-retry').disabled = chatSending || !!anyActive;
  $('#chat-delete').disabled = !chatId || !!active;
  $('#chat-rename').disabled = !chatId;
  $('#chat-title').textContent = chatSession?.title || '開始聊聊這個專案';
  const since = active ? chatSession.messages?.findLast?.(message => message.role === 'user')?.at : null;
  if (chatSession?.error) liveSince($('#chat-status'), `${CHAT_STATUS[chatSession.status] || ''}：${chatSession.error}`, null);
  else if (active) liveSince($('#chat-status'), 'AI 正在讀取與分析專案，展開執行紀錄可查看工具活動。', since);
  else if (anyActive && !active) liveSince($('#chat-status'), '另一個對話正在回覆；完成或停止後即可傳送。', null);
  else liveSince($('#chat-status'), chatSession ? '可直接追問，也可切換 AI 接續同一份對話紀錄。' : '不需要先產生 PRD，就可以討論專案。', null);
}
function renderChatMessages() {
  const host = $('#chat-messages');
  const key = `${chatSession?.id || ''}|${chatSession?.messages?.map(message => message.id).join(',') || ''}|${chatSession?.status || ''}|${chatSession?.turn || ''}`;
  if (key === chatMessagesKey) { renderChatLive(); return; }
  chatMessagesKey = key;
  const atBottom = host.scrollTop + host.clientHeight >= host.scrollHeight - 50;
  const keep = host.scrollTop; host.replaceChildren();
  if (!chatSession?.messages?.length) {
    host.innerHTML = '<div class="chat-welcome"><span class="eyebrow">問問題、理解程式、釐清下一步</span><h3>這次，你想了解什麼？</h3><p>從目前進度聊到整體架構，都不必進入 PRD 流程。</p><div class="chat-suggestions"></div></div>';
    for (const question of ['目前專案執行到哪裡？有什麼需要我處理？', '請閱讀程式碼，畫一張 Mermaid 專案架構圖。', '解釋目前的資料流與主要模組。', '目前有哪些風險、卡點或可以改善的地方？']) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = question;
      button.onclick = () => { $('#chat-input').value = question; $('#chat-input').focus(); }; $('.chat-suggestions').append(button);
    }
  }
  for (const message of chatSession?.messages || []) {
    const article = document.createElement('article'); article.className = `chat-message ${message.role === 'user' ? 'from-user' : 'from-ai'}`;
    const heading = document.createElement('div'); heading.className = 'chat-message-head';
    const name = document.createElement('b'); name.textContent = message.role === 'user' ? '你' : PROVIDER_LABEL[message.provider] || '專案助理';
    const time = document.createElement('span'); time.textContent = message.at ? new Date(message.at).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製'; copy.className = 'chat-copy';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(message.text); toast('已複製訊息'); } catch { toast('無法存取剪貼簿，請選取文字複製', true); } };
    heading.append(name, time, copy);
    const body = document.createElement('div'); body.className = 'chat-message-body md';
    if (message.role === 'user') { body.textContent = message.text; body.classList.add('plain-text'); }
    else renderChatMarkdown(body, message.text).then(() => { if (atBottom && body.isConnected) host.scrollTop = host.scrollHeight; });
    article.append(heading, body); if (message.references?.length) article.append(referenceChips(message.references)); host.append(article);
  }
  if (chatSession?.turn) {
    const activity = document.createElement('details'); activity.className = 'chat-activity';
    activity.innerHTML = '<summary></summary><div id="chat-live" class="lg-host"></div>';
    const running = chatActive(chatSession);
    liveSince(activity.querySelector('summary'), running ? '正在回覆 · 查看執行紀錄' : '這次回覆的執行紀錄', running ? chatSession.messages?.findLast?.(message => message.role === 'user')?.at : null);
    host.append(activity); renderChatLive();
  }
  host.scrollTop = atBottom ? host.scrollHeight : keep;
}
function renderChatLive() {
  const host = $('#chat-live'); if (!host || !chatSession?.turn) return;
  renderLogTree(host, logs[`chat-${chatSession.turn}`] || '正在準備 CLI 與專案背景…');
}
function rememberChatDraft() { chatDrafts.set(chatId || 'new', $('#chat-input').value); }
async function openChat(id) {
  rememberChatDraft(); const selection = ++chatSelection;
  try {
    const session = await api(`/api/chat/${encodeURIComponent(id)}`);
    if (selection !== chatSelection) return;
    chatId = id; chatSession = session; chatMessagesKey = '';
    $('#chat-input').value = chatDrafts.get(id) || '';
    $('#chat-provider').value = session.provider || 'claude'; $('#chat-model').value = session.model || '';
    renderChatOptions();
    if (session.effort && ![...$('#chat-effort').options].some(option => option.value === session.effort)) $('#chat-effort').append(new Option(session.effort, session.effort));
    $('#chat-effort').value = session.effort || '';
    renderChatHistory(); renderChatMessages(); renderChatControls(); renderChatContext();
    if (session.turn) {
      try { const { text } = await api(`/api/log/chat-${session.turn}`); logs[`chat-${session.turn}`] = text; renderChatLive(); } catch { /* 尚未建立 log */ }
    }
  } catch (error) { if (selection === chatSelection) { $('#chat-status').textContent = error.message; toast(error.message, true); } }
}
function newChat() {
  rememberChatDraft(); ++chatSelection; chatId = null; chatSession = null; chatMessagesKey = '';
  $('#chat-input').value = chatDrafts.get('new') || ''; $('#chat-model').value = ''; $('#chat-effort').value = '';
  renderChatOptions(); renderChatHistory(); renderChatMessages(); renderChatControls(); renderChatContext(); $('#chat-input').focus();
}
async function loadChatHome() {
  try {
    const { items } = await api('/api/chats');
    if (!Array.isArray(items)) throw new Error('無法讀取對話清單：回傳格式不正確');
    chatItems = items;
    renderChatHistory(); renderChatControls(); renderChatContext();
    if (!chatSession) renderChatMessages();
  } catch (error) { $('#chat-status').textContent = error.message; }
}
async function pollChat() {
  if (chatPollBusy || chatSending || !chatItems.some(chatActive) && $('#tab-chat').hidden) return;
  chatPollBusy = true;
  const selection = chatSelection, id = chatId;
  try {
    await loadChatHome();
    if (id && id === chatId) {
      const session = await api(`/api/chat/${encodeURIComponent(id)}`);
      if (selection === chatSelection) { chatSession = session; renderChatMessages(); renderChatControls(); renderChatContext(); }
    }
  } catch (error) { $('#chat-status').textContent = error.message; }
  finally { chatPollBusy = false; }
}
async function sendChat(retry = false) {
  if (chatSending || chatActive(chatSession) || chatItems.some(chatActive) || referencePending.has(`chat:${chatId || 'new'}`)) return;
  const input = $('#chat-input').value.trim(); const referenceKey = `chat:${chatId || 'new'}`; const references = referenceDraft(referenceKey); if (!retry && !input && !references.length) return;
  chatSending = true; renderChatControls();
  const selection = chatSelection;
  try {
    const session = await api('/api/chat/send', { chatId, input, retry, references, provider: $('#chat-provider').value, model: $('#chat-model').value, effort: $('#chat-effort').value });
    if (selection === chatSelection) {
      referenceDrafts.delete(referenceKey);
      chatDrafts.delete(chatId || 'new'); chatId = session.id; chatSession = session; chatMessagesKey = ''; $('#chat-input').value = '';
      renderChatMessages(); renderChatContext();
    }
    await loadChatHome();
  } catch (error) { $('#chat-status').textContent = error.message; toast(error.message, true); }
  finally { chatSending = false; renderChatControls(); }
}
function bindChat() {
  $('#chat-form').onsubmit = event => { event.preventDefault(); sendChat(); };
  $('#chat-input').onkeydown = event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); sendChat(); } };
  $('#chat-new').onclick = newChat;
  $('#chat-new-mobile').onclick = newChat;
  $('#chat-mobile-history').onchange = event => event.target.value ? openChat(event.target.value) : newChat();
  $('#chat-provider').onchange = () => { $('#chat-model').value = ''; $('#chat-effort').value = ''; renderChatOptions(); };
  $('#chat-model').onchange = renderChatOptions;
  $('#chat-retry').onclick = () => sendChat(true);
  $('#chat-stop').onclick = async () => {
    if (!chatId) return; try { chatSession = await api('/api/chat/cancel', { chatId }); renderChatControls(); } catch (error) { toast(error.message, true); }
  };
  $('#chat-rename').onclick = async () => {
    if (!chatId) return; const title = prompt('對話名稱', chatSession.title); if (!title?.trim()) return;
    try { chatSession = await api('/api/chat/rename', { chatId, title }); await loadChatHome(); renderChatControls(); } catch (error) { toast(error.message, true); }
  };
  $('#chat-delete').onclick = async () => {
    if (!chatId || !confirm(`刪除對話「${chatSession.title}」及其訊息紀錄？`)) return;
    try { await api('/api/chat/delete', { chatId }); chatDrafts.delete(chatId); newChat(); await loadChatHome(); } catch (error) { toast(error.message, true); }
  };
  renderChatMessages();
  chatTimer = setInterval(pollChat, 1500);
  window.addEventListener('pagehide', () => clearInterval(chatTimer), { once: true });
}

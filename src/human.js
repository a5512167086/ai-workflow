/* Human checkpoints: interview, editable documents, and explicit task approval. */
let humanDialog = null;
let interviewDialog = null;
const interviewDrafts = new Map();
function humanModal(title, description) {
  if (humanDialog) { humanDialog.focus(); return null; }
  const dialog = document.createElement('dialog'); dialog.className = 'human-dialog'; humanDialog = dialog;
  dialog.innerHTML = `<div class="human-dialog-layout"><div class="card-head"><h2></h2><button type="button" data-close aria-label="關閉編輯視窗">×</button></div><p class="hint human-description"></p><div class="human-editor-body"></div><p class="human-error notice bad" role="alert" hidden></p><div class="row end"><button type="button" data-cancel>取消</button><button type="button" class="primary" data-save>儲存修改</button></div></div>`;
  dialog.querySelector('h2').textContent = title; dialog.querySelector('.human-description').textContent = description;
  const close = () => dialog.close(); dialog.querySelector('[data-close]').onclick = close; dialog.querySelector('[data-cancel]').onclick = close;
  dialog.onclose = () => { humanDialog = null; dialog.remove(); };
  document.body.append(dialog); dialog.showModal(); return dialog;
}
function humanSave(dialog, save) {
  let saving = false;
  dialog.oncancel = event => { if (saving) event.preventDefault(); };
  dialog.querySelector('[data-save]').onclick = async () => {
    if (saving) return; saving = true;
    const error = dialog.querySelector('.human-error'); error.hidden = true;
    dialog.querySelectorAll('button').forEach(button => button.disabled = true);
    try { await save(); dialog.close(); }
    catch (err) { error.textContent = err.message; error.hidden = false; }
    finally { saving = false; dialog.querySelectorAll('button').forEach(button => button.disabled = false); }
  };
}
function editHumanPrd() {
  const source = { text: snap.prd, version: snap.state.prd.version, scope: snap.state.prd.reference_scope ?? null };
  const dialog = humanModal('人工編輯 PRD', '儲存為新版本，保留舊版與人工修改紀錄。儲存後需重新核准 PRD；舊版任務不能直接執行。'); if (!dialog) return;
  const body = dialog.querySelector('.human-editor-body'); body.classList.add('human-prd-editor');
  const input = document.createElement('textarea'); input.className = 'mono'; input.setAttribute('aria-label', 'PRD Markdown'); input.value = source.text; input.spellcheck = false;
  const preview = document.createElement('div'); preview.className = 'md human-preview'; preview.setAttribute('aria-label', 'PRD 即時預覽');
  const render = () => { if (typeof window.renderMarkdown === 'function') preview.innerHTML = window.renderMarkdown(input.value); else preview.textContent = input.value; };
  input.oninput = render; render(); body.append(input, preview);
  humanSave(dialog, async () => { await api('/api/prd/save', { ...source, text: input.value }); onState(await api('/api/state')); toast('已保存人工版本，請重新審查或核准'); }); input.focus();
}
function editHumanTask() {
  if (!detail) return;
  const source = detail; let task = source.task;
  if (task.parent) task = task.parent.subtasks?.find(child => String(child.id) === String(source.id).split('.')[1]) || task;
  const dialog = humanModal(`人工編輯任務 #${source.id}`, '可修改需求、驗收條件、優先序與依賴。實質修改後，此任務、同組子任務及後續依賴會重新待辦，並撤回任務核准；已寫入的程式碼保留。'); if (!dialog) return;
  const body = dialog.querySelector('.human-editor-body'); body.classList.add('human-task-editor');
  const controls = {};
  const fields = [['title','標題','input'], ['priority','優先序','select'], ['description','需求說明','textarea'], ['details','實作說明／限制','textarea'], ['acceptanceCriteria','驗收條件（每行一項）','lines'], ['testStrategy','驗證方式','textarea'], ['dependencies','依賴的任務 ID（逗號分隔；子任務可用完整 ID）','dependencies'], ['requirement_ids','對應需求 ID（每行一項）','lines'], ['skills','Skills 名稱（每行一項）','lines']];
  for (const [key,label,type] of fields) {
    const wrapper = document.createElement('label'); wrapper.className = 'human-field'; const title = document.createElement('span'); title.textContent = label;
    const input = document.createElement(type === 'select' ? 'select' : ['textarea','lines'].includes(type) ? 'textarea' : 'input');
    input.id = `human-task-${key}`; if (input.tagName === 'INPUT') input.type = 'text'; if (input.tagName === 'TEXTAREA') input.rows = 3;
    if (type === 'select') input.append(new Option('高','high'), new Option('中','medium'), new Option('低','low'));
    input.value = type === 'lines' ? (task[key] || []).join('\n') : type === 'dependencies' ? (task[key] || []).join(', ') : task[key] || (key === 'priority' ? 'medium' : '');
    wrapper.append(title,input); body.append(wrapper); controls[key] = input;
  }
  humanSave(dialog, async () => {
    const patch = {};
    for (const [key,,type] of fields) patch[key] = type === 'lines' ? controls[key].value.split('\n').map(s=>s.trim()).filter(Boolean) : type === 'dependencies' ? controls[key].value.split(/[,，\s]+/).filter(Boolean) : controls[key].value;
    await api('/api/task/save', { id: source.id, tag: source.tag ?? snap.taskTag, revision: source.revision ?? snap.taskRevision, task: patch });
    onState(await api('/api/state')); await loadDetail(); toast('任務已保存，請檢視後重新核准');
  }); controls.title.focus();
}
function renderHumanControls() {
  if (!snap) return;
  const busy = snap.runnerAlive || snap.prdBusy || snap.taskGenBusy || snap.skillBusy;
  $('#btn-prd-edit').disabled = !!busy || !snap.prd;
  $('#btn-prd-review').disabled = !!busy || !snap.prd;
  $('#d-edit').disabled = !!busy || !detail;
  const approved = !!snap.taskRevision && snap.taskRevision === snap.state.task_approval?.revision;
  $('#btn-task-approve').disabled = !!busy || !snap.tasks?.length || snap.state.prd.status !== 'approved' || approved;
  $('#btn-task-approve').textContent = approved ? '任務已核准' : '檢視後核准任務';
  $('#task-human-note').textContent = !snap.tasks?.length ? '需求釐清 → 你確認摘要 → PRD 交叉審查與人工核准 → 拆任務 → 你檢視並核准任務 → 執行與驗收' : approved ? '任務已由你核准。手動模式每項完成後等你測試；所有模式最後都需功能驗收。' : '請檢視任務的範圍、驗收條件、粒度與依賴，可直接人工編輯；核准後才會開始執行。';
  const prd = snap.state.prd;
  $('#prd-human-note').textContent = prd.human_edited_at && prd.reviewed_version !== prd.version ? '目前含人工修改。可只請不同 AI 審查，保留你的原文；最後仍由你核准。' : 'AI 審查提供意見；你可以直接編輯、要求修改，最後由你核准。';
}
async function approveHumanPrd() {
  const prd = snap.state.prd;
  if (prd.human_edited_at && prd.reviewed_version !== prd.version && !confirm('這個人工版本尚未重新交叉審查。要直接由你核准並開始拆任務嗎？')) return;
  await act('/api/prd/approve', { version: prd.version, scope: prd.reference_scope ?? null }, 'PRD 已核准，正在產生供你檢視的任務');
}
async function openInterview(id) {
  if (interviewDialog) { interviewDialog.focus(); return; }
  const dialog = document.createElement('dialog'); dialog.className = 'human-dialog interview-dialog'; interviewDialog = dialog;
  dialog.innerHTML = `<div class="human-dialog-layout"><div class="card-head"><h2>Grill Me · 需求釐清</h2><button type="button" data-close aria-label="關閉需求會議">×</button></div>
    <p class="hint">AI 先查專案、追問決策與驗收條件。你確認摘要後才會寫 PRD。可關閉後回來接續。</p>
    <div class="interview-conversation" role="log" aria-live="polite"></div><p class="interview-status" role="status"></p>
    <div class="interview-answer"><label class="field-label">你的回答或補充<textarea rows="3" maxlength="20000" placeholder="回答本輪問題；有多題時可依題號回答…"></textarea></label><div class="row end"><label class="hint">AI <select aria-label="需求釐清 AI"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><button type="button" data-stop hidden>停止回覆</button><button type="button" data-retry hidden>重試回覆</button><button type="button" data-restart>重新釐清</button><button type="button" data-send>送出回答</button></div></div>
    <div class="interview-summary" hidden><label class="field-label">確認需求摘要（可人工修正）<textarea rows="6"></textarea></label><button type="button" class="primary" data-confirm>確認需求，開始寫 PRD</button></div></div>`;
  const messages = dialog.querySelector('.interview-conversation'), status = dialog.querySelector('.interview-status'), input = dialog.querySelector('.interview-answer textarea'), provider = dialog.querySelector('select'), summary = dialog.querySelector('.interview-summary textarea');
  input.value = interviewDrafts.get(id) || ''; provider.value = snap?.config?.roles?.interviewer || snap?.config?.roles?.author || 'claude';
  let data, timer, pending = false, messageKey = '', summaryTurn = '';
  const close = () => dialog.close(); dialog.querySelector('[data-close]').onclick = close;
  dialog.onclose = () => { clearTimeout(timer); interviewDrafts.set(id,input.value); interviewDialog = null; dialog.remove(); };
  const render = () => {
    if (!dialog.isConnected) return;
    const session = data?.session; const active = chatActive(session);
    const key = JSON.stringify(session?.messages || []);
    if (messageKey !== key) {
      const follow = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 60; messageKey = key; messages.replaceChildren();
      for (const message of session?.messages || []) {
        const article = document.createElement('article'); article.className = `chat-message ${message.role === 'user' ? 'from-user' : 'from-ai'}`;
        const heading = document.createElement('b'); heading.textContent = message.role === 'user' ? '你' : '需求釐清 AI';
        const body = document.createElement('div'); body.className = 'md';
        // AI 訊息與專案對話一樣渲染：Markdown 加上離線 Mermaid 圖表；使用者訊息只當純文字。
        if (message.role === 'user') { body.textContent = message.text; body.classList.add('plain-text'); }
        else if (typeof renderChatMarkdown === 'function') renderChatMarkdown(body, message.text).then(() => { if (follow && body.isConnected) messages.scrollTop = messages.scrollHeight; });
        else if (typeof window.renderMarkdown === 'function') body.innerHTML = window.renderMarkdown(message.text);
        else body.textContent = message.text;
        article.append(heading,body); messages.append(article);
      }
      if (follow) messages.scrollTop = messages.scrollHeight;
    }
    status.textContent = data?.stale ? '需求或附件已修改，請重新釐清。舊對話仍保留。' : session?.error ? session.error : active || pending ? 'AI 正在查閱資料與整理問題…' : data?.confirmed ? '你已確認需求，可開始寫 PRD。' : session?.requirementsReady ? '關鍵問題已釐清，請檢閱、修正並確認下方摘要。' : '請回答本輪問題；AI 會依回答繼續追問。';
    dialog.querySelector('[data-send]').disabled = pending || active || !!data?.stale;
    dialog.querySelector('[data-restart]').disabled = pending || active;
    dialog.querySelector('[data-stop]').hidden = !active; dialog.querySelector('[data-retry]').hidden = !session || !['error','cancelled'].includes(session.status);
    dialog.querySelector('[data-retry]').disabled = pending || active;
    dialog.querySelector('.interview-summary').hidden = !session?.requirementsReady || !!data?.stale || active || pending;
    if (summaryTurn !== session?.turn && session?.requirementsReady) { summaryTurn = session.turn; summary.value = session.confirmedSummary || session.requirementsSummary || ''; }
    dialog.querySelector('[data-confirm]').textContent = data?.confirmed ? '開始寫 PRD' : '確認需求，開始寫 PRD';
    clearTimeout(timer); if (active) timer = setTimeout(load,1200);
  };
  async function load() {
    try { data = await api(`/api/requirements/${encodeURIComponent(id)}`); render(); }
    catch (error) { status.textContent = error.message; }
  }
  async function send(restart = false, retry = false, initial = false) {
    if (pending || (!restart && !retry && !initial && !input.value.trim())) return;
    if (restart && !confirm('重新開始需求釐清？舊會議會保留，這項需求改用新的會議。')) return;
    pending = true; render(); const answer = input.value;
    try { data = await api('/api/backlog/interview', { id, input: initial || restart ? '' : answer, provider: provider.value, restart, retry }); if (!initial && !restart) input.value = ''; interviewDrafts.set(id,input.value); }
    catch (error) { status.textContent = error.message; pending = false; return; }
    pending = false; render();
  }
  dialog.querySelector('[data-send]').onclick = () => send(); dialog.querySelector('[data-restart]').onclick = () => send(true); dialog.querySelector('[data-retry]').onclick = () => send(false,true);
  dialog.querySelector('[data-stop]').onclick = async () => { try { await api('/api/chat/cancel', { chatId: data.session.id }); await load(); } catch (error) { status.textContent = error.message; } };
  dialog.querySelector('[data-confirm]').onclick = async event => {
    if (pending || !data?.session?.requirementsReady) return;
    event.target.disabled = true;
    try {
      if (!data.confirmed) data = await api('/api/backlog/confirm', { id, sessionId: data.session.id, turn: data.session.turn, summary: summary.value });
      if (snap?.prd && !confirm('以這份已確認的需求起草新 PRD？目前 PRD 將切換到新功能。')) return;
      await api('/api/backlog/draft', { id }); interviewDrafts.delete(id); dialog.close(); toast('已確認需求，正在起草 PRD');
    } catch (error) { status.textContent = error.message; }
    finally { event.target.disabled = false; }
  };
  document.body.append(dialog); dialog.showModal(); await load(); if (data && !data.session) await send(false,false,true);
}
function bindHuman() {
  $('#btn-prd-edit').onclick = editHumanPrd; $('#d-edit').onclick = editHumanTask;
  $('#btn-prd-review').onclick = () => act('/api/prd/review', {}, '正在交叉審查目前版本，保留你的原文');
  $('#btn-task-approve').onclick = async () => {
    try { await api('/api/tasks/approve', { revision: snap.taskRevision }); onState(await api('/api/state')); toast('任務已核准，可開始執行'); }
    catch (error) { toast(error.message,true); }
  };
}

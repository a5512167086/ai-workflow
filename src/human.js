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
  const approved = !!snap.taskRevision && snap.taskRevision === snap.state.task_approval?.revision;
  if (snap.guards) {
    // 防呆原因由後端依流程狀態算好，停用時把原因放在提示文字。
    applyGuard($('#btn-prd-edit'), guardOf('prd.edit'));
    applyGuard($('#btn-prd-review'), guardOf('prd.review'));
    applyGuard($('#d-edit'), detail ? guardOf('task.edit') : '還沒有選擇任務');
    applyGuard($('#btn-task-approve'), approved ? '' : guardOf('tasks.approve'));
    if (approved) $('#btn-task-approve').disabled = true;
  } else {
    $('#btn-prd-edit').disabled = !!busy || !snap.prd;
    $('#btn-prd-review').disabled = !!busy || !snap.prd;
    $('#d-edit').disabled = !!busy || !detail;
    $('#btn-task-approve').disabled = !!busy || !snap.tasks?.length || snap.state.prd.status !== 'approved' || approved;
  }
  $('#btn-task-approve').textContent = approved ? '任務已核准' : '檢視後核准任務';
  $('#task-human-note').textContent = !snap.tasks?.length ? '需求釐清 → 你確認摘要 → PRD 交叉審查與人工核准 → 拆任務 → 你檢視並核准任務 → 執行與驗收' : approved ? '任務已由你核准。手動模式每項完成後等你測試；所有模式最後都需功能驗收。' : '核准前請確認：每個任務做完都能單獨展示與手動測試嗎？粒度會太粗或太細嗎？依賴是否只列真正擋住它的任務？有沒有該合併或再拆的？可以直接人工編輯；核准後照清單順序執行。';
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
    <p class="hint">AI 先查專案、追問決策與驗收條件。釐清完成後右側會出現需求摘要：先檢視（可編輯）並確認，再開始寫 PRD。可關閉後回來接續。</p>
    <div class="interview-body">
      <div class="interview-chat">
        <div class="interview-conversation" role="log" aria-live="polite"></div><p class="interview-status" role="status"></p>
        <div class="interview-answer"><label class="field-label">你的回答或補充<textarea rows="3" maxlength="20000" placeholder="回答本輪問題；有多題時可依題號回答…"></textarea></label><div class="row end"><label class="hint">AI <select aria-label="需求釐清 AI"><option value="claude">Claude Code</option><option value="codex">Codex</option></select></label><button type="button" data-stop hidden>停止回覆</button><button type="button" data-retry hidden>重試回覆</button><button type="button" data-restart>重新釐清</button><button type="button" data-send>送出回答</button></div></div>
      </div>
      <aside class="interview-summary" aria-label="需求摘要" hidden>
        <div class="card-head"><h3>需求摘要</h3><div class="seg" role="radiogroup" aria-label="摘要顯示方式"><button type="button" role="radio" aria-checked="true" data-summary-view="preview" class="on">預覽</button><button type="button" role="radio" aria-checked="false" data-summary-view="edit">編輯</button></div></div>
        <p class="interview-summary-note hint" role="status"></p>
        <div class="interview-summary-body"><div class="md summary-preview" aria-label="需求摘要預覽"></div><textarea aria-label="需求摘要 Markdown" spellcheck="false" hidden></textarea></div>
        <div class="row end interview-summary-actions"><button type="button" class="primary" data-confirm>確認需求摘要</button><button type="button" class="primary" data-draft hidden>開始寫 PRD</button></div>
      </aside>
    </div></div>`;
  const messages = dialog.querySelector('.interview-conversation'), status = dialog.querySelector('.interview-status'), input = dialog.querySelector('.interview-answer textarea'), provider = dialog.querySelector('select');
  const summary = dialog.querySelector('.interview-summary textarea'), preview = dialog.querySelector('.summary-preview'), summaryNote = dialog.querySelector('.interview-summary-note');
  input.value = interviewDrafts.get(id) || ''; provider.value = snap?.config?.roles?.interviewer || snap?.config?.roles?.author || 'claude';
  let data, timer, pending = false, messageKey = '', summaryTurn = '', previewText = null;
  // 摘要預覽：與會議訊息相同的 Markdown／Mermaid 渲染；只在內容變動時重畫。
  const renderSummary = () => {
    if (previewText === summary.value) return; previewText = summary.value;
    if (typeof renderChatMarkdown === 'function') renderChatMarkdown(preview, summary.value);
    else if (typeof window.renderMarkdown === 'function') preview.innerHTML = window.renderMarkdown(summary.value);
    else preview.textContent = summary.value;
  };
  const showSummaryView = view => {
    for (const button of dialog.querySelectorAll('[data-summary-view]')) { const on = button.dataset.summaryView === view; button.classList.toggle('on', on); button.setAttribute('aria-checked', String(on)); }
    summary.hidden = view !== 'edit'; preview.hidden = view === 'edit';
    if (view === 'edit') summary.focus(); else renderSummary();
  };
  for (const button of dialog.querySelectorAll('[data-summary-view]')) button.onclick = () => showSummaryView(button.dataset.summaryView);
  summary.oninput = () => renderSummaryState();
  // 確認與開始寫 PRD 分成兩步：摘要改過就要重新確認，確認後才開放「開始寫 PRD」。
  const renderSummaryState = () => {
    const session = data?.session; const edited = !!data?.confirmed && summary.value.trim() !== (session?.confirmedSummary || '').trim();
    const confirmed = !!data?.confirmed && !edited;
    summaryNote.textContent = confirmed ? '你已確認這份摘要。可以開始寫 PRD，或改成「編輯」再修改後重新確認。' : edited ? '摘要已修改，請重新確認。' : '請檢視 AI 整理的需求範圍、限制與驗收條件；可切到「編輯」直接修改，確認後才能開始寫 PRD。';
    const confirmButton = dialog.querySelector('[data-confirm]'), draftButton = dialog.querySelector('[data-draft]');
    confirmButton.textContent = edited ? '重新確認摘要' : confirmed ? '已確認' : '確認需求摘要';
    confirmButton.disabled = pending || confirmed || !summary.value.trim(); confirmButton.classList.toggle('primary', !confirmed);
    draftButton.hidden = !data?.confirmed;
    // 會議可以在流程執行中進行；開始寫 PRD 要等流程結束（防呆原因來自後端）。
    applyGuard(draftButton, pending ? '處理中…' : !confirmed ? '請先確認需求摘要' : guardOf('backlog.draft'));
  };
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
    // AI 工作中顯示從這一輪送出開始的持續時間（最後一則使用者訊息的時間）。
    const since = active ? session?.messages?.findLast?.(message => message.role === 'user')?.at : null;
    liveSince(status, data?.stale ? '需求或附件已修改，請重新釐清。舊對話仍保留。' : session?.error ? session.error : active || pending ? 'AI 正在查閱資料與整理問題…' : data?.confirmed ? '你已確認需求，可開始寫 PRD。' : session?.requirementsReady ? '關鍵問題已釐清，請檢閱、修正並確認右側摘要。' : '請回答本輪問題；AI 會依回答繼續追問。', since);
    dialog.querySelector('[data-send]').disabled = pending || active || !!data?.stale;
    dialog.querySelector('[data-restart]').disabled = pending || active;
    dialog.querySelector('[data-stop]').hidden = !active; dialog.querySelector('[data-retry]').hidden = !session || !['error','cancelled'].includes(session.status);
    dialog.querySelector('[data-retry]').disabled = pending || active;
    const showSummary = !!session?.requirementsReady && !data?.stale && !active && !pending;
    dialog.querySelector('.interview-summary').hidden = !showSummary; dialog.classList.toggle('with-summary', showSummary);
    if (summaryTurn !== session?.turn && session?.requirementsReady) { summaryTurn = session.turn; summary.value = session.confirmedSummary || session.requirementsSummary || ''; showSummaryView('preview'); }
    if (showSummary) { renderSummary(); renderSummaryState(); }
    clearTimeout(timer); if (active) timer = setTimeout(load,1200);
  };
  async function load() {
    try { data = await api(`/api/requirements/${encodeURIComponent(id)}`); render(); }
    catch (error) { liveSince(status, error.message, null); }
  }
  async function send(restart = false, retry = false, initial = false) {
    if (pending || (!restart && !retry && !initial && !input.value.trim())) return;
    if (restart && !confirm('重新開始需求釐清？舊會議會保留，這項需求改用新的會議。')) return;
    pending = true; render(); const answer = input.value;
    try { data = await api('/api/backlog/interview', { id, input: initial || restart ? '' : answer, provider: provider.value, restart, retry }); if (!initial && !restart) input.value = ''; interviewDrafts.set(id,input.value); }
    catch (error) { liveSince(status, error.message, null); pending = false; return; }
    pending = false; render();
  }
  dialog.querySelector('[data-send]').onclick = () => send(); dialog.querySelector('[data-restart]').onclick = () => send(true); dialog.querySelector('[data-retry]').onclick = () => send(false,true);
  dialog.querySelector('[data-stop]').onclick = async () => { try { await api('/api/chat/cancel', { chatId: data.session.id }); await load(); } catch (error) { liveSince(status, error.message, null); } };
  dialog.querySelector('[data-confirm]').onclick = async () => {
    if (pending || !data?.session?.requirementsReady || !summary.value.trim()) return;
    pending = true; renderSummaryState();
    try { data = await api('/api/backlog/confirm', { id, sessionId: data.session.id, turn: data.session.turn, summary: summary.value }); toast('需求摘要已確認，可以開始寫 PRD'); }
    catch (error) { summaryNote.textContent = error.message; }
    finally { pending = false; renderSummaryState(); }
  };
  dialog.querySelector('[data-draft]').onclick = async () => {
    if (pending || !data?.confirmed) return;
    // 目前功能還沒做完時講清楚後果：未完成的任務會留在原本的任務群組，不會繼續執行。
    const unfinished = (snap?.tasks || []).filter(task => task.status !== 'done').length;
    const switching = snap?.state?.pipeline?.status === 'complete' || !unfinished
      ? '以這份已確認的需求起草新 PRD？目前 PRD 將切換到新功能。'
      : `目前功能還有 ${unfinished} 個任務未完成。改用這份需求起草新 PRD 後，流程會切換到新功能，舊任務留在原本的任務群組，不會繼續執行。確定要切換嗎？`;
    if (snap?.prd && !confirm(switching)) return;
    pending = true; renderSummaryState();
    try { await api('/api/backlog/draft', { id }); interviewDrafts.delete(id); dialog.close(); toast('正在依確認的需求起草 PRD'); }
    catch (error) { summaryNote.textContent = error.message; pending = false; renderSummaryState(); }
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

/* AI 要求的工具權限：流程執行中 CLI 想跑沒有預先允許的指令時，跳出允許／拒絕的對話框。 */
let permissionDialog = null;
const permissionLater = new Set();
function permissionInputView(entry) {
  const input = entry.input || {};
  const wrap = document.createElement('div'); wrap.className = 'permission-input';
  const label = document.createElement('div'); label.className = 'field-label';
  const pre = document.createElement('pre'); pre.className = 'permission-code';
  if (typeof input.command === 'string') { label.textContent = '指令'; pre.textContent = input.command; }
  else if (typeof input.file_path === 'string') { label.textContent = '檔案'; pre.textContent = input.file_path; }
  else if (typeof input.url === 'string') { label.textContent = '網址'; pre.textContent = input.url; }
  else { label.textContent = '內容'; pre.textContent = JSON.stringify(input, null, 2); }
  wrap.append(label, pre);
  return wrap;
}
function permissionRuleText(entry) {
  const rules = (entry.suggestions || []).flatMap(s => s.rules || []);
  return rules.map(rule => rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName).filter(Boolean).join('、');
}
function renderPermissionNotice(waiting) {
  let notice = $('#permission-notice');
  if (!waiting.length || permissionDialog) { notice?.remove(); return; }
  if (!notice) {
    notice = document.createElement('div'); notice.id = 'permission-notice'; notice.className = 'permission-notice'; notice.setAttribute('role', 'status');
    notice.innerHTML = '<span></span><button type="button" class="primary">檢視</button>';
    notice.querySelector('button').onclick = () => { permissionLater.clear(); renderPermissions(true); };
    document.body.append(notice);
  }
  notice.querySelector('span').textContent = `AI 等待你允許 ${waiting.length} 個操作`;
}
function renderPermissions(force = false) {
  const waiting = snap?.permissions || [];
  // 對話框裡的請求已經失效（執行結束、逾時或在別處回答）就關掉。
  if (permissionDialog && !waiting.some(entry => entry.id === permissionDialog.dataset.id)) permissionDialog.close();
  const next = waiting.find(entry => force || !permissionLater.has(entry.id));
  if (permissionDialog || !next) { renderPermissionNotice(waiting); return; }
  const dialog = document.createElement('dialog'); dialog.className = 'permission-dialog'; dialog.dataset.id = next.id; permissionDialog = dialog;
  dialog.setAttribute('aria-labelledby', 'permission-title');
  dialog.innerHTML = `<div class="card-head"><h2 id="permission-title">AI 要求執行操作</h2><span class="hint permission-count"></span></div>
    <p class="permission-who"></p><p class="permission-desc"></p><div class="permission-body"></div><p class="hint permission-reason"></p>
    <label class="field-label permission-deny-label">拒絕原因（選填，會告訴 AI）<textarea rows="2" maxlength="2000" placeholder="例如：請改用 pnpm，或先不要安裝這個套件"></textarea></label>
    <p class="permission-error notice bad" role="alert" hidden></p>
    <div class="row permission-actions"><button type="button" data-later>稍後決定</button><span class="spacer"></span><button type="button" data-decision="deny">拒絕</button><button type="button" data-decision="allow_session" hidden></button><button type="button" class="primary" data-decision="allow">允許這一次</button></div>`;
  const others = waiting.length - 1;
  dialog.querySelector('.permission-count').textContent = others > 0 ? `還有 ${others} 個等待中` : '';
  dialog.querySelector('.permission-who').textContent = `${next.label || next.scope}・${next.provider === 'codex' ? 'Codex' : 'Claude'} 想使用 ${next.display_name || next.tool}`;
  dialog.querySelector('.permission-desc').textContent = next.description || '';
  dialog.querySelector('.permission-body').append(permissionInputView(next));
  dialog.querySelector('.permission-reason').textContent = next.reason ? `CLI：${next.reason}` : '';
  const rule = permissionRuleText(next);
  const session = dialog.querySelector('[data-decision="allow_session"]');
  if (rule) { session.hidden = false; session.textContent = `這次執行都允許 ${rule}`; session.title = '只在這次 AI 執行期間有效，不會寫進專案的設定檔'; }
  const error = dialog.querySelector('.permission-error'), reason = dialog.querySelector('textarea');
  for (const button of dialog.querySelectorAll('[data-decision]')) {
    button.onclick = async () => {
      dialog.querySelectorAll('button').forEach(b => b.disabled = true); error.hidden = true;
      try {
        await api('/api/permissions/answer', { id: next.id, decision: button.dataset.decision, message: button.dataset.decision === 'deny' ? reason.value : '' });
        snap.permissions = (snap.permissions || []).filter(entry => entry.id !== next.id);
        toast(button.dataset.decision === 'deny' ? '已拒絕，AI 會改用其他做法或停下' : '已允許，AI 繼續執行');
        dialog.close();
      } catch (err) { error.textContent = err.message; error.hidden = false; dialog.querySelectorAll('button').forEach(b => b.disabled = false); }
    };
  }
  dialog.querySelector('[data-later]').onclick = () => { permissionLater.add(next.id); dialog.close(); };
  // Esc 等於「稍後決定」，不會被當成拒絕。
  dialog.addEventListener('cancel', event => { event.preventDefault(); permissionLater.add(next.id); dialog.close(); });
  dialog.addEventListener('close', () => { permissionDialog = null; dialog.remove(); renderPermissions(); });
  document.body.append(dialog);
  if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', '');
  dialog.querySelector('[data-decision="allow"]').focus();
  renderPermissionNotice(waiting);
}

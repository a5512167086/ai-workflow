/* Project reference snapshots. Draft attachments belong to their composer/chat. */
const referenceDrafts = new Map();
const referencePending = new Set();
let referenceCatalog = new Map();
let referenceDialog = null;
function referenceDraft(key) { return referenceDrafts.get(key) || []; }
function referenceName(id) { return referenceCatalog.get(id)?.name || `參考 ${id.slice(0, 8)}`; }
async function refreshReferenceCatalog() {
  const data = await api('/api/references');
  if (Array.isArray(data.items)) for (const item of data.items) referenceCatalog.set(item.id, item);
}
function referenceChips(ids, remove) {
  const row = document.createElement('div'); row.className = 'reference-chips';
  for (const id of ids || []) {
    const item = referenceCatalog.get(id); const chip = document.createElement('span'); chip.className = 'reference-chip';
    chip.title = item ? `${item.sourcePath}\n${item.fileCount} 個檔案 · ${item.excludedCount || 0} 個排除項目\n${(item.warnings || []).join('\n')}` : id;
    const name = document.createElement('span'); name.textContent = `${item?.kind === 'folder' ? '▤' : '▧'} ${referenceName(id)}`; chip.append(name);
    if (remove) { const button = document.createElement('button'); button.type = 'button'; button.textContent = '×'; button.setAttribute('aria-label', `移除參考：${referenceName(id)}`); button.onclick = () => remove(id); chip.append(button); }
    row.append(chip);
  }
  return row;
}
function referenceOptions(type) {
  if (type === 'backlog-draft') return { title: '需求參考', key: 'backlog', ids: referenceDraft('backlog') };
  if (type === 'chat') { const key = `chat:${chatId || 'new'}`; return { title: '訊息參考', key, ids: referenceDraft(key) }; }
  if (type === 'feature') return { title: '功能參考（PRD、拆任務共用）', target: 'feature', featureScope: snap?.state?.prd?.reference_scope || null, ids: snap?.state?.prd?.references || [] };
  if (type === 'group') return { title: '功能共用參考', target: 'group', tag: snap?.taskTag, ids: snap?.taskReferences || [] };
  if (type === 'task') return { title: '此任務額外參考（另沿用功能與父任務）', target: 'task', id: detail?.id, tag: snap?.taskTag, ids: detail?.task?.references || [] };
}
async function saveReferenceSelection(options, ids) {
  ids = [...new Set(ids)]; if (ids.length > 24) throw new Error('最多加入 24 份參考資料');
  if (options.key) referenceDrafts.set(options.key, [...ids]);
  else {
    await api('/api/references/assign', { target: options.target, id: options.id, tag: options.tag, featureScope: options.featureScope, references: ids });
    if (options.target === 'backlog') await loadBacklog();
    else { onState(await api('/api/state')); if (options.target === 'task') await loadDetail(); }
  }
  renderReferenceWidgets();
}
function renderReferenceWidget(host, options) {
  if (!host || !options) return;
  const key = JSON.stringify([options, [...referenceCatalog.keys()]]);
  if (host.dataset.referenceRender === key) return;
  host.dataset.referenceRender = key; host.replaceChildren();
  const toolbar = document.createElement('div'); toolbar.className = 'reference-toolbar';
  const label = document.createElement('span'); label.className = 'hint'; label.textContent = options.title;
  const button = document.createElement('button'); button.type = 'button'; button.className = 'reference-add'; button.textContent = '＋ 加入參考';
  if (options.target === 'group' && !snap?.tasks?.length) { button.disabled = true; button.title = '拆任務前的參考資料請加在 PRD 或需求待辦'; }
  button.onclick = () => openReferenceDialog(options); toolbar.append(label, button);
  host.append(toolbar, referenceChips(options.ids, id => saveReferenceSelection(options, options.ids.filter(value => value !== id)).catch(error => toast(error.message, true))));
  host._referenceOptions = () => options;
}
function renderReferenceWidgets() {
  if ($('#bl-add')) $('#bl-add').disabled = referencePending.has('backlog');
  for (const [id, type] of [['bl-references', 'backlog-draft'], ['chat-references', 'chat'], ['prd-references', 'feature'], ['board-references', 'group'], ['task-references', 'task']]) {
    renderReferenceWidget(document.getElementById(id), referenceOptions(type));
  }
}
async function importReference(body) {
  const item = await api('/api/references/import', body); referenceCatalog.set(item.id, item); return item;
}
async function uploadReference(file) {
  if (file.size > 20 * 1024 * 1024) throw new Error('單檔上限 20 MB');
  const data = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
  return importReference({ name: file.name || `貼上圖片-${Date.now()}.png`, data });
}
async function openReferenceDialog(options) {
  if (referenceDialog) return;
  const dialog = document.createElement('dialog'); dialog.className = 'reference-dialog'; referenceDialog = dialog;
  dialog.innerHTML = `<form method="dialog" class="reference-dialog-form">
    <div class="card-head"><h2></h2><button type="submit" value="cancel" aria-label="關閉參考資料">×</button></div>
    <p class="hint">加入檔案、圖片、PDF 或資料夾。資料會保存為專案內的快照，來源更新後請重新加入。可拖放到這個視窗。</p>
    <div class="row"><button type="button" data-pick="files">選擇檔案</button><button type="button" data-pick="folder">選擇資料夾</button></div>
    <div class="reference-path"><input type="text" aria-label="參考檔案或資料夾路徑" placeholder="貼上檔案或資料夾完整路徑"><button type="button" data-import>加入路徑</button></div>
    <p class="hint">單檔 20 MB；每份資料夾 64 MB／2000 檔。資料夾會排除 .git、node_modules、建置產物、.env、金鑰與連結。其他格式提供原始快照，能否解析取決於 CLI 工具。</p>
    <p class="reference-status" role="status"></p><div class="reference-library" aria-label="已加入的參考資料"></div>
    <div class="row end"><button type="submit" value="cancel">取消</button><button type="button" class="primary" data-apply>套用參考資料</button></div>
  </form>`;
  dialog.querySelector('h2').textContent = options.title;
  const chosen = new Set(options.ids || []); const status = dialog.querySelector('.reference-status'); let importing = false;
  const render = () => {
    const list = dialog.querySelector('.reference-library'); list.replaceChildren();
    if (!referenceCatalog.size) list.textContent = '尚未加入參考資料';
    for (const item of referenceCatalog.values()) {
      const label = document.createElement('label'); label.className = 'reference-library-item';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = chosen.has(item.id);
      checkbox.onchange = () => checkbox.checked ? chosen.add(item.id) : chosen.delete(item.id);
      const info = document.createElement('span'); const name = document.createElement('b'); name.textContent = item.name;
      const detail = document.createElement('small'); detail.textContent = `${item.kind === 'folder' ? '資料夾' : '檔案'} · ${item.fileCount} 檔 · ${Math.ceil(item.totalBytes / 1024)} KB${item.excludedCount ? ` · 排除 ${item.excludedCount} 項` : ''}\n${item.sourcePath}${item.warnings?.length ? `\n${item.warnings.join('；')}` : ''}`;
      info.append(name, detail); label.append(checkbox, info); list.append(label);
    }
  };
  const importingFiles = async jobs => {
    if (importing || !jobs.length) return; importing = true;
    const buttons = [...dialog.querySelectorAll('button,input')]; buttons.forEach(button => button.disabled = true); status.textContent = '正在建立參考快照…';
    const errors = []; let count = 0;
    for (const job of jobs.slice(0, 16)) {
      try { const item = await job(); chosen.add(item.id); count++; } catch (error) { errors.push(error.message); }
    }
    if (jobs.length > 16) errors.push('一次最多匯入 16 項，其餘請再次加入');
    status.textContent = [count ? `已加入 ${count} 份資料，按「套用」使用。` : '', ...errors].filter(Boolean).join('\n');
    buttons.forEach(button => button.disabled = false); importing = false; render();
  };
  dialog._importPaths = paths => importingFiles(paths.map(path => () => importReference({ path })));
  const browserInput = document.createElement('input'); browserInput.type = 'file'; browserInput.multiple = true; browserInput.hidden = true; dialog.append(browserInput);
  browserInput.onchange = () => importingFiles([...browserInput.files].map(file => () => uploadReference(file)));
  dialog.querySelector('[data-pick="files"]').onclick = async () => {
    try {
      if (!window.__TAURI__?.webview) { browserInput.click(); return; }
      await dialog._importPaths(await window.__TAURI__.core.invoke('pick_reference_files'));
    } catch (error) { status.textContent = error.message; }
  };
  dialog.querySelector('[data-pick="folder"]').onclick = async () => {
    try { const path = await window.__TAURI__.core.invoke('pick_reference_folder'); if (path) await dialog._importPaths([path]); }
    catch (error) { status.textContent = `${error.message}；也可以貼上完整路徑。`; }
  };
  dialog.querySelector('[data-import]').onclick = () => { const input = dialog.querySelector('.reference-path input'); if (input.value.trim()) dialog._importPaths([input.value.trim()]); };
  dialog.querySelector('.reference-path input').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); dialog.querySelector('[data-import]').click(); } };
  dialog.querySelector('[data-apply]').onclick = async () => {
    try { if (chosen.size > 24) throw new Error('最多選取 24 份參考資料'); await saveReferenceSelection(options, [...chosen]); dialog.close(); }
    catch (error) { status.textContent = error.message; }
  };
  dialog.oncancel = event => { if (importing) event.preventDefault(); };
  dialog.onclose = () => { referenceDialog = null; dialog.remove(); renderReferenceWidgets(); };
  dialog.ondragover = event => event.preventDefault();
  dialog.ondrop = event => { event.preventDefault(); importingFiles([...event.dataTransfer.files].map(file => () => uploadReference(file))); };
  document.body.append(dialog); dialog.showModal(); render();
  try { await refreshReferenceCatalog(); if (dialog.isConnected) render(); } catch (error) { status.textContent = error.message; }
}
function bindReferenceInput(input, getOptions) {
  if (!input) return;
  input.addEventListener('paste', async event => {
    const files = [...(event.clipboardData?.files || [])]; if (!files.length) return;
    event.preventDefault(); const options = getOptions();
    if (referencePending.has(options.key || options.target)) return;
    referencePending.add(options.key || options.target); renderReferenceWidgets(); renderChatControls();
    try { const ids = [...options.ids]; for (const file of files) ids.push((await uploadReference(file)).id); await saveReferenceSelection(options, ids); }
    catch (error) { toast(error.message, true); }
    finally { referencePending.delete(options.key || options.target); renderReferenceWidgets(); renderChatControls(); }
  });
  let popup = null, timer, generation = 0, cursor = 0, rows = [], token;
  const hide = () => { popup?.remove(); popup = null; rows = []; generation++; };
  const choose = async index => {
    const row = rows[index]; if (!row) return;
    const options = getOptions(); const selectedToken = token; hide();
    try {
      const item = row.id ? row : await importReference({ path: row.path });
      await saveReferenceSelection(options, [...new Set([...options.ids, item.id])]);
      input.setRangeText(`@${item.name} `, selectedToken.start, selectedToken.end, 'end'); input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    } catch (error) { toast(error.message, true); }
  };
  input.addEventListener('input', () => {
    clearTimeout(timer); hide();
    const before = input.value.slice(0, input.selectionStart); const match = before.match(/(?:^|\s)@([^\s@]*)$/);
    if (!match) return;
    token = { start: before.length - match[1].length - 1, end: before.length }; const query = match[1]; const current = generation;
    timer = setTimeout(async () => {
      try {
        const data = await api('/api/references/suggest', { query }); if (current !== generation || !input.isConnected || document.activeElement !== input) return;
        rows = [...referenceCatalog.values()].filter(item => item.name.toLowerCase().includes(query.toLowerCase())).concat(data.items || []).slice(0, 12);
        if (!rows.length) return;
        popup = document.createElement('div'); popup.className = 'reference-suggestions'; popup.setAttribute('role', 'listbox');
        const rect = input.getBoundingClientRect(); popup.style.left = `${rect.left}px`; popup.style.bottom = `${window.innerHeight - rect.top + 4}px`; popup.style.width = `${Math.min(rect.width, 550)}px`; cursor = 0;
        rows.forEach((item, index) => { const button = document.createElement('button'); button.type = 'button'; button.textContent = `${item.kind === 'folder' ? '▤' : '▧'} ${item.name}${item.id ? ' · 已加入' : ''}`; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(index === 0)); button.onmousedown = event => { event.preventDefault(); choose(index); }; popup.append(button); });
        document.body.append(popup);
      } catch (error) { toast(error.message, true); }
    }, 180);
  });
  input.addEventListener('keydown', event => {
    if (!popup || event.isComposing) return;
    if (['ArrowDown', 'ArrowUp', 'Enter', 'Escape', 'Tab'].includes(event.key)) { event.preventDefault(); event.stopImmediatePropagation(); }
    if (event.key === 'Escape') hide();
    else if (event.key === 'Enter' || event.key === 'Tab') choose(cursor);
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { cursor = (cursor + (event.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length; [...popup.children].forEach((el, i) => el.setAttribute('aria-selected', String(i === cursor))); popup.children[cursor].scrollIntoView?.({ block: 'nearest' }); }
  }, true);
  input.addEventListener('blur', hide);
}
function bindReferences() {
  renderReferenceWidgets(); refreshReferenceCatalog().then(renderReferenceWidgets).catch(() => {});
  bindReferenceInput($('#bl-detail'), () => referenceOptions('backlog-draft'));
  bindReferenceInput($('#chat-input'), () => referenceOptions('chat'));
  bindReferenceInput($('#feedback'), () => referenceOptions('feature'));
  const webview = window.__TAURI__?.webview;
  if (webview && window === window.top) webview.getCurrentWebview().onDragDropEvent(async event => {
    if (event.payload.type !== 'drop') return;
    const paths = event.payload.paths || []; if (!paths.length) return;
    if (referenceDialog) { referenceDialog._importPaths(paths); return; }
    const point = event.payload.position; const element = point ? document.elementFromPoint(point.x / devicePixelRatio, point.y / devicePixelRatio) : null;
    // 拖到 Skills 頁：當成技能資料夾匯入（像 .claude/skills/<name>/），不是參考資料。
    if (element?.closest('#tab-skills') && typeof importSkillFolders === 'function') { await importSkillFolders(paths); return; }
    const type = element?.closest('#tab-backlog') ? 'backlog-draft' : element?.closest('#tab-prd') ? 'feature' : element?.closest('#detail') ? 'task' : element?.closest('#tab-board') ? 'group' : element?.closest('#tab-chat') ? 'chat' : null;
    if (!type) { toast('請將參考資料拖到需求、PRD、任務或聊天區域'); return; }
    const options = referenceOptions(type); const ids = [...options.ids];
    try { for (const path of paths.slice(0,16)) ids.push((await importReference({ path })).id); await saveReferenceSelection(options, [...new Set(ids)]); toast('已加入參考資料'); }
    catch (error) { toast(error.message, true); }
  }).catch(error => console.warn('參考資料拖放無法啟用', error));
}

'use strict';

// 任務 diff 檢視：把 git 的 unified diff 解析成檔案與區塊，用 GitHub 風格顯示（左右並排或單欄、行號、檔案清單）。
// 內容一律用 textContent 寫入，不會執行 diff 裡的 HTML。

/** 解析 unified diff。會略過開頭的 --stat 摘要；回傳 [{ path, oldPath, status, binary, adds, dels, hunks: [{ header, lines: [{ type, text, old, new }] }] }]。 */
function parseUnifiedDiff(text) {
  const files = [];
  let file = null, hunk = null, oldNo = 0, newNo = 0;
  const strip = p => p.replace(/^"?(a|b)\//, '').replace(/"$/, '');
  // 去掉結尾的換行，否則 split 會多出一行空的「未變更」內容。
  for (const raw of String(text || '').replace(/\r?\n$/, '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git (?:"?a\/(.+?)"?) (?:"?b\/(.+?)"?)$/);
      file = { path: m ? m[2] : line.slice(11), oldPath: m ? m[1] : '', status: 'modified', binary: false, adds: 0, dels: 0, hunks: [] };
      files.push(file); hunk = null; continue;
    }
    if (!file) continue; // --stat 摘要或其他前言
    if (!hunk) {
      if (line.startsWith('new file mode')) { file.status = 'added'; continue; }
      if (line.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
      if (line.startsWith('rename from ')) { file.status = 'renamed'; file.oldPath = line.slice(12); continue; }
      if (line.startsWith('rename to ')) { file.path = line.slice(10); continue; }
      if (line.startsWith('Binary files ') || line === 'GIT binary patch') { file.binary = true; continue; }
      if (line.startsWith('--- ')) { if (line !== '--- /dev/null') file.oldPath = strip(line.slice(4)); continue; }
      if (line.startsWith('+++ ')) { if (line !== '+++ /dev/null') file.path = strip(line.slice(4)); continue; }
    }
    const h = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { oldNo = Number(h[1]); newNo = Number(h[2]); hunk = { header: line, section: h[3].trim(), lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) continue;
    if (line.startsWith('+')) { hunk.lines.push({ type: 'add', text: line.slice(1), new: newNo++ }); file.adds++; }
    else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', text: line.slice(1), old: oldNo++ }); file.dels++; }
    else if (line.startsWith('\\')) { hunk.lines.push({ type: 'note', text: line.slice(2) }); }
    else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'ctx', text: line.slice(1), old: oldNo++, new: newNo++ }); }
  }
  return files;
}

/** 並排：連續的刪除與新增一對一配成同一列，多出來的那邊留空，和 GitHub 一樣。 */
function splitRows(lines) {
  const rows = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (line.type === 'ctx') { rows.push({ left: line, right: line }); i++; continue; }
    if (line.type === 'note') { rows.push({ note: line.text }); i++; continue; }
    const dels = [], adds = [];
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++]);
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++]);
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) rows.push({ left: dels[k] || null, right: adds[k] || null });
  }
  return rows;
}

const DIFF_STATUS = { added: '新增', deleted: '刪除', renamed: '改名', modified: '修改' };
let diffMode = (() => { try { return localStorage.getItem('ai-workflow.diff-mode') === 'unified' ? 'unified' : 'split'; } catch { return 'split'; } })();

function diffCell(tag, className, text) {
  const cell = document.createElement(tag); cell.className = className;
  if (text !== undefined && text !== null) cell.textContent = String(text);
  return cell;
}

function renderDiffFile(file, mode) {
  const box = document.createElement('details'); box.className = 'diff-file'; box.id = `diff-file-${file.index}`;
  // 很長的檔案（例如自動產生的 lock 檔）預設收合，避免一次畫太多列。
  box.open = file.adds + file.dels <= 800;
  const head = document.createElement('summary'); head.className = 'diff-file-head';
  const name = diffCell('span', 'diff-file-name', file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path);
  const stat = document.createElement('span'); stat.className = 'diff-stat';
  stat.append(diffCell('span', 'diff-adds', `+${file.adds}`), diffCell('span', 'diff-dels', `−${file.dels}`));
  head.append(diffCell('span', `diff-status diff-${file.status}`, DIFF_STATUS[file.status]), name, stat);
  box.append(head);
  if (file.binary) { box.append(diffCell('p', 'diff-empty', '二進位檔案，無法顯示文字差異')); return box; }
  if (!file.hunks.length) { box.append(diffCell('p', 'diff-empty', file.status === 'renamed' ? '只有改名，內容沒有變更' : '沒有文字變更（空檔案或只改了權限）')); return box; }
  const table = document.createElement('table'); table.className = `diff-table diff-${mode}`;
  const colgroup = document.createElement('colgroup');
  for (const width of mode === 'split' ? ['ln', 'code', 'ln', 'code'] : ['ln', 'ln', 'code']) { const col = document.createElement('col'); col.className = `col-${width}`; colgroup.append(col); }
  table.append(colgroup);
  const body = document.createElement('tbody');
  for (const hunk of file.hunks) {
    const hr = document.createElement('tr'); hr.className = 'diff-hunk';
    const cell = diffCell('td', 'diff-hunk-text', hunk.header); cell.colSpan = mode === 'split' ? 4 : 3; hr.append(cell); body.append(hr);
    if (mode === 'split') {
      for (const row of splitRows(hunk.lines)) {
        const tr = document.createElement('tr');
        if (row.note) { const c = diffCell('td', 'diff-note', row.note); c.colSpan = 4; tr.append(c); body.append(tr); continue; }
        const side = (line, which) => {
          if (!line) return [diffCell('td', 'ln empty'), diffCell('td', 'code empty')];
          const kind = line.type === 'ctx' ? 'ctx' : line.type;
          return [diffCell('td', `ln ${kind}`, which === 'left' ? line.old : line.new), diffCell('td', `code ${kind}`, line.text)];
        };
        tr.append(...side(row.left, 'left'), ...side(row.right, 'right'));
        body.append(tr);
      }
    } else {
      for (const line of hunk.lines) {
        const tr = document.createElement('tr');
        if (line.type === 'note') { const c = diffCell('td', 'diff-note', line.text); c.colSpan = 3; tr.append(c); body.append(tr); continue; }
        tr.append(diffCell('td', `ln ${line.type}`, line.old), diffCell('td', `ln ${line.type}`, line.new), diffCell('td', `code ${line.type} ${line.type === 'add' ? 'mark-add' : line.type === 'del' ? 'mark-del' : ''}`, line.text));
        body.append(tr);
      }
    }
  }
  table.append(body);
  const scroller = document.createElement('div'); scroller.className = 'diff-scroll'; scroller.append(table);
  box.append(scroller);
  return box;
}

/** 回傳整個 diff 檢視元件；沒有可解析的檔案時退回原文。 */
function diffView(text) {
  const files = parseUnifiedDiff(text);
  const root = document.createElement('div'); root.className = 'diff-view';
  if (!files.length) { const pre = document.createElement('pre'); pre.className = 'plain'; pre.textContent = text || '（尚無 diff）'; root.append(pre); return root; }
  files.forEach((file, index) => { file.index = index; });
  const adds = files.reduce((n, f) => n + f.adds, 0), dels = files.reduce((n, f) => n + f.dels, 0);

  const bar = document.createElement('div'); bar.className = 'diff-toolbar';
  const summary = document.createElement('span'); summary.className = 'diff-summary';
  summary.append(document.createTextNode(`${files.length} 個檔案 `), diffCell('span', 'diff-adds', `+${adds}`), document.createTextNode(' '), diffCell('span', 'diff-dels', `−${dels}`));
  const seg = document.createElement('div'); seg.className = 'seg'; seg.setAttribute('role', 'radiogroup'); seg.setAttribute('aria-label', 'diff 顯示方式');
  const toggleAll = document.createElement('button'); toggleAll.type = 'button'; toggleAll.className = 'diff-toggle-all';
  bar.append(summary, seg, toggleAll);

  const layout = document.createElement('div'); layout.className = 'diff-layout';
  const nav = document.createElement('nav'); nav.className = 'diff-nav'; nav.setAttribute('aria-label', '變更的檔案');
  const list = document.createElement('ul');
  for (const file of files) {
    const li = document.createElement('li'); const button = document.createElement('button'); button.type = 'button';
    button.title = file.path;
    const name = file.path.split('/'); const base = name.pop();
    button.append(diffCell('span', `diff-dot diff-${file.status}`), diffCell('span', 'diff-nav-name', base), diffCell('span', 'diff-nav-dir', name.join('/')));
    const stat = document.createElement('span'); stat.className = 'diff-stat'; stat.append(diffCell('span', 'diff-adds', `+${file.adds}`), diffCell('span', 'diff-dels', `−${file.dels}`));
    button.append(stat);
    button.onclick = () => { const target = root.querySelector(`#diff-file-${file.index}`); if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); } };
    li.append(button); list.append(li);
  }
  nav.append(list);
  const filesBox = document.createElement('div'); filesBox.className = 'diff-files';
  layout.append(nav, filesBox); root.append(bar, layout);

  const paint = () => {
    filesBox.replaceChildren(...files.map(file => renderDiffFile(file, diffMode)));
    seg.replaceChildren(...[['split', '並排'], ['unified', '單欄']].map(([value, label]) => {
      const b = document.createElement('button'); b.type = 'button'; b.setAttribute('role', 'radio'); b.textContent = label;
      b.dataset.diffMode = value; b.classList.toggle('on', diffMode === value); b.setAttribute('aria-checked', String(diffMode === value));
      b.onclick = () => { diffMode = value; try { localStorage.setItem('ai-workflow.diff-mode', value); } catch { /* 無法保存偏好時只影響這次 */ } paint(); };
      return b;
    }));
    const allOpen = [...filesBox.querySelectorAll('.diff-file')].every(d => d.open);
    toggleAll.textContent = allOpen ? '全部收合' : '全部展開';
  };
  toggleAll.onclick = () => {
    const open = toggleAll.textContent === '全部展開';
    for (const d of filesBox.querySelectorAll('.diff-file')) d.open = open;
    toggleAll.textContent = open ? '全部收合' : '全部展開';
  };
  paint();
  return root;
}

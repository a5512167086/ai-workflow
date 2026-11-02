'use strict';

// 所有專案總覽與全域設定。共用工具在 common.js，設定頁的邏輯在 settings.js。

const PROJECT_STATUS = {
  missing: ['找不到專案', 'error'],
  idle: ['閒置', 'idle'],
  drafting: ['PRD 起草中', 'running'],
  awaiting_approval: ['等待核准 PRD', 'waiting'],
  generating: ['產生任務中', 'running'],
  awaiting_tasks: ['等待核准任務', 'waiting'],
  awaiting_permission: ['等待你允許操作', 'waiting'],
  ready: ['可以開始', 'idle'],
  queued: ['排隊中', 'queued'],
  running: ['執行中', 'running'],
  paused: ['已暫停', 'paused'],
  waiting: ['等待人工測試', 'waiting'],
  feature_test: ['功能待測試', 'feature_test'],
  stuck: ['需要人工處理', 'stuck'],
  error: ['錯誤', 'error'],
  complete: ['已完成', 'complete'],
};

let data = null;

function render() {
  const { projects, queue } = data;
  const grid = $('#projects');
  grid.innerHTML = '';
  $('#count').textContent = projects.length || '';
  if (!projects.length) {
    grid.innerHTML = '<div class="card empty-state"><p>還沒有專案。在上面輸入專案資料夾加入，或在專案目錄執行 <code>ai-workflow projects add</code>。</p></div>';
  }
  for (const p of projects) {
    const [label, cls] = PROJECT_STATUS[p.status] || [p.status, 'idle'];
    const card = document.createElement('article');
    card.className = `card project-card${p.attention ? ' attention' : ''}`;
    card.setAttribute('aria-labelledby', `pc-${p.id}`);
    const pct = p.progress?.total ? Math.round((p.progress.done / p.progress.total) * 100) : 0;
    card.innerHTML = `
      <div class="pc-head">
        <h3 class="pc-name"><a id="pc-${p.id}" href="${projectHref(p.id)}"></a></h3>
        <span class="pill ${cls}"><span class="dot" aria-hidden="true"></span><span class="pill-text"></span></span>
      </div>
      <p class="pc-path mono"></p>
      <p class="pc-feature"></p>
      <div class="pc-progress">
        <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span style="width:${pct}%"></span></div>
        <span class="pc-count mono"></span>
      </div>
      <p class="pc-reason"></p>
      <div class="pc-actions">
        <button type="button" class="icon-btn" data-act="remove">${icon('trash')}</button>
        <a class="btn primary" href="${projectHref(p.id)}">${icon('forward')}開啟</a>
      </div>`;
    card.querySelector('.pc-name a').textContent = p.name;
    card.querySelector('.pill-text').textContent = label;
    card.querySelector('.pc-path').textContent = p.path;
    card.querySelector('.pc-path').title = p.path;
    const feature = (p.feature || '').split('\n')[0];
    card.querySelector('.pc-feature').textContent = feature ? `功能：${feature}` : '尚未開始功能';
    card.querySelector('.pc-feature').classList.toggle('muted', !feature);
    card.querySelector('.pc-count').textContent = p.progress?.total ? `${p.progress.done}/${p.progress.total}` : '—';
    card.querySelector('.bar').setAttribute('aria-label', p.progress?.total ? `任務進度 ${p.progress.done}/${p.progress.total}` : '還沒有任務');
    const reason = card.querySelector('.pc-reason');
    if (p.reason) {
      reason.innerHTML = p.attention ? `${icon('alert')}<span></span>` : '<span></span>';
      reason.querySelector('span').textContent = p.reason;
    } else reason.remove();
    const rm = card.querySelector('[data-act="remove"]');
    rm.setAttribute('aria-label', `從總覽移除 ${p.name}`);
    rm.title = '從總覽移除（不刪除任何檔案）';
    rm.onclick = async () => {
      if (!confirm(`從總覽移除「${p.name}」？\n只會移出清單，不會刪除任何檔案。`)) return;
      if (await act('/api/projects/remove', { id: p.id }, '已從總覽移除')) refresh();
    };
    grid.append(card);
  }

  const attention = projects.filter((p) => p.attention).length;
  const pill = $('#attention');
  pill.className = `pill ${attention ? 'waiting' : 'idle'}`;
  pill.querySelector('.pill-text').textContent = attention ? `${attention} 個專案等你處理` : '沒有待處理的專案';
  const names = (list) => list.map((e) => projects.find((p) => p.path.toLowerCase() === e.root.toLowerCase())?.name || e.root.split(/[\\/]/).pop());
  const running = names(queue.running);
  const waiting = names(queue.waiting);
  $('#queue-line').textContent = `執行中 ${running.length}/${queue.max}${running.length ? `：${running.join('、')}` : ''}${waiting.length ? `・排隊：${waiting.join('、')}` : ''}`;
  $('#btn-pick').classList.toggle('hidden', !desktop);
  if (!$('#overview-settings').hidden && typeof renderQueue === 'function') renderQueue(queue);
}

/** 設定是全域的，不用選專案；從專案頁連回來時帶 #settings。 */
function showSettings() {
  $('#overview-settings').hidden = false;
  $('#projects-panel').hidden = true;
  $('.overview-tools').hidden = true;
  history.replaceState(null, '', '#settings');
  if (typeof loadSettings === 'function') loadSettings();
}

function showProjects() {
  $('#overview-settings').hidden = true;
  $('#projects-panel').hidden = false;
  $('.overview-tools').hidden = false;
  history.replaceState(null, '', location.pathname);
}

async function refresh() {
  try {
    data = await api('/api/projects');
    render();
  } catch (err) {
    toast(err.message, true);
  }
}

async function addProject(init = false) {
  const path = $('#add-path').value.trim();
  if (!path) {
    toast('請輸入或選擇專案資料夾', true);
    $('#add-path').focus();
    return;
  }
  const res = await act('/api/projects/add', { path, init });
  if (!res) return;
  if (res.needs_init) {
    if (confirm(`${res.path}\n還不是 git repo。ai-workflow 用 git 追蹤、審查與還原 AI 的變更，要在這個資料夾執行 git init 並加入嗎？\n（除了 .git 以外，不會在專案裡新增任何檔案；流程資料放在 ~/.ai-workflow/projects/）`)) await addProject(true);
    return;
  }
  toast(`已加入 ${res.project.name}`);
  $('#add-path').value = '';
  refresh();
}

function connect() {
  subscribe({
    projects: (payload) => {
      data = payload;
      render();
    },
  }).catch((err) => toast(err.message ?? String(err), true));
}

function bind() {
  bindTheme();
  if (typeof bindSettings === 'function') bindSettings();
  $('#show-settings').onclick = () => showSettings();
  $('#show-projects').onclick = () => showProjects();
  $('#btn-add').onclick = () => addProject();
  $('#add-path').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) addProject();
  });
  $('#btn-pick').onclick = async () => {
    try {
      const dir = await desktop.invoke('pick_folder');
      if (dir) {
        $('#add-path').value = dir;
        addProject();
      }
    } catch (err) {
      toast(String(err), true);
    }
  };
}

bind();
if (location.hash.startsWith('#settings')) showSettings();
refresh();
connect();

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

// 全域資料（專案清單、佇列）放到暫存目錄，不碰使用者的 ~/.aipipe。
process.env.AIPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-home-'));

const { addProject, listProjects, removeProject, projectId, projectSummary } = await import('../src/projects.js');
const queue = await import('../src/queue.js');
const backlog = await import('../src/backlog.js');
const { archivePrd, archiveTasks, listArchives, readArchive, featureSlug, tagSlug } = await import('../src/archive.js');
const { writeTasks, readTasks, tagName } = await import('../src/taskmaster.js');
const { approvePrd } = await import('../src/prd.js');
const { updateState, aipipeDir, ensureDirs } = await import('../src/state.js');
const { defaultConfig, validateConfig } = await import('../src/config.js');
const { createServer } = await import('../src/server.js');

function makeProject(name = 'proj') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aipipe-${name}-`));
  fs.writeFileSync(path.join(dir, '.aipipe.json'), JSON.stringify({ mode: 'manual' }));
  ensureDirs(dir);
  return dir;
}

/** 一個會一直活著的子程序，當作「另一個 aipipe run」的 pid。 */
function sleeper() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
  return child;
}

test('專案清單：加入、重複加入不重複、移除；沒有 .aipipe.json 不能加入', () => {
  const a = makeProject('a');
  const b = makeProject('b');
  addProject(a);
  addProject(b, { name: '第二個' });
  addProject(a);
  const list = listProjects();
  assert.equal(list.length, 2);
  assert.equal(list.find((p) => p.path === path.resolve(b)).name, '第二個');
  assert.equal(list.find((p) => p.path === path.resolve(a)).id, projectId(a));
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-empty-'));
  assert.throws(() => addProject(empty), /aipipe init/);
  removeProject(projectId(b));
  assert.equal(listProjects().length, 1);
  removeProject(a);
  assert.equal(listProjects().length, 0);
});

test('專案摘要：PRD 等待核准時標成需要處理，任務進度正確', () => {
  const dir = makeProject('sum');
  const p = addProject(dir);
  updateState(dir, (s) => {
    s.prd.status = 'awaiting_approval';
  });
  let sum = projectSummary(p);
  assert.equal(sum.status, 'awaiting_approval');
  assert.equal(sum.attention, true);
  updateState(dir, (s) => {
    s.prd.status = 'approved';
  });
  writeTasks(dir, [{ title: 'A', description: 'a' }, { title: 'B', description: 'b' }]);
  sum = projectSummary(p);
  assert.equal(sum.status, 'ready');
  assert.deepEqual(sum.progress, { done: 0, total: 2 });
  removeProject(p.id);
});

test('佇列：上限 1 時第二個要排隊，前面的釋放後依序接上；max 可以設定', () => {
  const other = sleeper();
  try {
    queue.setMaxConcurrent(1);
    assert.equal(queue.tryAcquire('/x/one', other.pid).granted, true);
    const me = queue.tryAcquire('/x/two');
    assert.equal(me.granted, false);
    assert.equal(me.position, 1);
    assert.equal(queue.queueEntryFor('/x/two').state, 'waiting');
    queue.release(other.pid);
    assert.equal(queue.tryAcquire('/x/two').granted, true);
    assert.equal(queue.queueEntryFor('/x/two').state, 'running');
    queue.release();
    queue.setMaxConcurrent(2);
    assert.equal(queue.tryAcquire('/x/one', other.pid).granted, true);
    assert.equal(queue.tryAcquire('/x/two').granted, true);
    queue.release();
    queue.release(other.pid);
    assert.throws(() => queue.setMaxConcurrent(0), /1–8/);
  } finally {
    other.kill();
    queue.setMaxConcurrent(1);
  }
});

test('佇列：結束的程序自動清掉，不會卡住名額', async () => {
  const dead = sleeper();
  queue.setMaxConcurrent(1);
  assert.equal(queue.tryAcquire('/x/dead', dead.pid).granted, true);
  dead.kill();
  await new Promise((r) => dead.on('exit', r));
  assert.equal(queue.tryAcquire('/x/alive').granted, true);
  queue.release();
});

test('佇列：acquireSlot 排隊時可以放棄（暫停）', async () => {
  const other = sleeper();
  try {
    queue.tryAcquire('/x/busy', other.pid);
    const positions = [];
    let aborted = false;
    const ok = await queue.acquireSlot('/x/me', {
      onWait: (pos) => positions.push(pos),
      shouldAbort: () => (aborted = true),
      intervalMs: 10,
    });
    assert.equal(ok, false);
    assert.ok(aborted);
    assert.deepEqual(positions, [1]);
    assert.equal(queue.queueEntryFor('/x/me'), null);
  } finally {
    queue.release(other.pid);
    other.kill();
  }
});

test('需求待辦：新增、編輯、排序、刪除，存在 docs/aipipe/backlog.json', () => {
  const dir = makeProject('bl');
  const a = backlog.addItem(dir, { title: ' 匯出 CSV ', detail: '可選欄位' });
  const b = backlog.addItem(dir, { title: '深色模式' });
  assert.equal(a.title, '匯出 CSV');
  assert.throws(() => backlog.addItem(dir, { title: '  ' }), /標題/);
  backlog.reorderItems(dir, [b.id, a.id]);
  assert.deepEqual(backlog.readBacklog(dir).map((i) => i.title), ['深色模式', '匯出 CSV']);
  backlog.updateItem(dir, a.id, { title: '匯出 CSV 與 Excel', status: 'in_progress' });
  assert.equal(backlog.getItem(dir, a.id).status, 'in_progress');
  assert.throws(() => backlog.updateItem(dir, a.id, { status: 'x' }), /狀態/);
  assert.equal(backlog.ideaFor(backlog.getItem(dir, a.id)), '匯出 CSV 與 Excel\n\n可選欄位');
  backlog.deleteItem(dir, b.id);
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'docs', 'aipipe', 'backlog.json'), 'utf8'));
  assert.equal(file.items.length, 1);
});

test('Task Master tag：writeTasks 只寫目前 tag，readTasks 讀目前 tag；tag 名稱只用 ASCII', () => {
  const dir = makeProject('tag');
  writeTasks(dir, [{ title: 'old' }]);
  fs.writeFileSync(path.join(dir, '.taskmaster', 'state.json'), JSON.stringify({ currentTag: 'f-20261101-csv' }));
  writeTasks(dir, [{ title: 'new 1' }, { title: 'new 2', dependencies: [1] }]);
  const data = JSON.parse(fs.readFileSync(path.join(dir, '.taskmaster', 'tasks', 'tasks.json'), 'utf8'));
  assert.deepEqual(Object.keys(data), ['master', 'f-20261101-csv']);
  assert.equal(data.master.tasks[0].title, 'old');
  assert.deepEqual(readTasks(dir).map((t) => t.title), ['new 1', 'new 2']);
  assert.equal(tagName('2026-11-01', 'csv', ['f-20261101-csv']), 'f-20261101-csv-2');
  assert.equal(tagSlug('匯出 CSV 功能'), 'csv');
  assert.equal(tagSlug('中文想法'), 'feature');
  assert.equal(featureSlug('匯出 CSV 功能！'), '匯出-csv-功能');
});

test('封存：核准 PRD 建立 docs/prd/<日期>-<功能>/，下一個功能不覆蓋上一個', () => {
  const dir = makeProject('arc');
  const cfg = { ...defaultConfig(), mode: 'manual' };
  const draft = (idea, text) => {
    fs.writeFileSync(aipipeDir(dir, 'prd', 'current.md'), text);
    fs.writeFileSync(aipipeDir(dir, 'prd', 'v1.md'), text);
    fs.writeFileSync(aipipeDir(dir, 'prd', 'review-1.md'), 'VERDICT: APPROVE');
    updateState(dir, (s) => {
      s.prd = { ...s.prd, status: 'awaiting_approval', idea, archive_dir: null, rounds: [
        { kind: 'draft', round: 0, provider: 'claude', version: 1, file: 'v1.md' },
        { kind: 'review', round: 1, provider: 'codex', verdict: 'APPROVE', version: 1, file: 'review-1.md' },
      ] };
    });
  };
  draft('匯出 CSV', '# PRD A');
  approvePrd(dir, cfg);
  writeTasks(dir, [{ title: 'A1' }]);
  archiveTasks(dir);
  // 同一個功能重新核准：同一個資料夾
  approvePrd(dir, cfg);
  draft('匯出 CSV', '# PRD B');
  approvePrd(dir, cfg);
  const list = listArchives(dir, cfg);
  assert.equal(list.length, 2);
  const date = new Date().toISOString().slice(0, 10);
  assert.deepEqual(list.map((a) => a.name).sort(), [`${date}-匯出-csv`, `${date}-匯出-csv-2`]);
  const first = readArchive(dir, `${date}-匯出-csv`, cfg);
  assert.equal(first.prd, '# PRD A');
  assert.deepEqual(first.rounds.map((r) => r.name), ['01-draft-r0-v1.md', '02-review-r1-approve-v1.md']);
  assert.equal(first.tasks[0].title, 'A1');
  assert.equal(readArchive(dir, `${date}-匯出-csv-2`, cfg).prd, '# PRD B');
  assert.throws(() => readArchive(dir, '../x', cfg), /不正確/);
  assert.equal(archivePrd.length >= 1, true);
});

test('設定：backlog_path／archive_dir 必須是專案內相對路徑', () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
  assert.ok(validateConfig({ ...defaultConfig(), archive_dir: '../out' }).length);
  assert.ok(validateConfig({ ...defaultConfig(), backlog_path: 'C:\\abs\\b.json' }).length || process.platform !== 'win32');
});

test('伺服器：舊 API、/api/p/<id>/、總覽與 POST 防護', async () => {
  const dir = makeProject('srv');
  const p = addProject(dir);
  const server = createServer(dir, { overview: true });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const legacy = await (await fetch(`${base}/api/state`)).json();
    assert.equal(legacy.root, dir);
    const scoped = await (await fetch(`${base}/api/p/${p.id}/state`)).json();
    assert.equal(scoped.project.id, p.id);
    const all = await (await fetch(`${base}/api/projects`)).json();
    assert.ok(all.projects.some((x) => x.id === p.id));
    assert.equal(all.queue.max, 1);
    assert.match(await (await fetch(`${base}/`)).text(), /所有專案/);
    assert.match(await (await fetch(`${base}/p/${p.id}/`)).text(), /任務看板/);
    assert.equal((await fetch(`${base}/api/p/0000000000/state`)).status, 404);
    const noHeader = await fetch(`${base}/api/p/${p.id}/backlog/add`, { method: 'POST', body: '{"title":"x"}' });
    assert.equal(noHeader.status, 403);
    const add = await fetch(`${base}/api/p/${p.id}/backlog/add`, {
      method: 'POST', headers: { 'X-Aipipe': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: '從 API 新增' }),
    });
    assert.equal(add.status, 200);
    const bl = await (await fetch(`${base}/api/p/${p.id}/backlog`)).json();
    assert.equal(bl.items[0].title, '從 API 新增');
    const needsInit = await (await fetch(`${base}/api/projects/add`, {
      method: 'POST', headers: { 'X-Aipipe': '1' }, body: JSON.stringify({ path: fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-new-')) }),
    })).json();
    assert.equal(needsInit.needs_init, true);
  } finally {
    server.close();
    removeProject(p.id);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
process.env.AIPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-engine-home-'));
const { writeTasks, readTasks, validateTasks, nextTaskId, setStatus, currentTag, tasksFile } = await import('../src/tasks.js');
const roots = [];
function project() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-engine-')); roots.push(root); return root; }
test.after(() => { for (const root of [...roots, process.env.AIPIPE_HOME]) fs.rmSync(root, { recursive: true, force: true }); });
const status = (root, id, value) => setStatus(root, {}, id, value);
async function complete(root, id) { for (const value of ['in-progress', 'review', 'done']) await status(root, id, value); }

test('依賴不存在、循環、自我依賴與重複 ID 都會被拒絕，保留舊任務', () => {
  const root = project(); writeTasks(root, [{ title: 'original' }]);
  const before = fs.readFileSync(tasksFile(root), 'utf8');
  const cases = [
    [{ title: 'bad', dependencies: [99] }],
    [{ id: 1, title: 'a', dependencies: [2] }, { id: 2, title: 'b', dependencies: [1] }],
    [{ title: 'bad', dependencies: [1] }],
    [{ id: 1, title: 'a' }, { id: 1, title: 'b' }],
  ];
  for (const tasks of cases) assert.throws(() => writeTasks(root, tasks));
  assert.equal(fs.readFileSync(tasksFile(root), 'utf8'), before);
});

test('保留非連續 ID 與向後依賴，選擇高優先序且依賴已完成的任務', async () => {
  const root = project();
  writeTasks(root, [{ id: 10, title: 'later', dependencies: [20], priority: 'high' }, { id: 20, title: 'first', priority: 'low' }, { id: 30, title: 'other', priority: 'medium' }]);
  assert.equal(await nextTaskId(root), '30');
  await status(root, 30, 'blocked'); assert.equal(await nextTaskId(root), '20');
  await assert.rejects(status(root, 10, 'in-progress'), /依賴尚未完成/);
  await complete(root, 20); assert.equal(await nextTaskId(root), '10');
  await assert.rejects(status(root, 10, 'done'), /review/);
  await complete(root, 10);
  await assert.rejects(status(root, 20, 'pending'), /先重設/);
  assert.equal(readTasks(root).find(task => task.id === 20).status, 'done');
});

test('子任務依賴、父任務依賴與父任務完成狀態一致', async () => {
  const root = project();
  writeTasks(root, [{ id: 1, title: 'setup' }, { id: 2, title: 'feature', dependencies: [1], subtasks: [
    { id: 1, title: 'UI' }, { id: 2, title: 'checks', dependencies: [1] },
  ] }, { id: 3, title: 'integration', dependencies: [2] }]);
  assert.equal(await nextTaskId(root), '1'); await complete(root, 1);
  assert.equal(await nextTaskId(root), '2.1'); await complete(root, '2.1');
  assert.equal(await nextTaskId(root), '2.2'); await complete(root, '2.2');
  assert.equal(readTasks(root)[1].status, 'done'); assert.equal(await nextTaskId(root), '3');
  assert.throws(() => validateTasks([{ title: 'p', subtasks: [{ title: 's', dependencies: ['1'] }] }]), /循環/);
});

test('首次更新匯入舊 Task Master 多群組資料，不改動來源', async () => {
  const root = project(), dir = path.join(root, '.taskmaster');
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true });
  const legacy = JSON.stringify({ master: { tasks: [{ id: 1, title: 'old', status: 'done' }] }, feature: { tasks: [{ id: 4, title: 'current', status: 'pending', dependencies: [], subtasks: [] }] } });
  fs.writeFileSync(path.join(dir, 'tasks', 'tasks.json'), legacy);
  fs.writeFileSync(path.join(dir, 'state.json'), '{"currentTag":"feature"}');
  assert.equal(currentTag(root), 'feature'); assert.equal(readTasks(root)[0].id, 4);
  await status(root, 4, 'in-progress');
  const store = JSON.parse(fs.readFileSync(tasksFile(root), 'utf8'));
  assert.equal(store.groups.master.tasks[0].status, 'done'); assert.equal(store.groups.feature.tasks[0].status, 'in-progress');
  assert.equal(fs.readFileSync(path.join(dir, 'tasks', 'tasks.json'), 'utf8'), legacy);
});

test('跨程序同時更新不同任務不會遺失更新', async () => {
  const root = project(); writeTasks(root, [{ title: 'one' }, { title: 'two' }]);
  const moduleUrl = new URL('../src/tasks.js', import.meta.url).href;
  await Promise.all([1, 2].map(id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { setStatus } from ${JSON.stringify(moduleUrl)}; await setStatus(${JSON.stringify(root)}, {}, ${id}, 'in-progress');`], { windowsHide: true });
    let error = ''; child.stderr.on('data', data => { error += data; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(error)));
  })));
  assert.deepEqual(readTasks(root).map(task => task.status), ['in-progress', 'in-progress']);
});

test('損壞的內建任務檔會報錯，不會退回舊檔覆蓋', () => {
  const root = project(); writeTasks(root, [{ title: 'a' }]); fs.writeFileSync(tasksFile(root), '{broken');
  assert.throws(() => readTasks(root)); assert.throws(() => writeTasks(root, [{ title: 'b' }]));
  assert.equal(fs.readFileSync(tasksFile(root), 'utf8'), '{broken');
});

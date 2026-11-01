import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { listSkills, loadSkill, saveSkill, importSkill, prepareSkills, parseSkill, listSkillRuns } from '../src/skills.js';
import { defaultConfig, saveConfig } from '../src/config.js';
import { generateTasks, runSkill } from '../src/cli.js';
import { runAgent } from '../src/agents.js';
import { writeTasks, readTasks, nextTaskId, tasksFile } from '../src/tasks.js';
import { updateState, readState } from '../src/state.js';
import { runPipeline, acknowledge } from '../src/runner.js';
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-skills-home-'));
process.env.AIPIPE_HOME = testHome;
const roots = [testHome];
function project() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-skills-')); roots.push(root); return root; }
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });
const manifest = (name, body = 'Read references/design.md when needed.') => `---\nname: ${name}\ndescription: |\n  A shared skill\n  with multiline YAML.\n---\n${body}\n`;

function fakeConfig(root, provider = 'codex') {
  const fake = path.join(root, 'fake.cjs');
  fs.writeFileSync(fake, `const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.0');
else if (args[0] === 'login') console.error('Logged in using ChatGPT');
else if (args[0] === 'auth') console.log(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }));
else { let prompt = ''; process.stdin.on('data', chunk => prompt += chunk); process.stdin.on('end', () => {
fs.appendFileSync('.aipipe/calls.jsonl', JSON.stringify({ pid: process.pid, args, prompt }) + '\\n');
let text = prompt.includes('拆成可以逐一') ? JSON.stringify({ tasks: [{ title: 'first', skills: ['uiux-design'] }, { title: 'second', dependencies: [1] }] })
: prompt.includes('程式碼審查者') ? 'VERDICT: PASS' : '請問目標使用者是誰？';
if (args[0] === 'exec') fs.writeFileSync(args[args.indexOf('-o') + 1], text);
else console.log(JSON.stringify({ type: 'result', result: text, is_error: false }));
}); }
`);
  const cfg = defaultConfig(); cfg.runtime = { claude: 'windows', codex: 'windows' };
  cfg.cli[provider] = fake; cfg.cli[provider === 'codex' ? 'claude' : 'codex'] = path.join(root, 'missing.exe');
  cfg.roles = { author: provider, reviewer: provider, implementer: provider, code_reviewer: provider };
  cfg.skills.implement = ['uiux-design']; cfg.skills.code_review = ['uiux-design'];
  saveConfig(root, cfg); return cfg;
}

test('預設技能可被標準 YAML 解析；匯入完整資源並保存不可變版本快照', () => {
  const root = project(), source = project();
  assert.deepEqual(listSkills(root).map(skill => skill.name), ['grill-me', 'uiux-design']);
  fs.writeFileSync(path.join(source, 'SKILL.md'), manifest('custom-design'));
  fs.mkdirSync(path.join(source, 'references')); fs.writeFileSync(path.join(source, 'references', 'design.md'), 'original');
  importSkill(root, source);
  const cfg = { skills: { implement: ['custom-design'] } };
  const first = prepareSkills(root, cfg, 'implement');
  fs.writeFileSync(path.join(root, '.aipipe', 'skills', 'custom-design', 'references', 'design.md'), 'changed');
  const second = prepareSkills(root, cfg, 'implement');
  assert.notEqual(first.snapshots[0].version, second.snapshots[0].version);
  assert.equal(fs.readFileSync(path.join(first.snapshots[0].path, 'references', 'design.md'), 'utf8'), 'original');
  assert.throws(() => importSkill(root, source), /同名/);
  assert.throws(() => loadSkill(root, '../escape'), /名稱/);
});

test('不會默默執行 Claude 專屬 frontmatter；壞 YAML 與缺少說明會拒絕', () => {
  const root = project();
  const text = '---\nname: special\ndescription: test\nhooks: {}\n---\nRun things.';
  saveSkill(root, text);
  assert.equal(listSkills(root).find(skill => skill.name === 'special').compatible, false);
  assert.throws(() => prepareSkills(root, {}, undefined, ['special']), /專屬欄位/);
  assert.throws(() => parseSkill('---\nname: test\n---\nbody'));
  assert.throws(() => parseSkill('---\nname: [\n---\nbody'));
});

test('Codex 與 Claude 接到相同 Skill 指令；未綁定階段不帶入技能', async () => {
  const prompts = [];
  for (const provider of ['codex', 'claude']) {
    const root = project(), cfg = fakeConfig(root, provider);
    const result = await runAgent({ root, cfg, provider, prompt: 'Design a UI', write: false, scope: 'test', label: 'test', stage: 'implement' });
    assert.equal(result.ok, true); assert.equal(result.skills[0].name, 'uiux-design');
    const record = JSON.parse(fs.readFileSync(path.join(root, '.aipipe', 'sessions', result.sessionId + '.json'), 'utf8'));
    assert.equal(record.status, 'done'); assert.equal(record.provider, provider);
    prompts.push(JSON.parse(fs.readFileSync(path.join(root, '.aipipe', 'calls.jsonl'), 'utf8').trim()).prompt);
    assert.equal(prepareSkills(root, cfg, 'prd').text, '');
  }
  const body = loadSkill(project(), 'uiux-design').body;
  assert.ok(prompts.every(prompt => prompt.includes(body)));
});

test('Grill Me 接續回答以新 session 執行，交接包含前輪問題及使用者回答', async () => {
  const root = project(), cfg = fakeConfig(root);
  const first = await runSkill(root, 'grill-me', '我要做報表工具', { provider: 'codex' });
  const second = await runSkill(root, 'grill-me', '使用者是財務人員', { provider: 'codex', previousId: first.id });
  assert.notEqual(first.sessionId, second.sessionId);
  const calls = fs.readFileSync(path.join(root, '.aipipe', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.notEqual(calls[0].pid, calls[1].pid);
  assert.match(calls[1].prompt, /我要做報表工具/); assert.match(calls[1].prompt, /目標使用者/); assert.match(calls[1].prompt, /使用者是財務人員/);
  assert.ok(calls.every(call => !call.args.includes('resume')));
  assert.equal(listSkillRuns(root).length, 2);
});

test('不安裝 Task Master 即可拆任務、手動實作審查、人工確認並解鎖下一項', async () => {
  const root = project(), cfg = fakeConfig(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main'); git('config', 'user.name', 'test'); git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(root, '.gitignore'), '.aipipe/\n'); fs.writeFileSync(path.join(root, 'file.txt'), 'base'); git('add', '.'); git('commit', '-qm', 'initial');
  const file = path.join(root, cfg.prd_path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, '# PRD\nR1: reports');
  updateState(root, state => { state.prd = { ...state.prd, status: 'approved', version: 1, idea: 'reports' }; });
  await generateTasks(root);
  assert.equal(readTasks(root).length, 2); assert.equal(fs.existsSync(path.join(root, '.taskmaster')), false);
  assert.equal(await nextTaskId(root), '1');
  assert.equal(await runPipeline(root), 'waiting', readState(root).pipeline.reason);
  assert.equal(readTasks(root)[0].status, 'review');
  await acknowledge(root); assert.equal(readTasks(root)[0].status, 'done'); assert.equal(await nextTaskId(root), '2');
  const store = JSON.parse(fs.readFileSync(tasksFile(root), 'utf8'));
  assert.equal(store.groups.master.metadata.prd_version, 1);
  const sessions = fs.readdirSync(path.join(root, '.aipipe', 'sessions')).map(name => JSON.parse(fs.readFileSync(path.join(root, '.aipipe', 'sessions', name), 'utf8')));
  for (const stage of ['implement', 'code_review']) assert.ok(sessions.some(session => session.stage === stage && session.skills[0]?.name === 'uiux-design'));
});

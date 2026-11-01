import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAgent } from '../src/agents.js';
import { defaultConfig } from '../src/config.js';
import { usageLimit } from '../src/agent-errors.js';

const limit = "You've hit your session limit · resets 9:10pm (Asia/Taipei)";
const roots = [];
process.env.AIPIPE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-limit-home-'));
roots.push(process.env.AIPIPE_HOME);
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

function fixture({ claude = 'limit', codex = 'success', write = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-limit-')); roots.push(root);
  const cfg = defaultConfig(); cfg.runtime = { claude: 'windows', codex: 'windows' }; cfg.skills.prd = ['uiux-design'];
  for (const [provider, mode] of Object.entries({ claude, codex })) {
    const file = path.join(root, `${provider}.cjs`); cfg.cli[provider] = file;
    if (mode === 'missing') continue;
    fs.writeFileSync(file, `const fs = require('node:fs'); const args = process.argv.slice(2);
if (args[0] === '--version') console.log('1.0');
else if (args[0] === 'auth') console.log('{"loggedIn":true,"authMethod":"claude.ai"}');
else if (args[0] === 'login') console.error('Logged in using ChatGPT');
else { let prompt=''; process.stdin.on('data', data => prompt += data); process.stdin.on('end', () => {
  fs.appendFileSync('.aipipe/calls.jsonl', JSON.stringify({provider:${JSON.stringify(provider)},prompt,args}) + '\\n');
  const failed = ${JSON.stringify(mode)} !== 'success' && ${JSON.stringify(mode)} !== 'mentions-limit';
  const message = ${JSON.stringify(mode)} === 'error' ? 'permission denied' : failed ? ${JSON.stringify(limit)} : ${JSON.stringify(mode)} === 'mentions-limit' ? ${JSON.stringify(limit)} : '# PRD';
  if (${JSON.stringify(provider)} === 'claude') console.log(JSON.stringify({type:'result',is_error:failed,result:message}));
  else if (failed) console.error(message);
  else fs.writeFileSync(args[args.indexOf('-o')+1],message);
  process.exitCode = failed ? 1 : 0;
}); }
`);
  }
  return { root, cfg, provider: 'claude', prompt: 'Write a PRD.', write, scope: 'prd', label: 'test', stage: 'prd' };
}
const calls = root => fs.readFileSync(path.join(root, '.aipipe', 'calls.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('辨識 session 額度並保留 CLI 重設時間，不混淆 context 或網路錯誤', () => {
  assert.equal(usageLimit(limit).reset, '9:10pm (Asia/Taipei)');
  assert.equal(usageLimit('context window exceeded'), null);
  assert.equal(usageLimit('connection refused'), null);
  assert.equal(usageLimit('usage_limit_reached').kind, 'usage_limit');
});

test('唯讀作者遇到限額，改用另一 AI，原始 prompt 與技能只注入一次', async () => {
  const options = fixture(); const result = await runAgent(options);
  assert.equal(result.ok, true); assert.equal(result.provider, 'codex'); assert.equal(result.fallbackFrom, 'claude');
  const records = calls(options.root);
  assert.deepEqual(records.map(call => call.provider), ['claude', 'codex']);
  assert.ok(records.every(call => call.prompt.startsWith(options.prompt)));
  assert.ok(records.every(call => call.prompt.match(/### Skill: uiux-design/g)?.length === 1));
  const sessions = fs.readdirSync(path.join(options.root, '.aipipe', 'sessions')).map(name => JSON.parse(fs.readFileSync(path.join(options.root, '.aipipe', 'sessions', name), 'utf8')));
  assert.equal(sessions.length, 2); assert.deepEqual(sessions.map(s => s.status).sort(), ['done', 'error']);
});

test('兩個 AI 都限額時只嘗試各一次，顯示重設時間', async () => {
  const options = fixture({ codex: 'limit' }); const result = await runAgent(options);
  assert.equal(result.ok, false); assert.match(result.error, /9:10pm.*Asia\/Taipei/);
  assert.match(result.error, /也未完成/); assert.equal(calls(options.root).length, 2);
});

test('另一 AI 未安裝或設定在不同環境時顯示處理方式', async () => {
  const options = fixture({ codex: 'missing' }); const result = await runAgent(options);
  assert.equal(result.ok, false); assert.match(result.error, /安裝並登入另一個 AI/); assert.equal(calls(options.root).length, 1);
  const different = fixture(); different.cfg.runtime.codex = 'wsl';
  const otherResult = await runAgent(different);
  assert.match(otherResult.error, /不同執行環境/); assert.equal(calls(different.root).length, 1);
});

test('寫入中限額不會自動重做，普通失敗與成功回答也不觸發限額切換', async () => {
  const writing = fixture({ write: true }); const failure = await runAgent(writing);
  assert.match(failure.error, /確認變更後再重試/); assert.equal(calls(writing.root).length, 1);
  for (const mode of ['error', 'mentions-limit']) {
    const options = fixture({ claude: mode }); const result = await runAgent(options);
    assert.equal(result.ok, mode === 'mentions-limit'); assert.equal(result.provider, 'claude'); assert.equal(calls(options.root).length, 1);
  }
});

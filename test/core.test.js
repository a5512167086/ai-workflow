import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseVerdict } from '../src/agents.js';
import { cleanEnv } from '../src/proc.js';
import { defaultConfig, validateConfig } from '../src/config.js';
import { stripOuterFence } from '../src/prompts.js';
import { snapshotTree, diffTrees, restoreToTree } from '../src/git.js';
import { featureBranch } from '../src/runner.js';

test('parseVerdict 取最後一個 VERDICT，找不到視為不通過', () => {
  assert.deepEqual(parseVerdict('範例 VERDICT: PASS\n...\nVERDICT: FAIL', ['PASS']), { pass: false, verdict: 'FAIL' });
  assert.deepEqual(parseVerdict('**VERDICT:** APPROVE', ['APPROVE']), { pass: true, verdict: 'APPROVE' });
  assert.equal(parseVerdict('沒有結論', ['PASS']).pass, false);
});

test('cleanEnv 移除 API key 與上層 Claude session 變數', () => {
  process.env.ANTHROPIC_API_KEY = 'x';
  process.env.OPENAI_API_KEY = 'y';
  process.env.CLAUDE_CODE_SIMPLE = '1';
  process.env.CLAUDE_CODE_GIT_BASH_PATH = 'keep';
  const env = cleanEnv();
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CLAUDE_CODE_SIMPLE, undefined);
  assert.equal(env.CLAUDE_CODE_GIT_BASH_PATH, 'keep');
});

test('validateConfig 檢查角色、模式、輪數與 provider', () => {
  assert.deepEqual(validateConfig(defaultConfig()), []);
  const bad = { ...defaultConfig(), mode: 'x', max_fix_rounds: 0, roles: { author: 'gpt' }, taskmaster: { provider: 'anthropic' } };
  assert.ok(validateConfig(bad).length >= 4);
});

test('stripOuterFence 去掉整份輸出的 markdown 圍欄', () => {
  assert.equal(stripOuterFence('```markdown\n# A\n```'), '# A');
  assert.equal(stripOuterFence('# A\n```js\nx\n```'), '# A\n```js\nx\n```');
});

test('featureBranch 產生安全的分支名稱', () => {
  const cfg = defaultConfig();
  assert.equal(featureBranch({ ...cfg, feature: 'CSV Export!' }, { prd: {} }), 'aipipe/csv-export');
  assert.equal(featureBranch(cfg, { prd: { idea: '中文想法' } }), 'aipipe/feature');
});

test('snapshotTree / restoreToTree 不動 index，可還原任務變更', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-git-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  g('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  fs.mkdirSync(path.join(dir, '.aipipe', 'tmp'), { recursive: true });
  const base = snapshotTree(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'two\n');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'new\n');
  const diff = diffTrees(dir, base, snapshotTree(dir));
  assert.match(diff, /b\.txt/);
  assert.match(diff, /\+two/);
  assert.equal(g('diff', '--cached', '--name-only').trim(), '');
  restoreToTree(dir, base);
  assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(fs.existsSync(path.join(dir, 'b.txt')), false);
});

test('stripOuterFence 去掉短前言後的 markdown 區塊，但不誤砍以標題開頭的本文', () => {
  assert.equal(stripOuterFence('Here is the PRD.\n\n```markdown\n# A\nbody\n```'), '# A\nbody');
  assert.equal(stripOuterFence('# A\n\nsee\n```markdown\n# B\n```'), '# A\n\nsee\n```markdown\n# B\n```');
});

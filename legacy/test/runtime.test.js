import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectEnvironment, cliEnvironment, wslLocation } from '../src/runtime.js';
import { toWslPath, resolveCliFor } from '../src/proc.js';
import { defaultConfig } from '../src/config.js';
import { probeProvider, selectProvider } from '../src/capabilities.js';
import { doctorReport } from '../src/doctor.js';
import { draftPrd } from '../src/prd.js';
import { readState } from '../src/state.js';
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-runtime-home-'));
process.env.AIPIPE_HOME = testHome;
test.after(() => fs.rmSync(testHome, { recursive: true, force: true }));

test('自動辨識 Windows 與兩種 WSL UNC 路徑，保留發行版及空白中文', () => {
  assert.equal(projectEnvironment('C:\\work\\app', 'win32').runtime, 'windows');
  for (const host of ['wsl$', 'wsl.localhost']) {
    const root = `\\\\${host}\\Ubuntu-24.04\\home\\me\\中文 app`;
    assert.deepEqual(wslLocation(root), { distro: 'Ubuntu-24.04', path: '/home/me/中文 app' });
    const cfg = { ...defaultConfig(), wsl_distro: 'WrongDistro' };
    assert.equal(cliEnvironment(cfg, 'claude', root).distro, 'Ubuntu-24.04');
    assert.equal(toWslPath('Ubuntu-24.04', root), '/home/me/中文 app');
    assert.throws(() => toWslPath('Debian', root), /跨 WSL/);
  }
  assert.equal(wslLocation('\\\\server\\share\\repo'), null);
  assert.equal(projectEnvironment('/home/me/repo', 'linux', { WSL_DISTRO_NAME: 'Ubuntu' }).distro, 'Ubuntu');
});

test('手動 runtime 設定仍優先於自動判斷', () => {
  const cfg = defaultConfig();
  cfg.runtime.claude = 'windows';
  assert.equal(cliEnvironment(cfg, 'claude', '\\\\wsl$\\Ubuntu\\home\\repo').runtime, 'windows');
  assert.equal(cliEnvironment(cfg, 'claude', '\\\\wsl$\\Ubuntu\\home\\repo').distro, '');
  if (process.platform === 'win32') {
    cfg.runtime.claude = 'auto'; cfg.wsl_distro = 'Ubuntu';
    assert.equal(cliEnvironment(cfg, 'claude', 'C:\\work\\app').runtime, 'windows');
    assert.equal(cliEnvironment(cfg, 'claude', 'C:\\work\\app').distro, '');
  }
});

test('自動 WSL spec 使用專案發行版，參數路徑不需要呼叫 wslpath', { skip: process.platform !== 'win32' }, () => {
  const root = '\\\\wsl.localhost\\Debian\\home\\me\\repo';
  const spec = resolveCliFor(defaultConfig(), 'codex', root);
  assert.equal(spec.distro, 'Debian');
  assert.equal(spec.toPath(root + '\\file.md'), '/home/me/repo/file.md');
});

test('CLI 探測區分未安裝、未登入、訂閱登入與 API 登入', async () => {
  const resolve = () => ({ runtime: 'windows', label: 'fake' });
  for (const provider of ['claude', 'codex']) {
    const probe = (auth, versionCode = 0) => probeProvider('.', {}, provider, { resolve,
      execute: async (_spec, args) => args[0] === '--version'
        ? { code: versionCode, stdout: '1.0', stderr: '' }
        : { code: 0, stdout: auth, stderr: '' },
    });
    assert.equal((await probe('', 1)).installed, false);
    assert.equal((await probe('')).available, false);
    const ok = provider === 'claude' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT';
    assert.equal((await probe(ok)).available, true);
    const api = provider === 'claude' ? '{"loggedIn":true,"authMethod":"api_key"}' : 'Logged in using an API key';
    const result = await probe(api);
    assert.equal(result.installed, true);
    assert.equal(result.available, false);
  }
});

test('缺任一 AI 時選另一個，兩個都缺時顯示診斷', async () => {
  for (const preferred of ['claude', 'codex']) {
    const other = preferred === 'claude' ? 'codex' : 'claude';
    const single = async (_root, _cfg, provider) => ({ available: provider === other, error: '未安裝' });
    assert.equal((await selectProvider('.', {}, preferred, single)).provider, other);
    const both = async () => ({ available: true });
    assert.equal((await selectProvider('.', {}, preferred, both)).provider, preferred);
  }
  await assert.rejects(selectProvider('.', {}, 'claude', async () => ({ available: false, error: '未登入' })), /沒有可用.*doctor/);
});

test('doctor 另一環境缺 CLI 不會阻擋目前專案的單 AI 模式', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-doctor-'));
  try {
    const runtime = projectEnvironment(root).runtime;
    const report = await doctorReport(root, { probe: async (_root, cfg, provider) => ({
      installed: provider === 'codex', available: cfg.runtime[provider] === runtime && provider === 'codex', error: '未安裝',
    }) });
    assert.equal(report.bad, 0);
    assert.deepEqual(report.available, ['codex']);
    assert.match(report.lines.join('\n'), /單 AI 模式/);
    const none = await doctorReport(root, { probe: async () => ({ available: false, error: '未安裝' }) });
    assert.equal(none.bad, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('僅 Codex 可用時，PRD 起草與審查使用不同程序且保存實際 provider', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-single-'));
  try {
    const fake = path.join(root, 'codex.cjs');
    fs.writeFileSync(fake, `const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') console.log('codex 1.0');
else if (args[0] === 'login') console.error('Logged in using ChatGPT');
else {
  fs.appendFileSync('runs.jsonl', JSON.stringify({pid: process.pid, args}) + '\\n');
  fs.writeFileSync(args[args.indexOf('-o') + 1], '# PRD\\nVERDICT: APPROVE');
  process.stdin.resume();
}
`);
    const cfg = defaultConfig();
    cfg.runtime = { claude: 'windows', codex: 'windows', task_master: 'windows' };
    cfg.cli.claude = path.join(root, 'missing.exe');
    cfg.cli.codex = fake;
    await draftPrd(root, cfg, 'test idea');
    const state = readState(root);
    assert.equal(state.prd.status, 'awaiting_approval');
    assert.deepEqual(state.prd.rounds.map(r => r.provider), ['codex', 'codex']);
    const runs = fs.readFileSync(path.join(root, 'runs.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(runs.length, 2);
    assert.notEqual(runs[0].pid, runs[1].pid);
    assert.ok(runs.every(r => !r.args.includes('resume')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

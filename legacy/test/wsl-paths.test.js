import test from 'node:test';
import assert from 'node:assert/strict';
import { toWslPath, wslArgs } from '../src/proc.js';

test('啟動 WSL 的 cwd 直接交給 --cd，不呼叫 wslpath', () => {
  const spec = { distro: 'Ubuntu', bin: 'claude', toPath() { throw new Error('不應轉換 cwd'); } };
  const args = wslArgs(spec, 'C:\\codebase-win\\ai-workflow', ['--version']);
  assert.deepEqual(args.slice(0, 4), ['-d', 'Ubuntu', '--cd', 'C:\\codebase-win\\ai-workflow']);
  assert.equal(args.at(-1), '--version');
  assert.equal(wslArgs(spec, '\\\\wsl.localhost\\Ubuntu\\home\\中文 app', [])[3], '/home/中文 app');
  assert.throws(() => wslArgs(spec, '\\\\wsl$\\Debian\\home\\app', []), /跨 WSL/);
});

test('必要的 wslpath 轉換獨立 cwd，支援冷啟動等待並保留空白中文', () => {
  const input = 'C:\\中文 app\\file.md';
  const converted = toWslPath('Ubuntu', input, { execute(command, args, options) {
    assert.equal(command, 'wsl.exe');
    assert.deepEqual(args, ['-d', 'Ubuntu', '--cd', '/', '-e', '/usr/bin/wslpath', '-a', input]);
    assert.equal(options.timeout, 30000);
    return { status: 0, stdout: '/mnt/c/中文 app/file.md\n' };
  } });
  assert.equal(converted, '/mnt/c/中文 app/file.md');
});

test('轉換錯誤包含逾時、找不到 WSL 或發行版錯誤，不再只顯示空白訊息', () => {
  for (const [result, expected] of [
    [{ status: null, stdout: null, error: { code: 'ETIMEDOUT' } }, /30 秒/],
    [{ status: null, stdout: null, error: { code: 'ENOENT', message: 'wsl.exe not found' } }, /ENOENT/],
    [{ status: 1, stdout: 'Distribution not found', stderr: '' }, /Distribution not found/],
  ]) {
    assert.throws(() => toWslPath('Ubuntu', 'C:\\app', { execute: () => result }), expected);
  }
  assert.throws(() => toWslPath('Ubuntu', 'C:\\app', { execute: () => ({ status: 0, stdout: 'not a linux path' }) }), /有效的 Linux 路徑/);
});

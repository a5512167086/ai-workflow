import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolveCliFor, run } from '../src/proc.js';
import { defaultConfig } from '../src/config.js';

const hasWsl = process.platform === 'win32' && spawnSync('wsl.exe', ['-e', 'true'], { windowsHide: true }).status === 0;

test('WSL runtime：參數原樣傳遞、cwd 轉成 /mnt 路徑、API key 在 WSL 端被清掉', { skip: !hasWsl && '沒有 WSL' }, async () => {
  const cfg = { ...defaultConfig(), runtime: { claude: 'wsl', codex: 'windows', task_master: 'windows' }, wsl_cli: { claude: 'bash' } };
  const spec = resolveCliFor(cfg, 'claude');
  // WSLENV 會把 Windows 端變數轉送進 WSL，模擬「WSL 環境裡有 API key」。
  const env = { ...process.env, ANTHROPIC_API_KEY: 'leak', OPENAI_API_KEY: 'leak', WSLENV: 'ANTHROPIC_API_KEY:OPENAI_API_KEY' };
  const script = 'printf "%s|" "$@"; echo; pwd; echo "a=${ANTHROPIC_API_KEY-unset} o=${OPENAI_API_KEY-unset}"; cat';
  const res = await run(spec, ['-c', script, 'x', 'a b', 'q"uote', '$HOME', 'x;y'], { cwd: process.cwd(), env, input: '中文 stdin' });
  const [argsLine, pwd, keys, stdin] = res.stdout.trim().split('\n');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(argsLine, 'a b|q"uote|$HOME|x;y|');
  assert.match(pwd, /^\/mnt\/c\//);
  assert.equal(keys, 'a=unset o=unset');
  assert.equal(stdin, '中文 stdin');
  assert.match(spec.toPath('C:\\Users\\x y\\f.md'), /^\/mnt\/c\/Users\/x y\/f\.md$/);
});

import { resolveCliFor, run } from './proc.js';

export async function probeProvider(root, cfg, provider, { resolve = resolveCliFor, execute = run } = {}) {
  const result = { provider, installed: false, authenticated: false, available: false };
  try {
    const spec = resolve(cfg, provider, root);
    result.runtime = spec.runtime;
    result.label = spec.label;
    const timeoutSec = spec.runtime === 'wsl' ? 30 : 15;
    const version = await execute(spec, ['--version'], { cwd: root, timeoutSec });
    if (version.code !== 0) throw new Error(version.timedOut ? `${spec.runtime === 'wsl' ? 'WSL 啟動或 ' : ''}CLI 版本檢查逾時（${timeoutSec} 秒）` : 'CLI 無法啟動或尚未安裝');
    result.installed = true;
    result.version = version.stdout.trim().split('\n').at(-1);
    const auth = await execute(spec, provider === 'claude' ? ['auth', 'status'] : ['login', 'status'], { cwd: root, timeoutSec });
    if (auth.code !== 0) throw new Error(auth.timedOut ? '登入檢查逾時' : '尚未登入或登入檢查失敗');
    if (provider === 'claude') {
      const out = auth.stdout.trim();
      const status = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
      if (!status.loggedIn || status.authMethod !== 'claude.ai') throw new Error('請使用 claude.ai 訂閱登入');
    } else if (!/logged in using chatgpt/i.test(auth.stdout + auth.stderr)) {
      throw new Error('未確認 ChatGPT 訂閱登入，請執行 codex login');
    }
    result.authenticated = result.available = true;
  } catch (error) { result.error = error.message; }
  return result;
}

/** Fallback only before execution: never repeat failed writes with another AI. */
export async function selectProvider(root, cfg, preferred, probe = probeProvider) {
  const first = await probe(root, cfg, preferred);
  if (first.available) return { provider: preferred, checks: [first] };
  const other = preferred === 'claude' ? 'codex' : 'claude';
  const second = await probe(root, cfg, other);
  if (second.available) return { provider: other, checks: [first, second] };
  throw new Error(`沒有可用的 AI CLI：${preferred}：${first.error}；${other}：${second.error}。請執行 aipipe doctor`);
}

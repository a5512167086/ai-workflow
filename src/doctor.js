import { spawnSync } from 'node:child_process';
import { loadConfig, CLI_NAMES } from './config.js';
import { resolveCliFor, run, cleanEnv, STRIPPED_ENV_DESCRIPTION } from './proc.js';

const CHECKS = {
  claude: [['--version'], ['auth', 'status']],
  codex: [['--version'], ['login', 'status']],
  task_master: [['--version']],
};
const LABEL = { claude: 'claude', codex: 'codex', task_master: 'task-master' };

/** WSL 本身是否可用，以及 login shell 裡有沒有 API key（只列名稱，不讀值）。 */
function checkWsl(distro, lines) {
  const base = distro ? ['-d', distro] : [];
  const r = spawnSync('wsl.exe', [...base, '-e', 'bash', '-lc', 'echo "$WSL_DISTRO_NAME"; compgen -e | grep -E "^(ANTHROPIC_|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY)" || true'], {
    encoding: 'utf8',
    env: cleanEnv(),
    windowsHide: true,
    timeout: 60000,
  });
  if (r.error || r.status !== 0) {
    lines.push(`✖ WSL${distro ? `（${distro}）` : ''} 無法啟動：${(r.error?.message || r.stderr || '').replace(/\0/g, '').trim()}`);
    return false;
  }
  const [name, ...keys] = r.stdout.trim().split('\n').filter(Boolean);
  lines.push(`● WSL 發行版：${name || '(未知)'}`);
  if (keys.length) lines.push(`  WSL login shell 設有 ${keys.join(', ')}；aipipe 會在 WSL 端用 env -u／unset 清掉後才執行 CLI`);
  return true;
}

function interpretClaudeAuth(out) {
  try {
    const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
    if (!j.loggedIn) return { ok: false, note: '未登入 → 在該 runtime 執行 claude auth login' };
    if (j.authMethod !== 'claude.ai') return { ok: false, note: `已登入但方式是 ${j.authMethod}，不是訂閱（claude.ai）` };
    return { ok: true, note: `已用訂閱登入（${j.subscriptionType || j.authMethod}）` };
  } catch {
    return null;
  }
}

export async function doctorReport(root) {
  let cfg;
  try {
    cfg = loadConfig(root);
  } catch {
    cfg = loadConfig(root, { required: false });
  }
  const lines = [];
  let bad = 0;
  lines.push(`Windows 端子程序會移除的環境變數：${STRIPPED_ENV_DESCRIPTION}`);
  const leaked = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'CODEX_API_KEY'].filter((k) => process.env[k]);
  if (leaked.length) lines.push(`  目前環境有 ${leaked.join(', ')}，aipipe 呼叫 CLI 時會移除，確保走訂閱額度`);

  const usesWsl = CLI_NAMES.some((n) => cfg.runtime[n] === 'wsl');
  const wslOk = usesWsl ? checkWsl(cfg.wsl_distro, lines) : true;
  if (!wslOk) bad++;

  for (const name of CLI_NAMES) {
    const runtime = cfg.runtime[name];
    if (runtime === 'wsl' && !wslOk) {
      lines.push(`✖ ${LABEL[name]}（wsl）：WSL 無法使用，略過`);
      bad++;
      continue;
    }
    let spec;
    try {
      spec = resolveCliFor(cfg, name);
    } catch (err) {
      lines.push(`✖ ${LABEL[name]}（${runtime}）：${err.message}`);
      bad++;
      continue;
    }
    lines.push(`● ${LABEL[name]}（${runtime}）：${spec.label}`);
    for (const args of CHECKS[name]) {
      let res;
      try {
        res = await run(spec, args, { cwd: root, env: cleanEnv(), timeoutSec: 60 });
      } catch (err) {
        lines.push(`    ${args.join(' ')}：無法執行 ${err.message}`);
        bad++;
        continue;
      }
      const out = (res.stdout + res.stderr).trim();
      const line = out.split('\n').filter(Boolean).slice(-1)[0] || '';
      const auth = name === 'claude' && args[0] === 'auth' ? interpretClaudeAuth(out) : null;
      if (auth) {
        lines.push(`    ${args.join(' ')}：${auth.note}`);
        if (!auth.ok) bad++;
        continue;
      }
      if (res.code !== 0) {
        lines.push(`    ${args.join(' ')}：失敗（結束碼 ${res.code}）${line}`);
        bad++;
      } else {
        lines.push(`    ${args.join(' ')}：${line}`);
      }
    }
  }
  lines.push(bad ? `有 ${bad} 項需要處理` : '全部正常');
  return { lines, bad };
}

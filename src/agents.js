import fs from 'node:fs';
import path from 'node:path';
import { resolveCliFor, run } from './proc.js';
import { appendLog, aipipeDir } from './state.js';

/**
 * 以官方 CLI 跑一次全新對話（不 resume），prompt 由 stdin 傳入。
 * write=false 的角色（PRD 審查、程式碼審查）以唯讀方式執行。
 * 回傳 { ok, text, error }。
 */
export async function runAgent({ root, cfg, provider, prompt, write, scope, label }) {
  appendLog(root, scope, `── ${label}：${provider}（${write ? '可編輯' : '唯讀'}）開始 ──`);
  const promptFile = aipipeDir(root, 'tmp', `${scope}-${Date.now()}.prompt.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  const started = Date.now();
  const result = provider === 'codex'
    ? await runCodex({ root, cfg, prompt, write, scope })
    : await runClaude({ root, cfg, prompt, write, scope });
  const secs = Math.round((Date.now() - started) / 1000);
  appendLog(root, scope, `── ${label}：${result.ok ? '完成' : '失敗'}（${secs}s）${result.error ? ' ' + result.error : ''} ──`);
  return result;
}

async function runClaude({ root, cfg, prompt, write, scope }) {
  const spec = resolveCliFor(cfg, 'claude');
  // -p + stream-json 需要 --verbose 才會輸出逐步事件。
  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  if (write) {
    args.push('--permission-mode', 'acceptEdits');
    if (cfg.claude.allowed_tools?.length) args.push('--allowedTools', cfg.claude.allowed_tools.join(','));
  } else {
    // dontAsk：沒有預先允許的工具一律拒絕；再明確禁止編輯類工具。
    args.push('--permission-mode', 'dontAsk', '--disallowedTools', 'Edit,Write,NotebookEdit');
  }
  if (cfg.claude.model) args.push('--model', cfg.claude.model);

  let buffer = '';
  let finalText = '';
  let isError = false;
  let errorText = '';
  const handleLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      appendLog(root, scope, line);
      return;
    }
    if (ev.type === 'assistant') {
      for (const part of ev.message?.content || []) {
        if (part.type === 'text' && part.text.trim()) appendLog(root, scope, part.text.trim());
        if (part.type === 'tool_use') appendLog(root, scope, `🔧 ${part.name} ${summarizeToolInput(part.input)}`);
      }
    } else if (ev.type === 'result') {
      finalText = ev.result || '';
      isError = !!ev.is_error;
      if (isError) errorText = finalText;
      if (ev.permission_denials?.length) {
        appendLog(root, scope, `⚠ 被拒絕的工具呼叫：${ev.permission_denials.map((d) => d.tool_name).join(', ')}`);
      }
    }
  };
  const res = await run(spec, args, {
    cwd: root,
    input: prompt,
    timeoutSec: cfg.agent_timeout_sec,
    onStdout: (d) => {
      buffer += d;
      let idx;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    onStderr: (d) => appendLog(root, scope, d.trimEnd()),
  });
  handleLine(buffer);
  if (res.timedOut) return { ok: false, text: finalText, error: `逾時（${cfg.agent_timeout_sec}s）` };
  if (isError || res.code !== 0) {
    return { ok: false, text: finalText, error: errorText || `claude 結束碼 ${res.code}` };
  }
  return { ok: true, text: finalText };
}

async function runCodex({ root, cfg, prompt, write, scope }) {
  const spec = resolveCliFor(cfg, 'codex');
  const outFile = aipipeDir(root, 'tmp', `${scope}-${Date.now()}.codex-last.md`);
  const args = [
    'exec',
    '--sandbox', write ? 'workspace-write' : 'read-only',
    '-C', spec.toPath(root),
    '--color', 'never',
    '-o', spec.toPath(outFile),
  ];
  if (cfg.codex.model) args.push('-m', cfg.codex.model);
  // 唯讀角色也帶上，否則 Windows 上 Codex 連讀檔用的 shell 指令都無法啟動。
  if (spec.runtime === 'windows' && cfg.codex.windows_sandbox) args.push('-c', `windows.sandbox="${cfg.codex.windows_sandbox}"`);
  args.push('-'); // 從 stdin 讀 prompt
  const res = await run(spec, args, {
    cwd: root,
    input: prompt,
    timeoutSec: cfg.agent_timeout_sec,
    onStdout: (d) => appendLog(root, scope, d.trimEnd()),
    onStderr: (d) => appendLog(root, scope, d.trimEnd()),
  });
  let text = '';
  try {
    text = fs.readFileSync(outFile, 'utf8');
  } catch {
    text = res.stdout;
  }
  if (res.timedOut) return { ok: false, text, error: `逾時（${cfg.agent_timeout_sec}s）` };
  if (res.code !== 0) return { ok: false, text, error: `codex 結束碼 ${res.code}：${lastLines(res.stderr, 5)}` };
  if (write && /^sandbox:\s*read-only/m.test(res.stderr + res.stdout)) {
    return {
      ok: false,
      text,
      error: 'Codex 把 workspace-write 降成了 read-only，無法修改檔案。Windows 請在 .aipipe.json 設定 codex.windows_sandbox（elevated 或 unelevated）',
    };
  }
  return { ok: true, text };
}

function summarizeToolInput(input) {
  if (!input) return '';
  const v = input.file_path || input.path || input.command || input.pattern || '';
  return String(v).slice(0, 160);
}

export function lastLines(text, n) {
  return String(text || '').trim().split('\n').slice(-n).join(' | ');
}

/** 從審查回覆找出 VERDICT 行；找不到時保守視為不通過。 */
export function parseVerdict(text, passWords) {
  const all = [...String(text || '').matchAll(/VERDICT\s*\**\s*[:：]\s*\**\s*([A-Z_]+)/gi)];
  const m = all.at(-1);
  if (!m) return { pass: false, verdict: 'UNKNOWN' };
  const verdict = m[1].toUpperCase();
  return { pass: passWords.includes(verdict), verdict };
}

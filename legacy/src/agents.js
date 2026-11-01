import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { resolveCliFor, run } from './proc.js';
import { appendLog, aipipeDir } from './state.js';
import { selectProvider, probeProvider } from './capabilities.js';
import { cliEnvironment } from './runtime.js';
import { usageLimit, explainUsageLimit } from './agent-errors.js';
import { prepareSkills } from './skills.js';
import { writeJson } from './home.js';
import { createTelemetry, recordTelemetry } from './usage.js';

/**
 * 以官方 CLI 跑一次全新對話（不 resume），prompt 由 stdin 傳入。
 * write=false 的角色（PRD 審查、程式碼審查）以唯讀方式執行。
 * 回傳 { ok, text, error }。
 */
export async function runAgent(options) {
  const { root, cfg, provider: preferred, write, scope } = options;
  const selected = await selectProvider(root, cfg, preferred);
  const provider = selected.provider;
  if (provider !== preferred) {
    appendLog(root, scope, `單 AI 模式：${preferred} 不可用（${selected.checks[0].error}），改用 ${provider}，建立全新 session`);
  }
  const result = await runAgentSession({ ...options, provider });
  const limit = !result.ok && usageLimit(result.error);
  if (!limit) return result;
  const message = explainUsageLimit(provider, limit);
  if (write) return { ...result, error: `${message}。工作可能已修改檔案，已停止；確認變更後再重試`, failure: limit };
  const other = provider === 'claude' ? 'codex' : 'claude';
  const target = cliEnvironment(cfg, provider, root), alternate = cliEnvironment(cfg, other, root);
  if (target.runtime !== alternate.runtime || target.distro !== alternate.distro) {
    return { ...result, error: `${message}。另一個 AI 設定在不同執行環境，請在設定中調整後再重試`, failure: limit };
  }
  const check = await probeProvider(root, cfg, other);
  if (!check.available) return { ...result, error: `${message}。同環境的 ${other} 不可用：${check.error}。請等待額度重設，或安裝並登入另一個 AI`, failure: limit };
  appendLog(root, scope, `${message}；本次唯讀工作改用 ${other}，建立全新 session`);
  // Call the session directly: at most one fallback, with the original prompt and fresh skill paths.
  const fallback = await runAgentSession({ ...options, provider: other });
  const secondLimit = !fallback.ok && usageLimit(fallback.error);
  return { ...fallback, fallbackFrom: provider,
    ...(fallback.ok ? {} : { error: `${message}；${other} 也未完成：${secondLimit ? explainUsageLimit(other, secondLimit) : fallback.error}`,
      failure: secondLimit || limit }) };
}

async function runAgentSession({ root, cfg, provider, prompt, write, scope, label, stage, skills }) {
  const spec = resolveCliFor(cfg, provider, root);
  const skillContext = prepareSkills(root, cfg, stage, skills, spec.toPath);
  prompt = [prompt, skillContext.text].filter(Boolean).join('\n\n');
  const sessionId = randomUUID();
  const sessionFile = aipipeDir(root, 'sessions', `${sessionId}.json`);
  const session = { id: sessionId, provider, runtime: spec.runtime, distro: cliEnvironment(cfg, provider, root).distro, stage: stage || 'skill', label,
    skills: skillContext.snapshots, started_at: new Date().toISOString(), status: 'running' };
  writeJson(sessionFile, session);
  const telemetry = createTelemetry(provider);
  let previousTelemetry = '';
  const onEvent = event => {
    const value = telemetry.accept(event), signature = JSON.stringify(value);
    if (signature !== previousTelemetry) {
      previousTelemetry = signature;
      recordTelemetry(root, session, value);
    }
  };
  onEvent({});
  appendLog(root, scope, `── ${label}：${provider}（${write ? '可編輯' : '唯讀'}）開始，session ${sessionId} ──`);
  const promptFile = aipipeDir(root, 'tmp', `${sessionId}.prompt.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt);
  const started = Date.now();
  let result;
  try {
    result = provider === 'codex'
      ? await runCodex({ root, cfg, prompt, write, scope, onEvent })
      : await runClaude({ root, cfg, prompt, write, scope, onEvent });
  } catch (error) {
    writeJson(sessionFile, { ...session, status: 'error', error: error.message, finished_at: new Date().toISOString() });
    recordTelemetry(root, { ...session, status: 'error' }, telemetry.snapshot());
    throw error;
  }
  const status = result.ok ? 'done' : 'error';
  writeJson(sessionFile, { ...session, status, error: result.error, finished_at: new Date().toISOString(), ...telemetry.snapshot() });
  recordTelemetry(root, { ...session, status }, telemetry.snapshot());
  const secs = Math.round((Date.now() - started) / 1000);
  appendLog(root, scope, `── ${label}：${result.ok ? '完成' : '失敗'}（${secs}s）${result.error ? ' ' + result.error : ''} ──`);
  return { ...result, provider, sessionId, skills: skillContext.snapshots, ...telemetry.snapshot() };
}

async function runClaude({ root, cfg, prompt, write, scope, onEvent }) {
  const spec = resolveCliFor(cfg, 'claude', root);
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
    onEvent(ev);
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
    return { ok: false, text: finalText, error: errorText || finalText || `claude 結束碼 ${res.code}：${lastLines(res.stderr || res.stdout, 8)}` };
  }
  return { ok: true, text: finalText };
}

async function runCodex({ root, cfg, prompt, write, scope, onEvent }) {
  const spec = resolveCliFor(cfg, 'codex', root);
  const outFile = aipipeDir(root, 'tmp', `${randomUUID()}.codex-last.md`);
  const args = [
    'exec',
    '--json',
    '--sandbox', write ? 'workspace-write' : 'read-only',
    '-C', spec.toPath(root),
    '--color', 'never',
    '-o', spec.toPath(outFile),
  ];
  if (cfg.codex.model) args.push('-m', cfg.codex.model);
  // 唯讀角色也帶上，否則 Windows 上 Codex 連讀檔用的 shell 指令都無法啟動。
  if (spec.runtime === 'windows' && cfg.codex.windows_sandbox) args.push('-c', `windows.sandbox="${cfg.codex.windows_sandbox}"`);
  args.push('-'); // 從 stdin 讀 prompt
  let buffer = '', lastMessage = '';
  const handleLine = line => {
    if (!line.trim()) return;
    let event;
    try { event = JSON.parse(line); } catch { appendLog(root, scope, line); return; }
    onEvent(event);
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      lastMessage = event.item.text || ''; appendLog(root, scope, lastMessage);
    } else if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
      appendLog(root, scope, `$ ${event.item.command}\n${event.item.aggregated_output || ''}`);
    } else if (event.type === 'error' || event.type === 'turn.failed') {
      appendLog(root, scope, event.message || event.error?.message || line);
    }
  };
  const res = await run(spec, args, {
    cwd: root,
    input: prompt,
    timeoutSec: cfg.agent_timeout_sec,
    onStdout: data => {
      buffer += data;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) { handleLine(buffer.slice(0, index)); buffer = buffer.slice(index + 1); }
    },
    onStderr: (d) => appendLog(root, scope, d.trimEnd()),
  });
  handleLine(buffer);
  let text = '';
  try {
    text = fs.readFileSync(outFile, 'utf8');
  } catch {
    text = lastMessage || res.stdout;
  }
  if (res.timedOut) return { ok: false, text, error: `逾時（${cfg.agent_timeout_sec}s）` };
  if (res.code !== 0) return { ok: false, text, error: `codex 結束碼 ${res.code}：${lastLines(res.stderr + '\n' + text, 8)}` };
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

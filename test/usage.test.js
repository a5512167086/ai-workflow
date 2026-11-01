import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelemetry, normalizeTokens, normalizeCodexLimits, recordTelemetry, usageSnapshot, refreshUsageLimits } from '../src/usage.js';
import { defaultConfig } from '../src/config.js';
import { queryCodexRpc } from '../src/proc.js';
import { runAgent } from '../src/agents.js';
const roots = [];
function temp() { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipipe-usage-')); roots.push(root); return root; }
process.env.AIPIPE_HOME = temp();
test.after(() => { for (const root of roots) fs.rmSync(root, { recursive: true, force: true }); });

test('Claude 快取輸入分開加總，Codex 快取是輸入子集，不重複相加', () => {
  assert.equal(normalizeTokens('claude', { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 5 }).totalTokens, 65);
  assert.equal(normalizeTokens('codex', { input_tokens: 100, cached_input_tokens: 80, output_tokens: 5 }).totalTokens, 105);
  assert.equal(normalizeTokens('codex', {}), null);
});

test('Claude 重複 assistant 事件去重，result 取代暫時計數，context 使用最後一次請求', () => {
  const tracker = createTelemetry('claude');
  const event = { type: 'assistant', message: { id: 'm1', model: 'test-model', usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 } } };
  tracker.accept(event); tracker.accept(event);
  assert.equal(tracker.snapshot().tokens.totalTokens, 160);
  tracker.accept({ ...event, message: { ...event.message, id: 'm2' } });
  assert.equal(tracker.snapshot().tokens.totalTokens, 320);
  const final = tracker.accept({ type: 'result', usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 100 }, modelUsage: { 'test-model': { contextWindow: 1000 } } });
  assert.equal(final.tokens.totalTokens, 320);
  assert.equal(final.context.remainingTokens, 840); assert.equal(final.context.remainingPercent, 84);
  assert.equal(final.context.estimated, true);
});

test('Codex 以 turn.completed 記錄 tokens，累計處理量不拿來推測 context', () => {
  const tracker = createTelemetry('codex');
  tracker.accept({ type: 'turn.completed', usage: { input_tokens: 9000, cached_input_tokens: 8000, output_tokens: 100 } });
  assert.equal(tracker.snapshot().tokens.totalTokens, 9100); assert.equal(tracker.snapshot().context, null);
  tracker.accept({ type: 'event_msg', payload: { type: 'token_count', info: { model_context_window: 1000, last_token_usage: { total_tokens: 100 } } } });
  assert.equal(tracker.snapshot().context.remainingPercent, 90);
});

test('未回報與明確零用量不同；限額但沒比例時不憑空顯示 0%', () => {
  assert.equal(normalizeTokens('claude', undefined), null);
  assert.equal(normalizeTokens('codex', { input_tokens: 0, output_tokens: 0 }).totalTokens, 0);
  const tracker = createTelemetry('claude');
  const first = tracker.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' } });
  assert.equal(first.limits[0].remainingPercent, null);
  const second = tracker.accept({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.8, resetsAt: 2000000000 } });
  assert.equal(second.limits[0].remainingPercent, 20);
});

test('專案用量按 session ID 更新而非重複累加，跨環境帳號額度分開', async () => {
  const root = temp(), cfg = defaultConfig(); cfg.runtime = { claude: 'windows', codex: 'windows' }; cfg.cli.codex = process.execPath;
  const session = { id: 'a', provider: 'codex', runtime: 'windows', label: 'first', status: 'running' };
  recordTelemetry(root, session, { tokens: normalizeTokens('codex', { input_tokens: 100, output_tokens: 10 }), context: null, limits: [] });
  recordTelemetry(root, { ...session, status: 'done' }, { tokens: normalizeTokens('codex', { input_tokens: 100, output_tokens: 10 }), context: null, limits: [] });
  recordTelemetry(root, { ...session, id: 'b', runtime: 'wsl', distro: 'Ubuntu' }, { tokens: null, context: null, limits: [{ remainingPercent: 50 }] });
  const snapshot = usageSnapshot(root, cfg);
  assert.equal(snapshot.totalTokens, 110); assert.equal(snapshot.measuredSessions, 1); assert.equal(snapshot.unknownSessions, 1);
  assert.equal(snapshot.providers.find(row => row.provider === 'codex').limits, null);
  const result = await refreshUsageLimits(root, cfg, async (_spec, options) => {
    assert.equal(options.method, 'account/rateLimits/read');
    return { rateLimits: { primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1000000000 } } };
  });
  const limits = result.providers.find(row => row.provider === 'codex').limits;
  assert.equal(limits.windows[0].remainingPercent, 70); assert.equal(limits.windows[0].expired, true);
});

test('Codex 多視窗各自顯示，缺少或無效百分比保留未知', () => {
  const windows = normalizeCodexLimits({ rateLimitsByLimitId: { codex: { primary: { usedPercent: 25 }, secondary: { usedPercent: 99 } }, other: { primary: { usedPercent: 120 } } } });
  assert.deepEqual(windows.map(window => window.remainingPercent), [75, 1, null]);
});

test('Codex 額度 RPC 完成 handshake，只查額度，不建立 thread 或 turn', async () => {
  const root = temp(), file = path.join(root, 'rpc.cjs');
  fs.writeFileSync(file, `const readline = require('node:readline'); let initialized = false;
readline.createInterface({input:process.stdin}).on('line', line => {
const message = JSON.parse(line);
if (message.method === 'initialize') console.log(JSON.stringify({id:message.id,result:{}}));
else if (message.method === 'initialized') initialized = true;
else if (message.method === 'account/rateLimits/read' && initialized) console.log(JSON.stringify({id:message.id,result:{rateLimits:{primary:{usedPercent:25}}}}));
else process.exit(3);
});`);
  const result = await queryCodexRpc({ command: process.execPath, prefixArgs: [file], shell: false }, { cwd: root, method: 'account/rateLimits/read', timeoutSec: 2 });
  assert.equal(result.rateLimits.primary.usedPercent, 25);
});

test('CLI 實際事件串流會寫入 session 與專案統計，且保留最後回覆', async () => {
  for (const provider of ['claude', 'codex']) {
    const root = temp(), cfg = defaultConfig(), file = path.join(root, 'fake.cjs');
    cfg.runtime = { claude: 'windows', codex: 'windows' }; cfg.cli[provider] = file;
    const events = provider === 'claude' ? [
      { type: 'assistant', message: { id: 'a', model: 'test', usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }, content: [] } },
      { type: 'rate_limit_event', rate_limit_info: { utilization: 0.9, status: 'allowed_warning', resetsAt: 2000000000 } },
      { type: 'result', result: 'done', is_error: false, usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 10 }, modelUsage: { test: { contextWindow: 800 } } },
    ] : [
      { type: 'item.completed', item: { type: 'agent_message', text: 'done' } },
      { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } },
    ];
    fs.writeFileSync(file, `const args = process.argv.slice(2);
if(args[0]==='--version') console.log('1.0');
else if(args[0]==='auth') console.log('{"loggedIn":true,"authMethod":"claude.ai"}');
else if(args[0]==='login') console.log('Logged in using ChatGPT');
else { process.stdin.resume(); const text = ${JSON.stringify(events.map(event => JSON.stringify(event)).join('\n'))}; process.stdout.write(text.slice(0,17)); setImmediate(()=>process.stdout.write(text.slice(17))); }
`);
    const result = await runAgent({ root, cfg, provider, prompt: 'test', write: false, scope: 'test', label: 'test' });
    assert.equal(result.ok, true); assert.equal(result.text, 'done');
    const expected = provider === 'claude' ? 130 : 110;
    assert.equal(result.tokens.totalTokens, expected);
    const session = JSON.parse(fs.readFileSync(path.join(root, '.aipipe', 'sessions', result.sessionId + '.json'), 'utf8'));
    assert.equal(session.tokens.totalTokens, expected);
    assert.equal(usageSnapshot(root, cfg).totalTokens, expected);
    if (provider === 'codex') assert.equal(session.context, null);
  }
});

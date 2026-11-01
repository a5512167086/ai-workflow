import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { withLock, writeJson } from './home.js';
import { cliEnvironment } from './runtime.js';
import { resolveCliFor, queryCodexRpc } from './proc.js';

export const usageFile = root => path.join(root, '.aipipe', 'usage.json');
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) !== null && value <= 100 ? value : null;
const epoch = value => number(value) !== null && value > 0 && Number.isFinite(new Date(value * 1000).getTime()) ? new Date(value * 1000).toISOString() : null;
const environmentKey = (provider, env) => `${provider}|${env.runtime}|${env.runtime === 'wsl' ? env.distro || '' : ''}`;
function read(root) {
  if (!fs.existsSync(usageFile(root))) return { version: 1, sessions: {}, limits: {} };
  return JSON.parse(fs.readFileSync(usageFile(root), 'utf8'));
}
function change(root, fn) {
  const key = createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  return withLock(`usage-${key}`, () => { const store = read(root); fn(store); writeJson(usageFile(root), store); });
}

export function normalizeTokens(provider, usage) {
  if (!usage || (number(usage.input_tokens) === null && number(usage.output_tokens) === null)) return null;
  const input = number(usage.input_tokens), output = number(usage.output_tokens);
  const cacheRead = number(provider === 'claude' ? usage.cache_read_input_tokens : usage.cached_input_tokens);
  const cacheWrite = provider === 'claude' ? number(usage.cache_creation_input_tokens) : 0;
  const totalInput = input === null ? null : input + (provider === 'claude' ? (cacheRead || 0) + (cacheWrite || 0) : 0);
  return { inputTokens: totalInput, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    totalTokens: totalInput === null || output === null ? null : totalInput + output };
}

export function normalizeCodexLimits(result) {
  const buckets = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : result?.rateLimits ? [result.rateLimits] : [];
  return buckets.flatMap(bucket => ['primary', 'secondary'].flatMap(slot => {
    const window = bucket?.[slot];
    if (!window) return [];
    const usedPercent = percent(window.usedPercent);
    return [{ name: `${bucket.limitName || bucket.limitId || 'Codex'} · ${slot === 'primary' ? '主要額度' : '次要額度'}`, usedPercent,
      remainingPercent: usedPercent === null ? null : 100 - usedPercent, windowMinutes: number(window.windowDurationMins), resetsAt: epoch(window.resetsAt), source: 'codex-app-server' }];
  }));
}

/** Event accumulator: result usage is authoritative; assistant messages are not added to it. */
export function createTelemetry(provider) {
  let tokens = null, context = null, limits = [], lastRequest = null, lastModel = null;
  const messages = new Map();
  return {
    accept(event) {
      if (provider === 'claude') {
        if (event.type === 'assistant' && event.message?.usage) {
          lastRequest = normalizeTokens('claude', event.message.usage); lastModel = event.message.model;
          if (event.message.id && lastRequest) {
            messages.set(event.message.id, lastRequest);
            const values = [...messages.values()];
            tokens = Object.fromEntries(['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'].map(key =>
              [key, values.some(value => value[key] === null) ? null : values.reduce((sum, value) => sum + value[key], 0)]));
            tokens.provisional = true;
          }
        }
        if (event.type === 'result') {
          tokens = normalizeTokens('claude', event.usage) || tokens;
          const models = event.modelUsage || {};
          const model = models[lastModel] || (Object.keys(models).length === 1 ? Object.values(models)[0] : null);
          const capacity = number(model?.contextWindow);
          if (lastRequest?.totalTokens !== null && lastRequest?.totalTokens !== undefined && capacity > 0) {
            const used = lastRequest.totalTokens;
            context = { model: lastModel, usedTokens: used, capacity, remainingTokens: Math.max(0, capacity - used),
              remainingPercent: Math.max(0, 100 * (1 - used / capacity)), estimated: true };
          }
        }
        if (event.type === 'rate_limit_event' && event.rate_limit_info) {
          const info = event.rate_limit_info;
          const ratio = number(info.utilization);
          const usedPercent = ratio !== null && ratio <= 1 ? ratio * 100 : null;
          const window = { name: info.rateLimitType || 'Claude 訂閱視窗', usedPercent,
            remainingPercent: usedPercent === null ? null : 100 - usedPercent, resetsAt: epoch(info.resetsAt),
            status: info.status, source: 'claude-cli-event' };
          limits = [...limits.filter(previous => previous.name !== window.name), window];
        }
      } else {
        if (event.type === 'turn.completed') tokens = normalizeTokens('codex', event.usage) || tokens;
        const info = event.type === 'event_msg' && event.payload?.type === 'token_count' ? event.payload.info : null;
        const capacity = number(info?.model_context_window), used = number(info?.last_token_usage?.total_tokens);
        if (capacity > 0 && used !== null) context = { usedTokens: used, capacity, remainingTokens: Math.max(0, capacity - used),
          remainingPercent: Math.max(0, 100 * (1 - used / capacity)), estimated: false };
      }
      return this.snapshot();
    },
    snapshot() { return { tokens, context, limits }; },
  };
}

export function recordTelemetry(root, session, telemetry) {
  change(root, store => {
    const key = environmentKey(session.provider, session);
    store.sessions[session.id] = { id: session.id, provider: session.provider, runtime: session.runtime, distro: session.distro || '',
      label: session.label, status: session.status, updatedAt: new Date().toISOString(), tokens: telemetry.tokens, context: telemetry.context };
    if (telemetry.limits?.length) store.limits[key] = { windows: telemetry.limits, checkedAt: new Date().toISOString(), error: null };
  });
}

export function usageSnapshot(root, cfg, now = Date.now()) {
  const store = read(root), sessions = Object.values(store.sessions);
  const known = sessions.filter(session => session.tokens?.totalTokens !== null && session.tokens?.totalTokens !== undefined);
  const providers = ['claude', 'codex'].map(provider => {
    const env = cliEnvironment(cfg, provider, root), key = environmentKey(provider, env);
    const own = sessions.filter(session => environmentKey(session.provider, session) === key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const limits = store.limits[key];
    const measured = own.filter(session => session.tokens?.totalTokens !== null && session.tokens?.totalTokens !== undefined);
    return { provider, ...env, latest: own[0] || null, tokens: measured.length ? measured.reduce((sum, session) => sum + session.tokens.totalTokens, 0) : null,
      limits: limits ? { ...limits, windows: limits.windows.map(window => ({ ...window,
        expired: !!window.resetsAt && Date.parse(window.resetsAt) <= now })) } : null };
  });
  return { totalTokens: known.length ? known.reduce((sum, session) => sum + session.tokens.totalTokens, 0) : null,
    measuredSessions: known.length, unknownSessions: sessions.length - known.length, providers,
    recent: sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 20) };
}

export async function refreshUsageLimits(root, cfg, query = queryCodexRpc) {
  const env = cliEnvironment(cfg, 'codex', root);
  let windows = [], error = null;
  try {
    const result = await query(resolveCliFor(cfg, 'codex', root), { cwd: root, method: 'account/rateLimits/read', timeoutSec: 15 });
    windows = normalizeCodexLimits(result);
    if (!windows.length) error = 'CLI 未提供訂閱額度資料';
  } catch { error = '無法查詢 Codex 額度：請確認 CLI 已安裝、登入且版本支援 app-server'; }
  change(root, store => { store.limits[environmentKey('codex', env)] = { windows, error, checkedAt: new Date().toISOString() }; });
  return usageSnapshot(root, cfg);
}

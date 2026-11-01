import os from 'node:os';
import { loadConfig } from './config.js';
import { probeProvider } from './capabilities.js';
import { cliEnvironment, projectEnvironment } from './runtime.js';

export async function doctorReport(root, { probe = probeProvider } = {}) {
  const cfg = loadConfig(root, { required: false });
  const project = projectEnvironment(root);
  const environments = process.platform === 'win32' ? ['windows', 'wsl'] : ['wsl'];
  const settled = await Promise.allSettled(environments.flatMap(runtime => ['claude', 'codex'].map(async provider => {
    const checkCfg = { ...cfg, runtime: { ...cfg.runtime, [provider]: runtime }, wsl_distro: project.distro || cfg.wsl_distro };
    return { ...await probe(os.tmpdir(), checkCfg, provider), provider, runtime };
  })));
  const inventory = settled.map((entry, i) => entry.status === 'fulfilled' ? entry.value : {
    provider: ['claude', 'codex'][i % 2], runtime: environments[Math.floor(i / 2)], available: false, error: entry.reason.message,
  });
  const active = ['claude', 'codex'].map(provider => inventory.find(item =>
    item.provider === provider && item.runtime === cliEnvironment(cfg, provider, root).runtime));
  const available = active.filter(item => item?.available);
  const lines = [`專案環境：${project.runtime}${project.distro ? `（${project.distro}）` : ''}`];
  for (const item of inventory) {
    lines.push(`${item.available ? '✔' : '○'} ${item.runtime} / ${item.provider}：${item.available ? `${item.version || ''}，已登入` : `${item.installed ? '已安裝但未就緒' : '未安裝或無法啟動'}；${item.error}`}`);
  }
  for (const provider of ['claude', 'codex']) {
    const target = cliEnvironment(cfg, provider, root);
    lines.push(`專案 ${provider} → ${target.runtime}${target.distro ? `（${target.distro}）` : ''}`);
    if (target.runtime !== project.runtime) lines.push(`  手動設定覆蓋專案位置：可在設定頁將 ${provider} 改為「自動（依專案位置）」`);
  }
  const bad = available.length ? 0 : 1;
  lines.push(available.length === 2 ? '雙 AI 可用' : available.length === 1
    ? `單 AI 模式：${available[0].provider}；實作與審查使用獨立 session`
    : '目前專案環境沒有可用的 AI，請先安裝並登入至少一個 CLI');
  return { lines, bad, inventory, available: available.map(item => item.provider) };
}

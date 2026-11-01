import fs from 'node:fs';
import path from 'node:path';
import { configPath, defaultConfig, saveConfig } from './config.js';
import { ensureGitignoreEntry, initRepo, isGitRepo } from './git.js';
import { ensureDirs } from './state.js';

/** 依專案內容猜 build/test/lint 指令；猜不到就留空讓使用者自己填。 */
export function detectCommands(root) {
  const cmds = { build: '', test: '', lint: '' };
  const pkgFile = path.join(root, 'package.json');
  if (fs.existsSync(pkgFile)) {
    const scripts = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).scripts || {};
    const runner = fs.existsSync(path.join(root, 'pnpm-lock.yaml'))
      ? 'pnpm'
      : fs.existsSync(path.join(root, 'yarn.lock'))
        ? 'yarn'
        : 'npm';
    for (const k of ['build', 'test', 'lint']) {
      if (scripts[k]) cmds[k] = k === 'test' && runner === 'npm' ? 'npm test' : `${runner} run ${k}`;
    }
    return cmds;
  }
  if (fs.existsSync(path.join(root, 'Cargo.toml'))) return { build: 'cargo build', test: 'cargo test', lint: 'cargo clippy' };
  if (fs.existsSync(path.join(root, 'go.mod'))) return { build: 'go build ./...', test: 'go test ./...', lint: 'go vet ./...' };
  if (fs.existsSync(path.join(root, 'pyproject.toml'))) return { build: '', test: 'pytest', lint: '' };
  return cmds;
}

const CONTEXT_TEMPLATE = `# AI Context

給每個新 AI 對話讀的專案說明。請保持精簡、即時。

## 專案目的

## 技術棧與架構

## 重要慣例（命名、資料夾、測試方式）

## 不要做的事
`;

const INDEX_TEMPLATE = `# 專案索引

列出主要目錄與檔案的用途，讓 AI 快速找到要改的地方。

| 路徑 | 用途 |
| --- | --- |
`;

export function initProject(root, options = {}) {
  if (fs.existsSync(configPath(root)) && !options.force) {
    throw new Error('.aipipe.json 已存在；要覆蓋請加 --force');
  }
  let gitInitialized = false;
  if (!isGitRepo(root)) {
    if (!options.gitInit) throw new Error('目標目錄不是 git repo；加 --git-init 讓 aipipe 幫你 git init，或自己先 git init');
    initRepo(root);
    gitInitialized = true;
  }
  const cfg = defaultConfig();
  cfg.commands = detectCommands(root);
  if (options.mode) cfg.mode = options.mode;
  for (const role of ['author', 'reviewer', 'implementer', 'code_reviewer']) {
    if (options[role]) cfg.roles[role] = options[role];
  }
  if (options.feature) cfg.feature = options.feature;
  saveConfig(root, cfg);

  ensureDirs(root);
  ensureGitignoreEntry(root, '.aipipe/');
  const created = [];
  const stubs = [
    [cfg.context_files[0], CONTEXT_TEMPLATE],
    [cfg.context_files[1], INDEX_TEMPLATE],
  ];
  for (const [rel, text] of stubs) {
    const file = path.join(root, rel);
    if (rel && !fs.existsSync(file)) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
      created.push(rel);
    }
  }
  fs.mkdirSync(path.join(root, path.dirname(cfg.handover_path)), { recursive: true });
  return { cfg, created, gitInitialized };
}

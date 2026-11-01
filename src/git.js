import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { aipipeDir } from './state.js';

function git(root, args, extraEnv = {}) {
  const res = spawnSync('git', ['-c', 'core.quotePath=false', ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (res.error) throw res.error;
  return { code: res.status, out: (res.stdout || '').trim(), err: (res.stderr || '').trim(), raw: res.stdout || '' };
}

function gitOk(root, args, extraEnv) {
  const r = git(root, args, extraEnv);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} 失敗：${r.err || r.out}`);
  return r.out;
}

/** git add -A，但永遠不把 .aipipe/ 放進 index（不論使用者有沒有把它加進 .gitignore）。 */
function stageAll(root, env) {
  gitOk(root, ['add', '-A'], env);
  gitOk(root, ['rm', '-r', '-q', '-f', '--cached', '--ignore-unmatch', '--', '.aipipe'], env);
}

export function hasIdentity(root) {
  return git(root, ['config', 'user.email']).out !== '' && git(root, ['config', 'user.name']).out !== '';
}

export function isGitRepo(root) {
  return git(root, ['rev-parse', '--is-inside-work-tree']).out === 'true';
}

/** 在 root 建立空的 git repo（不做初始 commit，snapshotTree 能處理沒有 HEAD 的情況）。 */
export function initRepo(root) {
  gitOk(root, ['init', '-q']);
}

export function currentBranch(root) {
  const r = git(root, ['symbolic-ref', '--short', '-q', 'HEAD']);
  return r.code === 0 ? r.out : null;
}

export function headSha(root) {
  const r = git(root, ['rev-parse', '--verify', '-q', 'HEAD']);
  return r.code === 0 ? r.out : null;
}

/**
 * 用暫存 index 把目前工作目錄（含未追蹤、排除 .gitignore）存成 tree 物件，不動使用者的 index 或檔案。
 * 任務開始與結束各取一次，就能得到「這個任務造成的 diff」，自動與手動模式都適用。
 */
export function snapshotTree(root) {
  const index = aipipeDir(root, 'tmp', `snapshot-${process.pid}.index`);
  try {
    fs.rmSync(index, { force: true });
    const env = { GIT_INDEX_FILE: index };
    if (headSha(root)) gitOk(root, ['read-tree', 'HEAD'], env);
    stageAll(root, env);
    return gitOk(root, ['write-tree'], env);
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// 任務 diff 與還原都不含 Task Master 的狀態檔：那是流程本身改的，不是任務的程式碼變更。
const TASK_PATHSPEC = ['--', '.', ':(exclude).taskmaster'];

export function diffTrees(root, fromTree, toTree) {
  const r = git(root, ['diff', '--no-color', '--stat', '--patch', fromTree, toTree, ...TASK_PATHSPEC]);
  return r.raw;
}

export function hasChanges(root) {
  return git(root, ['status', '--porcelain']).out.length > 0;
}

/** 自動模式：切到 aipipe/<feature> 分支（不存在就從目前 HEAD 建立），絕不在 main/master 上 commit。 */
export function ensureFeatureBranch(root, branch) {
  const cur = currentBranch(root);
  if (cur === branch) return branch;
  const exists = git(root, ['rev-parse', '--verify', '-q', `refs/heads/${branch}`]).code === 0;
  gitOk(root, exists ? ['switch', branch] : ['switch', '-c', branch]);
  return branch;
}

export function commitAll(root, message) {
  stageAll(root);
  if (git(root, ['diff', '--cached', '--quiet']).code === 0) return null;
  gitOk(root, ['commit', '-m', message]);
  return headSha(root);
}

/**
 * git revert 任務的 commit。Task Master 的 tasks.json 代表目前的任務狀態，不跟著歷史倒回：
 * revert 前先存下內容並還原成 HEAD 版本，revert 後再寫回並補一個 commit。
 */
export function revertCommit(root, sha) {
  const rel = '.taskmaster/tasks/tasks.json';
  const file = `${root}/${rel}`;
  const saved = fs.existsSync(file) ? fs.readFileSync(file) : null;
  const tracked = git(root, ['ls-files', '--error-unmatch', rel]).code === 0;
  if (saved && tracked) gitOk(root, ['checkout', 'HEAD', '--', rel]);
  try {
    gitOk(root, ['revert', '--no-edit', sha]);
  } finally {
    if (saved) fs.writeFileSync(file, saved);
  }
  return headSha(root);
}

export function ensureGitignoreEntry(root, entry) {
  const file = `${root}/.gitignore`;
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(entry) || lines.includes(entry.replace(/\/$/, ''))) return false;
  fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + entry + '\n');
  return true;
}

/** 把「baseTree 之後新增或修改」的檔案還原：新增的刪掉，修改／刪除的從 baseTree 取回。 */
export function restoreToTree(root, baseTree) {
  const now = snapshotTree(root);
  const rows = git(root, ['diff', '--name-status', '--no-renames', baseTree, now, ...TASK_PATHSPEC]).out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [status, ...rest] = l.split('\t');
      return { status: status[0], file: rest.join('\t') };
    });
  for (const r of rows) {
    if (r.status === 'A') fs.rmSync(`${root}/${r.file}`, { force: true });
  }
  const files = rows.filter((r) => r.status !== 'A').map((r) => r.file);
  if (files.length) gitOk(root, ['restore', `--source=${baseTree}`, '--worktree', '--', ...files]);
  return rows.length;
}

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.js';
import { aipipeDir, readState, readText, updateState } from './state.js';
import { readTasks, currentTag } from './taskmaster.js';

/*
 * 功能封存：每個功能一個資料夾 <archive_dir>/<日期>-<功能>/（預設 docs/prd/），可以 commit。
 *   prd.md            核准的 PRD
 *   rounds/NN-*.md    每一輪的初稿、審查、修訂、使用者意見
 *   tasks.json        最後的任務清單（Task Master 格式，含狀態）
 *   meta.json         功能名稱、想法、核准時間、Task Master tag、待辦項目 id
 * 資料夾名稱不會重複；同一個功能重新核准時更新同一個資料夾，開始下一個功能時一定建新的。
 */

const KIND_FILE = { draft: 'draft', review: 'review', revise: 'revise', user_feedback: 'user-feedback' };

export function featureSlug(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '') || 'feature';
}

/** Task Master tag 用的 ASCII slug（tag 名稱不接受中文）；全是中文時回傳 feature。 */
export function tagSlug(text) {
  return featureSlug(text).normalize('NFKD').replace(/[^a-z0-9-]+/g, '').replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'feature';
}

function archiveRoot(root, cfg) {
  return path.join(root, cfg.archive_dir);
}

function uniqueDir(base, name) {
  let dir = path.join(base, name);
  for (let i = 2; fs.existsSync(dir); i++) dir = path.join(base, `${name}-${i}`);
  return dir;
}

/** 核准 PRD 時呼叫：建立（或更新）這個功能的封存資料夾，回傳相對於專案的路徑。 */
export function archivePrd(root, cfg = loadConfig(root)) {
  const state = readState(root);
  const base = archiveRoot(root, cfg);
  let dir = state.prd.archive_dir ? path.join(root, state.prd.archive_dir) : null;
  if (!dir) {
    const date = new Date().toISOString().slice(0, 10);
    dir = uniqueDir(base, `${date}-${featureSlug(cfg.feature || state.prd.idea)}`);
  }
  fs.mkdirSync(path.join(dir, 'rounds'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'prd.md'), readText(aipipeDir(root, 'prd', 'current.md')));
  for (const f of fs.readdirSync(path.join(dir, 'rounds'))) fs.rmSync(path.join(dir, 'rounds', f));
  state.prd.rounds.forEach((r, i) => {
    if (!r.file) return;
    const name = [String(i + 1).padStart(2, '0'), KIND_FILE[r.kind] || r.kind, `r${r.round}`, r.verdict && r.verdict.toLowerCase(), r.version && `v${r.version}`]
      .filter(Boolean)
      .join('-');
    fs.writeFileSync(path.join(dir, 'rounds', `${name}.md`), readText(aipipeDir(root, 'prd', r.file)));
  });
  const rel = path.relative(root, dir).split(path.sep).join('/');
  writeMeta(dir, {
    feature: cfg.feature || '',
    idea: state.prd.idea || '',
    approved_at: new Date().toISOString(),
    rounds: state.prd.rounds.map(({ kind, round, provider, verdict, version, at }) => ({ kind, round, provider, verdict, version, at })),
    backlog_id: state.prd.backlog_id || null,
  });
  updateState(root, (s) => {
    s.prd.archive_dir = rel;
  });
  return rel;
}

function writeMeta(dir, patch) {
  const file = path.join(dir, 'meta.json');
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // 新的封存
  }
  fs.writeFileSync(file, JSON.stringify({ ...meta, ...patch, updated_at: new Date().toISOString() }, null, 2) + '\n');
}

/** 把目前的任務清單（含狀態）寫進這個功能的封存；還沒有封存（PRD 未核准）時不做事。 */
export function archiveTasks(root, extra = {}) {
  const state = readState(root);
  if (!state.prd.archive_dir) return null;
  const dir = path.join(root, state.prd.archive_dir);
  if (!fs.existsSync(dir)) return null;
  const tasks = readTasks(root);
  if (tasks.length) fs.writeFileSync(path.join(dir, 'tasks.json'), JSON.stringify({ tag: currentTag(root), tasks }, null, 2) + '\n');
  writeMeta(dir, {
    tm_tag: state.task_gen?.tag || currentTag(root),
    pipeline_status: state.pipeline.status,
    progress: { done: tasks.filter((t) => t.status === 'done').length, total: tasks.length },
    ...extra,
  });
  return state.prd.archive_dir;
}

const SAFE_NAME = /^[^\\/:*?"<>|]+$/;

export function listArchives(root, cfg = loadConfig(root)) {
  const base = archiveRoot(root, cfg);
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(base, d.name, 'prd.md')))
    .map((d) => {
      let meta = {};
      try {
        meta = JSON.parse(fs.readFileSync(path.join(base, d.name, 'meta.json'), 'utf8'));
      } catch {
        // 手動放進來、沒有 meta 的封存
      }
      return { name: d.name, ...meta };
    })
    .sort((a, b) => b.name.localeCompare(a.name));
}

export function readArchive(root, name, cfg = loadConfig(root)) {
  if (!SAFE_NAME.test(name) || name === '.' || name === '..') throw Object.assign(new Error('封存名稱不正確'), { status: 400 });
  const dir = path.join(archiveRoot(root, cfg), name);
  if (!fs.existsSync(path.join(dir, 'prd.md'))) throw Object.assign(new Error('找不到這個封存'), { status: 404 });
  const roundsDir = path.join(dir, 'rounds');
  const rounds = fs.existsSync(roundsDir)
    ? fs.readdirSync(roundsDir).sort().map((f) => ({ name: f, text: readText(path.join(roundsDir, f)) }))
    : [];
  let tasks = [];
  try {
    tasks = JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks || [];
  } catch {
    // 還沒產生任務
  }
  let meta = {};
  try {
    meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
  } catch {
    // 沒有 meta
  }
  return { name, path: path.relative(root, dir).split(path.sep).join('/'), meta, prd: readText(path.join(dir, 'prd.md')), rounds, tasks };
}

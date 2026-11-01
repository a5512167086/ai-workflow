import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parse } from 'yaml';
import { BUILTIN_SKILLS } from './builtin-skills.js';
import { writeJson } from './home.js';

export const SKILL_STAGES = ['prd', 'prd_review', 'tasks', 'implement', 'code_review', 'fix', 'handover'];
const validName = name => typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
const library = root => path.join(root, '.aipipe', 'skills');

export function parseSkill(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 100000) throw new Error('SKILL.md 必須小於 100 KB');
  const match = text.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)$/);
  if (!match) throw new Error('SKILL.md 需要 YAML frontmatter 與指令本文');
  const meta = parse(match[1], { maxAliasCount: 20 });
  if (!validName(meta?.name) || typeof meta.description !== 'string' || !meta.description.trim() || !match[2].trim()) throw new Error('Skill 需要合法 name、description 與指令');
  const extensions = Object.keys(meta).filter(key => !['name', 'description', 'metadata', 'license', 'compatibility'].includes(key));
  return { name: meta.name, description: meta.description, body: match[2].trim(), text, extensions };
}

export function listSkills(root) {
  const skills = new Map(Object.entries(BUILTIN_SKILLS).map(([name, text]) => [name, { ...parseSkill(text), builtin: true }]));
  if (fs.existsSync(library(root))) for (const entry of fs.readdirSync(library(root), { withFileTypes: true })) {
    if (!entry.isDirectory() || !validName(entry.name)) continue;
    try { skills.set(entry.name, loadSkill(root, entry.name)); }
    catch (error) { skills.set(entry.name, { name: entry.name, error: error.message }); }
  }
  return [...skills.values()].map(skill => ({ ...skill, compatible: !skill.error && !skill.extensions?.length }));
}

export function loadSkill(root, name) {
  if (!validName(name)) throw new Error('Skill 名稱不正確');
  const dir = path.join(library(root), name);
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file)) {
    if (fs.lstatSync(dir).isSymbolicLink() || fs.lstatSync(file).isSymbolicLink()) throw new Error('Skill 不支援符號連結');
    const skill = parseSkill(fs.readFileSync(file, 'utf8'));
    if (skill.name !== name) throw new Error('Skill 目錄與 name 不一致');
    return { ...skill, dir, builtin: false };
  }
  if (!BUILTIN_SKILLS[name]) throw new Error(`找不到 Skill：${name}`);
  return { ...parseSkill(BUILTIN_SKILLS[name]), builtin: true };
}

function bundle(dir) {
  const files = [];
  let bytes = 0;
  function walk(current, rel = '') {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) throw new Error('Skill 不支援符號連結');
      const full = path.join(current, entry.name), file = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(full, file);
      else if (entry.isFile()) {
        const stat = fs.statSync(full);
        bytes += stat.size;
        if (files.length >= 500 || bytes > 10e6) throw new Error('Skill 最多 500 個檔案、10 MB');
        files.push({ rel: file, data: fs.readFileSync(full) });
      } else throw new Error('Skill 只支援一般檔案');
    }
  }
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Skill 不支援符號連結');
  walk(dir);
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

export function saveSkill(root, text, expectedName) {
  const skill = parseSkill(text);
  if (expectedName && expectedName !== skill.name) throw new Error('編輯時不能更改 Skill name，請另建技能');
  const dir = path.join(library(root), skill.name);
  fs.mkdirSync(dir, { recursive: true });
  if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Skill 不支援符號連結');
  const file = path.join(dir, 'SKILL.md');
  if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw new Error('Skill 不支援符號連結');
  fs.writeFileSync(file, text);
  return loadSkill(root, skill.name);
}

export function importSkill(root, source) {
  if (typeof source !== 'string' || !source.trim()) throw new Error('請指定包含 SKILL.md 的資料夾');
  const dir = path.resolve(source);
  const files = bundle(dir);
  const manifest = files.find(file => file.rel === 'SKILL.md');
  if (!manifest) throw new Error('請選擇包含 SKILL.md 的資料夾');
  const skill = parseSkill(manifest.data.toString('utf8'));
  const destination = path.join(library(root), skill.name);
  if (fs.existsSync(destination)) throw new Error('同名 Skill 已存在，請使用編輯功能');
  for (const file of files) {
    const target = path.join(destination, file.rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.data);
  }
  return loadSkill(root, skill.name);
}

/** Same portable instructions for both CLIs; scripts, hooks and tool permissions are not auto-executed. */
export function prepareSkills(root, cfg, stage, names, toPath = value => value) {
  const selected = [...new Set(names ?? cfg.skills?.[stage] ?? [])];
  const snapshots = [];
  const blocks = selected.map(name => {
    const skill = loadSkill(root, name);
    if (skill.extensions.length) throw new Error(`${name} 含執行器專屬欄位（${skill.extensions.join(', ')}），請先轉為共用 Skill`);
    const files = skill.dir ? bundle(skill.dir) : [{ rel: 'SKILL.md', data: Buffer.from(skill.text) }];
    const hash = createHash('sha256');
    for (const file of files) hash.update(file.rel.replaceAll('\\', '/')).update('\0').update(file.data).update('\0');
    const version = hash.digest('hex');
    const snapshot = path.join(root, '.aipipe', 'tmp', 'skills', version, name);
    for (const file of files) {
      const target = path.join(snapshot, file.rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, file.data);
    }
    snapshots.push({ name, version, path: toPath(snapshot) });
    return `### Skill: ${name}\n資源目錄：${toPath(snapshot)}\n相對檔案路徑以此目錄為基準，按需讀取；不要自動執行 scripts。\n${skill.body}`;
  });
  return { snapshots, text: blocks.length ? `## 本次選用的共用 Skills\n依下列方法完成當前工作，保留任務指定的範圍與輸出格式。\n${blocks.join('\n\n')}` : '' };
}

const runsDir = root => path.join(root, '.aipipe', 'skill-runs');
export function skillRunFile(root, id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Skill session id 不正確');
  return path.join(runsDir(root), `${id}.json`);
}
export function listSkillRuns(root) {
  if (!fs.existsSync(runsDir(root))) return [];
  return fs.readdirSync(runsDir(root)).filter(name => /^[0-9a-f-]{36}\.json$/.test(name)).map(name =>
    JSON.parse(fs.readFileSync(path.join(runsDir(root), name), 'utf8'))).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}
export function newSkillRun(root, name, input, previousId) {
  loadSkill(root, name);
  let previous;
  if (previousId) {
    previous = JSON.parse(fs.readFileSync(skillRunFile(root, previousId), 'utf8'));
    if (previous.name !== name) throw new Error('Skill 與交接對話不一致');
    if (previous.status !== 'done') throw new Error('只能接續已完成的回覆');
  }
  const run = { id: randomUUID(), name, previousId: previousId || null, status: 'running', updated_at: new Date().toISOString(),
    messages: [...(previous?.messages || []), { role: 'user', text: input }] };
  if (JSON.stringify(run.messages).length > 120000) throw new Error('釐清紀錄過長，請整理需求後建立新會議');
  writeJson(skillRunFile(root, run.id), run);
  return run;
}

export function saveSkillRun(root, run) {
  run.updated_at = new Date().toISOString();
  writeJson(skillRunFile(root, run.id), run);
}

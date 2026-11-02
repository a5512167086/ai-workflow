//! 共用 Skills。技能庫在專案資料目錄的 skills/；兩個 CLI 拿到相同的可攜指令；scripts、hooks、工具權限都不會自動執行。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use yaml_rust2::{Yaml, YamlLoader};

use super::builtin_skills::{builtin, BUILTIN_SKILLS};
use super::util::{now_iso, valid_skill_name, write_json};
use super::Result;

pub use super::config::SKILL_STAGES;

fn library(root: &Path) -> PathBuf {
    super::state::data_dir(root).join("skills")
}

#[derive(Clone, Debug)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub body: String,
    pub text: String,
    pub extensions: Vec<String>,
    pub builtin: bool,
    pub dir: Option<PathBuf>,
}

impl Skill {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "name": self.name, "description": self.description, "body": self.body, "text": self.text,
            "extensions": self.extensions, "builtin": self.builtin,
            // 名稱是內建技能時，技能庫裡的副本可以「還原內建」；不是內建的才會真的刪除。
            "hasBuiltin": builtin(&self.name).is_some(),
            "files": self.dir.as_ref().map(|dir| list_files(dir)).unwrap_or_else(|| vec![json!({ "path": "SKILL.md", "bytes": self.text.len() })]),
        });
        if let Some(dir) = &self.dir {
            v["dir"] = json!(dir.to_string_lossy());
        }
        v
    }
}

/// 技能資料夾裡的資源檔清單（相對路徑一律用 /），給 UI 顯示；只讀目錄，不讀內容。
fn list_files(dir: &Path) -> Vec<Value> {
    fn walk(current: &Path, rel: &Path, out: &mut Vec<Value>) {
        let Ok(entries) = fs::read_dir(current) else { return };
        let mut entries: Vec<_> = entries.filter_map(|e| e.ok()).collect();
        entries.sort_by_key(|e| e.file_name());
        for entry in entries {
            if out.len() >= 500 {
                return;
            }
            let file = rel.join(entry.file_name());
            match entry.file_type() {
                Ok(ty) if ty.is_dir() => walk(&entry.path(), &file, out),
                Ok(ty) if ty.is_file() => out.push(json!({ "path": file.to_string_lossy().replace('\\', "/"), "bytes": entry.metadata().map(|m| m.len()).unwrap_or(0) })),
                _ => {}
            }
        }
    }
    let mut out = Vec::new();
    walk(dir, Path::new(""), &mut out);
    out
}

pub fn parse_skill(text: &str) -> Result<Skill> {
    if text.len() > 100_000 {
        crate::bail!("SKILL.md 必須小於 100 KB");
    }
    let t = text.trim_start_matches('\u{feff}');
    // ^---\r?\n(frontmatter)\r?\n---\r?\n(body)$
    let rest = t.strip_prefix("---\r\n").or_else(|| t.strip_prefix("---\n"));
    let parsed = rest.and_then(|rest| {
        let mut search = 0;
        while let Some(pos) = rest[search..].find("\n---") {
            let at = search + pos;
            let after = &rest[at + 4..];
            let body = after.strip_prefix("\r\n").or_else(|| after.strip_prefix('\n'));
            if let Some(body) = body.filter(|b| !b.is_empty()) {
                let front = rest[..at].strip_suffix('\r').unwrap_or(&rest[..at]);
                return Some((front, body));
            }
            search = at + 1;
        }
        None
    });
    let Some((front, body)) = parsed else { crate::bail!("SKILL.md 需要 YAML frontmatter 與指令本文") };
    let docs = YamlLoader::load_from_str(front).map_err(|e| super::AppError::new(format!("SKILL.md 的 YAML 格式錯誤：{e}")))?;
    let meta = docs.into_iter().next().unwrap_or(Yaml::Null);
    let get = |k: &str| match &meta {
        Yaml::Hash(h) => h.get(&Yaml::String(k.into())).and_then(Yaml::as_str).map(String::from),
        _ => None,
    };
    let name = get("name").unwrap_or_default();
    let description = get("description").unwrap_or_default();
    if !valid_skill_name(&name) || description.trim().is_empty() || body.trim().is_empty() {
        crate::bail!("Skill 需要合法 name、description 與指令");
    }
    let extensions = match &meta {
        Yaml::Hash(h) => h.keys().filter_map(Yaml::as_str).filter(|k| !["name", "description", "metadata", "license", "compatibility"].contains(k)).map(String::from).collect(),
        _ => vec![],
    };
    Ok(Skill { name, description, body: body.trim().to_string(), text: text.to_string(), extensions, builtin: false, dir: None })
}

fn is_symlink(p: &Path) -> bool {
    fs::symlink_metadata(p).map(|m| m.file_type().is_symlink()).unwrap_or(false)
}

pub fn load_skill(root: &Path, name: &str) -> Result<Skill> {
    if !valid_skill_name(name) {
        crate::bail!("Skill 名稱不正確");
    }
    let dir = library(root).join(name);
    let file = dir.join("SKILL.md");
    if file.exists() {
        if is_symlink(&dir) || is_symlink(&file) {
            crate::bail!("Skill 不支援符號連結");
        }
        let mut skill = parse_skill(&fs::read_to_string(&file)?)?;
        if skill.name != name {
            crate::bail!("Skill 目錄與 name 不一致");
        }
        skill.dir = Some(dir);
        return Ok(skill);
    }
    let Some(text) = builtin(name) else { crate::bail!("找不到 Skill：{name}") };
    let mut skill = parse_skill(text)?;
    skill.builtin = true;
    Ok(skill)
}

pub fn list_skills(root: &Path) -> Vec<Value> {
    let mut skills: Vec<(String, Value)> = BUILTIN_SKILLS.iter().map(|(name, text)| {
        let mut s = parse_skill(text).expect("內建 Skill 格式錯誤");
        s.builtin = true;
        (name.to_string(), s.to_json())
    }).collect();
    if let Ok(entries) = fs::read_dir(library(root)) {
        let mut names: Vec<String> = entries.filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| valid_skill_name(n))
            .collect();
        names.sort();
        for name in names {
            let value = match load_skill(root, &name) {
                Ok(s) => s.to_json(),
                Err(err) => json!({ "name": name, "error": err.message }),
            };
            match skills.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = value,
                None => skills.push((name, value)),
            }
        }
    }
    skills.into_iter().map(|(_, mut s)| {
        let compatible = s.get("error").is_none() && s["extensions"].as_array().is_none_or(|e| e.is_empty());
        s["compatible"] = json!(compatible);
        s
    }).collect()
}

pub struct BundleFile {
    pub rel: String,
    pub data: Vec<u8>,
}

fn bundle(dir: &Path) -> Result<Vec<BundleFile>> {
    fn walk(current: &Path, rel: &Path, files: &mut Vec<BundleFile>, bytes: &mut u64) -> Result<()> {
        for entry in fs::read_dir(current)? {
            let entry = entry?;
            let ty = entry.file_type()?;
            if ty.is_symlink() {
                crate::bail!("Skill 不支援符號連結");
            }
            let full = entry.path();
            let file = rel.join(entry.file_name());
            if ty.is_dir() {
                walk(&full, &file, files, bytes)?;
            } else if ty.is_file() {
                *bytes += entry.metadata()?.len();
                if files.len() >= 500 || *bytes > 10_000_000 {
                    crate::bail!("Skill 最多 500 個檔案、10 MB");
                }
                files.push(BundleFile { rel: file.to_string_lossy().into_owned(), data: fs::read(&full)? });
            } else {
                crate::bail!("Skill 只支援一般檔案");
            }
        }
        Ok(())
    }
    if is_symlink(dir) {
        crate::bail!("Skill 不支援符號連結");
    }
    let mut files = Vec::new();
    walk(dir, Path::new(""), &mut files, &mut 0)?;
    files.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(files)
}

pub fn save_skill(root: &Path, text: &str, expected_name: Option<&str>) -> Result<Skill> {
    let skill = parse_skill(text)?;
    if expected_name.is_some_and(|n| !n.is_empty() && n != skill.name) {
        crate::bail!("編輯時不能更改 Skill name，請另建技能");
    }
    let dir = library(root).join(&skill.name);
    fs::create_dir_all(&dir)?;
    let file = dir.join("SKILL.md");
    if is_symlink(&dir) || is_symlink(&file) {
        crate::bail!("Skill 不支援符號連結");
    }
    fs::write(&file, text)?;
    load_skill(root, &skill.name)
}

pub fn import_skill(root: &Path, source: &str) -> Result<Skill> {
    if source.trim().is_empty() {
        crate::bail!("請指定包含 SKILL.md 的資料夾");
    }
    let dir = super::util::resolve(source.trim());
    if !dir.is_dir() {
        crate::bail!("找不到資料夾：{}", dir.display());
    }
    let mut files = bundle(&dir)?;
    // 像 Claude Code 的 .claude/skills/<name>/ 一樣以 SKILL.md 為主檔；檔名不分大小寫（skill.md 也接受），匯入後統一存成 SKILL.md。
    let Some(manifest) = files.iter_mut().find(|f| f.rel.eq_ignore_ascii_case("SKILL.md")) else { crate::bail!("請選擇包含 SKILL.md 的資料夾") };
    manifest.rel = "SKILL.md".into();
    let skill = parse_skill(&String::from_utf8_lossy(&manifest.data))?;
    let destination = library(root).join(&skill.name);
    if destination.exists() {
        crate::bail!("同名 Skill 已存在，請使用編輯功能");
    }
    for file in &files {
        let target = destination.join(&file.rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::write(target, &file.data)?;
    }
    load_skill(root, &skill.name)
}

/// 刪除技能庫裡的技能資料夾。內建技能沒有資料夾時不能刪；有副本（編輯過）時刪掉副本就是「還原內建」。
pub fn delete_skill(root: &Path, name: &str) -> Result<Value> {
    let skill = load_skill(root, name)?;
    let Some(dir) = skill.dir else { crate::bail!("內建技能不能刪除") };
    if is_symlink(&dir) {
        crate::bail!("Skill 不支援符號連結");
    }
    fs::remove_dir_all(&dir)?;
    Ok(json!({ "name": name, "restored": builtin(name).is_some() }))
}

#[derive(Debug)]
pub struct PreparedSkills {
    pub snapshots: Vec<Value>,
    pub text: String,
}

/// 依階段（或明確指定的 names）把 Skill 複製成不可變的版本快照，並產生附加在 prompt 後的說明。
/// to_path 把 Windows 路徑轉成 CLI 看得到的路徑（WSL 時是 /mnt/...）。
pub fn prepare_skills(root: &Path, cfg: &Value, stage: Option<&str>, names: Option<&[String]>, to_path: &dyn Fn(&Path) -> String) -> Result<PreparedSkills> {
    let wanted: Vec<String> = match names {
        Some(n) => n.to_vec(),
        None => stage.and_then(|s| cfg["skills"][s].as_array()).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default(),
    };
    let mut selected: Vec<String> = Vec::new();
    for n in wanted {
        if !selected.contains(&n) {
            selected.push(n);
        }
    }
    let mut snapshots = Vec::new();
    let mut blocks = Vec::new();
    for name in &selected {
        let skill = load_skill(root, name)?;
        if !skill.extensions.is_empty() {
            crate::bail!("{name} 含執行器專屬欄位（{}），請先轉為共用 Skill", skill.extensions.join(", "));
        }
        let files = match &skill.dir {
            Some(dir) => bundle(dir)?,
            None => vec![BundleFile { rel: "SKILL.md".into(), data: skill.text.clone().into_bytes() }],
        };
        let mut hash = Sha256::new();
        for file in &files {
            hash.update(file.rel.replace('\\', "/").as_bytes());
            hash.update([0]);
            hash.update(&file.data);
            hash.update([0]);
        }
        let version = hex::encode(hash.finalize());
        let snapshot = super::state::data_dir(root).join("tmp").join("skills").join(&version).join(name);
        for file in &files {
            let target = snapshot.join(&file.rel);
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)?;
            }
            fs::write(target, &file.data)?;
        }
        let shown = to_path(&snapshot);
        snapshots.push(json!({ "name": name, "version": version, "path": shown }));
        blocks.push(format!("### Skill: {name}\n資源目錄：{shown}\n相對檔案路徑以此目錄為基準，按需讀取；不要自動執行 scripts。\n{}", skill.body));
    }
    let text = if blocks.is_empty() {
        String::new()
    } else {
        format!("## 本次選用的共用 Skills\n依下列方法完成當前工作，保留任務指定的範圍與輸出格式。\n{}", blocks.join("\n\n"))
    };
    Ok(PreparedSkills { snapshots, text })
}

pub fn native_path(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn runs_dir(root: &Path) -> PathBuf {
    super::state::data_dir(root).join("skill-runs")
}

fn valid_run_id(id: &str) -> bool {
    id.len() == 36 && id.chars().all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c) || c == '-')
}

pub fn skill_run_file(root: &Path, id: &str) -> Result<PathBuf> {
    if !valid_run_id(id) {
        crate::bail!("Skill session id 不正確");
    }
    Ok(runs_dir(root).join(format!("{id}.json")))
}

pub fn list_skill_runs(root: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(runs_dir(root)) else { return vec![] };
    let mut runs: Vec<Value> = entries.filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().strip_suffix(".json").is_some_and(valid_run_id))
        .filter_map(|e| super::util::read_json(e.path()))
        .collect();
    runs.sort_by(|a, b| b["updated_at"].as_str().cmp(&a["updated_at"].as_str()));
    runs
}

pub fn new_skill_run(root: &Path, name: &str, input: &str, previous_id: Option<&str>) -> Result<Value> {
    load_skill(root, name)?;
    let previous = match previous_id.filter(|p| !p.is_empty()) {
        Some(id) => {
            let prev: Value = serde_json::from_str(&fs::read_to_string(skill_run_file(root, id)?)?)?;
            if prev["name"] != name {
                crate::bail!("Skill 與交接對話不一致");
            }
            if prev["status"] != "done" {
                crate::bail!("只能接續已完成的回覆");
            }
            Some(prev)
        }
        None => None,
    };
    let mut messages = previous.as_ref().and_then(|p| p["messages"].as_array().cloned()).unwrap_or_default();
    let now = now_iso();
    // at 給 UI 顯示時間與「AI 正在回覆（已 N 秒）」；舊紀錄沒有這個欄位也照常顯示。
    messages.push(json!({ "role": "user", "text": input, "at": now }));
    let run = json!({
        "id": uuid::Uuid::new_v4().to_string(), "name": name, "previousId": previous_id.filter(|p| !p.is_empty()),
        "status": "running", "created_at": now, "updated_at": now, "messages": messages,
    });
    if run["messages"].to_string().chars().count() > 120_000 {
        crate::bail!("釐清紀錄過長，請整理需求後建立新會議");
    }
    write_json(&skill_run_file(root, run["id"].as_str().unwrap())?, &run)?;
    Ok(run)
}

pub fn save_skill_run(root: &Path, run: &mut Value) -> Result<()> {
    run["updated_at"] = json!(now_iso());
    write_json(&skill_run_file(root, run["id"].as_str().unwrap_or(""))?, run)
}

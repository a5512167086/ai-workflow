//! git 操作（對應 legacy/src/git.js）。每個任務開始與結束各取一次快照 tree，得到「這個任務造成的 diff」。
use std::fs;
use std::path::Path;
use std::process::{Command, Stdio};

use super::proc::{hide_window, to_wsl_path};
use super::runtime::wsl_location;
use super::state::aipipe_dir;
use super::{AppError, Result};

pub struct GitOut {
    pub code: i32,
    pub out: String,
    pub err: String,
    pub raw: String,
}

fn git(root: &Path, args: &[&str], extra_env: &[(&str, String)]) -> Result<GitOut> {
    let location = if cfg!(windows) { wsl_location(root) } else { None };
    let mut git_args = vec!["-c", "core.quotePath=false"];
    git_args.extend_from_slice(args);
    let mut cmd = match &location {
        Some(loc) => {
            let mut c = Command::new("wsl.exe");
            c.args(["-d", &loc.distro, "--cd", &loc.path, "-e", "env"]);
            for (key, value) in extra_env {
                let v = if *key == "GIT_INDEX_FILE" { to_wsl_path(&loc.distro, value)? } else { value.clone() };
                c.arg(format!("{key}={v}"));
            }
            c.arg("git").args(&git_args);
            c
        }
        None => {
            let mut c = Command::new("git");
            c.args(&git_args).current_dir(root);
            for (key, value) in extra_env {
                c.env(key, value);
            }
            c
        }
    };
    cmd.stdin(Stdio::null());
    hide_window(&mut cmd);
    let output = cmd.output().map_err(|e| AppError::new(format!("無法執行 git：{e}")))?;
    let raw = String::from_utf8_lossy(&output.stdout).into_owned();
    let err = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Ok(GitOut { code: output.status.code().unwrap_or(-1), out: raw.trim().to_string(), err, raw })
}

fn git_ok(root: &Path, args: &[&str], extra_env: &[(&str, String)]) -> Result<String> {
    let r = git(root, args, extra_env)?;
    if r.code != 0 {
        crate::bail!("git {} 失敗：{}", args.join(" "), if r.err.is_empty() { &r.out } else { &r.err });
    }
    Ok(r.out)
}

/// git add -A，但永遠不把 .aipipe/ 放進 index（不論使用者有沒有把它加進 .gitignore）。
fn stage_all(root: &Path, env: &[(&str, String)]) -> Result<()> {
    git_ok(root, &["add", "-A"], env)?;
    git_ok(root, &["rm", "-r", "-q", "-f", "--cached", "--ignore-unmatch", "--", ".aipipe"], env)?;
    Ok(())
}

pub fn has_identity(root: &Path) -> Result<bool> {
    Ok(!git(root, &["config", "user.email"], &[])?.out.is_empty() && !git(root, &["config", "user.name"], &[])?.out.is_empty())
}

pub fn is_git_repo(root: &Path) -> Result<bool> {
    let r = git(root, &["rev-parse", "--is-inside-work-tree"], &[])?;
    if r.code != 0 && !format!("{}{}", r.err, r.out).to_lowercase().contains("not a git repository") {
        let detail = if !r.err.is_empty() { r.err } else if !r.out.is_empty() { r.out } else { format!("結束碼 {}", r.code) };
        crate::bail!("無法檢查 Git 專案：{detail}");
    }
    Ok(r.code == 0 && r.out == "true")
}

/// 在 root 建立空的 git repo（不做初始 commit，snapshot_tree 能處理沒有 HEAD 的情況）。
pub fn init_repo(root: &Path) -> Result<()> {
    git_ok(root, &["init", "-q"], &[]).map(|_| ())
}

pub fn current_branch(root: &Path) -> Result<Option<String>> {
    let r = git(root, &["symbolic-ref", "--short", "-q", "HEAD"], &[])?;
    Ok((r.code == 0).then_some(r.out))
}

pub fn head_sha(root: &Path) -> Result<Option<String>> {
    let r = git(root, &["rev-parse", "--verify", "-q", "HEAD"], &[])?;
    Ok((r.code == 0).then_some(r.out))
}

/// 用暫存 index 把目前工作目錄（含未追蹤、排除 .gitignore）存成 tree 物件，不動使用者的 index 或檔案。
pub fn snapshot_tree(root: &Path) -> Result<String> {
    let dir = aipipe_dir(root).join("tmp");
    fs::create_dir_all(&dir)?;
    let index = dir.join(format!("snapshot-{}.index", std::process::id()));
    let _ = fs::remove_file(&index);
    let env = [("GIT_INDEX_FILE", index.to_string_lossy().into_owned())];
    let result = (|| {
        if head_sha(root)?.is_some() {
            git_ok(root, &["read-tree", "HEAD"], &env)?;
        }
        stage_all(root, &env)?;
        git_ok(root, &["write-tree"], &env)
    })();
    let _ = fs::remove_file(&index);
    result
}

// 流程資料不屬於實作變更；保留舊 Task Master 資料以支援歷史版本。
const TASK_PATHSPEC: [&str; 4] = ["--", ".", ":(exclude).aipipe", ":(exclude).taskmaster"];

pub fn diff_trees(root: &Path, from: &str, to: &str) -> Result<String> {
    let mut args = vec!["diff", "--no-color", "--stat", "--patch", from, to];
    args.extend(TASK_PATHSPEC);
    Ok(git(root, &args, &[])?.raw)
}

pub fn has_changes(root: &Path) -> Result<bool> {
    Ok(!git(root, &["status", "--porcelain"], &[])?.out.is_empty())
}

/// 自動模式：切到 aipipe/<feature> 分支（不存在就從目前 HEAD 建立），絕不在 main/master 上 commit。
pub fn ensure_feature_branch(root: &Path, branch: &str) -> Result<String> {
    if current_branch(root)?.as_deref() == Some(branch) {
        return Ok(branch.to_string());
    }
    let reference = format!("refs/heads/{branch}");
    let exists = git(root, &["rev-parse", "--verify", "-q", &reference], &[])?.code == 0;
    if exists {
        git_ok(root, &["switch", branch], &[])?;
    } else {
        git_ok(root, &["switch", "-c", branch], &[])?;
    }
    Ok(branch.to_string())
}

pub fn commit_all(root: &Path, message: &str) -> Result<Option<String>> {
    stage_all(root, &[])?;
    if git(root, &["diff", "--cached", "--quiet"], &[])?.code == 0 {
        return Ok(None);
    }
    git_ok(root, &["commit", "-m", message], &[])?;
    head_sha(root)
}

/// git revert 任務的 commit。keep 裡的檔案（舊 Task Master 的 tasks.json、功能封存的 meta.json／tasks.json）
/// 代表目前的狀態，不跟著歷史倒回：revert 前先存下內容並還原成 HEAD 版本（否則未 commit 的變更會擋住 revert），
/// revert 後再寫回。
pub fn revert_commit(root: &Path, sha: &str, keep: &[String]) -> Result<Option<String>> {
    let mut saved = Vec::new();
    for rel in keep {
        let file = root.join(rel);
        let Ok(data) = fs::read(&file) else { continue };
        if git(root, &["ls-files", "--error-unmatch", rel], &[])?.code == 0 {
            git_ok(root, &["checkout", "HEAD", "--", rel], &[])?;
        }
        saved.push((file, data));
    }
    let result = git_ok(root, &["revert", "--no-edit", sha], &[]);
    for (file, data) in saved {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir)?;
        }
        fs::write(&file, data)?;
    }
    result?;
    head_sha(root)
}

pub fn ensure_gitignore_entry(root: &Path, entry: &str) -> Result<bool> {
    let file = root.join(".gitignore");
    let text = fs::read_to_string(&file).unwrap_or_default();
    let bare = entry.trim_end_matches('/');
    if text.lines().map(str::trim).any(|l| l == entry || l == bare) {
        return Ok(false);
    }
    let sep = if !text.is_empty() && !text.ends_with('\n') { "\n" } else { "" };
    fs::write(&file, format!("{text}{sep}{entry}\n"))?;
    Ok(true)
}

/// 把「base_tree 之後新增或修改」的檔案還原：新增的刪掉，修改／刪除的從 base_tree 取回。
pub fn restore_to_tree(root: &Path, base_tree: &str) -> Result<usize> {
    let now = snapshot_tree(root)?;
    let mut args = vec!["diff", "--name-status", "--no-renames", base_tree, now.as_str()];
    args.extend(TASK_PATHSPEC);
    let out = git(root, &args, &[])?.out;
    let rows: Vec<(char, String)> = out.lines().filter(|l| !l.is_empty()).filter_map(|l| {
        let (status, file) = l.split_once('\t')?;
        Some((status.chars().next()?, file.to_string()))
    }).collect();
    for (status, file) in &rows {
        if *status == 'A' {
            let _ = fs::remove_file(root.join(file));
        }
    }
    let files: Vec<&str> = rows.iter().filter(|(s, _)| *s != 'A').map(|(_, f)| f.as_str()).collect();
    if !files.is_empty() {
        let source = format!("--source={base_tree}");
        let mut restore = vec!["restore", source.as_str(), "--worktree", "--"];
        restore.extend(files);
        git_ok(root, &restore, &[])?;
    }
    Ok(rows.len())
}

//! ai-workflow 子指令。桌面 app 帶參數啟動時走這裡；GUI 也用它在背景啟動獨立的流程程序。
use std::fs;
use std::io::{IsTerminal, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

use super::agents::{run_agent, AgentOpts};
use super::archive::{archive_tasks, tag_slug};
use super::backlog::{get_item, idea_for, update_item};
use super::config::{cfg_str, find_project_root, load_config, project_registered, MODES, ROLES};
use super::doctor::doctor_report;
use super::git::is_git_repo;
use super::init::{init_project, prepare_project, InitOptions};
use super::prd::{approve_prd, draft_prd, revise_prd};
use super::projects::{add_project, list_projects, project_summary, remove_project};
use super::prompts::tasks_from_prd_prompt;
use super::queue::{queue_snapshot, set_max_concurrent};
use super::runner::{acknowledge, prepare_rerun, request_pause, run_pipeline_with_provider, Next};
use super::skills::{import_skill, list_skills, load_skill, new_skill_run, save_skill_run};
use super::state::{append_log, data_dir, ensure_dirs, prd_file, read_state, update_state};
use super::tasks;
use super::util::{js_string, now_iso, read_text, resolve};
use super::Result;

pub const HELP: &str = "ai-workflow — 用本機已登入的 Claude Code / Codex CLI 跑 AI 開發流程

用法：ai-workflow <指令> [選項]

  init [--mode auto|manual] [--author claude|codex] [--reviewer ...]
       [--implementer ...] [--code-reviewer ...] [--feature 名稱] [--force] [--git-init]
                          把目前專案加入 ai-workflow：偵測 build/test/lint 指令並登錄到總覽。
                          流程資料放在 ~/.ai-workflow/projects/<id>/，專案資料夾裡不會新增任何檔案；
                          不是 git repo 時 --git-init 會先 git init（互動終端機下沒加也會詢問）
  doctor                  檢查 Windows／WSL 的 Claude Code、Codex 安裝與訂閱登入
  prd \"<想法>\"            作者 AI 起草 PRD → 審查 AI 審 → 來回最多 max_prd_rounds 輪
  prd --backlog <id>      用需求待辦裡已完成需求釐清（Grill Me）並確認摘要的項目起草 PRD
  prd --revise \"<意見>\"   依你的意見修訂後再審一次
  prd --review            只請審查 AI 重新審查目前的 PRD（人工修改後保留原文）
  prd --approve           核准目前的 PRD
  tasks --approve         人工檢視後核准目前的任務清單；run 之前必須核准
  tasks                   用 AI 拆解核准的 PRD，由內建任務引擎保存及排程
  skills list             列出共用 Skills
  skills import <資料夾>  匯入包含 SKILL.md 的技能資料夾
  skills run <名稱> --input <需求> [--provider claude|codex] [--session <上次回覆 id>]
  run [--task <id>]       逐個任務執行（實作 → 驗證 → 審查 → 修正 → handover）
  pause                   目前任務結束後暫停
  continue                「我測完了，繼續」
  rerun <id> [--revert]   重跑任務；--revert 先還原該任務的變更
  mode <auto|manual>      切換模式（全域設定）
  status                  顯示目前狀態
  projects list           列出總覽裡的專案（~/.ai-workflow/projects.json）
  projects add [目錄]     加入專案（預設目前目錄；同 init）
  projects remove <id|目錄|名稱>
                          從總覽移除（不刪任何檔案）
  queue [--max <n>]       顯示全域執行佇列；--max 設定同時執行的 run 上限（預設 1）

全域選項：--cwd <目錄>  指定目標專案（預設從目前目錄往上找已加入總覽的專案）

設定全部是全域的，放在 ~/.ai-workflow/config.json（可用環境變數 AI_WORKFLOW_HOME 換位置）。
不帶參數執行時開啟桌面視窗。";

/// 子指令（GUI 用的保留字以外的第一個參數）。
pub const COMMANDS: [&str; 15] = ["init", "doctor", "prd", "tasks", "skills", "run", "pause", "continue", "rerun", "mode", "status", "projects", "queue", "help", "--help"];

pub struct Args {
    pub positional: Vec<String>,
    pub opts: std::collections::HashMap<String, String>,
}

impl Args {
    pub fn flag(&self, key: &str) -> bool {
        self.opts.contains_key(key)
    }
    pub fn get(&self, key: &str) -> Option<&str> {
        self.opts.get(key).map(String::as_str).filter(|v| *v != "true")
    }
}

/// --key value、--key=value、--flag（值為 "true"）；鍵名的 - 轉成 _。
pub fn parse_args(argv: &[String]) -> Args {
    let mut positional = Vec::new();
    let mut opts = std::collections::HashMap::new();
    let mut i = 0;
    while i < argv.len() {
        let a = &argv[i];
        if let Some(body) = a.strip_prefix("--") {
            let (k, inline) = match body.split_once('=') {
                Some((k, v)) => (k, Some(v.to_string())),
                None => (body, None),
            };
            let key = k.replace('-', "_");
            let value = match inline {
                Some(v) => v,
                None if argv.get(i + 1).is_some_and(|n| !n.starts_with("--")) => {
                    i += 1;
                    argv[i].clone()
                }
                None => "true".into(),
            };
            opts.insert(key, value);
        } else {
            positional.push(a.clone());
        }
        i += 1;
    }
    Args { positional, opts }
}

fn confirm_prompt(question: &str) -> bool {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().read_line(&mut line).is_err() {
        return false;
    }
    !line.trim().to_lowercase().starts_with('n')
}

/// 執行一個子指令；回傳 process 的結束碙。
pub fn main(argv: &[String]) -> Result<i32> {
    let args = parse_args(argv);
    let cmd = args.positional.first().map(String::as_str);
    let rest: Vec<String> = args.positional.iter().skip(1).cloned().collect();
    let start = args.get("cwd").map(resolve).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let root = if cmd == Some("init") || (cmd == Some("projects") && rest.first().map(String::as_str) == Some("add")) { start.clone() } else { find_project_root(&start) };
    let root = root.as_path();
    if project_registered(root) {
        prepare_project(root);
    }

    let forward_run = |mut forwarded: Vec<String>| {
        if let Some(p) = args.get("use_provider") { forwarded.extend(["--use-provider".into(), p.into()]); }
        main(&forwarded)
    };

    match cmd {
        Some("chat") => {
            let id = args.get("id").ok_or_else(|| super::AppError::new("請指定對話 id"))?;
            let turn = args.get("turn").ok_or_else(|| super::AppError::new("請指定對話回合"))?;
            let chat = super::chat::run_turn(root, id, turn)?;
            if chat["status"] != "done" { crate::bail!("{}", chat["error"].as_str().unwrap_or("對話未完成")); }
        }
        Some("init") => {
            let mut git_init = args.flag("git_init");
            if !git_init && std::io::stdin().is_terminal() && !is_git_repo(root)? {
                git_init = confirm_prompt(&format!("{} 不是 git repo（ai-workflow 用 git 追蹤、審查與還原 AI 的變更）。要幫你執行 git init 嗎？[Y/n] ", root.display()));
            }
            let roles = ROLES.iter().filter_map(|r| args.get(r).map(|v| (r.to_string(), v.to_string()))).collect();
            let r = init_project(root, &InitOptions {
                force: args.flag("force"), git_init, mode: args.get("mode").map(String::from), feature: args.get("feature").map(String::from), roles,
            })?;
            if r.git_initialized {
                println!("已在 {} 執行 git init", root.display());
            }
            let p = add_project(root, None)?;
            println!("已加入 {}（id {}，模式：{}）；流程資料放在 {}，專案資料夾不會新增檔案", root.display(), p["id"].as_str().unwrap_or(""), cfg_str(&r.cfg, "mode"), r.data_dir.display());
            let c = |k: &str| r.cfg["commands"][k].as_str().filter(|s| !s.is_empty()).unwrap_or("-").to_string();
            println!("偵測到的指令：build={} test={} lint={}", c("build"), c("test"), c("lint"));
            for item in &r.migrated {
                println!("已搬移舊資料：{item}");
            }
            println!("下一步：ai-workflow doctor 確認 CLI 登入狀態，然後 ai-workflow prd \"<想法>\" 或開啟桌面 app");
        }
        Some("doctor") => {
            let report = doctor_report(root)?;
            for line in report["lines"].as_array().into_iter().flatten() {
                println!("{}", line.as_str().unwrap_or(""));
            }
            return Ok(if report["bad"] == 0 { 0 } else { 1 });
        }
        Some("prd") => {
            let cfg = load_config(root)?;
            ensure_dirs(root)?;
            if args.flag("approve") {
                let file = approve_prd(root, &cfg)?;
                println!("PRD 已核准：{}\n下一步：ai-workflow tasks", file.display());
                return Ok(0);
            }
            if args.flag("review") {
                super::prd::review_current(root, &cfg)?;
            } else if let Some(feedback) = args.get("revise") {
                revise_prd(root, &cfg, feedback)?;
            } else if let Some(id) = args.get("backlog") {
                let item = get_item(root, id)?;
                // 先確認需求釐清已由使用者確認，再把待辦標成進行中，失敗時不改狀態。
                super::requirements::prd_input(root, &item)?;
                update_item(root, id, &json!({ "status": "in_progress" }))?;
                draft_prd(root, &cfg, &idea_for(&item), Some(id))?;
            } else {
                let idea = rest.join(" ").trim().to_string();
                if idea.is_empty() {
                    crate::bail!("請提供想法，例如：ai-workflow prd \"加入匯出 CSV 功能\"");
                }
                draft_prd(root, &cfg, &idea, None)?;
            }
            println!("PRD 已完成審查，等待核准：在 UI 按「核准」或執行 ai-workflow prd --approve");
        }
        Some("tasks") => {
            if args.flag("approve") { super::human::approve_tasks(root, &tasks::revision(root)?)?; println!("任務已人工核准，可執行 ai-workflow run"); return Ok(0); }
            let count = generate_tasks(root)?;
            println!("已產生 {count} 個任務，下一步：ai-workflow run 或在 UI 按「開始」");
        }
        Some("skills") => match rest.first().map(String::as_str) {
            None | Some("list") => {
                for s in list_skills(root) {
                    let detail = if s["compatible"] == true { s["description"].as_str() } else { s["error"].as_str().or(Some("含執行器專屬設定")) };
                    println!("{}：{}", s["name"].as_str().unwrap_or(""), detail.unwrap_or(""));
                }
            }
            Some("import") => {
                let Some(dir) = rest.get(1) else { crate::bail!("請指定 Skill 資料夾") };
                println!("已匯入 {}", import_skill(root, dir)?.name);
            }
            Some("run") => {
                let name = rest.get(1).cloned().unwrap_or_default();
                let run = run_skill(root, &name, args.get("input").unwrap_or(""), args.get("provider"), args.get("session"))?;
                let text = run["messages"].as_array().and_then(|m| m.last()).and_then(|m| m["text"].as_str()).unwrap_or("");
                println!("{text}\n\nSkill session: {}", run["id"].as_str().unwrap_or(""));
            }
            _ => crate::bail!("用法：skills list|import|run"),
        },
        Some("run") => {
            let result = run_pipeline_with_provider(root, args.get("task"), args.flag("verify"), args.get("use_provider"))?;
            let reason = read_state(root)["pipeline"]["reason"].as_str().unwrap_or("").to_string();
            println!("流程停止：{result}{}", if reason.is_empty() { String::new() } else { format!(" — {reason}") });
        }
        Some("pause") => {
            request_pause(root)?;
            println!("已要求暫停，目前任務結束後停下");
        }
        Some("continue") => match acknowledge(root)? {
            Next::Run if !args.flag("no_run") => return forward_run(strings(&["run", "--cwd", &root.to_string_lossy()])),
            Next::Verify(id) => return forward_run(strings(&["run", "--cwd", &root.to_string_lossy(), "--task", &id, "--verify"])),
            Next::Done => println!("功能已完成"),
            Next::Run => {}
        },
        Some("rerun") => {
            let Some(id) = rest.first() else { crate::bail!("請指定任務 id") };
            prepare_rerun(root, id, args.flag("revert"))?;
            if !args.flag("no_run") {
                return forward_run(strings(&["run", "--cwd", &root.to_string_lossy(), "--task", id]));
            }
        }
        Some("mode") => {
            let mode = rest.first().map(String::as_str).unwrap_or("");
            if !MODES.contains(&mode) {
                crate::bail!("模式必須是 {}", MODES.join(" / "));
            }
            super::config::patch_global(&json!({ "mode": mode }))?;
            println!("已切換為 {mode} 模式（全域設定）");
        }
        Some("status") => print_status(root)?,
        Some("projects") => projects_command(&rest, root)?,
        Some("queue") => {
            if let Some(max) = args.get("max") {
                set_max_concurrent(&json!(max))?;
            }
            let q = queue_snapshot();
            println!("同時執行上限：{}", q["max"]);
            let running: Vec<String> = q["running"].as_array().into_iter().flatten().map(|e| format!("{}（pid {}）", e["root"].as_str().unwrap_or(""), e["pid"])).collect();
            println!("執行中：{}", if running.is_empty() { "無".to_string() } else { running.join("、") });
            for e in q["waiting"].as_array().into_iter().flatten() {
                println!("  排隊 #{}：{}（pid {}）", e["position"], e["root"].as_str().unwrap_or(""), e["pid"]);
            }
        }
        None | Some("help") | Some("--help") => println!("{HELP}"),
        Some(other) => crate::bail!("未知指令：{other}\n\n{HELP}"),
    }
    Ok(0)
}

fn strings(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

/// 用作者 AI 依核准的 PRD 拆任務，交給內建任務引擎。回傳任務數。
pub fn generate_tasks(root: &Path) -> Result<usize> {
    let cfg = load_config(root)?;
    let state = read_state(root);
    if state["prd"]["status"] != "approved" {
        crate::bail!("PRD 尚未核准");
    }
    let scope = "tasks";
    update_state(root, |s| s["task_gen"] = json!({ "status": "running", "pid": std::process::id(), "error": "" }))?;
    let result = (|| -> Result<usize> {
        let prd = read_text(prd_file(root));
        if prd.trim().is_empty() {
            crate::bail!("找不到核准的 PRD（{}）", prd_file(root).display());
        }
        let res = run_agent(AgentOpts {
            root, cfg: &cfg, provider: cfg_str(&cfg["roles"], "task_planner"), prompt: tasks_from_prd_prompt(root, &cfg, &prd),
            write: false, scope, label: "依 PRD 產生任務", stage: Some("tasks"), skills: None, role: Some("task_planner"),
        })?;
        if !res.ok {
            crate::bail!("作者 AI 產生任務失敗：{}", res.error_text());
        }
        let text = res.text.trim();
        let parsed: Value = match (text.find('{'), text.rfind('}')) {
            (Some(a), Some(b)) if a < b => serde_json::from_str(&text[a..=b]).map_err(|e| super::AppError::new(format!("AI 回覆的任務不是合法 JSON：{e}")))?,
            _ => crate::bail!("AI 回覆裡找不到任務 JSON"),
        };
        let list = parsed["tasks"].as_array().cloned().unwrap_or_default();
        tasks::validate_tasks(&list)?;
        let feature = cfg_str(&cfg, "feature");
        let tag = tasks::use_feature_tag(root, &tag_slug(if feature.is_empty() { state["prd"]["idea"].as_str().unwrap_or("") } else { feature }))?;
        tasks::write_tasks(root, &list, Some(&tag), json!({ "references": state["prd"]["references"], "reference_feature": state["prd"]["archive_dir"], "prd_version": state["prd"]["version"], "prd_scope": state["prd"]["reference_scope"], "provider": res.provider, "sessionId": res.session_id }))?;
        let count = tasks::read_tasks(root)?.len();
        update_state(root, |s| {
            s["task_gen"] = json!({ "status": "done", "pid": null, "error": "", "count": count, "via": "builtin", "tag": tag });
            s["tasks"] = json!({}); s["task_approval"] = Value::Null;
        })?;
        archive_tasks(root, json!({}))?;
        append_log(root, scope, &format!("產生 {count} 個任務（AI 拆解，內建任務引擎管理）"));
        Ok(count)
    })();
    if let Err(err) = &result {
        let message = err.message.clone();
        update_state(root, |s| s["task_gen"] = json!({ "status": "error", "pid": null, "error": message }))?;
    }
    result
}

/// 互動式 Skill 會議：每次回答都是新的 session，交接紀錄放在 prompt 裡。
pub fn run_skill(root: &Path, name: &str, input: &str, provider: Option<&str>, previous_id: Option<&str>) -> Result<Value> {
    if input.trim().is_empty() {
        crate::bail!("請輸入需求或回答");
    }
    let cfg = load_config(root)?;
    if provider.is_some_and(|p| !["claude", "codex"].contains(&p)) {
        crate::bail!("provider 必須是 claude 或 codex");
    }
    load_skill(root, name)?;
    let mut run = new_skill_run(root, name, input, previous_id)?;
    let run_id = run["id"].as_str().unwrap_or("").to_string();
    update_state(root, |s| s["skill_job"] = json!({ "pid": std::process::id(), "id": run_id }))?;
    let history: Vec<String> = run["messages"].as_array().into_iter().flatten().map(|m| format!("{}: {}", m["role"].as_str().unwrap_or(""), m["text"].as_str().unwrap_or(""))).collect();
    let prompt = format!("這是互動式技能會議。根據以下交接紀錄回覆最新的使用者訊息；不要替使用者回答。\n{}", history.join("\n\n"));
    let scope = format!("skill-{run_id}");
    let label = format!("Skill {name}");
    let result = run_agent(AgentOpts {
        root, cfg: &cfg, provider: provider.unwrap_or(cfg_str(&cfg["roles"], "author")), prompt, write: false, scope: &scope, label: &label,
        stage: None, skills: Some(vec![name.to_string()]), role: None,
    }).and_then(|r| if r.ok { Ok(r) } else { Err(super::AppError::new(r.error_text())) });
    let out = match result {
        Ok(r) => {
            run["messages"].as_array_mut().unwrap().push(json!({ "role": "assistant", "text": r.text }));
            run["status"] = json!("done");
            run["provider"] = json!(r.provider);
            run["sessionId"] = json!(r.session_id);
            run["skills"] = json!(r.skills);
            save_skill_run(root, &mut run)?;
            Ok(run)
        }
        Err(err) => {
            run["status"] = json!("error");
            run["error"] = json!(err.message);
            save_skill_run(root, &mut run)?;
            Err(err)
        }
    };
    update_state(root, |s| s["skill_job"] = json!({ "pid": null, "id": run_id }))?;
    out
}

fn print_status(root: &Path) -> Result<()> {
    let cfg = load_config(root)?;
    let s = read_state(root);
    let reason = s["pipeline"]["reason"].as_str().filter(|r| !r.is_empty()).map(|r| format!("（{r}）")).unwrap_or_default();
    println!("模式：{}　流程：{}{reason}", cfg_str(&cfg, "mode"), s["pipeline"]["status"].as_str().unwrap_or(""));
    println!("資料目錄：{}", data_dir(root).display());
    let round = s["prd"]["round"].as_u64().filter(|r| *r > 0).map(|r| format!("，審查 {r} 輪")).unwrap_or_default();
    println!("PRD：{}{round}", s["prd"]["status"].as_str().unwrap_or(""));
    for t in tasks::read_tasks(root)? {
        let id = js_string(&t["id"]);
        let ts = &s["tasks"][id.as_str()];
        let extra = if ts.is_object() {
            let step = ts["step"].as_str().filter(|x| !x.is_empty()).map(|x| format!("：{x}")).unwrap_or_default();
            format!(" — {}{step}", ts["phase"].as_str().unwrap_or(""))
        } else {
            String::new()
        };
        println!("  #{id} [{}] {}{extra}", t["status"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""));
    }
    Ok(())
}

fn projects_command(args: &[String], root: &Path) -> Result<()> {
    match args.first().map(String::as_str) {
        Some("add") => {
            let dir = args.get(1).map(resolve).unwrap_or_else(|| root.to_path_buf());
            let p = add_project(&dir, None)?;
            println!("已加入：{}（{}，id {}）；流程資料放在 {}", p["name"].as_str().unwrap_or(""), p["path"].as_str().unwrap_or(""), p["id"].as_str().unwrap_or(""), data_dir(&dir).display());
        }
        Some("remove") | Some("rm") => {
            let Some(r) = args.get(1) else { crate::bail!("請指定要移除的專案 id、路徑或名稱") };
            let p = remove_project(r)?;
            println!("已從總覽移除：{}（{}），檔案沒有變動", p["name"].as_str().unwrap_or(""), p["path"].as_str().unwrap_or(""));
        }
        None | Some("list") | Some("ls") => {
            let list = list_projects();
            if list.is_empty() {
                println!("總覽裡還沒有專案：在專案目錄執行 ai-workflow projects add");
            }
            for p in list {
                let s = project_summary(&p);
                let total = s["progress"]["total"].as_u64().unwrap_or(0);
                let prog = if total > 0 { format!(" {}/{total}", s["progress"]["done"]) } else { String::new() };
                let feature: String = s["feature"].as_str().unwrap_or("").lines().next().unwrap_or("").chars().take(40).collect();
                let feature = if feature.is_empty() { String::new() } else { format!("  {feature}") };
                println!("{}  {}  [{}{prog}]{feature}\n            {}", p["id"].as_str().unwrap_or(""), p["name"].as_str().unwrap_or(""), s["status"].as_str().unwrap_or(""), p["path"].as_str().unwrap_or(""));
            }
        }
        _ => crate::bail!("用法：ai-workflow projects list|add [目錄]|remove <id|目錄|名稱>"),
    }
    Ok(())
}

/// 在背景以獨立程序執行子指令（關掉 app 也不會中斷），輸出寫到專案資料目錄的 logs/process.log。回傳 pid。
pub fn spawn_detached_cli(root: &Path, args: &[String]) -> Result<u32> {
    spawn_detached_with(&std::env::current_exe()?, root, args)
}

pub fn spawn_detached_with(exe: &PathBuf, root: &Path, args: &[String]) -> Result<u32> {
    ensure_dirs(root)?;
    let log_file = data_dir(root).join("logs").join("process.log");
    let mut out = fs::OpenOptions::new().create(true).append(true).open(&log_file)?;
    writeln!(out, "\n[{}] ai-workflow {}", now_iso(), args.join(" "))?;
    let mut cmd = Command::new(exe);
    cmd.args(args).arg("--cwd").arg(root).current_dir(root).stdin(Stdio::null()).stdout(out.try_clone()?).stderr(out);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    Ok(cmd.spawn()?.id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_支援_key_value_inline_與旗標() {
        let a = parse_args(&strings(&["prd", "想法", "--revise=改這裡", "--task", "3", "--no-run", "--cwd", "C:\\x"]));
        assert_eq!(a.positional, vec!["prd", "想法"]);
        assert_eq!(a.get("revise"), Some("改這裡"));
        assert_eq!(a.get("task"), Some("3"));
        assert!(a.flag("no_run"));
        assert_eq!(a.get("no_run"), None);
        assert_eq!(a.get("cwd"), Some("C:\\x"));
    }
}

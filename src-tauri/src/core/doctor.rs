//! 檢查 Windows／WSL 的 Claude Code、Codex 安裝與訂閱登入（對應 legacy/src/doctor.js）。
use std::path::Path;

use serde_json::{json, Value};

use super::capabilities::probe_provider;
use super::config::load_config_or_default;
use super::runtime::{cli_environment, project_environment};
use super::Result;

pub fn doctor_report(root: &Path) -> Result<Value> {
    doctor_report_with(root, &probe_provider)
}

pub fn doctor_report_with(root: &Path, probe: &(dyn Fn(&Path, &Value, &str) -> Value + Sync)) -> Result<Value> {
    let cfg = load_config_or_default(root)?;
    let project = project_environment(root);
    let environments: &[&str] = if cfg!(windows) { &["windows", "wsl"] } else { &["wsl"] };
    let tmp = std::env::temp_dir();
    let combos: Vec<(&str, &str)> = environments.iter().flat_map(|r| ["claude", "codex"].map(|p| (*r, p))).collect();
    // 每個組合各自探測（WSL 冷啟動慢，平行執行）。
    let inventory: Vec<Value> = std::thread::scope(|scope| {
        let handles: Vec<_> = combos.iter().map(|(runtime, provider)| {
            let mut check_cfg = cfg.clone();
            check_cfg["runtime"][*provider] = json!(runtime);
            if !project.distro.is_empty() {
                check_cfg["wsl_distro"] = json!(project.distro);
            }
            let tmp = &tmp;
            scope.spawn(move || {
                let mut item = probe(tmp, &check_cfg, provider);
                item["provider"] = json!(provider);
                item["runtime"] = json!(runtime);
                item
            })
        }).collect();
        handles.into_iter().zip(&combos).map(|(h, (runtime, provider))| {
            h.join().unwrap_or_else(|_| json!({ "provider": provider, "runtime": runtime, "available": false, "error": "檢查失敗" }))
        }).collect()
    });
    let active: Vec<Option<&Value>> = ["claude", "codex"].iter().map(|provider| {
        let runtime = cli_environment(&cfg, provider, root).runtime;
        inventory.iter().find(|i| i["provider"] == *provider && i["runtime"] == runtime.as_str())
    }).collect();
    let available: Vec<&Value> = active.into_iter().flatten().filter(|i| i["available"] == true).collect();
    let mut lines = vec![format!("專案環境：{}{}", project.runtime, if project.distro.is_empty() { String::new() } else { format!("（{}）", project.distro) })];
    for item in &inventory {
        let ok = item["available"] == true;
        let detail = if ok {
            format!("{}，已登入", item["version"].as_str().unwrap_or(""))
        } else {
            format!("{}；{}", if item["installed"] == true { "已安裝但未就緒" } else { "未安裝或無法啟動" }, item["error"].as_str().unwrap_or(""))
        };
        lines.push(format!("{} {} / {}：{detail}", if ok { "✔" } else { "○" }, item["runtime"].as_str().unwrap_or(""), item["provider"].as_str().unwrap_or("")));
    }
    for provider in ["claude", "codex"] {
        let target = cli_environment(&cfg, provider, root);
        lines.push(format!("專案 {provider} → {}{}", target.runtime, if target.distro.is_empty() { String::new() } else { format!("（{}）", target.distro) }));
        if target.runtime != project.runtime {
            lines.push(format!("  手動設定覆蓋專案位置：可在設定頁將 {provider} 改為「自動（依專案位置）」"));
        }
    }
    lines.push(match available.len() {
        2 => "雙 AI 可用".to_string(),
        1 => format!("單 AI 模式：{}；實作與審查使用獨立 session", available[0]["provider"].as_str().unwrap_or("")),
        _ => "目前專案環境沒有可用的 AI，請先安裝並登入至少一個 CLI".to_string(),
    });
    let names: Vec<Value> = available.iter().map(|i| i["provider"].clone()).collect();
    Ok(json!({ "lines": lines, "bad": if available.is_empty() { 1 } else { 0 }, "inventory": inventory, "available": names }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::util::temp_dir;

    #[test]
    fn doctor_另一環境缺_cli_不會阻擋目前專案的單_ai_模式() {
        let root = temp_dir("doctor-");
        let runtime = project_environment(&root).runtime;
        let report = doctor_report_with(&root, &|_, cfg, provider| json!({
            "installed": provider == "codex",
            "available": cfg["runtime"][provider] == runtime.as_str() && provider == "codex",
            "error": "未安裝",
        })).unwrap();
        assert_eq!(report["bad"], 0);
        assert_eq!(report["available"], json!(["codex"]));
        assert!(report["lines"].as_array().unwrap().iter().any(|l| l.as_str().unwrap().contains("單 AI 模式")));
        let none = doctor_report_with(&root, &|_, _, _| json!({ "available": false, "error": "未安裝" })).unwrap();
        assert_eq!(none["bad"], 1);
    }
}

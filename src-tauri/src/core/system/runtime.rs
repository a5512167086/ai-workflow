//! 專案與 CLI 的執行環境（對應 legacy/src/runtime.js）。
use std::path::Path;

use serde_json::{json, Value};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WslLocation {
    pub distro: String,
    pub path: String,
}

/// \\wsl$\<發行版>\... 或 \\wsl.localhost\<發行版>\... 的 Windows 路徑帶有發行版，不能用預設發行版存取。
pub fn wsl_location(root: impl AsRef<Path>) -> Option<WslLocation> {
    let s = root.as_ref().to_string_lossy().replace('/', "\\");
    let rest = s.strip_prefix("\\\\")?;
    let lower = rest.to_ascii_lowercase();
    let host_len = if lower.starts_with("wsl$\\") { 5 } else if lower.starts_with("wsl.localhost\\") { 14 } else { return None };
    let rest = &rest[host_len..];
    let (distro, path) = match rest.find('\\') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, ""),
    };
    if distro.is_empty() {
        return None;
    }
    let path = path.replace('\\', "/");
    Some(WslLocation { distro: distro.to_string(), path: if path.is_empty() { "/".into() } else { path } })
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Environment {
    pub runtime: String,
    pub distro: String,
    pub native: bool,
    pub path: Option<String>,
}

impl Environment {
    pub fn to_json(&self) -> Value {
        let mut v = json!({ "runtime": self.runtime, "distro": self.distro });
        if self.native {
            v["native"] = json!(true);
        }
        if let Some(p) = &self.path {
            v["path"] = json!(p);
        }
        v
    }
}

pub fn project_environment_on(root: &Path, windows: bool, wsl_distro_env: Option<String>) -> Environment {
    if let Some(loc) = wsl_location(root) {
        return Environment { runtime: "wsl".into(), distro: loc.distro, native: false, path: Some(loc.path) };
    }
    if windows {
        return Environment { runtime: "windows".into(), distro: String::new(), native: false, path: None };
    }
    Environment { runtime: "wsl".into(), distro: wsl_distro_env.unwrap_or_default(), native: true, path: None }
}

pub fn project_environment(root: &Path) -> Environment {
    project_environment_on(root, cfg!(windows), std::env::var("WSL_DISTRO_NAME").ok())
}

pub fn cli_environment(cfg: &Value, name: &str, root: &Path) -> Environment {
    let project = project_environment(root);
    let runtime = cfg["runtime"][name].as_str().filter(|r| !r.is_empty()).unwrap_or("auto");
    let wsl_distro = cfg["wsl_distro"].as_str().unwrap_or("");
    if runtime == "auto" {
        let distro = if project.runtime == "wsl" { if project.distro.is_empty() { wsl_distro.to_string() } else { project.distro.clone() } } else { String::new() };
        return Environment { distro, ..project };
    }
    let distro = if runtime == "wsl" { wsl_location(root).map(|l| l.distro).unwrap_or_else(|| wsl_distro.to_string()) } else { String::new() };
    Environment { runtime: runtime.into(), distro, native: !cfg!(windows), path: None }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::default_config;

    #[test]
    fn 自動辨識_windows_與兩種_wsl_unc_路徑_保留發行版及空白中文() {
        assert_eq!(project_environment_on(Path::new("C:\\work\\app"), true, None).runtime, "windows");
        for host in ["wsl$", "wsl.localhost"] {
            let root = format!("\\\\{host}\\Ubuntu-24.04\\home\\me\\中文 app");
            assert_eq!(wsl_location(&root), Some(WslLocation { distro: "Ubuntu-24.04".into(), path: "/home/me/中文 app".into() }));
            let mut cfg = default_config();
            cfg["wsl_distro"] = json!("WrongDistro");
            assert_eq!(cli_environment(&cfg, "claude", Path::new(&root)).distro, "Ubuntu-24.04");
        }
        assert_eq!(wsl_location("\\\\server\\share\\repo"), None);
        assert_eq!(project_environment_on(Path::new("/home/me/repo"), false, Some("Ubuntu".into())).distro, "Ubuntu");
    }

    #[test]
    fn 手動_runtime_設定仍優先於自動判斷() {
        let mut cfg = default_config();
        cfg["runtime"]["claude"] = json!("windows");
        let env = cli_environment(&cfg, "claude", Path::new("\\\\wsl$\\Ubuntu\\home\\repo"));
        assert_eq!(env.runtime, "windows");
        assert_eq!(env.distro, "");
        if cfg!(windows) {
            cfg["runtime"]["claude"] = json!("auto");
            cfg["wsl_distro"] = json!("Ubuntu");
            let env = cli_environment(&cfg, "claude", Path::new("C:\\work\\app"));
            assert_eq!(env.runtime, "windows");
            assert_eq!(env.distro, "");
        }
    }
}

//! 取代 Node 版 SSE 的變化偵測（對應 server.js 的 sse() 與 projectsSse()）。
//! 每次 tick 比對 state／設定／用量檔的修改時間與 log 檔大小，回傳要推送給前端的事件。
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use serde_json::{json, Value};

use crate::core::api::{projects_payload, snapshot};
use crate::core::state::data_dir;
use crate::core::tasks::tasks_file;
use crate::core::usage::usage_file;

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

pub struct ProjectWatcher {
    root: PathBuf,
    sizes: HashMap<String, u64>,
    /// AI 正在打字的串流檔（<scope>.stream）上次推送時的大小。
    streams: HashMap<String, u64>,
    last: Option<Vec<Option<SystemTime>>>,
}

impl ProjectWatcher {
    /// 建立時記下目前 log 大小：只推送之後新增的內容（既有內容由前端另外讀取）。
    pub fn new(root: &Path) -> Self {
        // 串流檔不先記大小：App 打開時如果 AI 正在打字，第一次 tick 就把目前的文字送出去。
        let mut w = Self { root: root.to_path_buf(), sizes: HashMap::new(), streams: HashMap::new(), last: None };
        for (name, size) in w.log_sizes() {
            w.sizes.insert(name, size);
        }
        w
    }

    fn log_sizes(&self) -> Vec<(String, u64)> {
        let dir = data_dir(&self.root).join("logs");
        fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).filter_map(|e| Some((e.file_name().to_string_lossy().into_owned(), e.metadata().ok()?.len()))).filter(|(name, _)| name.ends_with(".log")).collect()).unwrap_or_default()
    }

    fn stream_sizes(&self) -> HashMap<String, u64> {
        let dir = data_dir(&self.root).join("logs");
        fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).filter_map(|e| {
            let name = e.file_name().to_string_lossy().into_owned();
            Some((name.strip_suffix(".stream")?.to_string(), e.metadata().ok()?.len()))
        }).collect()).unwrap_or_default()
    }

    /// 回傳 (事件名稱, 內容)：state 變化時推送完整 snapshot，log 只推送新增的部分（單次最多 500 KB）。
    pub fn tick(&mut self) -> Vec<(&'static str, Value)> {
        let mut events = Vec::new();
        let sig = vec![
            mtime(&data_dir(&self.root).join("state.json")),
            mtime(&crate::core::config::project_config_path(&self.root)),
            mtime(&crate::core::config::global_config_path()),
            mtime(&usage_file(&self.root)),
            mtime(&tasks_file(&self.root)),
            mtime(&self.root.join(".taskmaster").join("state.json")),
            mtime(&crate::core::permissions::marker(&self.root)),
        ];
        if self.last.as_ref() != Some(&sig) {
            self.last = Some(sig);
            match snapshot(&self.root) {
                Ok(snap) => events.push(("state", snap)),
                Err(err) => events.push(("error", json!({ "message": err.message }))),
            }
        }
        for (name, size) in self.log_sizes() {
            let prev = self.sizes.get(&name).copied().unwrap_or(0);
            if size > prev {
                let len = (size - prev).min(500_000);
                let path = data_dir(&self.root).join("logs").join(&name);
                let read = || -> std::io::Result<Vec<u8>> {
                    let mut f = fs::File::open(&path)?;
                    f.seek(SeekFrom::Start(size - len))?;
                    let mut buf = vec![0; len as usize];
                    f.read_exact(&mut buf)?;
                    Ok(buf)
                };
                if let Ok(buf) = read() {
                    let scope = name.strip_suffix(".log").unwrap_or(&name).to_string();
                    events.push(("log", json!({ "scope": scope, "text": String::from_utf8_lossy(&buf) })));
                }
            }
            self.sizes.insert(name, size);
        }
        // 正在打字的文字：有變化就推送整段（一段訊息通常不大）；檔案被清掉就推送空字串，前端收起打字中的訊息。
        let streams = self.stream_sizes();
        for (scope, size) in &streams {
            if self.streams.get(scope) == Some(size) { continue; }
            let text = fs::read(data_dir(&self.root).join("logs").join(format!("{scope}.stream"))).map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
            events.push(("stream", json!({ "scope": scope, "text": text })));
        }
        for scope in self.streams.keys().filter(|s| !streams.contains_key(*s)) {
            events.push(("stream", json!({ "scope": scope, "text": "" })));
        }
        self.streams = streams;
        events
    }
}

/// 總覽：重算所有專案的摘要，有變化才回傳。
#[derive(Default)]
pub struct ProjectsWatcher {
    last: String,
}

impl ProjectsWatcher {
    pub fn tick(&mut self) -> Option<Value> {
        let payload = projects_payload();
        let text = payload.to_string();
        if text == self.last {
            return None;
        }
        self.last = text;
        Some(payload)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::state::{append_log, ensure_dirs, update_state};
    use crate::core::util::temp_dir;

    #[test]
    fn state_變化推送_snapshot_log_只推送新增內容() {
        let root = temp_dir("watch-");
        crate::core::config::save_project(&root, &json!({})).unwrap();
        ensure_dirs(&root).unwrap();
        append_log(&root, "runner", "舊的內容");
        let mut w = ProjectWatcher::new(&root);
        let first = w.tick();
        assert_eq!(first.len(), 1);
        assert_eq!(first[0].0, "state");
        assert!(w.tick().is_empty());
        append_log(&root, "runner", "新的一行");
        std::thread::sleep(std::time::Duration::from_millis(20));
        update_state(&root, |s| s["pipeline"]["status"] = json!("running")).unwrap();
        let events = w.tick();
        let log = events.iter().find(|(e, _)| *e == "log").unwrap();
        assert_eq!(log.1["scope"], "runner");
        assert!(log.1["text"].as_str().unwrap().contains("新的一行"));
        assert!(!log.1["text"].as_str().unwrap().contains("舊的內容"));
        assert_eq!(events.iter().find(|(e, _)| *e == "state").unwrap().1["state"]["pipeline"]["status"], "running");
    }

    #[test]
    fn ai_打字中的文字_推送整段_清掉後推送空字串_不混進_log() {
        let root = temp_dir("watch-stream-");
        crate::core::config::save_project(&root, &json!({})).unwrap();
        ensure_dirs(&root).unwrap();
        // App 打開時 AI 已經在打字：第一次 tick 就送出目前的文字。
        crate::core::state::append_stream(&root, "chat-t1", "你好");
        let mut w = ProjectWatcher::new(&root);
        let stream = |events: &[(&str, Value)]| events.iter().find(|(e, _)| *e == "stream").map(|(_, v)| v.clone());
        let first = w.tick();
        assert_eq!(stream(&first).unwrap(), json!({ "scope": "chat-t1", "text": "你好" }));
        assert!(first.iter().all(|(e, _)| *e != "log"), "串流檔不能當成 log 推送");
        // 沒變化不重送；多了文字就送整段。
        assert!(stream(&w.tick()).is_none());
        crate::core::state::append_stream(&root, "chat-t1", "，世界\r\n");
        assert_eq!(stream(&w.tick()).unwrap()["text"], "你好，世界\n");
        // 這段寫完（清掉串流檔）：送空字串，前端收起打字中的訊息。
        crate::core::state::clear_stream(&root, "chat-t1");
        assert_eq!(stream(&w.tick()).unwrap(), json!({ "scope": "chat-t1", "text": "" }));
        assert!(stream(&w.tick()).is_none());
    }
}

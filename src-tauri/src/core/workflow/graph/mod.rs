//! 專案圖譜（token_saving.code_map）：用 tree-sitter 把專案的檔案、定義、import 與呼叫建成一張圖，
//! 讓 AI 先讀報告、查圖，而不是逐一搜尋與讀檔。設計參考 graphify（https://github.com/Graphify-Labs/graphify）。
//! 輸出在專案資料目錄的 graph/，專案資料夾裡不會多任何檔案。
pub mod analyze;
pub mod export;
pub mod extract;
pub mod query;
pub mod report;
pub mod resolve;

use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::core::savings::is_noise_path;
use crate::core::util::{now_iso, read_json, write_atomic};
use crate::core::Result;
use analyze::Analysis;
use extract::{extract, Facts, Lang};
use resolve::{FileInput, Graph};

/// 超過的檔案只當成檔案節點，不解析內容。
const MAX_PARSE_BYTES: u64 = 500_000;
const MAX_FILES: usize = 5000;
/// 快取版本：抽取規則或 tree-sitter 版本改變時更新，舊快取就會整份重新解析（graphify 也把 grammar 版本放進快取鍵）。
const CACHE_VERSION: &str = "1-tree-sitter-0.27";
/// 附在 prompt 裡的查詢結果上限（token）。
const PROMPT_BUDGET: usize = 1500;

pub fn graph_dir(root: &Path) -> PathBuf {
    crate::core::state::data_dir(root).join("graph")
}

pub fn report_file(root: &Path) -> PathBuf {
    graph_dir(root).join("GRAPH_REPORT.md")
}

pub fn json_file(root: &Path) -> PathBuf {
    graph_dir(root).join("graph.json")
}

pub fn html_file(root: &Path) -> PathBuf {
    graph_dir(root).join("graph.html")
}

pub struct Built {
    pub graph: Graph,
    pub analysis: Analysis,
    pub report: String,
}

fn project_name(root: &Path) -> String {
    crate::core::projects::find_project_by_path(root).and_then(|p| p["name"].as_str().map(String::from))
        .or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned())).unwrap_or_else(|| "project".into())
}

/// 重新建立圖譜（內容沒變的檔案沿用快取），寫出 graph.json、GRAPH_REPORT.md 與 graph.html。
pub fn build(root: &Path) -> Result<Built> {
    let (graph, parsed, reused) = scan(root)?;
    let analysis = analyze::analyze(&graph);
    let commit = crate::core::git::head_sha(root).ok().flatten();
    let built_at = now_iso();
    let project = project_name(root);
    let stats = report::Stats { project: project.clone(), date: built_at[..10].to_string(), commit: commit.clone(), parsed, reused };
    let report = report::generate(&graph, &analysis, &stats);
    let meta = export::Meta { project: &project, built_at: &built_at, commit: commit.as_deref() };
    write_atomic(&json_file(root), &export::to_json(&graph, &analysis, &meta))?;
    write_atomic(&report_file(root), &report)?;
    write_atomic(&html_file(root), &export::to_html(&graph, &analysis, &meta))?;
    Ok(Built { graph, analysis, report })
}

/// 讀回上次建立的圖譜；沒有或格式不符時重新建立。
pub fn load(root: &Path) -> Result<(Graph, Analysis)> {
    match read_json(json_file(root)).as_ref().and_then(export::from_json) {
        Some((graph, _)) => {
            let analysis = analyze::analyze(&graph);
            Ok((graph, analysis))
        }
        None => build(root).map(|b| (b.graph, b.analysis)),
    }
}

/// 給「架構圖」分頁：報告、互動圖與統計。還沒建立過時 exists 為 false。
pub fn summary(root: &Path) -> Value {
    let Some(v) = read_json(json_file(root)) else { return json!({ "exists": false }) };
    let count = |k: &str| v[k].as_array().map(|a| a.len()).unwrap_or(0);
    let files = v["nodes"].as_array().map(|a| a.iter().filter(|n| n["kind"] == "file").count()).unwrap_or(0);
    let communities = v["nodes"].as_array().map(|a| a.iter().filter_map(|n| n["community"].as_u64()).max().map(|m| m + 1).unwrap_or(0)).unwrap_or(0);
    json!({
        "exists": true, "builtAt": v["graph"]["built_at"], "commit": v["graph"]["built_at_commit"],
        "stats": { "nodes": count("nodes"), "edges": count("links"), "files": files, "communities": communities },
        "report": fs::read_to_string(report_file(root)).unwrap_or_default(),
        "html": export::refresh_html(&fs::read_to_string(html_file(root)).unwrap_or_default()),
        "paths": { "json": json_file(root).display().to_string(), "report": report_file(root).display().to_string(), "html": html_file(root).display().to_string() },
    })
}

/// 附在實作與修正 prompt 的圖譜內容：先重建（只解析改過的檔案），再依任務內容查出相關子圖，
/// 加上核心節點與完整檔案的路徑。照 graphify 的經驗，寫成事實陳述而不是命令。建立失敗時回傳 None，流程照常進行。
pub fn prompt_context(root: &Path, question: &str) -> Option<String> {
    let built = build(root).ok()?;
    let (g, a) = (&built.graph, &built.analysis);
    let files = g.nodes.iter().filter(|n| n.kind == "file").count();
    let mut out = vec![format!(
        "這個專案有一份由 ai-workflow 以 tree-sitter 建立的程式碼圖譜：{files} 個檔案、{} 個節點、{} 條關係（呼叫、匯入、繼承、包含）。關係標有信心度：EXTRACTED 是原始碼明確寫出，INFERRED 是依名稱推斷，AMBIGUOUS 是同名的定義不只一個。圖譜已經標出位置的地方，直接讀那幾行就夠了，不需要整個專案搜尋。",
        g.nodes.len(), g.edges.len()
    )];
    out.push(format!("- 架構總覽（核心節點、分群、循環匯入）：{}", report_file(root).display()));
    out.push(format!("- 完整圖譜：{}（每行一個節點或關係，用搜尋工具找符號名稱就能看到誰呼叫它、它依賴誰）", json_file(root).display()));
    if !a.god_nodes.is_empty() {
        out.push("\n### 核心節點".into());
        for &i in a.god_nodes.iter().take(5) {
            let n = &g.nodes[i];
            out.push(format!("- `{}` {}:L{}（{} 條關係）", n.label, n.file, n.line, a.degree[i]));
        }
    }
    out.push("\n### 與這次工作相關的節點與關係".into());
    out.push(query::query(g, a, question, PROMPT_BUDGET).unwrap_or_else(|| "（內容沒有對到圖譜裡的名稱；可以先看核心節點與架構總覽）".into()));
    Some(out.join("\n"))
}

/// 依 git 的檔案清單解析整個專案；內容沒變的檔案沿用上次的解析結果。回傳圖與（解析數, 快取命中數）。
pub fn scan(root: &Path) -> Result<(Graph, usize, usize)> {
    let files: Vec<String> = crate::core::git::list_files(root)?.into_iter().filter(|f| !is_noise_path(f)).take(MAX_FILES).collect();
    let cache_file = graph_dir(root).join("cache.json");
    let old = read_json(&cache_file).filter(|c| c["version"] == CACHE_VERSION).unwrap_or(Value::Null);
    let mut cache = json!({ "version": CACHE_VERSION, "files": {} });
    let (mut parsed, mut reused) = (0, 0);
    let mut inputs = Vec::new();
    for path in files {
        let lang = Lang::of(&path);
        let full = root.join(&path);
        let readable = lang.is_some() && fs::metadata(&full).is_ok_and(|m| m.is_file() && m.len() <= MAX_PARSE_BYTES);
        let facts = match readable.then(|| fs::read(&full).ok()).flatten() {
            Some(bytes) => {
                let hash = hex::encode(&Sha256::digest(&bytes)[..12]);
                let hit = (old["files"][&path]["hash"] == hash.as_str()).then(|| Facts::from_json(&old["files"][&path]["facts"])).flatten();
                let facts = match hit {
                    Some(f) => {
                        reused += 1;
                        f
                    }
                    None => {
                        parsed += 1;
                        extract(lang.unwrap(), &String::from_utf8_lossy(&bytes))
                    }
                };
                cache["files"][&path] = json!({ "hash": hash, "facts": facts.to_json() });
                facts
            }
            None => Facts::default(),
        };
        inputs.push(FileInput { path, lang: lang.filter(|_| readable), facts });
    }
    write_atomic(&cache_file, &cache.to_string())?;
    Ok((resolve::build(&inputs), parsed, reused))
}

//! 輸出 graph.json 與 graph.html。graph.json 沿用 graphify 的 node-link 格式（nodes、links、graph.schema_version），
//! 每個節點、每條關係各佔一行，讓 AI 可以直接用搜尋工具找符號名稱，不必讀整個檔案。
use std::collections::BTreeMap;

use serde_json::{json, Value};

use super::analyze::Analysis;
use super::resolve::{confidence_score, Edge, Graph, Node};

pub const SCHEMA_VERSION: u64 = 1;
/// graph.html 超過這麼多節點時只畫檔案層級（graphify 在超過上限時改畫分群的彙總圖）。
pub const VIEW_LIMIT: usize = 3000;

pub struct Meta<'a> {
    pub project: &'a str,
    pub built_at: &'a str,
    pub commit: Option<&'a str>,
}

pub fn to_json(g: &Graph, a: &Analysis, meta: &Meta) -> String {
    let header = json!({ "schema_version": SCHEMA_VERSION, "generator": "ai-workflow", "project": meta.project, "built_at": meta.built_at, "built_at_commit": meta.commit });
    let nodes: Vec<String> = g.nodes.iter().enumerate().map(|(i, n)| {
        let c = &a.communities[a.community[i]];
        json!({
            "id": n.id, "label": n.label, "kind": n.kind, "file_type": n.file_type, "source_file": n.file,
            "source_location": if n.line > 0 { Value::from(format!("L{}", n.line)) } else { Value::Null },
            "lang": n.lang, "community": c.id, "community_name": c.name, "norm_label": n.label.trim_end_matches("()").to_lowercase(),
        }).to_string()
    }).collect();
    let links: Vec<String> = g.edges.iter().map(|e| {
        let source = a.index.get(&e.source).map(|i| &g.nodes[*i]);
        json!({
            "source": e.source, "target": e.target, "relation": e.relation, "confidence": e.confidence, "confidence_score": e.score(),
            "source_file": source.map(|n| n.file.as_str()), "source_location": source.filter(|n| n.line > 0).map(|n| format!("L{}", n.line)), "weight": e.weight,
        }).to_string()
    }).collect();
    format!("{{\"directed\":true,\"multigraph\":false,\"graph\":{header},\n\"nodes\":[\n{}\n],\n\"links\":[\n{}\n]}}\n", nodes.join(",\n"), links.join(",\n"))
}

fn relation(name: &str) -> &'static str {
    match name {
        "contains" => "contains",
        "method" => "method",
        "imports" => "imports",
        "inherits" => "inherits",
        "implements" => "implements",
        _ => "calls",
    }
}

fn confidence(name: &str) -> &'static str {
    match name {
        "EXTRACTED" => "EXTRACTED",
        "INFERRED" => "INFERRED",
        _ => "AMBIGUOUS",
    }
}

/// 讀回 graph.json（CLI 查詢用）。格式不對或版本不同時回傳 None，呼叫端會重建。
pub fn from_json(v: &Value) -> Option<(Graph, Value)> {
    if v["graph"]["schema_version"] != SCHEMA_VERSION {
        return None;
    }
    let s = |x: &Value| x.as_str().unwrap_or("").to_string();
    let nodes = v["nodes"].as_array()?.iter().map(|n| Node {
        id: s(&n["id"]), label: s(&n["label"]), kind: s(&n["kind"]), file_type: s(&n["file_type"]), file: s(&n["source_file"]),
        line: n["source_location"].as_str().and_then(|l| l.trim_start_matches('L').parse().ok()).unwrap_or(0), lang: s(&n["lang"]),
    }).collect();
    let edges = v["links"].as_array()?.iter().map(|e| Edge {
        source: s(&e["source"]), target: s(&e["target"]), relation: relation(e["relation"].as_str().unwrap_or("")),
        confidence: confidence(e["confidence"].as_str().unwrap_or("")), weight: e["weight"].as_u64().unwrap_or(1) as usize,
    }).collect();
    Some((Graph { nodes, edges }, v["graph"].clone()))
}

/// graph.html 用的精簡資料：節點與關係用陣列和索引表示。節點太多時改成檔案層級的彙總圖。
fn view_data(g: &Graph, a: &Analysis, meta: &Meta) -> Value {
    let relations = ["contains", "method", "imports", "calls", "inherits", "implements"];
    let confidences = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];
    let rel_index = |r: &str| relations.iter().position(|x| *x == r).unwrap_or(3);
    let conf_index = |c: &str| confidences.iter().position(|x| *x == c).unwrap_or(2);
    let aggregated = g.nodes.len() > VIEW_LIMIT;
    let (nodes, links): (Vec<Value>, Vec<Value>) = if !aggregated {
        let nodes = g.nodes.iter().enumerate().map(|(i, n)| json!([n.label, n.kind, n.file, n.line, a.community[i], a.degree[i]])).collect();
        let links = g.edges.iter().filter_map(|e| Some(json!([a.index.get(&e.source)?, a.index.get(&e.target)?, rel_index(e.relation), conf_index(e.confidence)]))).collect();
        (nodes, links)
    } else {
        // 檔案層級：每個檔案一個節點，定義之間的關係併到所屬檔案上，取最可靠的信心度。
        let files: Vec<usize> = (0..g.nodes.len()).filter(|i| g.nodes[*i].kind == "file").collect();
        let position: BTreeMap<&str, usize> = files.iter().enumerate().map(|(k, i)| (g.nodes[*i].file.as_str(), k)).collect();
        let mut merged: BTreeMap<(usize, usize), (&str, &str)> = BTreeMap::new();
        for e in &g.edges {
            let (Some(&s), Some(&t)) = (a.index.get(&e.source), a.index.get(&e.target)) else { continue };
            let (fs, ft) = (position[g.nodes[s].file.as_str()], position[g.nodes[t].file.as_str()]);
            if fs == ft {
                continue;
            }
            let entry = merged.entry((fs, ft)).or_insert((e.relation, e.confidence));
            if confidence_score(e.confidence) > confidence_score(entry.1) {
                *entry = (e.relation, e.confidence);
            }
        }
        let mut degree = vec![0; files.len()];
        for (s, t) in merged.keys() {
            degree[*s] += 1;
            degree[*t] += 1;
        }
        let nodes = files.iter().enumerate().map(|(k, i)| { let n = &g.nodes[*i]; json!([n.label, n.kind, n.file, 0, a.community[*i], degree[k]]) }).collect();
        let links = merged.iter().map(|((s, t), (r, c))| json!([s, t, rel_index(r), conf_index(c)])).collect();
        (nodes, links)
    };
    let communities: Vec<Value> = a.communities.iter().map(|c| json!([c.id, c.name, c.members.len()])).collect();
    json!({
        "project": meta.project, "aggregated": aggregated, "limit": VIEW_LIMIT, "relations": relations, "confidences": confidences,
        "stats": { "nodes": g.nodes.len(), "edges": g.edges.len(), "built": meta.built_at },
        "nodes": nodes, "links": links, "communities": communities,
    })
}

pub fn to_html(g: &Graph, a: &Analysis, meta: &Meta) -> String {
    // 資料直接嵌進頁面；`</` 換成 `<\/`，避免名稱裡的 </script> 提早結束標籤。
    let data = view_data(g, a, meta).to_string().replace("</", "<\\/");
    include_str!("viewer.html").replace("/*__GRAPH__*/null", &data)
}

/// 以前建立的 graph.html 換上目前版本的互動圖（嵌入的資料不變）：不必重新建立圖譜，就能用到新的操作方式與修正。
/// 看不出是我們產生的頁面時原樣回傳。
pub fn refresh_html(stored: &str) -> String {
    const MARK: &str = "const DATA = ";
    let Some(start) = stored.find(MARK).map(|i| i + MARK.len()) else { return stored.to_string() };
    let end = stored[start..].find('\n').map_or(stored.len(), |i| start + i);
    let data = stored[start..end].trim_end().trim_end_matches(';');
    if !data.starts_with('{') {
        return stored.to_string();
    }
    include_str!("viewer.html").replace("/*__GRAPH__*/null", data)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::graph::analyze::analyze;
    use crate::core::graph::extract::{extract, Lang};
    use crate::core::graph::resolve::{build, FileInput};

    fn sample() -> Graph {
        let files = [("src/a.ts", "import { b } from './b';\nexport function a() { b(); }\n"), ("src/b.ts", "export function b() { return '</script>'; }\n")];
        build(&files.iter().map(|(p, s)| FileInput { path: p.to_string(), lang: Lang::of(p), facts: extract(Lang::of(p).unwrap(), s) }).collect::<Vec<_>>())
    }

    #[test]
    fn graph_json_每行一個節點或關係_可以讀回() {
        let g = sample();
        let a = analyze(&g);
        let text = to_json(&g, &a, &Meta { project: "demo", built_at: "2026-11-02T00:00:00Z", commit: Some("abc") });
        let call = text.lines().find(|l| l.contains("\"relation\":\"calls\"")).unwrap();
        assert!(call.contains("\"source\":\"src/a.ts#a\"") && call.contains("\"target\":\"src/b.ts#b\"") && call.contains("\"confidence\":\"EXTRACTED\"") && call.contains("\"confidence_score\":1.0"));
        let v: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(v["graph"]["schema_version"], 1);
        assert_eq!(v["graph"]["built_at_commit"], "abc");
        assert_eq!(v["nodes"][1]["source_location"], "L2");
        let (back, _) = from_json(&v).unwrap();
        assert_eq!(back.nodes, g.nodes);
        assert_eq!(back.edges, g.edges);
    }

    #[test]
    fn graph_html_內嵌資料且不會被名稱提早結束_script() {
        let g = sample();
        let a = analyze(&g);
        let html = to_html(&g, &a, &Meta { project: "demo", built_at: "now", commit: None });
        assert!(html.contains("const DATA = {") && !html.contains("/*__GRAPH__*/"));
        assert_eq!(html.matches("</script>").count(), 1);
    }

    #[test]
    fn 舊版_graph_html_讀取時換上目前的互動圖_資料不變() {
        let g = sample();
        let a = analyze(&g);
        let html = to_html(&g, &a, &Meta { project: "demo", built_at: "now", commit: None });
        let old = html.replace("雙擊重新置中", "舊版提示").replace("\n", "\r\n");
        assert_eq!(refresh_html(&old), html);
        assert_eq!(refresh_html(&html), html);
        assert_eq!(refresh_html(""), "");
        assert_eq!(refresh_html("<html>別的頁面</html>"), "<html>別的頁面</html>");
    }
}

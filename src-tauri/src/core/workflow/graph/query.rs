//! 查詢圖譜（對應 graphify 的 query／path／explain）：只回傳和問題有關的一小塊子圖，取代整個專案搜尋。
//! 評分沿用 graphify：名稱完全相符 1000、開頭相符 100、包含 1、檔案路徑包含 0.5，乘上詞的稀有度（IDF）；
//! 取最多 3 個起點，往外走 2 層，不展開非起點的大型樞紐；輸出超過 token 預算時截斷並註明。
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use super::analyze::Analysis;
use super::resolve::Graph;

const STOPWORDS: [&str; 24] = ["the", "and", "for", "with", "from", "into", "that", "this", "what", "how", "why", "does", "are", "is", "of", "to", "in", "on", "a", "an", "fn", "function", "class", "method"];

/// 問題拆成詞：英數字串，駝峰與底線也拆開；中文不拆（圖譜的名稱是程式識別字）。
pub fn terms(text: &str) -> Vec<String> {
    let mut out = BTreeSet::new();
    for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_')) {
        if word.len() < 2 {
            continue;
        }
        let whole = word.to_ascii_lowercase();
        if !STOPWORDS.contains(&whole.as_str()) {
            out.insert(whole);
        }
        for part in split_identifier(word) {
            if part.len() >= 3 && !STOPWORDS.contains(&part.as_str()) {
                out.insert(part);
            }
        }
    }
    out.into_iter().collect()
}

fn split_identifier(word: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let chars: Vec<char> = word.chars().collect();
    for (i, &c) in chars.iter().enumerate() {
        let boundary = c == '_' || (c.is_uppercase() && i > 0 && (chars[i - 1].is_lowercase() || chars.get(i + 1).is_some_and(|n| n.is_lowercase())));
        if boundary && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        }
        if c != '_' {
            current.push(c.to_ascii_lowercase());
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn norm(label: &str) -> String {
    label.trim_end_matches("()").to_ascii_lowercase()
}

/// 節點分數（越高越相關）。
pub fn score_nodes(g: &Graph, query: &str) -> Vec<(usize, f64)> {
    let terms = terms(query);
    if terms.is_empty() {
        return vec![];
    }
    let labels: Vec<String> = g.nodes.iter().map(|n| norm(&n.label)).collect();
    let total = g.nodes.len() as f64;
    let idf: HashMap<&str, f64> = terms.iter().map(|t| {
        let df = labels.iter().filter(|l| l.contains(t.as_str())).count() as f64;
        (t.as_str(), (total / (1.0 + df)).ln().max(0.0) + 1.0)
    }).collect();
    let whole = norm(query.trim());
    let mut scored = Vec::new();
    for (i, n) in g.nodes.iter().enumerate() {
        let label = &labels[i];
        let short = label.rsplit('.').next().unwrap_or(label);
        let mut label_score = 0.0;
        let mut matched = 0;
        let mut file_score = 0.0;
        for t in &terms {
            let tier = if short == t || label == t { 1000.0 } else if short.starts_with(t.as_str()) { 100.0 } else if label.contains(t.as_str()) { 1.0 } else { 0.0 };
            if tier > 0.0 {
                matched += 1;
                label_score += tier * idf[t.as_str()];
            } else if n.file.to_ascii_lowercase().contains(t.as_str()) {
                file_score += 0.5 * idf[t.as_str()];
            }
        }
        let coverage = matched as f64 / terms.len() as f64;
        let mut score = label_score * coverage * coverage + file_score;
        if !whole.is_empty() && (*label == whole || short == whole) {
            score *= 10.0;
        }
        if score > 0.0 {
            scored.push((i, score));
        }
    }
    scored.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.cmp(&b.0)));
    scored
}

/// 起點：最多 3 個，分數低於第一名 80% 的不算。
fn seeds(scored: &[(usize, f64)]) -> Vec<usize> {
    let Some(&(_, top)) = scored.first() else { return vec![] };
    scored.iter().take(3).filter(|(_, s)| *s >= top * 0.8).map(|(i, _)| *i).collect()
}

fn location(g: &Graph, i: usize) -> String {
    let n = &g.nodes[i];
    if n.line > 0 { format!("{}:L{}", n.file, n.line) } else { n.file.clone() }
}

fn node_line(g: &Graph, a: &Analysis, i: usize) -> String {
    let n = &g.nodes[i];
    let loc = if n.line > 0 { format!(" loc=L{}", n.line) } else { String::new() };
    format!("NODE {} [src={}{loc} community={}]", n.label, n.file, a.communities[a.community[i]].name)
}

/// 子圖裡兩端都被走到的關係。
fn edge_lines(g: &Graph, a: &Analysis, visited: &BTreeSet<usize>) -> Vec<String> {
    g.edges.iter().filter_map(|e| {
        let (s, t) = (*a.index.get(&e.source)?, *a.index.get(&e.target)?);
        (visited.contains(&s) && visited.contains(&t) && e.relation != "contains").then(|| {
            format!("EDGE {} --{} [{} {:.2}]--> {} at={}", g.nodes[s].label, e.relation, e.confidence, e.score(), g.nodes[t].label, location(g, s))
        })
    }).collect()
}

/// graphify 的 query：回傳文字結果；找不到相關節點時回傳 None。budget 是大約的 token 數（3 個字元約一個 token）。
pub fn query(g: &Graph, a: &Analysis, question: &str, budget: usize) -> Option<String> {
    let seeds = seeds(&score_nodes(g, question));
    if seeds.is_empty() {
        return None;
    }
    // 大型樞紐（連接數 ≥ max(50, 前 1%)）除非是起點，否則不往外展開，免得一次帶出半個專案。
    let mut sorted: Vec<usize> = a.degree.clone();
    sorted.sort_unstable();
    let p99 = sorted.get(sorted.len().saturating_sub(1) * 99 / 100).copied().unwrap_or(0);
    let hub = 50usize.max(p99);
    let mut hop: BTreeMap<usize, usize> = seeds.iter().map(|s| (*s, 0)).collect();
    let mut queue: VecDeque<usize> = seeds.iter().copied().collect();
    while let Some(v) = queue.pop_front() {
        let d = hop[&v];
        if d >= 2 || (d > 0 && a.degree[v] >= hub) {
            continue;
        }
        for &w in &a.neighbors[v] {
            if let std::collections::btree_map::Entry::Vacant(slot) = hop.entry(w) {
                slot.insert(d + 1);
                queue.push_back(w);
            }
        }
    }
    let mut order: Vec<usize> = hop.keys().copied().collect();
    order.sort_by(|x, y| hop[x].cmp(&hop[y]).then(a.degree[*y].cmp(&a.degree[*x])).then(x.cmp(y)));
    let start: Vec<String> = seeds.iter().map(|s| g.nodes[*s].label.clone()).collect();
    let limit = budget * 3;
    let header = format!("圖譜查詢 | 走訪：BFS depth=2 | 起點：[{}] | 找到 {} 個節點", start.join(", "), order.len());
    let mut out = vec![header];
    let mut used = out[0].len();
    let mut shown = BTreeSet::new();
    for &i in &order {
        let line = node_line(g, a, i);
        if used + line.len() > limit * 2 / 3 {
            break;
        }
        used += line.len() + 1;
        shown.insert(i);
        out.push(line);
    }
    for line in edge_lines(g, a, &shown) {
        if used + line.len() > limit {
            break;
        }
        used += line.len() + 1;
        out.push(line);
    }
    if shown.len() < order.len() {
        out.push(format!("[!] 已截斷：只顯示 {} / {} 個節點，請縮小問題範圍", shown.len(), order.len()));
    }
    Some(out.join("\n"))
}

/// 名稱找節點：完全相符優先，其次是查詢分數最高的。
pub fn find(g: &Graph, name: &str) -> Option<usize> {
    let wanted = norm(name);
    g.nodes.iter().position(|n| n.id == name || norm(&n.label) == wanted).or_else(|| score_nodes(g, name).first().map(|(i, _)| *i))
}

/// graphify 的 path：兩個節點之間的最短路徑（先照關係方向走，contains 可以反向；找不到再當成無向圖），並標出最弱的一跳。
pub fn path(g: &Graph, a: &Analysis, from: &str, to: &str) -> String {
    let (Some(s), Some(t)) = (find(g, from), find(g, to)) else { return format!("找不到節點：{}", if find(g, from).is_none() { from } else { to }) };
    let mut directed: Vec<Vec<(usize, usize, bool)>> = vec![vec![]; g.nodes.len()];
    let mut undirected: Vec<Vec<(usize, usize, bool)>> = vec![vec![]; g.nodes.len()];
    for (k, e) in g.edges.iter().enumerate() {
        let (Some(&x), Some(&y)) = (a.index.get(&e.source), a.index.get(&e.target)) else { continue };
        directed[x].push((y, k, true));
        if e.relation == "contains" || e.relation == "method" {
            directed[y].push((x, k, false));
        }
        undirected[x].push((y, k, true));
        undirected[y].push((x, k, false));
    }
    let bfs = |adj: &Vec<Vec<(usize, usize, bool)>>| -> Option<Vec<(usize, usize, bool)>> {
        let mut prev: HashMap<usize, (usize, usize, bool)> = HashMap::new();
        let mut queue = VecDeque::from([s]);
        let mut seen = BTreeSet::from([s]);
        while let Some(v) = queue.pop_front() {
            if v == t {
                let mut hops = Vec::new();
                let mut cur = t;
                while cur != s {
                    let (p, k, forward) = prev[&cur];
                    hops.push((cur, k, forward));
                    cur = p;
                }
                hops.reverse();
                return Some(hops);
            }
            for &(w, k, forward) in &adj[v] {
                if seen.insert(w) {
                    prev.insert(w, (v, k, forward));
                    queue.push_back(w);
                }
            }
        }
        None
    };
    let Some(hops) = bfs(&directed).or_else(|| bfs(&undirected)) else { return format!("{} 與 {} 之間沒有路徑", g.nodes[s].label, g.nodes[t].label) };
    let mut line = g.nodes[s].label.clone();
    let mut weakest: Option<(f64, usize, &str)> = None;
    for (n, (node, k, forward)) in hops.iter().enumerate() {
        let e = &g.edges[*k];
        line.push_str(&if *forward { format!(" --{} [{} {:.2}]--> {}", e.relation, e.confidence, e.score(), g.nodes[*node].label) } else { format!(" <--{}-- {}", e.relation, g.nodes[*node].label) });
        if weakest.is_none_or(|(w, ..)| e.score() < w) {
            weakest = Some((e.score(), n + 1, e.relation));
        }
    }
    let (score, at, relation) = weakest.unwrap_or((1.0, 0, ""));
    format!("最短路徑（{} 跳）：\n  {line}\n路徑信心度：{score:.2}（最弱的是第 {at} 跳：{relation}）", hops.len())
}

/// graphify 的 explain：一個節點的基本資料與連接（依鄰居的連接數排序，前 20 個）。
pub fn explain(g: &Graph, a: &Analysis, name: &str) -> String {
    let Some(i) = find(g, name) else { return format!("找不到節點：{name}") };
    let n = &g.nodes[i];
    let mut lines = vec![
        format!("節點：{}", n.label), format!("ID：{}", n.id), format!("位置：{}", location(g, i)),
        format!("種類：{}", n.kind), format!("分群：{}", a.communities[a.community[i]].name), format!("連接數：{}", a.degree[i]),
    ];
    let mut connections: Vec<(usize, String)> = g.edges.iter().filter_map(|e| {
        let (s, t) = (*a.index.get(&e.source)?, *a.index.get(&e.target)?);
        if s == i {
            Some((t, format!("--> {} [{}] [{}] {}", g.nodes[t].label, e.relation, e.confidence, location(g, t))))
        } else if t == i {
            Some((s, format!("<-- {} [{}] [{}] {}", g.nodes[s].label, e.relation, e.confidence, location(g, s))))
        } else {
            None
        }
    }).collect();
    connections.sort_by(|x, y| a.degree[y.0].cmp(&a.degree[x.0]).then(x.1.cmp(&y.1)));
    lines.push(format!("連接（{}）：", connections.len()));
    lines.extend(connections.iter().take(20).map(|(_, l)| format!("  {l}")));
    if connections.len() > 20 {
        lines.push(format!("  …另外 {} 個", connections.len() - 20));
    }
    lines.join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::graph::analyze::analyze;
    use crate::core::graph::extract::{extract, Lang};
    use crate::core::graph::resolve::{build, FileInput};

    fn sample() -> Graph {
        let files = [
            ("src/store.ts", "export class OrderStore {\n  saveOrder() { validate(); }\n}\nexport function validate() {}\n"),
            ("src/api.ts", "import { OrderStore } from './store';\nexport function handleRequest() { new OrderStore().saveOrder(); }\n"),
            ("src/util.ts", "export function formatDate() {}\n"),
        ];
        build(&files.iter().map(|(p, s)| FileInput { path: p.to_string(), lang: Lang::of(p), facts: extract(Lang::of(p).unwrap(), s) }).collect::<Vec<_>>())
    }

    #[test]
    fn 問題拆詞_駝峰與底線也拆開() {
        assert_eq!(terms("修正 saveOrder 的 order_id 錯誤"), vec!["order", "order_id", "save", "saveorder"]);
    }

    #[test]
    fn query_從最相關的節點往外走兩層_超過預算會截斷() {
        let g = sample();
        let a = analyze(&g);
        let out = query(&g, &a, "saveOrder 驗證失敗", 2000).unwrap();
        assert!(out.starts_with("圖譜查詢 | 走訪：BFS depth=2 | 起點：[OrderStore.saveOrder()]"), "{out}");
        assert!(out.contains("NODE validate() [src=src/store.ts loc=L4"));
        assert!(out.contains("EDGE OrderStore.saveOrder() --calls [EXTRACTED 1.00]--> validate()"));
        assert!(!out.contains("formatDate"));
        assert!(query(&g, &a, "完全無關的中文", 2000).is_none());
        assert!(query(&g, &a, "saveOrder", 20).unwrap().contains("[!] 已截斷"));
    }

    #[test]
    fn path_與_explain() {
        let g = sample();
        let a = analyze(&g);
        let p = path(&g, &a, "handleRequest", "validate");
        assert!(p.starts_with("最短路徑（2 跳）") && p.contains("handleRequest() --calls") && p.contains("--> validate()"), "{p}");
        let e = explain(&g, &a, "validate");
        assert!(e.contains("節點：validate()") && e.contains("位置：src/store.ts:L4") && e.contains("<-- OrderStore.saveOrder() [calls] [EXTRACTED]"), "{e}");
        assert!(explain(&g, &a, "zzz").starts_with("找不到節點"));
    }
}

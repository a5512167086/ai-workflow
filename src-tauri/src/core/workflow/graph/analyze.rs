//! 圖譜分析，給 GRAPH_REPORT.md 與查詢使用。方法沿用 graphify：
//! Louvain 分群（過大的群再切一次）、凝聚度、依連接數排的核心節點、意外的關聯評分、循環匯入、
//! 不確定的關聯、知識缺口與樣板產生的建議問題（不呼叫 AI）。
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

use super::resolve::{Edge, Graph};

pub struct Community {
    pub id: usize,
    pub name: String,
    /// 依連接數由多到少。
    pub members: Vec<usize>,
    pub cohesion: f64,
}

pub struct Analysis {
    /// 節點 id → 在 graph.nodes 的位置。
    pub index: HashMap<String, usize>,
    /// 無向的鄰居（去掉重複），依節點位置。
    pub neighbors: Vec<BTreeSet<usize>>,
    pub degree: Vec<usize>,
    pub community: Vec<usize>,
    pub communities: Vec<Community>,
    /// 少於 3 個非檔案節點的群：報告裡不列出。
    pub thin: BTreeSet<usize>,
    pub god_nodes: Vec<usize>,
    /// （邊的位置，分數）。
    pub surprising: Vec<(usize, u32)>,
    pub cycles: Vec<Vec<String>>,
    pub ambiguous: Vec<usize>,
    pub isolated: Vec<usize>,
    /// （問題，為什麼問）。
    pub questions: Vec<(String, String)>,
}

const MIN_COMMUNITY: usize = 3;

pub fn analyze(g: &Graph) -> Analysis {
    let index: HashMap<String, usize> = g.nodes.iter().enumerate().map(|(i, n)| (n.id.clone(), i)).collect();
    let n = g.nodes.len();
    let mut neighbors = vec![BTreeSet::new(); n];
    let mut weights: BTreeMap<(usize, usize), f64> = BTreeMap::new();
    for e in &g.edges {
        let (Some(&a), Some(&b)) = (index.get(&e.source), index.get(&e.target)) else { continue };
        neighbors[a].insert(b);
        neighbors[b].insert(a);
        let key = (a.min(b), a.max(b));
        // 不確定的關聯在分群時只算一半（graphify 的 AMBIGUOUS 權重）。
        *weights.entry(key).or_insert(0.0) += if e.confidence == "AMBIGUOUS" { 0.5 } else { 1.0 };
    }
    let degree: Vec<usize> = neighbors.iter().map(|s| s.len()).collect();
    let community = communities_of(n, &weights);
    let is_file = |i: usize| g.nodes[i].kind == "file";
    let mut groups: BTreeMap<usize, Vec<usize>> = BTreeMap::new();
    for (i, c) in community.iter().enumerate() {
        groups.entry(*c).or_default().push(i);
    }
    let mut communities: Vec<Community> = groups.into_values().map(|mut members| {
        members.sort_by(|a, b| degree[*b].cmp(&degree[*a]).then(a.cmp(b)));
        let set: BTreeSet<usize> = members.iter().copied().collect();
        let internal = weights.keys().filter(|(a, b)| set.contains(a) && set.contains(b)).count();
        let size = members.len();
        let cohesion = if size > 1 { internal as f64 / (size * (size - 1) / 2) as f64 } else { 0.0 };
        // 名稱：連接最多的成員（graphify 的 label_communities_by_hub），優先用非檔案節點。
        let hub = members.iter().copied().find(|i| !is_file(*i)).unwrap_or(members[0]);
        Community { id: 0, name: g.nodes[hub].label.trim_end_matches("()").to_string(), members, cohesion }
    }).collect();
    communities.sort_by(|a, b| b.members.len().cmp(&a.members.len()).then(a.members[0].cmp(&b.members[0])));
    let mut community = vec![0; n];
    for (id, c) in communities.iter_mut().enumerate() {
        c.id = id;
        for &m in &c.members {
            community[m] = id;
        }
    }
    let thin: BTreeSet<usize> = communities.iter().filter(|c| c.members.iter().filter(|m| !is_file(**m)).count() < MIN_COMMUNITY).map(|c| c.id).collect();

    // 核心節點：連接數最多的定義（檔案不算），前 10 個。
    let mut god_nodes: Vec<usize> = (0..n).filter(|i| !is_file(*i) && g.nodes[*i].kind != "module" && degree[*i] > 0).collect();
    god_nodes.sort_by(|a, b| degree[*b].cmp(&degree[*a]).then(a.cmp(b)));
    god_nodes.truncate(10);

    let surprising = surprising(g, &index, &degree, &community);
    let cycles = import_cycles(g);
    let ambiguous: Vec<usize> = g.edges.iter().enumerate().filter(|(_, e)| e.confidence == "AMBIGUOUS").map(|(i, _)| i).collect();
    // 孤立節點：幾乎沒有連接的定義；main 是程式進入點，本來就沒有人呼叫，不算。
    let isolated: Vec<usize> = (0..n).filter(|i| !is_file(*i) && degree[*i] <= 1 && g.nodes[*i].label != "main()").collect();
    let mut analysis = Analysis { index, neighbors, degree, community, communities, thin, god_nodes, surprising, cycles, ambiguous, isolated, questions: vec![] };
    analysis.questions = questions(g, &analysis);
    analysis
}

/// Louvain：反覆把節點移到模組度增益最大的鄰近群，再把群合成一個節點，直到不再變動。
/// 過大的群（超過 max(10, 25%) 個節點）在子圖上再切一次，與 graphify 相同。結果依節點順序決定，每次都一樣。
fn communities_of(n: usize, weights: &BTreeMap<(usize, usize), f64>) -> Vec<usize> {
    let mut labels = louvain(n, weights);
    let limit = 10usize.max(n / 4);
    let mut sizes: HashMap<usize, Vec<usize>> = HashMap::new();
    for (i, l) in labels.iter().enumerate() {
        sizes.entry(*l).or_default().push(i);
    }
    let mut next = n;
    let mut big: Vec<Vec<usize>> = sizes.into_values().filter(|m| m.len() > limit).collect();
    big.sort();
    for members in big {
        let local: HashMap<usize, usize> = members.iter().enumerate().map(|(i, m)| (*m, i)).collect();
        let sub: BTreeMap<(usize, usize), f64> = weights.iter().filter_map(|((a, b), w)| Some(((*local.get(a)?, *local.get(b)?), *w))).collect();
        let parts = louvain(members.len(), &sub);
        if parts.iter().collect::<BTreeSet<_>>().len() > 1 {
            for (i, m) in members.iter().enumerate() {
                labels[*m] = next + parts[i];
            }
            next += members.len();
        }
    }
    labels
}

fn louvain(n: usize, weights: &BTreeMap<(usize, usize), f64>) -> Vec<usize> {
    let mut assignment: Vec<usize> = (0..n).collect();
    let mut edges: Vec<(usize, usize, f64)> = weights.iter().map(|((a, b), w)| (*a, *b, *w)).collect();
    let mut size = n;
    for _level in 0..10 {
        let mut adj: Vec<Vec<(usize, f64)>> = vec![vec![]; size];
        let mut k = vec![0.0; size];
        let mut total = 0.0;
        for &(a, b, w) in &edges {
            if a == b {
                k[a] += 2.0 * w;
            } else {
                adj[a].push((b, w));
                adj[b].push((a, w));
                k[a] += w;
                k[b] += w;
            }
            total += w;
        }
        if total == 0.0 {
            break;
        }
        let m2 = 2.0 * total;
        let mut comm: Vec<usize> = (0..size).collect();
        let mut tot = k.clone();
        let mut moved_any = false;
        for _pass in 0..20 {
            let mut moved = false;
            for i in 0..size {
                let current = comm[i];
                tot[current] -= k[i];
                let mut links: BTreeMap<usize, f64> = BTreeMap::new();
                for &(j, w) in &adj[i] {
                    *links.entry(comm[j]).or_insert(0.0) += w;
                }
                let gain = |c: usize, kin: f64| kin - tot[c] * k[i] / m2;
                let mut best = (current, gain(current, links.get(&current).copied().unwrap_or(0.0)));
                for (&c, &kin) in &links {
                    let g = gain(c, kin);
                    if g > best.1 + 1e-12 {
                        best = (c, g);
                    }
                }
                comm[i] = best.0;
                tot[best.0] += k[i];
                if best.0 != current {
                    moved = true;
                    moved_any = true;
                }
            }
            if !moved {
                break;
            }
        }
        if !moved_any {
            break;
        }
        // 重新編號並合併成下一層的圖。
        let mut renumber: BTreeMap<usize, usize> = BTreeMap::new();
        for c in &comm {
            let next = renumber.len();
            renumber.entry(*c).or_insert(next);
        }
        for a in assignment.iter_mut() {
            *a = renumber[&comm[*a]];
        }
        let mut merged: BTreeMap<(usize, usize), f64> = BTreeMap::new();
        for &(a, b, w) in &edges {
            let (ca, cb) = (renumber[&comm[a]], renumber[&comm[b]]);
            *merged.entry((ca.min(cb), ca.max(cb))).or_insert(0.0) += w;
        }
        edges = merged.into_iter().map(|((a, b), w)| (a, b, w)).collect();
        size = renumber.len();
    }
    assignment
}

fn top_dir(path: &str) -> &str {
    path.split('/').next().unwrap_or("")
}

/// 意外的關聯：跨檔案、不是 import／contains／method 的關係，依 graphify 的評分挑前 5 名。
fn surprising(g: &Graph, index: &HashMap<String, usize>, degree: &[usize], community: &[usize]) -> Vec<(usize, u32)> {
    let mut scored: Vec<(usize, u32)> = Vec::new();
    for (i, e) in g.edges.iter().enumerate() {
        if matches!(e.relation, "imports" | "contains" | "method") {
            continue;
        }
        let (Some(&a), Some(&b)) = (index.get(&e.source), index.get(&e.target)) else { continue };
        let (na, nb) = (&g.nodes[a], &g.nodes[b]);
        if na.kind == "file" || nb.kind == "file" || na.file == nb.file {
            continue;
        }
        let mut score = match e.confidence { "AMBIGUOUS" => 3, "INFERRED" => 2, _ => 1 };
        // 跨語言的推斷呼叫多半是巧合同名，不加分。
        let bonus_ok = !(e.confidence == "INFERRED" && e.relation == "calls" && na.lang != nb.lang);
        if bonus_ok {
            if na.file_type != nb.file_type { score += 2; }
            if top_dir(&na.file) != top_dir(&nb.file) { score += 2; }
            if community[a] != community[b] { score += 1; }
            let (lo, hi) = (degree[a].min(degree[b]), degree[a].max(degree[b]));
            if lo <= 2 && hi >= 5 { score += 1; }
        }
        scored.push((i, score));
    }
    scored.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    // 同一對群只留一條，避免整份都是同一種關聯。
    let mut seen = BTreeSet::new();
    scored.retain(|(i, _)| {
        let e = &g.edges[*i];
        let (a, b) = (community[index[&e.source]], community[index[&e.target]]);
        seen.insert((a.min(b), a.max(b)))
    });
    scored.truncate(5);
    scored
}

/// 檔案之間的循環匯入（最多 5 個檔案一圈，列前 10 個），每個循環從路徑最小的檔案開始寫。
fn import_cycles(g: &Graph) -> Vec<Vec<String>> {
    let mut adj: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    // Rust 允許同一個 crate 裡的模組互相引用，不算問題；只檢查 JavaScript、TypeScript、Python 等會出錯的語言。
    let rust: BTreeSet<&str> = g.nodes.iter().filter(|n| n.kind == "file" && n.lang == "rust").map(|n| n.id.as_str()).collect();
    for e in g.edges.iter().filter(|e| e.relation == "imports" && !rust.contains(e.source.as_str())) {
        adj.entry(e.source.as_str()).or_default().push(e.target.as_str());
    }
    let mut cycles = Vec::new();
    fn dfs<'a>(start: &'a str, node: &'a str, adj: &BTreeMap<&'a str, Vec<&'a str>>, path: &mut Vec<&'a str>, out: &mut Vec<Vec<String>>) {
        if out.len() >= 10 {
            return;
        }
        for &next in adj.get(node).into_iter().flatten() {
            if next == start && path.len() >= 2 {
                out.push(path.iter().map(|s| s.to_string()).collect());
            } else if next > start && !path.contains(&next) && path.len() < 5 {
                path.push(next);
                dfs(start, next, adj, path, out);
                path.pop();
            }
        }
    }
    for &start in adj.keys() {
        dfs(start, start, &adj, &mut vec![start], &mut cycles);
    }
    cycles
}

/// 中介中心性（Brandes，無向、不加權）。超過 1000 個節點時只取 100 個起點估算。
fn betweenness(neighbors: &[BTreeSet<usize>]) -> Vec<f64> {
    let n = neighbors.len();
    let mut score = vec![0.0; n];
    let step = if n > 1000 { n / 100 } else { 1 };
    for s in (0..n).step_by(step.max(1)) {
        let mut stack = Vec::new();
        let mut preds: Vec<Vec<usize>> = vec![vec![]; n];
        let mut sigma = vec![0.0; n];
        let mut dist = vec![-1i64; n];
        sigma[s] = 1.0;
        dist[s] = 0;
        let mut queue = VecDeque::from([s]);
        while let Some(v) = queue.pop_front() {
            stack.push(v);
            for &w in &neighbors[v] {
                if dist[w] < 0 {
                    dist[w] = dist[v] + 1;
                    queue.push_back(w);
                }
                if dist[w] == dist[v] + 1 {
                    sigma[w] += sigma[v];
                    preds[w].push(v);
                }
            }
        }
        let mut delta = vec![0.0; n];
        while let Some(w) = stack.pop() {
            for &v in &preds[w] {
                delta[v] += sigma[v] / sigma[w] * (1.0 + delta[w]);
            }
            if w != s {
                score[w] += delta[w];
            }
        }
    }
    score
}

fn code(label: &str) -> String {
    format!("`{label}`")
}

/// 建議問題：依 graphify 的樣板，從不確定的關聯、橋接節點、推斷較多的核心節點、孤立節點、凝聚度低的大群各取幾題，輪流排列後取前 7 題。
fn questions(g: &Graph, a: &Analysis) -> Vec<(String, String)> {
    let label = |i: usize| g.nodes[i].label.clone();
    let group = |c: usize| format!("「{}」", a.communities[c].name);
    let mut kinds: Vec<Vec<(String, String)>> = Vec::new();
    kinds.push(a.ambiguous.iter().take(3).map(|&i| {
        let e: &Edge = &g.edges[i];
        let (s, t) = (a.index[&e.source], a.index[&e.target]);
        (format!("{} 實際上{}的是哪一個 {}？", code(&label(s)), if e.relation == "calls" { "呼叫" } else { "依賴" }, code(&label(t))), "同名的定義不只一個，圖譜無法確定".into())
    }).collect());
    let bc = betweenness(&a.neighbors);
    let mut bridges: Vec<usize> = (0..g.nodes.len()).filter(|i| g.nodes[*i].kind != "file" && bc[*i] > 0.0).collect();
    bridges.sort_by(|x, y| bc[*y].total_cmp(&bc[*x]).then(x.cmp(y)));
    kinds.push(bridges.into_iter().take(3).filter_map(|i| {
        let mut groups: Vec<usize> = a.neighbors[i].iter().map(|n| a.community[*n]).filter(|c| *c != a.community[i]).collect::<BTreeSet<_>>().into_iter().collect();
        groups.truncate(2);
        let others = groups.iter().map(|c| group(*c)).collect::<Vec<_>>().join("與");
        (!others.is_empty()).then(|| (format!("{} 為什麼連接{}和{others}？", code(&label(i)), group(a.community[i])), "它是不同分群之間的主要橋樑，改動會影響多個區塊".into()))
    }).collect());
    kinds.push(a.god_nodes.iter().take(5).filter_map(|&i| {
        let inferred = g.edges.iter().filter(|e| e.confidence == "INFERRED" && (e.source == g.nodes[i].id || e.target == g.nodes[i].id)).count();
        (inferred >= 2).then(|| (format!("{} 的 {inferred} 條推斷關係都正確嗎？", code(&label(i))), "核心節點的關係有一部分是依名稱推斷，值得確認".into()))
    }).collect());
    kinds.push(a.isolated.iter().take(2).map(|&i| (format!("{} 還有被用到嗎？", code(&label(i))), "它幾乎沒有和其他程式連接".into())).collect());
    kinds.push(a.communities.iter().filter(|c| c.members.len() >= 5 && c.cohesion < 0.15 && !a.thin.contains(&c.id)).take(2)
        .map(|c| (format!("{}是否該拆成幾個更小的模組？", group(c.id)), format!("凝聚度只有 {:.2}，成員之間連接很少", c.cohesion))).collect());
    let mut out = Vec::new();
    let mut round = 0;
    while out.len() < 7 && kinds.iter().any(|k| k.len() > round) {
        for k in &kinds {
            if let Some(q) = k.get(round) {
                if out.len() < 7 && !out.iter().any(|(text, _): &(String, String)| *text == q.0) {
                    out.push(q.clone());
                }
            }
        }
        round += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::graph::extract::{extract, Lang};
    use crate::core::graph::resolve::{build, FileInput};

    fn input(path: &str, src: &str) -> FileInput {
        let lang = Lang::of(path);
        FileInput { path: path.into(), lang, facts: lang.map(|l| extract(l, src)).unwrap_or_default() }
    }

    #[test]
    fn louvain_把兩組緊密相連的節點分開() {
        // 兩個三角形，中間一條邊相連。
        let w: BTreeMap<(usize, usize), f64> = [((0, 1), 1.0), ((1, 2), 1.0), ((0, 2), 1.0), ((3, 4), 1.0), ((4, 5), 1.0), ((3, 5), 1.0), ((2, 3), 1.0)].into_iter().collect();
        let c = louvain(6, &w);
        assert_eq!(c[0], c[1]);
        assert_eq!(c[1], c[2]);
        assert_eq!(c[3], c[4]);
        assert_ne!(c[0], c[3]);
    }

    #[test]
    fn 分析找出核心節點_循環匯入_不確定關聯與孤立節點() {
        let g = build(&[
            input("app/a.py", "from app import b\ndef core():\n    pass\ndef one():\n    core()\ndef two():\n    core()\ndef three():\n    core()\n"),
            input("app/b.py", "from app import a\ndef helper():\n    core()\ndef lonely():\n    pass\n"),
            input("lib/x.py", "def dup():\n    pass\n"),
            input("lib/y.py", "def dup():\n    pass\n"),
            input("lib/z.py", "def use():\n    dup()\n"),
        ]);
        let a = analyze(&g);
        assert_eq!(g.nodes[a.god_nodes[0]].label, "core()");
        assert_eq!(a.cycles, vec![vec!["app/a.py".to_string(), "app/b.py".to_string()]]);
        assert_eq!(a.ambiguous.len(), 2);
        assert!(a.isolated.iter().any(|i| g.nodes[*i].label == "lonely()"));
        assert!(a.questions.iter().any(|(q, _)| q.contains("`use()` 實際上呼叫的是哪一個 `dup()`")), "{:?}", a.questions);
        assert!(a.communities.iter().all(|c| c.cohesion >= 0.0 && c.cohesion <= 1.0));
        // 分群依大小排序，id 從 0 開始。
        assert!(a.communities.windows(2).all(|w| w[0].members.len() >= w[1].members.len()));
    }
}

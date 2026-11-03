//! GRAPH_REPORT.md：人看得懂的結構報告，章節依 graphify 的順序（中文）。沒有內容的章節不寫。
use std::collections::BTreeMap;

use super::analyze::{Analysis, Community};
use super::resolve::Graph;

pub struct Stats {
    pub project: String,
    pub date: String,
    pub commit: Option<String>,
    pub parsed: usize,
    pub reused: usize,
}

fn lang_name(lang: &str) -> &str {
    match lang {
        "rust" => "Rust",
        "javascript" => "JavaScript",
        "typescript" => "TypeScript",
        "python" => "Python",
        "go" => "Go",
        "java" => "Java",
        other => other,
    }
}

fn percent(part: usize, total: usize) -> String {
    if total == 0 { "0%".into() } else { format!("{:.0}%", part as f64 * 100.0 / total as f64) }
}

pub fn generate(g: &Graph, a: &Analysis, s: &Stats) -> String {
    let r = Report { g, a };
    let mut out = vec![format!("# 專案圖譜報告 - {}（{}）", s.project, s.date)];
    r.corpus(&mut out);
    r.summary(s, &mut out);
    if let Some(commit) = &s.commit {
        out.push("\n## 圖譜新鮮度".into());
        out.push(format!("- 建立自 commit `{}`；之後的改動會在下一次實作或修正前自動更新，也可以在「架構圖」分頁重建", &commit[..8.min(commit.len())]));
    }
    r.community_nav(&mut out);
    r.god_nodes(&mut out);
    r.surprising(&mut out);
    r.cycles(&mut out);
    r.communities(&mut out);
    r.ambiguous(&mut out);
    r.gaps(&mut out);
    r.questions(&mut out);
    out.join("\n") + "\n"
}

/// 報告的各個章節；每個方法把自己的章節接到 out 後面，沒有內容就不寫。
struct Report<'a> {
    g: &'a Graph,
    a: &'a Analysis,
}

impl Report<'_> {
    fn label(&self, i: usize) -> String {
        format!("`{}`", self.g.nodes[i].label)
    }

    /// 節點的位置：定義寫成「檔案:L行號」，檔案只寫路徑。
    fn at(&self, i: usize) -> String {
        let n = &self.g.nodes[i];
        if n.line > 0 { format!("{}:L{}", n.file, n.line) } else { n.file.clone() }
    }

    fn count(&self, confidence: &str) -> usize {
        self.g.edges.iter().filter(|e| e.confidence == confidence).count()
    }

    fn visible(&self) -> Vec<&Community> {
        self.a.communities.iter().filter(|c| !self.a.thin.contains(&c.id)).collect()
    }

    fn corpus(&self, out: &mut Vec<String>) {
        let g = self.g;
        let files: Vec<usize> = (0..g.nodes.len()).filter(|i| g.nodes[*i].kind == "file").collect();
        let mut by_lang: BTreeMap<&str, usize> = BTreeMap::new();
        for &i in &files {
            if g.nodes[i].lang != "other" {
                *by_lang.entry(lang_name(&g.nodes[i].lang)).or_default() += 1;
            }
        }
        let parsed_files: usize = by_lang.values().sum();
        out.push("\n## 語料檢查".into());
        let langs = by_lang.iter().map(|(l, n)| format!("{l} {n}")).collect::<Vec<_>>().join("、");
        out.push(format!("- {} 個檔案 · 以 tree-sitter 解析 {parsed_files} 個{}", files.len(), if langs.is_empty() { String::new() } else { format!("（{langs}）") }));
        if files.len() > parsed_files {
            out.push(format!("- 未解析 {} 個：文件、設定檔與不支援的語言，只列為檔案節點", files.len() - parsed_files));
        }
    }

    fn summary(&self, s: &Stats, out: &mut Vec<String>) {
        let (g, a) = (self.g, self.a);
        let edges = g.edges.len();
        let (extracted, inferred, ambiguous) = (self.count("EXTRACTED"), self.count("INFERRED"), self.count("AMBIGUOUS"));
        let shown = a.communities.len() - a.thin.len();
        out.push("\n## 摘要".into());
        out.push(format!("- {} 個節點 · {edges} 條關係 · {} 個分群（列出 {shown} 個，{} 個過小省略）", g.nodes.len(), a.communities.len(), a.thin.len()));
        out.push(format!("- 抽取：{} EXTRACTED · {} INFERRED · {} AMBIGUOUS{}", percent(extracted, edges), percent(inferred, edges), percent(ambiguous, edges), if inferred > 0 { format!(" · INFERRED：{inferred} 條（平均信心度 0.85）") } else { String::new() }));
        out.push(format!("- 成本：0 AI token（本機 tree-sitter 解析）· 這次解析 {} 個檔案，沿用快取 {} 個", s.parsed, s.reused));
    }

    fn community_nav(&self, out: &mut Vec<String>) {
        let visible = self.visible();
        if visible.is_empty() {
            return;
        }
        out.push("\n## 分群導覽".into());
        for c in &visible {
            out.push(format!("- 群 {}「{}」（{} 個節點）", c.id, c.name, c.members.len()));
        }
    }

    fn god_nodes(&self, out: &mut Vec<String>) {
        let a = self.a;
        if a.god_nodes.is_empty() {
            return;
        }
        out.push("\n## 核心節點（連接最多，專案的核心抽象）".into());
        for (rank, &i) in a.god_nodes.iter().enumerate() {
            out.push(format!("{}. {} - {} 條關係（{}）", rank + 1, self.label(i), a.degree[i], self.at(i)));
        }
    }

    fn surprising(&self, out: &mut Vec<String>) {
        let (g, a) = (self.g, self.a);
        if a.surprising.is_empty() {
            return;
        }
        out.push("\n## 意外的關聯（你可能不知道）".into());
        for &(k, _) in &a.surprising {
            let e = &g.edges[k];
            let (s, t) = (a.index[&e.source], a.index[&e.target]);
            out.push(format!("- {} --{}--> {}  [{} {:.2}]", self.label(s), e.relation, self.label(t), e.confidence, e.score()));
            out.push(format!("  {} → {}", g.nodes[s].file, g.nodes[t].file));
        }
    }

    fn cycles(&self, out: &mut Vec<String>) {
        let a = self.a;
        if a.cycles.is_empty() {
            return;
        }
        out.push("\n## 循環匯入".into());
        for cycle in &a.cycles {
            out.push(format!("- {} 個檔案的循環：`{} -> {}`", cycle.len(), cycle.join(" -> "), cycle[0]));
        }
    }

    fn communities(&self, out: &mut Vec<String>) {
        let (g, a) = (self.g, self.a);
        let visible = self.visible();
        if visible.is_empty() {
            return;
        }
        out.push(format!("\n## 分群（共 {} 個，省略 {} 個過小的）", a.communities.len(), a.thin.len()));
        for c in &visible {
            out.push(format!("\n### 群 {} -「{}」", c.id, c.name));
            out.push(format!("凝聚度：{:.2}", c.cohesion));
            let names: Vec<String> = c.members.iter().take(8).map(|m| g.nodes[*m].label.clone()).collect();
            let more = c.members.len().saturating_sub(8);
            out.push(format!("節點（{}）：{}{}", c.members.len(), names.join("、"), if more > 0 { format!("（還有 {more} 個）") } else { String::new() }));
        }
    }

    fn ambiguous(&self, out: &mut Vec<String>) {
        let (g, a) = (self.g, self.a);
        if a.ambiguous.is_empty() {
            return;
        }
        out.push("\n## 不確定的關聯（請檢查）".into());
        for &k in a.ambiguous.iter().take(15) {
            let e = &g.edges[k];
            let (s, t) = (a.index[&e.source], a.index[&e.target]);
            out.push(format!("- {} --{}--> {}  [AMBIGUOUS 0.20]  {}", self.label(s), e.relation, self.label(t), self.at(s)));
        }
        if a.ambiguous.len() > 15 {
            out.push(format!("- 還有 {} 條", a.ambiguous.len() - 15));
        }
    }

    fn gaps(&self, out: &mut Vec<String>) {
        let a = self.a;
        let edges = self.g.edges.len();
        let ambiguous = self.count("AMBIGUOUS");
        let mut gaps = Vec::new();
        if !a.isolated.is_empty() {
            let names: Vec<String> = a.isolated.iter().take(5).map(|i| self.label(*i)).collect();
            gaps.push(format!("- {} 個孤立節點（連接 ≤ 1）：{}{}", a.isolated.len(), names.join("、"), if a.isolated.len() > 5 { "…" } else { "" }));
        }
        if !a.thin.is_empty() {
            gaps.push(format!("- {} 個過小的分群（少於 3 個定義）", a.thin.len()));
        }
        if edges > 0 && ambiguous * 5 > edges {
            gaps.push(format!("- 不確定的關聯占 {}：同名的定義很多，推斷出來的關係要小心", percent(ambiguous, edges)));
        }
        if !gaps.is_empty() {
            out.push("\n## 知識缺口".into());
            out.extend(gaps);
        }
    }

    fn questions(&self, out: &mut Vec<String>) {
        let a = self.a;
        if a.questions.is_empty() {
            return;
        }
        out.push("\n## 建議問題".into());
        for (q, why) in &a.questions {
            out.push(format!("- **{q}**  _{why}_"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::graph::analyze::analyze;
    use crate::core::graph::extract::{extract, Lang};
    use crate::core::graph::resolve::{build, FileInput};

    #[test]
    fn 報告依_graphify_的章節順序_沒有內容的章節不寫() {
        let files = [
            ("app/a.py", "from app import b\ndef core():\n    pass\ndef one():\n    core()\ndef two():\n    core()\n"),
            ("app/b.py", "from app import a\ndef helper():\n    core()\n"),
        ];
        let mut inputs: Vec<FileInput> = files.iter().map(|(p, s)| FileInput { path: p.to_string(), lang: Lang::of(p), facts: extract(Lang::of(p).unwrap(), s) }).collect();
        inputs.push(FileInput { path: "README.md".into(), lang: None, facts: Default::default() });
        let g = build(&inputs);
        let a = analyze(&g);
        let report = generate(&g, &a, &Stats { project: "demo".into(), date: "2026-11-02".into(), commit: Some("abcdef1234".into()), parsed: 2, reused: 0 });
        let order = ["# 專案圖譜報告 - demo（2026-11-02）", "## 語料檢查", "## 摘要", "## 圖譜新鮮度", "## 核心節點", "## 循環匯入"];
        let positions: Vec<usize> = order.iter().map(|h| report.find(h).unwrap_or_else(|| panic!("缺少 {h}\n{report}"))).collect();
        assert!(positions.windows(2).all(|w| w[0] < w[1]), "{report}");
        assert!(report.contains("以 tree-sitter 解析 2 個（Python 2）") && report.contains("未解析 1 個"));
        assert!(report.contains("1. `core()` - 4 條關係（app/a.py:L2）"), "{report}");
        assert!(report.contains("`app/a.py -> app/b.py -> app/a.py`"));
        assert!(report.contains("commit `abcdef12`"));
        assert!(!report.contains("## 不確定的關聯"));
    }
}

//! 把各檔案的事實接成一張圖：import 解析成檔案、呼叫與繼承依名稱接到定義。
//! 關係與信心度沿用 graphify 的定義：
//! - EXTRACTED（1.0）：原始碼明確寫出——import 到的檔案、同一個類別或檔案裡的定義、已 import 檔案裡的定義。
//! - INFERRED（0.85）：只靠全專案（同語言）唯一的名稱推斷。
//! - AMBIGUOUS（0.2）：同名的定義有 2–3 個，各連一條，留給人或 AI 判斷；更多就不連線。
//!
//! 呼叫的寫法（見 extract::Walker::callee）決定能接到哪些定義：`foo` 接函式與型別、`@foo` 接同一個類別的方法、
//! `Type.foo` 接該型別的方法、`.foo` 只接方法且不做全專案推斷（型別未知，像 `vec.push()` 不能接到專案裡的 push）。
use std::collections::{BTreeMap, BTreeSet, HashMap};

use super::extract::{Facts, Lang};

#[derive(Clone, Debug, PartialEq)]
pub struct Node {
    /// 檔案是相對路徑；定義是「路徑#名稱」，方法的名稱是「類別.方法」。
    pub id: String,
    /// 顯示名稱（graphify 的寫法）：檔案用檔名，函式與方法加上 ()。
    pub label: String,
    /// file、function、method、class、struct、enum、trait、interface、type、module、const、macro。
    pub kind: String,
    /// code、document、paper、image。
    pub file_type: String,
    pub file: String,
    pub line: usize,
    pub lang: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Edge {
    pub source: String,
    pub target: String,
    /// contains、method、imports、calls、inherits、implements。
    pub relation: &'static str,
    /// EXTRACTED、INFERRED、AMBIGUOUS。
    pub confidence: &'static str,
    pub weight: usize,
}

impl Edge {
    pub fn score(&self) -> f64 {
        confidence_score(self.confidence)
    }
}

pub fn confidence_score(confidence: &str) -> f64 {
    match confidence {
        "EXTRACTED" => 1.0,
        "INFERRED" => 0.85,
        _ => 0.2,
    }
}

#[derive(Default, Debug)]
pub struct Graph {
    pub nodes: Vec<Node>,
    pub edges: Vec<Edge>,
}

pub struct FileInput {
    pub path: String,
    pub lang: Option<Lang>,
    pub facts: Facts,
}

fn file_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "md" | "markdown" | "txt" | "rst" | "adoc" => "document",
        "pdf" => "paper",
        "png" | "jpg" | "jpeg" | "gif" | "svg" | "webp" | "ico" => "image",
        _ => "code",
    }
}

fn label_of(name: &str, kind: &str) -> String {
    if matches!(kind, "function" | "method") { format!("{name}()") } else { name.to_string() }
}

/// 一個定義在名稱索引裡的資料。
struct Entry<'a> {
    id: String,
    file: &'a str,
    lang: Option<Lang>,
    kind: &'a str,
}

pub fn build(files: &[FileInput]) -> Graph {
    let paths: BTreeSet<&str> = files.iter().map(|f| f.path.as_str()).collect();
    let mut graph = Graph::default();
    // 名稱索引：最後一段名稱（方法用方法名）→ 定義；完整名稱（Type.method）→ 定義。
    let mut by_name: HashMap<&str, Vec<Entry>> = HashMap::new();
    let mut by_qual: HashMap<&str, Vec<Entry>> = HashMap::new();
    for f in files {
        let lang = f.lang.map(|l| l.name()).unwrap_or("other");
        graph.nodes.push(Node { id: f.path.clone(), label: file_name(&f.path).into(), kind: "file".into(), file_type: file_type(&f.path).into(), file: f.path.clone(), line: 0, lang: lang.into() });
        for d in &f.facts.defs {
            let id = format!("{}#{}", f.path, d.name);
            graph.nodes.push(Node { id: id.clone(), label: label_of(&d.name, &d.kind), kind: d.kind.clone(), file_type: "code".into(), file: f.path.clone(), line: d.line, lang: lang.into() });
            let simple = d.name.rsplit('.').next().unwrap_or(&d.name);
            by_name.entry(simple).or_default().push(Entry { id: id.clone(), file: &f.path, lang: f.lang, kind: &d.kind });
            if d.name.contains('.') {
                by_qual.entry(&d.name).or_default().push(Entry { id, file: &f.path, lang: f.lang, kind: &d.kind });
            }
        }
    }
    let defined: BTreeSet<String> = graph.nodes.iter().map(|n| n.id.clone()).collect();
    let mut edges: BTreeMap<(String, String, &'static str), (&'static str, usize)> = BTreeMap::new();
    let mut add = |source: String, target: String, relation: &'static str, confidence: &'static str| {
        if source == target {
            return;
        }
        let entry = edges.entry((source, target, relation)).or_insert((confidence, 0));
        entry.1 += 1;
        // 同一條關係有多種證據時取最可靠的。
        if confidence_score(confidence) > confidence_score(entry.0) {
            entry.0 = confidence;
        }
    };
    let go_dirs = go_dirs(files);
    let mut imported: HashMap<&str, BTreeSet<String>> = HashMap::new();
    let mut rust_rest: Vec<(&str, String, Vec<String>)> = Vec::new();
    for f in files {
        // contains：檔案 → 頂層定義；method：類別 → 方法（graphify 的關係名稱）。
        for d in &f.facts.defs {
            let id = format!("{}#{}", f.path, d.name);
            match d.name.rsplit_once('.').map(|(p, _)| format!("{}#{p}", f.path)).filter(|p| defined.contains(p)) {
                Some(class) => add(class, id, if d.kind == "method" { "method" } else { "contains" }, "EXTRACTED"),
                None => add(f.path.clone(), id, "contains", "EXTRACTED"),
            }
        }
        let Some(lang) = f.lang else { continue };
        let targets = imported.entry(f.path.as_str()).or_default();
        for spec in &f.facts.imports {
            if lang == Lang::Rust {
                // Rust 的 `mod x;` 是父模組包含子模組，不是匯入；當成 contains，才不會和子模組的 `use crate::…` 算成循環匯入。
                if spec.starts_with("mod:") {
                    for target in resolve_rust(&f.path, spec, &paths) {
                        add(f.path.clone(), target, "contains", "EXTRACTED");
                    }
                } else if let Some((target, rest)) = rust_target(&f.path, spec, &paths) {
                    rust_rest.push((f.path.as_str(), target.clone(), rest));
                    targets.insert(target);
                }
                continue;
            }
            for target in resolve_import(&f.path, lang, spec, &paths, &go_dirs) {
                targets.insert(target);
            }
        }
    }
    // Rust 的 `pub use`：`use crate::core::state::x` 先解析到 core/mod.rs，mod.rs 又轉出 project::state，
    // 就改接到 project/state.rs（最多追三層）。
    // 中間的轉出檔（mod.rs）若別的 use 也沒有直接用到，就換成實際的檔案。
    let mut followed: Vec<(&str, String, String)> = Vec::new();
    for (from, original, mut rest) in rust_rest {
        let mut target = original.clone();
        for _ in 0..3 {
            let Some(next) = rest.first() else { break };
            let Some(found) = imported.get(target.as_str()).and_then(|t| t.iter().find(|p| module_name(p) == next.as_str()).cloned()) else { break };
            target = found;
            rest.remove(0);
        }
        followed.push((from, original, target));
    }
    let kept: BTreeSet<(&str, &str)> = followed.iter().filter(|(_, o, t)| o == t).map(|(f, o, _)| (*f, o.as_str())).collect();
    for (from, original, target) in &followed {
        if original != target {
            if let Some(set) = imported.get_mut(from) {
                if !kept.contains(&(*from, original.as_str())) {
                    set.remove(original);
                }
                set.insert(target.clone());
            }
        }
    }
    for (from, targets) in &imported {
        for target in targets {
            add(from.to_string(), target.clone(), "imports", "EXTRACTED");
        }
    }
    for f in files {
        let none = BTreeSet::new();
        let targets = imported.get(f.path.as_str()).unwrap_or(&none);
        // 依可信度挑候選：同檔 → 已 import 的檔案 → 同語言全專案唯一（推斷）→ 2–3 個（不確定）。
        let from_test = is_test_path(&f.path);
        let pick = |mut candidates: Vec<&Entry>, global: bool| -> Vec<(String, &'static str)> {
            if !from_test {
                candidates.retain(|e| !is_test_path(e.file));
            }
            let local: Vec<&&Entry> = candidates.iter().filter(|e| e.file == f.path).collect();
            let via: Vec<&&Entry> = candidates.iter().filter(|e| targets.contains(e.file)).collect();
            let same_lang: Vec<&&Entry> = candidates.iter().filter(|e| e.lang.map(|l| l.name()) == f.lang.map(|l| l.name())).collect();
            match (local.as_slice(), via.as_slice(), same_lang.as_slice()) {
                ([one], ..) | ([], [one], _) => vec![(one.id.clone(), "EXTRACTED")],
                ([], [], [one]) if global => vec![(one.id.clone(), "INFERRED")],
                ([], [], many) if global && (2..=3).contains(&many.len()) => many.iter().map(|e| (e.id.clone(), "AMBIGUOUS")).collect(),
                _ => vec![],
            }
        };
        let class_of = |owner: &str| -> Option<String> {
            let class = if defined.contains(&format!("{}#{owner}", f.path)) && owner.contains('.') { owner.rsplit_once('.').map(|(c, _)| c.to_string()) } else { None };
            class.or_else(|| f.facts.defs.iter().find(|d| d.name == owner && !matches!(d.kind.as_str(), "function" | "method")).map(|d| d.name.clone()))
        };
        for (owner, callee) in &f.facts.calls {
            let source = if owner.is_empty() { f.path.clone() } else { format!("{}#{owner}", f.path) };
            let methods = |name: &str| -> Vec<&Entry> { by_name.get(name).map(|c| c.iter().filter(|e| e.kind == "method").collect()).unwrap_or_default() };
            let found = if let Some(name) = callee.strip_prefix('@') {
                // self／this：先找同一個類別，找不到再當成未知型別的方法。
                match class_of(owner).map(|c| format!("{}#{c}.{name}", f.path)).filter(|id| defined.contains(id)) {
                    Some(id) => vec![(id, "EXTRACTED")],
                    None => pick(methods(name), false),
                }
            } else if let Some(name) = callee.strip_prefix('.') {
                pick(methods(name), false)
            } else if let Some((module, name)) = callee.rsplit_once("::") {
                // Rust 寫明模組路徑：路徑解析得到檔案時只在那個檔案裡找；解析不到（外部 crate、別名）再依名稱推斷。
                // 模組檔本身，加上它 `pub use` 轉出去的檔案（core/mod.rs 把 workflow::human 轉成 core::human）。
                let mut files = resolve_rust(&f.path, module, &paths);
                let reexported: Vec<String> = files.iter().flat_map(|p| imported.get(p.as_str()).into_iter().flatten().cloned()).collect();
                files.extend(reexported);
                let functions = || by_name.get(name).map(|c| c.iter().filter(|e| e.kind != "method").collect::<Vec<_>>()).unwrap_or_default();
                match functions().into_iter().filter(|e| files.iter().any(|p| p == e.file)).collect::<Vec<_>>().as_slice() {
                    [one] => vec![(one.id.clone(), "EXTRACTED")],
                    _ if !files.is_empty() || ["crate", "super", "self"].iter().any(|p| module.starts_with(p)) => pick(functions(), true),
                    _ => vec![],
                }
            } else if callee.contains('.') {
                pick(by_qual.get(callee.as_str()).map(|c| c.iter().collect()).unwrap_or_default(), true)
            } else {
                // 直接呼叫：同一個類別的方法（Java 可以省略 this）優先，其次是函式、型別與其他定義。
                match class_of(owner).map(|c| format!("{}#{c}.{callee}", f.path)).filter(|id| defined.contains(id)) {
                    Some(id) => vec![(id, "EXTRACTED")],
                    None => pick(by_name.get(callee.as_str()).map(|c| c.iter().filter(|e| e.kind != "method").collect()).unwrap_or_default(), true),
                }
            };
            for (target, confidence) in found {
                add(source.clone(), target, "calls", confidence);
            }
        }
        for (child, base, relation) in &f.facts.bases {
            let candidates: Vec<&Entry> = by_name.get(base.as_str()).map(|c| c.iter().filter(|e| e.kind != "method" && e.kind != "function").collect()).unwrap_or_default();
            let relation = if relation == "implements" { "implements" } else { "inherits" };
            for (target, confidence) in pick(candidates, true) {
                add(format!("{}#{child}", f.path), target, relation, confidence);
            }
        }
    }
    graph.edges = edges.into_iter().map(|((source, target, relation), (confidence, weight))| Edge { source, target, relation, confidence, weight }).collect();
    graph
}

pub fn file_name(path: &str) -> &str {
    path.rsplit('/').next().unwrap_or(path)
}

fn parent(path: &str) -> &str {
    path.rsplit_once('/').map(|(d, _)| d).unwrap_or("")
}

fn join(dir: &str, rel: &str) -> String {
    let mut parts: Vec<&str> = if dir.is_empty() { vec![] } else { dir.split('/').collect() };
    for seg in rel.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    parts.join("/")
}

fn go_dirs(files: &[FileInput]) -> BTreeMap<String, Vec<String>> {
    let mut dirs: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for f in files.iter().filter(|f| f.lang == Some(Lang::Go)) {
        dirs.entry(parent(&f.path).to_string()).or_default().push(f.path.clone());
    }
    dirs
}

/// 依語言把 import 的寫法解析成專案裡的檔案；外部套件解析不到就略過。
pub fn resolve_import(from: &str, lang: Lang, spec: &str, files: &BTreeSet<&str>, go_dirs: &BTreeMap<String, Vec<String>>) -> Vec<String> {
    let dir = parent(from);
    let first = |candidates: Vec<String>| candidates.into_iter().find(|c| files.contains(c.as_str())).into_iter().collect::<Vec<_>>();
    match lang {
        Lang::JavaScript | Lang::TypeScript | Lang::Tsx => {
            let base = if spec.starts_with('.') { join(dir, spec) } else if spec.contains('/') { join("", spec.trim_start_matches("@/").trim_start_matches("~/")) } else { return vec![] };
            let exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
            let mut found = first(exts.iter().map(|e| format!("{base}{e}")).collect());
            if found.is_empty() && !spec.starts_with('.') {
                found = first(exts.iter().map(|e| format!("src/{base}{e}")).collect());
            }
            found
        }
        Lang::Python => {
            let dots = spec.chars().take_while(|c| *c == '.').count();
            let rest = spec[dots..].replace('.', "/");
            let bases: Vec<String> = if dots > 0 {
                let mut base = dir.to_string();
                for _ in 1..dots {
                    base = parent(&base).to_string();
                }
                vec![join(&base, &rest)]
            } else {
                vec![rest.clone(), format!("src/{rest}")]
            };
            first(bases.iter().flat_map(|b| [format!("{b}.py"), format!("{b}/__init__.py")]).collect())
        }
        Lang::Rust => resolve_rust(from, spec, files),
        Lang::Go => go_dirs.iter().filter(|(d, _)| !d.is_empty() && (spec == d.as_str() || spec.ends_with(&format!("/{d}")))).flat_map(|(_, fs)| fs.iter().take(8).cloned()).collect(),
        Lang::Java => {
            let path = spec.trim_end_matches(".*").replace('.', "/");
            if spec.ends_with(".*") {
                files.iter().filter(|f| f.ends_with(".java") && (parent(f) == path || parent(f).ends_with(&format!("/{path}")))).take(8).map(|f| f.to_string()).collect()
            } else {
                files.iter().find(|f| **f == format!("{path}.java") || f.ends_with(&format!("/{path}.java"))).map(|f| vec![f.to_string()]).unwrap_or_default()
            }
        }
    }
}

/// 檔案代表的 Rust 模組名稱：mod.rs 用所在目錄名，其他用檔名。
fn module_name(path: &str) -> &str {
    let stem = file_name(path).trim_end_matches(".rs");
    if stem == "mod" { file_name(parent(path)) } else { stem }
}

fn resolve_rust(from: &str, spec: &str, files: &BTreeSet<&str>) -> Vec<String> {
    rust_target(from, spec, files).map(|(f, _)| vec![f]).unwrap_or_default()
}

/// Rust 的模組路徑：mod foo、crate::a::b、super::x、self::x。從最長的路徑往短試，因為最後幾段可能是型別或函式名稱。
/// 回傳檔案與沒用到的路徑段（給 `pub use` 轉出時繼續往下找）。
fn rust_target(from: &str, spec: &str, files: &BTreeSet<&str>) -> Option<(String, Vec<String>)> {
    let dir = parent(from);
    let stem = file_name(from).trim_end_matches(".rs");
    // 這個檔案自己這個模組的目錄：mod.rs、lib.rs、main.rs 是所在目錄，其他檔案是同名子目錄。
    let module_dir = if ["mod", "lib", "main"].contains(&stem) { dir.to_string() } else { join(dir, stem) };
    let try_paths = |base: &str, segments: &[&str]| -> Option<(String, Vec<String>)> {
        for n in (1..=segments.len()).rev() {
            let path = join(base, &segments[..n].join("/"));
            for candidate in [format!("{path}.rs"), format!("{path}/mod.rs")] {
                if files.contains(candidate.as_str()) {
                    return Some((candidate, segments[n..].iter().map(|s| s.to_string()).collect()));
                }
            }
        }
        None
    };
    if let Some(name) = spec.strip_prefix("mod:") {
        return try_paths(&module_dir, &[name]);
    }
    let segments: Vec<&str> = spec.split("::").collect();
    match segments.first().copied() {
        Some("crate") => {
            // crate 根目錄：往上找最近的 src 目錄。
            let mut root = dir;
            while !root.is_empty() && file_name(root) != "src" {
                root = parent(root);
            }
            let root = if file_name(root) == "src" { root } else { dir };
            try_paths(root, &segments[1..])
        }
        Some("self") => try_paths(&module_dir, &segments[1..]),
        Some("super") => {
            let mut base = module_dir.clone();
            let mut rest = &segments[..];
            while rest.first() == Some(&"super") {
                base = parent(&base).to_string();
                rest = &rest[1..];
            }
            try_paths(&base, rest)
        }
        // 沒有前綴的路徑（2018 版的 uniform paths）：先當成目前模組底下的子模組，例如 mod.rs 的 `pub use workflow::human`；
        // 找不到就是外部 crate，不連線。
        _ => try_paths(&module_dir, &segments),
    }
}

/// 測試檔：非測試程式的呼叫不接到測試檔裡的同名函式。
fn is_test_path(path: &str) -> bool {
    let name = file_name(path);
    path.starts_with("tests/") || path.contains("/tests/") || path.contains("/__tests__/") || name.starts_with("test_")
        || [".test.", ".spec.", "_test."].iter().any(|s| name.contains(s))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::graph::extract::extract;

    fn input(path: &str, src: &str) -> FileInput {
        let lang = Lang::of(path);
        FileInput { path: path.into(), lang, facts: lang.map(|l| extract(l, src)).unwrap_or_default() }
    }

    fn edge<'a>(g: &'a Graph, s: &str, t: &str, relation: &str) -> Option<&'a Edge> {
        g.edges.iter().find(|e| e.source == s && e.target == t && e.relation == relation)
    }

    #[test]
    fn 解析各語言的_import_路徑() {
        let files: BTreeSet<&str> = ["web/src/a.ts", "web/src/util/index.ts", "pkg/models.py", "pkg/sub/__init__.py", "src/core/mod.rs", "src/core/store.rs", "src/core/store/disk.rs", "src/main.rs", "app/store/s.go", "com/x/User.java"].into_iter().collect();
        let go = go_dirs(&[FileInput { path: "app/store/s.go".into(), lang: Some(Lang::Go), facts: Facts::default() }]);
        let r = |from: &str, lang: Lang, spec: &str| resolve_import(from, lang, spec, &files, &go);
        assert_eq!(r("web/src/a.ts", Lang::TypeScript, "./util"), vec!["web/src/util/index.ts"]);
        assert!(r("web/src/a.ts", Lang::TypeScript, "react").is_empty());
        assert_eq!(r("pkg/sub/__init__.py", Lang::Python, "..models"), vec!["pkg/models.py"]);
        assert_eq!(r("pkg/models.py", Lang::Python, "pkg.sub"), vec!["pkg/sub/__init__.py"]);
        assert_eq!(r("src/main.rs", Lang::Rust, "mod:core"), vec!["src/core/mod.rs"]);
        assert_eq!(r("src/core/mod.rs", Lang::Rust, "mod:store"), vec!["src/core/store.rs"]);
        assert_eq!(r("src/core/store.rs", Lang::Rust, "mod:disk"), vec!["src/core/store/disk.rs"]);
        assert_eq!(r("src/main.rs", Lang::Rust, "crate::core::store::Store"), vec!["src/core/store.rs"]);
        assert_eq!(r("src/core/store/disk.rs", Lang::Rust, "super::super::store"), vec!["src/core/store.rs"]);
        assert!(r("src/main.rs", Lang::Rust, "serde_json::Value").is_empty());
        assert_eq!(r("main.go", Lang::Go, "example.com/app/store"), vec!["app/store/s.go"]);
        assert_eq!(r("com/y/S.java", Lang::Java, "com.x.User"), vec!["com/x/User.java"]);
    }

    #[test]
    fn 呼叫依同檔_已匯入檔案_全專案唯一名稱的順序接到定義() {
        let g = build(&[
            input("src/a.ts", "import { load } from './b';\nexport function run() { load(); save(); local(); get(); }\nfunction local() {}"),
            input("src/b.ts", "export function load() {}\nexport function get() {}"),
            input("src/c.ts", "export function save() {}\nexport function get() {}"),
            input("README.md", ""),
        ]);
        assert_eq!(edge(&g, "src/a.ts", "src/b.ts", "imports").unwrap().confidence, "EXTRACTED");
        assert_eq!(edge(&g, "src/a.ts#run", "src/b.ts#load", "calls").unwrap().confidence, "EXTRACTED");
        assert_eq!(edge(&g, "src/a.ts#run", "src/a.ts#local", "calls").unwrap().confidence, "EXTRACTED");
        assert_eq!(edge(&g, "src/a.ts#run", "src/c.ts#save", "calls").unwrap().confidence, "INFERRED");
        // get 在兩個檔案都有：已匯入的 b.ts 優先。
        assert!(edge(&g, "src/a.ts#run", "src/b.ts#get", "calls").is_some() && edge(&g, "src/a.ts#run", "src/c.ts#get", "calls").is_none());
        assert!(edge(&g, "src/a.ts", "src/a.ts#run", "contains").is_some());
        assert!(g.nodes.iter().any(|n| n.id == "README.md" && n.lang == "other" && n.file_type == "document"));
        assert_eq!(g.nodes.iter().find(|n| n.id == "src/a.ts#run").unwrap().label, "run()");
    }

    #[test]
    fn 方法呼叫看接收者_不把標準庫的方法接到專案裡的同名函式() {
        let g = build(&[
            input("src/store.rs", "pub struct Store;\nimpl Store {\n    pub fn new() -> Self { Store }\n    pub fn save(&self) { self.flush(); let v: Vec<u8> = vec![]; v.join(); }\n    fn flush(&self) {}\n}\npub fn join() {}\n"),
            input("src/main.rs", "use crate::store::Store;\nfn main() { let s = Store::new(); s.save(); }\n"),
            input("src/a.py", "def handle():\n    pass\n"),
            input("src/b.py", "def handle():\n    pass\n"),
            input("src/c.py", "def run():\n    handle()\n"),
        ]);
        assert_eq!(edge(&g, "src/store.rs#Store.save", "src/store.rs#Store.flush", "calls").unwrap().confidence, "EXTRACTED");
        assert!(edge(&g, "src/store.rs#Store.save", "src/store.rs#join", "calls").is_none(), "v.join() 不能接到專案的 join()");
        assert_eq!(edge(&g, "src/main.rs#main", "src/store.rs#Store.new", "calls").unwrap().confidence, "EXTRACTED");
        assert_eq!(edge(&g, "src/main.rs#main", "src/store.rs#Store.save", "calls").unwrap().confidence, "EXTRACTED");
        assert!(edge(&g, "src/store.rs#Store", "src/store.rs#Store.save", "method").is_some());
        // 兩個同名函式、都沒有 import：各連一條 AMBIGUOUS。
        assert_eq!(edge(&g, "src/c.py#run", "src/a.py#handle", "calls").unwrap().confidence, "AMBIGUOUS");
        assert_eq!(edge(&g, "src/c.py#run", "src/b.py#handle", "calls").unwrap().confidence, "AMBIGUOUS");
    }

    #[test]
    fn rust_的_pub_use_轉出與寫明模組路徑的呼叫接到實際檔案_mod_宣告不算循環匯入() {
        let g = build(&[
            input("src/core/mod.rs", "pub mod project;\npub mod workflow;\npub use project::state;\npub use workflow::human;\n"),
            input("src/core/project/state.rs", "use crate::core::human;\npub fn data_dir() {}\n"),
            input("src/core/workflow/human.rs", "use crate::core::state::data_dir;\npub fn approve() { data_dir(); std::fs::write(); }\n"),
            input("src/main.rs", "mod core;\nfn main() { crate::core::human::approve(); }\npub fn write() {}\n"),
            input("tests/flow.rs", "fn approve() {}\n"),
        ]);
        assert!(edge(&g, "src/core/workflow/human.rs", "src/core/project/state.rs", "imports").is_some(), "{:?}", g.edges);
        assert_eq!(edge(&g, "src/core/workflow/human.rs#approve", "src/core/project/state.rs#data_dir", "calls").unwrap().confidence, "EXTRACTED");
        assert_eq!(edge(&g, "src/main.rs#main", "src/core/workflow/human.rs#approve", "calls").unwrap().confidence, "EXTRACTED");
        assert!(edge(&g, "src/core/workflow/human.rs#approve", "src/main.rs#write", "calls").is_none(), "std::fs::write 不能接到專案的 write");
        assert!(edge(&g, "src/main.rs", "src/core/mod.rs", "contains").is_some() && edge(&g, "src/main.rs", "src/core/mod.rs", "imports").is_none());
    }

    #[test]
    fn 繼承與實作接到類別與介面() {
        let g = build(&[
            input("src/base.ts", "export class Base {}\nexport interface Api {}"),
            input("src/view.ts", "import { Base, Api } from './base';\nclass View extends Base implements Api {}"),
            input("src/fmt.rs", "trait Show {}\nstruct Item;\nimpl Show for Item {}"),
        ]);
        assert_eq!(edge(&g, "src/view.ts#View", "src/base.ts#Base", "inherits").unwrap().confidence, "EXTRACTED");
        assert!(edge(&g, "src/view.ts#View", "src/base.ts#Api", "implements").is_some());
        assert!(edge(&g, "src/fmt.rs#Item", "src/fmt.rs#Show", "implements").is_some());
    }
}

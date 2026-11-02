//! 用 tree-sitter 從單一檔案抽出定義、import 與呼叫。每個檔案各自處理，結果以內容雜湊快取。
//! 只記錄檔案頂層與類別（impl、class、trait…）裡的定義；函式內部的巢狀函式不另外成為節點，其中的呼叫算在外層函式。
use serde_json::{json, Value};
use tree_sitter::{Node, Parser};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Lang {
    Rust,
    JavaScript,
    TypeScript,
    Tsx,
    Python,
    Go,
    Java,
}

impl Lang {
    pub fn of(path: &str) -> Option<Lang> {
        let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
        Some(match ext.as_str() {
            "rs" => Lang::Rust,
            "js" | "mjs" | "cjs" | "jsx" => Lang::JavaScript,
            "ts" | "mts" | "cts" => Lang::TypeScript,
            "tsx" => Lang::Tsx,
            "py" => Lang::Python,
            "go" => Lang::Go,
            "java" => Lang::Java,
            _ => return None,
        })
    }

    pub fn name(self) -> &'static str {
        match self {
            Lang::Rust => "rust",
            Lang::JavaScript => "javascript",
            Lang::TypeScript | Lang::Tsx => "typescript",
            Lang::Python => "python",
            Lang::Go => "go",
            Lang::Java => "java",
        }
    }

    fn language(self) -> tree_sitter::Language {
        match self {
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::JavaScript => tree_sitter_javascript::LANGUAGE.into(),
            Lang::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Java => tree_sitter_java::LANGUAGE.into(),
        }
    }

    fn is_js(self) -> bool {
        matches!(self, Lang::JavaScript | Lang::TypeScript | Lang::Tsx)
    }
}

/// 一個定義。name 是檔案內的完整名稱：方法寫成「類別.方法」。
#[derive(Clone, Debug, PartialEq)]
pub struct Def {
    pub name: String,
    pub kind: String,
    pub line: usize,
}

/// 一個檔案抽出的事實。calls 是（呼叫所在的定義名稱，空字串＝檔案頂層；被呼叫的名稱）。
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Facts {
    pub lines: usize,
    pub defs: Vec<Def>,
    pub imports: Vec<String>,
    pub calls: Vec<(String, String)>,
    /// 繼承與實作：（定義名稱，父類別或介面名稱，inherits 或 implements）。
    pub bases: Vec<(String, String, String)>,
}

impl Facts {
    pub fn to_json(&self) -> Value {
        json!({
            "lines": self.lines,
            "defs": self.defs.iter().map(|d| json!([d.name, d.kind, d.line])).collect::<Vec<_>>(),
            "imports": self.imports,
            "calls": self.calls.iter().map(|(a, b)| json!([a, b])).collect::<Vec<_>>(),
            "bases": self.bases.iter().map(|(a, b, r)| json!([a, b, r])).collect::<Vec<_>>(),
        })
    }

    pub fn from_json(v: &Value) -> Option<Facts> {
        let strs = |v: &Value| v.as_array().map(|a| a.iter().filter_map(|s| s.as_str().map(String::from)).collect::<Vec<_>>());
        Some(Facts {
            lines: v["lines"].as_u64()? as usize,
            defs: v["defs"].as_array()?.iter().filter_map(|d| Some(Def { name: d[0].as_str()?.into(), kind: d[1].as_str()?.into(), line: d[2].as_u64()? as usize })).collect(),
            imports: strs(&v["imports"])?,
            calls: v["calls"].as_array()?.iter().filter_map(|c| Some((c[0].as_str()?.to_string(), c[1].as_str()?.to_string()))).collect(),
            bases: v["bases"].as_array()?.iter().filter_map(|c| Some((c[0].as_str()?.to_string(), c[1].as_str()?.to_string(), c[2].as_str()?.to_string()))).collect(),
        })
    }
}

pub fn extract(lang: Lang, source: &str) -> Facts {
    let mut parser = Parser::new();
    let facts = Facts { lines: source.lines().count(), ..Default::default() };
    if parser.set_language(&lang.language()).is_err() {
        return facts;
    }
    let Some(tree) = parser.parse(source, None) else { return facts };
    let mut walker = Walker { src: source.as_bytes(), lang, facts };
    walker.walk(tree.root_node(), "", None, false);
    walker.facts.calls.sort();
    walker.facts.calls.dedup();
    walker.facts.imports.dedup();
    walker.facts
}

struct Walker<'a> {
    src: &'a [u8],
    lang: Lang,
    facts: Facts,
}

/// 定義的種類與名稱；container 為 true 時，裡面的函式算這個定義的方法。
struct Found {
    kind: &'static str,
    name: String,
    container: bool,
}

impl Walker<'_> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.src).unwrap_or("").to_string()
    }

    fn field(&self, node: Node, name: &str) -> Option<String> {
        node.child_by_field_name(name).map(|n| self.text(n)).filter(|s| !s.is_empty())
    }

    /// owner：目前所在的定義（呼叫算在它頭上）；class：方法要掛在哪個類別下；in_fn：是否在函式本體內。
    fn walk(&mut self, node: Node, owner: &str, class: Option<&str>, in_fn: bool) {
        // Rust 的 #[cfg(test)] mod tests 只是測試，不放進圖譜，免得測試呼叫把核心節點的排名灌水。
        if self.lang == Lang::Rust && node.kind() == "mod_item" && self.field(node, "name").as_deref() == Some("tests") {
            return;
        }
        for spec in self.imports(node) {
            self.facts.imports.push(spec);
        }
        if let Some(callee) = self.callee(node) {
            self.facts.calls.push((owner.to_string(), callee));
        }
        let mut owner = owner.to_string();
        let mut class = class.map(String::from);
        let mut in_fn = in_fn;
        if let Some(target) = self.impl_target(node) {
            // `impl Trait for Type`：Type 實作 Trait。
            if let Some(tr) = self.field(node, "trait").map(|t| base_type(&t)).filter(|t| !t.is_empty()) {
                self.facts.bases.push((target.clone(), tr, "implements".into()));
            }
            class = Some(target);
        } else if let Some(found) = self.definition(node, class.as_deref()).filter(|_| !in_fn) {
            let name = match (&class, found.kind) {
                (Some(c), "method") => format!("{c}.{}", found.name),
                _ => found.name.clone(),
            };
            for (base, relation) in self.bases(node) {
                self.facts.bases.push((name.clone(), base, relation.into()));
            }
            self.facts.defs.push(Def { name: name.clone(), kind: found.kind.into(), line: node.start_position().row + 1 });
            owner = name.clone();
            if found.container {
                class = Some(name);
            } else {
                class = None;
                in_fn = matches!(found.kind, "function" | "method");
            }
        }
        let mut cursor = node.walk();
        for child in node.named_children(&mut cursor) {
            self.walk(child, &owner, class.as_deref(), in_fn);
        }
    }

    /// 類別宣告上寫的父類別與介面（extends／implements／Python 的基底類別）。
    fn bases(&self, node: Node) -> Vec<(String, &'static str)> {
        let names = |text: &str| -> Vec<String> {
            text.split(',').map(|p| p.trim()).filter(|p| !p.is_empty() && !p.contains('=')).map(base_type).filter(|b| !b.is_empty() && b != "object").collect()
        };
        // 「extends A implements B, C」這類寫法：依關鍵字切開。
        let clauses = |text: &str| -> Vec<(String, &'static str)> {
            let mut out = Vec::new();
            let mut relation = "inherits";
            let mut buf = String::new();
            let flush = |buf: &mut String, relation: &'static str, out: &mut Vec<(String, &'static str)>| {
                out.extend(names(buf).into_iter().map(|n| (n, relation)));
                buf.clear();
            };
            for word in text.split_whitespace() {
                match word {
                    "extends" => { flush(&mut buf, relation, &mut out); relation = "inherits"; }
                    "implements" => { flush(&mut buf, relation, &mut out); relation = "implements"; }
                    w => { buf.push_str(w); buf.push(' '); }
                }
            }
            flush(&mut buf, relation, &mut out);
            out
        };
        match (self.lang, node.kind()) {
            (l, "class_declaration" | "abstract_class_declaration") if l.is_js() => {
                let mut cursor = node.walk();
                let heritage = node.named_children(&mut cursor).find(|c| c.kind() == "class_heritage").map(|h| self.text(h)).unwrap_or_default();
                clauses(&heritage)
            }
            (l, "interface_declaration") if l.is_js() => {
                let mut cursor = node.walk();
                let ext = node.named_children(&mut cursor).find(|c| c.kind() == "extends_type_clause").map(|h| self.text(h)).unwrap_or_default();
                clauses(&ext)
            }
            (Lang::Python, "class_definition") => {
                let text = self.field(node, "superclasses").unwrap_or_default();
                names(text.trim_start_matches('(').trim_end_matches(')')).into_iter().map(|n| (n, "inherits")).collect()
            }
            (Lang::Java, "class_declaration" | "record_declaration" | "enum_declaration" | "interface_declaration") => {
                let mut out = Vec::new();
                let mut cursor = node.walk();
                for child in node.named_children(&mut cursor) {
                    match child.kind() {
                        "superclass" | "extends_interfaces" => out.extend(clauses(&format!("extends {}", self.text(child).trim_start_matches("extends")))),
                        "super_interfaces" => out.extend(clauses(&format!("implements {}", self.text(child).trim_start_matches("implements")))),
                        _ => {}
                    }
                }
                out
            }
            _ => vec![],
        }
    }

    /// Rust 的 impl 區塊：不是定義，但裡面的函式是該型別的方法。
    fn impl_target(&self, node: Node) -> Option<String> {
        (self.lang == Lang::Rust && node.kind() == "impl_item").then(|| self.field(node, "type")).flatten().map(|t| base_type(&t))
    }

    fn definition(&self, node: Node, class: Option<&str>) -> Option<Found> {
        let named = |kind: &'static str, container: bool| self.field(node, "name").map(|name| Found { kind, name, container });
        let func = || if class.is_some() { "method" } else { "function" };
        match (self.lang, node.kind()) {
            (Lang::Rust, "function_item") => named(func(), false),
            (Lang::Rust, "struct_item" | "union_item") => named("struct", false),
            (Lang::Rust, "enum_item") => named("enum", false),
            (Lang::Rust, "trait_item") => named("trait", true),
            (Lang::Rust, "mod_item") if node.child_by_field_name("body").is_some() => named("module", true),
            (Lang::Rust, "const_item" | "static_item") => named("const", false),
            (Lang::Rust, "type_item") => named("type", false),
            (Lang::Rust, "macro_definition") => named("macro", false),
            (l, "function_declaration" | "generator_function_declaration") if l.is_js() => named("function", false),
            (l, "class_declaration" | "abstract_class_declaration") if l.is_js() => named("class", true),
            (l, "method_definition") if l.is_js() && class.is_some() => named("method", false),
            (l, "interface_declaration") if l.is_js() => named("interface", false),
            (l, "type_alias_declaration") if l.is_js() => named("type", false),
            (l, "enum_declaration") if l.is_js() => named("enum", false),
            (l, "variable_declarator") if l.is_js() && class.is_none() => {
                let value = node.child_by_field_name("value")?;
                matches!(value.kind(), "arrow_function" | "function_expression" | "function").then(|| named("function", false)).flatten()
            }
            (Lang::Python, "function_definition") => named(func(), false),
            (Lang::Python, "class_definition") => named("class", true),
            (Lang::Go, "function_declaration") => named("function", false),
            (Lang::Go, "method_declaration") => {
                let receiver = self.field(node, "receiver").map(|r| last_identifier(&r)).unwrap_or_default();
                self.field(node, "name").map(|name| Found { kind: "method", name: if receiver.is_empty() { name } else { format!("{receiver}.{name}") }, container: false })
            }
            (Lang::Go, "type_spec") => {
                let kind = match node.child_by_field_name("type").map(|t| t.kind()) { Some("struct_type") => "struct", Some("interface_type") => "interface", _ => "type" };
                named(kind, false)
            }
            (Lang::Java, "class_declaration" | "record_declaration") => named("class", true),
            (Lang::Java, "interface_declaration") => named("interface", true),
            (Lang::Java, "enum_declaration") => named("enum", true),
            (Lang::Java, "method_declaration" | "constructor_declaration") => named("method", false),
            _ => None,
        }
    }

    /// import 的原始寫法；解析成檔案由 graph 模組依語言處理。
    fn imports(&self, node: Node) -> Vec<String> {
        match (self.lang, node.kind()) {
            (Lang::Rust, "use_declaration") => self.field(node, "argument").map(|a| expand_use(&a)).unwrap_or_default(),
            (Lang::Rust, "mod_item") if node.child_by_field_name("body").is_none() => self.field(node, "name").map(|n| vec![format!("mod:{n}")]).unwrap_or_default(),
            (l, "import_statement" | "export_statement") if l.is_js() => self.field(node, "source").map(|s| vec![unquote(&s)]).unwrap_or_default(),
            (l, "call_expression") if l.is_js() => {
                let callee = self.field(node, "function").unwrap_or_default();
                if callee != "require" && callee != "import" {
                    return vec![];
                }
                let args = node.child_by_field_name("arguments");
                let first = args.and_then(|a| a.named_child(0)).filter(|n| n.kind() == "string");
                first.map(|s| vec![unquote(&self.text(s))]).unwrap_or_default()
            }
            (Lang::Python, "import_statement") => {
                let mut cursor = node.walk();
                node.children_by_field_name("name", &mut cursor)
                    .map(|n| if n.kind() == "aliased_import" { self.field(n, "name").unwrap_or_default() } else { self.text(n) })
                    .filter(|s| !s.is_empty()).collect()
            }
            (Lang::Python, "import_from_statement") => {
                let Some(module) = self.field(node, "module_name") else { return vec![] };
                let mut out = vec![module.clone()];
                let mut cursor = node.walk();
                for name in node.children_by_field_name("name", &mut cursor) {
                    let name = if name.kind() == "aliased_import" { self.field(name, "name").unwrap_or_default() } else { self.text(name) };
                    if !name.is_empty() {
                        out.push(if module.ends_with('.') { format!("{module}{name}") } else { format!("{module}.{name}") });
                    }
                }
                out
            }
            (Lang::Go, "import_spec") => self.field(node, "path").map(|p| vec![unquote(&p)]).unwrap_or_default(),
            (Lang::Java, "import_declaration") => {
                let text = self.text(node);
                let spec = text.trim_start_matches("import").trim().trim_start_matches("static").trim().trim_end_matches(';').trim().to_string();
                if spec.is_empty() { vec![] } else { vec![spec] }
            }
            _ => vec![],
        }
    }

    /// 被呼叫的對象，依寫法分四種，解析時規則不同：
    /// `foo`（直接呼叫函式）、`@foo`（self／this 的方法）、`Type.foo`（指明型別的關聯函式或靜態方法）、`.foo`（其他物件的方法，型別未知）。
    fn callee(&self, node: Node) -> Option<String> {
        let target = match (self.lang, node.kind()) {
            (Lang::Rust | Lang::Go, "call_expression") => self.call_target(node.child_by_field_name("function")?),
            (l, "call_expression") if l.is_js() => self.call_target(node.child_by_field_name("function")?).filter(|n| n != "require" && n != "import"),
            (l, "new_expression") if l.is_js() => self.call_target(node.child_by_field_name("constructor")?),
            (Lang::Python, "call") => self.call_target(node.child_by_field_name("function")?),
            (Lang::Java, "method_invocation") => {
                let name = self.field(node, "name")?;
                match node.child_by_field_name("object") {
                    None => Some(name),
                    Some(object) => Some(format!("{}{name}", self.receiver(object))),
                }
            }
            (Lang::Java, "object_creation_expression") => self.field(node, "type").map(|t| base_type(&t)),
            _ => None,
        }?;
        let name = target.trim_start_matches(['@', '.']);
        name.split(['.', ':']).filter(|p| !p.is_empty()).all(is_identifier).then_some(target)
    }

    fn call_target(&self, n: Node) -> Option<String> {
        let member = |object: &str, name: &str| -> Option<String> {
            let object = n.child_by_field_name(object)?;
            Some(format!("{}{}", self.receiver(object), self.field(n, name)?))
        };
        match n.kind() {
            "identifier" => Some(self.text(n)),
            // Rust 的 `Type::new()`、`store::load()`：路徑最後一段是型別才記成 Type.new。
            // 路徑最後一段是型別（`Type::new()`）記成 Type.new；是模組（`crate::core::human::approve()`）就保留整條路徑，解析時先找模組的檔案。
            "scoped_identifier" => {
                let name = self.field(n, "name")?;
                let path = self.field(n, "path").unwrap_or_default();
                let last = base_type(&path);
                Some(if last.starts_with(char::is_uppercase) { format!("{last}.{name}") } else if path.is_empty() { name } else { format!("{path}::{name}") })
            }
            "generic_function" => self.call_target(n.child_by_field_name("function")?),
            "field_expression" => member("value", "field"),
            "member_expression" => member("object", "property"),
            "attribute" => member("object", "attribute"),
            // Go 的 `pkg.Func()` 與 `s.Method()` 從語法分不出來；大寫開頭當成套件的匯出函式（直接呼叫）。
            "selector_expression" => {
                let field = self.field(n, "field")?;
                let operand = n.child_by_field_name("operand")?;
                if operand.kind() == "identifier" && field.starts_with(char::is_uppercase) { Some(field) } else { member("operand", "field") }
            }
            _ => None,
        }
    }

    /// 方法呼叫的接收者寫法：self／this → `@`，大寫開頭的名稱（型別）→ `Type.`，其他 → `.`。
    fn receiver(&self, object: Node) -> String {
        let text = self.text(object);
        match text.as_str() {
            "self" | "this" => "@".into(),
            t if is_identifier(t) && t.starts_with(char::is_uppercase) => format!("{t}."),
            _ => ".".into(),
        }
    }
}

fn is_identifier(s: &str) -> bool {
    let mut chars = s.chars();
    chars.next().is_some_and(|c| c.is_alphabetic() || c == '_' || c == '$') && chars.all(|c| c.is_alphanumeric() || c == '_' || c == '$')
}

fn unquote(s: &str) -> String {
    s.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
}

/// 型別名稱去掉泛型與路徑：`Store<T>` → Store，`crate::a::Store` → Store。
fn base_type(t: &str) -> String {
    last_identifier(t.split('<').next().unwrap_or(t))
}

fn last_identifier(s: &str) -> String {
    s.split(|c: char| !(c.is_alphanumeric() || c == '_')).rfind(|p| !p.is_empty() && is_identifier(p)).unwrap_or("").to_string()
}

/// 展開 Rust 的 use 樹：`crate::a::{b, c::{D, e}}` → crate::a::b、crate::a::c::D、crate::a::c::e。
pub fn expand_use(text: &str) -> Vec<String> {
    fn split_top(s: &str) -> Vec<&str> {
        let (mut depth, mut start, mut out) = (0, 0, Vec::new());
        for (i, c) in s.char_indices() {
            match c {
                '{' => depth += 1,
                '}' => depth -= 1,
                ',' if depth == 0 => {
                    out.push(&s[start..i]);
                    start = i + 1;
                }
                _ => {}
            }
        }
        out.push(&s[start..]);
        out
    }
    // 先去掉別名（`C as D`），再去掉空白。
    let words: Vec<&str> = text.split_whitespace().collect();
    let mut kept: Vec<&str> = Vec::new();
    let mut i = 0;
    while i < words.len() {
        if words[i] == "as" {
            // 別名本身去掉，但保留它後面的標點（`D,`、`D}`）。
            if let Some(alias) = words.get(i + 1) {
                kept.push(alias.trim_start_matches(|c: char| c.is_alphanumeric() || c == '_'));
            }
            i += 2;
            continue;
        }
        kept.push(words[i]);
        i += 1;
    }
    let text: String = kept.concat();
    match (text.find('{'), text.rfind('}')) {
        (Some(open), Some(close)) if open < close => {
            let prefix = text[..open].trim_end_matches("::");
            split_top(&text[open + 1..close]).into_iter().filter(|p| !p.is_empty()).flat_map(|part| {
                expand_use(part).into_iter().map(move |rest| if rest == "self" { prefix.to_string() } else if prefix.is_empty() { rest } else { format!("{prefix}::{rest}") })
            }).collect()
        }
        _ => vec![text.trim_end_matches("::*").to_string()],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defs(f: &Facts) -> Vec<(String, String)> {
        f.defs.iter().map(|d| (d.name.clone(), d.kind.clone())).collect()
    }

    #[test]
    fn rust_抽出定義_impl_方法_use_與呼叫_略過測試模組() {
        let src = "use crate::core::{a, b::{C, d}};\nmod store;\npub struct Store;\nimpl<T> Display for Store<T> {\n    fn fmt(&self) { helper(); self.save(); }\n}\nfn helper() { let inner = || load(); crate::x::run(); }\n#[cfg(test)]\nmod tests { fn t() { helper(); } }\n";
        let f = extract(Lang::Rust, src);
        assert_eq!(defs(&f), vec![("Store".into(), "struct".into()), ("Store.fmt".into(), "method".into()), ("helper".into(), "function".into())]);
        assert_eq!(f.imports, vec!["crate::core::a", "crate::core::b::C", "crate::core::b::d", "mod:store"]);
        assert_eq!(f.calls, vec![("Store.fmt".into(), "@save".into()), ("Store.fmt".into(), "helper".into()), ("helper".into(), "crate::x::run".into()), ("helper".into(), "load".into())]);
        assert_eq!(f.defs[2].line, 7);
        assert_eq!(f.bases, vec![("Store".into(), "Display".into(), "implements".into())]);
    }

    #[test]
    fn typescript_與_javascript_抽出類別方法_箭頭函式_import_與_require() {
        let src = "import { x } from './util';\nexport * from \"../shared/types\";\nconst fs = require('fs');\nexport class Store extends Base {\n  load() { return parse(this.raw); }\n}\nexport const render = (s: Store) => new Store();\ninterface Props { a: string }\n";
        let f = extract(Lang::TypeScript, src);
        assert_eq!(defs(&f), vec![("Store".into(), "class".into()), ("Store.load".into(), "method".into()), ("render".into(), "function".into()), ("Props".into(), "interface".into())]);
        assert_eq!(f.imports, vec!["./util", "../shared/types", "fs"]);
        assert!(f.calls.contains(&("Store.load".into(), "parse".into())) && f.calls.contains(&("render".into(), "Store".into())));
        assert_eq!(f.bases, vec![("Store".into(), "Base".into(), "inherits".into())]);
        let tsx = extract(Lang::Tsx, "class View extends React.Component implements Props, Other {}");
        assert_eq!(tsx.bases, vec![("View".into(), "Component".into(), "inherits".into()), ("View".into(), "Props".into(), "implements".into()), ("View".into(), "Other".into(), "implements".into())]);
        let js = extract(Lang::JavaScript, "function a() { b(); }\nmodule.exports = { a };");
        assert_eq!(defs(&js), vec![("a".into(), "function".into())]);
    }

    #[test]
    fn python_go_java_抽出定義與匯入() {
        let py = extract(Lang::Python, "from .models import User, Group as G\nimport os.path\nclass Repo(Base, metaclass=Meta):\n    def save(self):\n        validate(self)\n");
        assert_eq!(py.bases, vec![("Repo".into(), "Base".into(), "inherits".into())]);
        assert_eq!(defs(&py), vec![("Repo".into(), "class".into()), ("Repo.save".into(), "method".into())]);
        assert_eq!(py.imports, vec![".models", ".models.User", ".models.Group", "os.path"]);
        assert_eq!(py.calls, vec![("Repo.save".into(), "validate".into())]);
        let go = extract(Lang::Go, "package s\nimport (\n  \"example.com/app/store\"\n)\ntype Store struct{}\nfunc (s *Store) Load() { store.Open() }\n");
        assert_eq!(defs(&go), vec![("Store".into(), "struct".into()), ("Store.Load".into(), "method".into())]);
        assert_eq!(go.imports, vec!["example.com/app/store"]);
        assert_eq!(go.calls, vec![("Store.Load".into(), "Open".into())]);
        let java = extract(Lang::Java, "import com.app.model.User;\npublic class Service extends Base implements Runnable, Api { void run() { new User().save(); } }");
        assert_eq!(java.bases, vec![("Service".into(), "Base".into(), "inherits".into()), ("Service".into(), "Runnable".into(), "implements".into()), ("Service".into(), "Api".into(), "implements".into())]);
        assert_eq!(defs(&java), vec![("Service".into(), "class".into()), ("Service.run".into(), "method".into())]);
        assert_eq!(java.imports, vec!["com.app.model.User"]);
        assert!(java.calls.contains(&("Service.run".into(), ".save".into())) && java.calls.contains(&("Service.run".into(), "User".into())));
    }

    #[test]
    fn rust_use_樹展開並去掉別名() {
        assert_eq!(expand_use("crate::a::{b as B, c::{self, D}, e}"), vec!["crate::a::b", "crate::a::c", "crate::a::c::D", "crate::a::e"]);
        assert_eq!(expand_use("super::store::*"), vec!["super::store"]);
        assert_eq!(expand_use("std::fmt as f"), vec!["std::fmt"]);
    }

    #[test]
    fn 快取格式可以來回轉換() {
        let f = extract(Lang::Python, "def a():\n    b()\n");
        assert_eq!(Facts::from_json(&f.to_json()), Some(f));
    }
}

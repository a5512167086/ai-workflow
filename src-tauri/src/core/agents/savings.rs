//! 節省 token：縮小送給 AI 的 prompt，並記下每一項少送了多少（估計值，顯示在用量頁）。
//! 開關在全域設定的 token_saving（見 config::default_token_saving）。
use std::sync::LazyLock;

use regex::Regex;
use serde_json::{json, Value};

/// 粗估 token 數：ASCII 約 4 個字元一個 token，中文等非 ASCII 字元約一個字一個 token。
pub fn estimate_tokens(text: &str) -> u64 {
    let (ascii, other) = text.chars().fold((0u64, 0u64), |(a, o), c| if c.is_ascii() { (a + 1, o) } else { (a, o + 1) });
    ascii.div_ceil(4) + other
}

/// 一筆節省紀錄：before 是原本會送出的內容，after 是實際送出的內容。沒有變小就不記。
pub fn saved(feature: &str, before: &str, after: &str) -> Option<Value> {
    let (b, a) = (estimate_tokens(before), estimate_tokens(after));
    (b > a).then(|| json!({ "feature": feature, "tokens": b - a }))
}

pub fn total_saved(entries: &[Value]) -> u64 {
    entries.iter().filter_map(|e| e["tokens"].as_u64()).sum()
}

const LOCKFILES: [&str; 12] = [
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
    "Cargo.lock", "poetry.lock", "Pipfile.lock", "composer.lock", "Gemfile.lock", "go.sum",
];
const GENERATED_DIRS: [&str; 8] = ["node_modules", "dist", "build", "target", ".next", "coverage", "vendor", "__pycache__"];

/// lockfile、壓縮過的檔案、source map 與建置產物：AI 讀了也沒幫助，審查與專案地圖都略過。
pub fn is_noise_path(path: &str) -> bool {
    let path = path.replace('\\', "/");
    let name = path.rsplit('/').next().unwrap_or(&path);
    LOCKFILES.contains(&name)
        || [".min.js", ".min.css", ".map", ".snap"].iter().any(|s| name.ends_with(s))
        || path.split('/').rev().skip(1).any(|dir| GENERATED_DIRS.contains(&dir))
}

static DIFF_HEADER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^diff --git a/(.+?) b/(.+)$").unwrap());

/// 把審查用的 diff 中 lockfile 與產生檔的內容換成一行說明；回傳新的 diff 與略過的檔案。
/// --stat 摘要不動，審查者仍看得到這些檔案有變更。
pub fn filter_review_diff(diff: &str) -> (String, Vec<String>) {
    let mut out = String::with_capacity(diff.len());
    let mut skipped = Vec::new();
    let mut skipping = false;
    for line in diff.split_inclusive('\n') {
        if let Some(c) = DIFF_HEADER.captures(line.trim_end()) {
            let path = c[2].to_string();
            skipping = is_noise_path(&path) || is_noise_path(&c[1]);
            if skipping {
                out.push_str(&format!("diff --git a/{} b/{path}\n（ai-workflow 已略過：lockfile 或自動產生的檔案，內容不送審查）\n", &c[1]));
                skipped.push(path);
                continue;
            }
        }
        if !skipping {
            out.push_str(line);
        }
    }
    (out, skipped)
}

/// 只取 PRD 中和任務有關的部分：提到任務 requirement_ids（例如 US-3）的段落，加上測試決策與不做的事。
/// 任務沒有 requirement_ids 或 PRD 裡一個都對不到時回傳 None，呼叫端照舊附全文。
pub fn prd_excerpt(prd: &str, task: &Value) -> Option<String> {
    let ids: Vec<String> = task["requirement_ids"].as_array().into_iter().flatten().filter_map(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
    if ids.is_empty() {
        return None;
    }
    let patterns: Vec<Regex> = ids.iter().filter_map(|id| Regex::new(&format!(r"(^|[^\w-]){}($|[^\w-])", regex::escape(id))).ok()).collect();
    // 依段落（空行或清單項目開頭）切開，才不會把一條使用者故事的後半截切掉。
    let mut blocks: Vec<String> = Vec::new();
    for line in prd.lines() {
        let starts_item = line.trim_start().starts_with(['-', '*', '#']) || line.trim_start().chars().next().is_some_and(|c| c.is_ascii_digit());
        if blocks.is_empty() || line.trim().is_empty() || (starts_item && !line.starts_with([' ', '\t'])) {
            blocks.push(String::new());
        }
        let block = blocks.last_mut().unwrap();
        block.push_str(line);
        block.push('\n');
    }
    let stories: Vec<&str> = blocks.iter().map(|b| b.trim()).filter(|b| !b.is_empty() && !b.starts_with('#') && patterns.iter().any(|p| p.is_match(b))).collect();
    if stories.is_empty() {
        return None;
    }
    let mut parts = vec![format!("### 這個任務對應的使用者故事\n{}", stories.join("\n"))];
    for (title, keys) in [("測試決策", ["測試決策", "Testing Decisions"]), ("不做的事", ["不做的事", "Out of Scope"])] {
        if let Some(section) = markdown_section(prd, &keys) {
            parts.push(format!("### {title}\n{section}"));
        }
    }
    Some(parts.join("\n\n"))
}

/// 找到標題含任一關鍵字的章節，回傳到下一個同級或更高級標題之前的內容（不含標題本身）。
fn markdown_section(text: &str, keys: &[&str]) -> Option<String> {
    let level = |l: &str| l.starts_with('#').then(|| l.chars().take_while(|c| *c == '#').count());
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.iter().position(|l| level(l).is_some() && keys.iter().any(|k| l.contains(k)))?;
    let depth = level(lines[start]).unwrap_or(1);
    let body: Vec<&str> = lines[start + 1..].iter().take_while(|l| level(l).is_none_or(|d| d > depth)).copied().collect();
    let body = body.join("\n").trim().to_string();
    (!body.is_empty()).then_some(body)
}

/// 精簡輸出規則：只約束回覆文字，不影響寫進檔案的內容與規定格式。
/// 改寫自 caveman（https://github.com/juliusbrussee/caveman，Copyright 2026 Julius Brussee，Apache-2.0）的回覆規則：
/// 濃縮成五條、翻成繁體中文，並限定在回覆文字。授權全文見 THIRD_PARTY_NOTICES.txt。
pub const TERSE_RULES: &str = "## 回覆風格：精簡
- 結論先行；不寒暄、不重述題目或任務內容、不寫結語。
- 用短句條列，一句一個重點；可以省略贅字，但不要自創縮寫。
- 程式碼、指令、檔案路徑、錯誤訊息、數字與單位一律保留原文；不要省略「不、沒有、只、除了」這類否定或限定詞。
- 工具呼叫之間不用說明正在做什麼。
- 這些規則只約束你的回覆文字；寫進檔案的程式碼、註解、文件，以及上面規定的輸出格式（例如最後的 VERDICT 行）照原本的要求。";

/// 內建技能的方法已經寫在這個階段的 prompt 裡（技能改編自同一份來源）：重複附加只是多花 token。
/// tdd 不在這裡：開發方法完全交給使用者綁定的技能（可以換成別的方法，或不綁），實作 prompt 不寫死。
pub fn builtin_inlined(skill: &str, stage: Option<&str>, role: Option<&str>) -> bool {
    match skill {
        "to-spec" => stage == Some("prd"),
        "to-tickets" => stage == Some("tasks"),
        "grill-me" => role == Some("interviewer"),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 估算_token_中文一字一個_英文四字元一個() {
        assert_eq!(estimate_tokens("abcdefgh"), 2);
        assert_eq!(estimate_tokens("中文"), 2);
        assert!(saved("x", "短", "短").is_none());
        assert_eq!(saved("x", "中文中文", "中").unwrap()["tokens"], 3);
    }

    #[test]
    fn 審查_diff_略過_lockfile_與產生檔_保留其他檔案() {
        let diff = " a.js | 1 +\n package-lock.json | 900 ++++\ndiff --git a/a.js b/a.js\n+x\ndiff --git a/package-lock.json b/package-lock.json\n+{\"lock\":1}\ndiff --git a/web/dist/app.min.js b/web/dist/app.min.js\n+min\ndiff --git a/src/b.rs b/src/b.rs\n+y\n";
        let (out, skipped) = filter_review_diff(diff);
        assert_eq!(skipped, vec!["package-lock.json", "web/dist/app.min.js"]);
        assert!(out.contains("package-lock.json | 900") && out.contains("+x") && out.contains("+y"));
        assert!(!out.contains("\"lock\"") && !out.contains("+min"));
        assert!(is_noise_path("crates\\x\\Cargo.lock") && !is_noise_path("src/build.rs") && is_noise_path("build/out.js"));
    }

    #[test]
    fn prd_摘要只取對應的使用者故事_對不到就回傳_none() {
        let prd = "# PRD\n## 3. 使用者故事\n- US-1 身為使用者，我想要新增待辦\n- US-12 身為使用者，我想要刪除\n  （含確認對話框）\n- US-2 身為使用者，我想要篩選\n## 5. 測試決策\n在 store 介面測試。\n## 6. 不做的事\n不做同步。\n## 7. 其他\n無";
        let ex = prd_excerpt(prd, &json!({ "requirement_ids": ["US-12"] })).unwrap();
        assert!(ex.contains("US-12") && ex.contains("確認對話框") && ex.contains("在 store 介面測試") && ex.contains("不做同步"));
        assert!(!ex.contains("US-1 ") && !ex.contains("US-2") && !ex.contains("無"));
        assert!(prd_excerpt(prd, &json!({ "requirement_ids": ["US-9"] })).is_none());
        assert!(prd_excerpt(prd, &json!({})).is_none());
    }
}

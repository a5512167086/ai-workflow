//! CLI 失敗輸出的分類（對應 legacy/src/agent-errors.js）。只分類失敗輸出，從不分類成功的模型回覆。
use std::sync::LazyLock;

use regex::Regex;

static LIMIT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)(?:you['’]ve|you have) (?:hit|reached) your (?:session|usage|weekly) limit|usage limit (?:has been )?(?:reached|exceeded)|(?:insufficient_quota|usage_limit_reached)|exceeded your current quota").unwrap()
});
static RESET: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bresets?\s+(?:at\s+)?([^\n|·]+)").unwrap());

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UsageLimit {
    pub reset: Option<String>,
    pub original: String,
}

pub fn usage_limit(error: &str) -> Option<UsageLimit> {
    if !LIMIT.is_match(error) {
        return None;
    }
    let reset = RESET.captures(error).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_string()).filter(|r| !r.is_empty());
    Some(UsageLimit { reset, original: error.to_string() })
}

pub fn explain_usage_limit(provider: &str, limit: &UsageLimit) -> String {
    let name = if provider == "claude" { "Claude Code" } else { "Codex" };
    let reset = limit.reset.as_ref().map(|r| format!("；CLI 回報重設時間：{r}")).unwrap_or_default();
    format!("{name} 用量已達上限{reset}。重開 session 不會重設訂閱額度")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 辨識_session_額度並保留重設時間_不混淆_context_或網路錯誤() {
        let limit = "You've hit your session limit · resets 9:10pm (Asia/Taipei)";
        assert_eq!(usage_limit(limit).unwrap().reset.as_deref(), Some("9:10pm (Asia/Taipei)"));
        assert_eq!(usage_limit("context window exceeded"), None);
        assert_eq!(usage_limit("connection refused"), None);
        assert!(usage_limit("usage_limit_reached").is_some());
    }
}

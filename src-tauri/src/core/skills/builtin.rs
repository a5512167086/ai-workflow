//! 內建的共用 Skills（對應 legacy/src/builtin-skills.js），直接編進執行檔，不需要外部資源。

pub const BUILTIN_SKILLS: &[(&str, &str)] = &[
    (
        "grill-me",
        r#"---
name: grill-me
description: Challenge a product idea or PRD through focused questions about assumptions, scope, tradeoffs, and acceptance criteria.
---
Find the highest-impact unresolved assumption in the supplied idea or PRD. Ask one focused question at a time and explain which decision its answer changes. Use the user's previous answers; do not ask settled questions again.
Probe who has the problem, the current workaround, evidence of demand, the smallest useful scope, failure cases, constraints, and measurable success when relevant. Challenge contradictions directly without hostility. Offer concrete choices when helpful, but do not decide for the user or invent their answers.
When enough is known, summarize confirmed requirements, decisions with reasons, remaining assumptions, and unresolved questions for the PRD author. During a review stage, present specific objections and questions as review findings; preserve the stage's required response format. During an interactive session, ask the next question and wait for the user's answer.
"#,
    ),
    (
        "uiux-design",
        r#"---
name: uiux-design
description: Design or review product interfaces through user journeys, screen states, interaction rules, accessibility, and verifiable UI acceptance criteria.
---
Start from the target user's task and any existing design system. Inspect supplied screens and repository conventions before proposing changes. Keep terminology and component behavior consistent with the product.
Describe the primary journey, information hierarchy, screen layout, and navigation. Specify loading, empty, error, success, disabled, and destructive-action states where applicable. Include keyboard navigation, visible focus, readable contrast, clear labels, and feedback after actions.
Separate confirmed requirements from proposed design choices. Make tradeoffs visible and ask about choices that change scope. Produce concrete screen and interaction specifications with acceptance criteria that an implementation agent can verify.
For implementation, use existing UI primitives and check the result with available preview tools. For review, cite specific interface issues and their impact. Do not claim visual verification without actually viewing the interface. Preserve the enclosing task's output format and scope.
"#,
    ),
];

pub fn builtin(name: &str) -> Option<&'static str> {
    BUILTIN_SKILLS.iter().find(|(n, _)| *n == name).map(|(_, text)| *text)
}

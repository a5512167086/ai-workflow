//! 內建的共用 Skills，直接編進執行檔，不需要外部資源。
//!
//! grill-me、to-spec、to-tickets、tdd 改寫自 Matt Pocock 的 skills（https://github.com/mattpocock/skills，MIT 授權，
//! 授權全文見 src/THIRD_PARTY_NOTICES.txt），配合 ai-workflow 的流程：需求釐清 → PRD → 拆任務 → 逐一實作。
//! 流程各階段的提示詞已經內含同樣的規則；這些技能讓使用者在 Skills 頁看得到、可以綁到其他階段或單獨開會議。

pub const BUILTIN_SKILLS: &[(&str, &str)] = &[
    (
        "grill-me",
        r#"---
name: grill-me
description: Interview the user relentlessly about a plan or requirement, round by round over a design tree, until there is a shared understanding.
metadata:
  source: Adapted from mattpocock/skills "grilling" (MIT)
---
Interview the user until you reach a shared understanding. Map the plan as a design tree: every decision branches into the decisions that hang off it.

Work the tree in rounds. The frontier is every decision whose prerequisites are already settled: the questions you can ask now without guessing at answers you haven't heard yet. Ask the whole frontier in one round, number each question, give your recommended answer, then wait for the user's answers before the next round. Word each question so "yes" accepts your recommendation. A question whose answer depends on another question still open in this round belongs to a later round.

Each answer reshapes the tree: settled decisions push the frontier outward. Recompute the frontier and ask the next round. Do not re-ask settled questions.

Finding facts is your job, never the user's: look up anything you can learn from the repository, references or tools yourself. Decisions are the user's: put each one to them and wait. Keep accepted recommendations separate from assumptions the user has not confirmed.

The session is done when the frontier is empty: every branch visited, nothing silently assumed. Then summarize the confirmed decisions, scope, constraints and acceptance criteria, and do not act on them until the user confirms. During a review stage, present unresolved decisions as review findings and keep the stage's required response format.
"#,
    ),
    (
        "tdd",
        r#"---
name: tdd
description: Test-driven development at pre-agreed seams. Red then green, one vertical slice at a time, tests that verify behavior through public interfaces.
metadata:
  source: Adapted from mattpocock/skills "tdd" (MIT)
---
TDD is the red → green loop. Every rule below applies on every cycle.

Good tests verify behavior through public interfaces, not implementation details. A good test reads like a specification ("user can check out with a valid cart") and survives refactors because it does not care about internal structure.

Seams: a seam is the public boundary where you observe behavior without reaching inside. Test only at the seams agreed in the spec's testing decisions (or the task's test strategy). Prefer existing seams and the highest seam possible; fewer seams are better.

Anti-patterns:
- Implementation-coupled: mocking your own modules, testing private functions, or verifying through a side channel (querying the database or file system instead of using the interface). The tell: the test breaks on a refactor although behavior did not change.
- Tautological: the expected value is recomputed the way the code computes it, so the test passes by construction. Expected values must come from an independent source: a known literal, a worked example, the spec.
- Horizontal slicing: writing all tests first, then all code. Work in vertical slices instead: one test, then the minimal code to pass it, then the next.

Mocking: mock only at system boundaries (external APIs, time, randomness, sometimes the file system or database). Never mock code you control. Pass external dependencies in so they are easy to replace.

Rules of the loop: write the failing test first, then only enough code to pass it. One seam, one test, one minimal implementation per cycle. Do not anticipate future tests or add speculative features. Refactoring belongs to review, not to the red → green loop. Run type checks and the relevant test file often, and the full suite before finishing.
"#,
    ),
    (
        "to-spec",
        r#"---
name: to-spec
description: Turn an already-clarified requirement into a spec (PRD) without interviewing again - problem, solution, user stories, implementation and testing decisions, out of scope.
metadata:
  source: Adapted from mattpocock/skills "to-spec" (MIT)
---
Synthesize what has already been agreed into a spec. Do not interview the user again.

1. Explore the repository to understand the current state. Use the project's vocabulary and respect existing architectural decisions.
2. Sketch the seams where the feature will be tested. Prefer existing seams, use the highest seam possible, and keep the number of seams small (ideally one).
3. Write the spec with these sections:
   - Problem statement, from the user's perspective.
   - Solution, from the user's perspective.
   - User stories: a long numbered list ("US-1 As a <role>, I want <feature>, so that <benefit>") covering every aspect, including errors and edge cases.
   - Implementation decisions: modules to build or modify and their interfaces, architecture, schemas, API contracts, important interactions. No file paths or code snippets; they go stale quickly.
   - Testing decisions: which seams, what makes a good test (only external behavior), which modules are tested, prior art in the codebase.
   - Out of scope.
   - Further notes and open questions.
"#,
    ),
    (
        "to-tickets",
        r#"---
name: to-tickets
description: Break a spec into tracer-bullet vertical slices - each demoable on its own, sized for one fresh session, with only the blocking edges that truly gate it.
metadata:
  source: Adapted from mattpocock/skills "to-tickets" (MIT)
---
Break the spec into tasks that are tracer-bullet vertical slices.

- Each slice cuts a narrow but complete path through every layer it needs (data, logic, state, UI, tests). Never a horizontal slice of one layer: "types, then storage, then state, then UI" leaves nothing demoable until the end.
- A completed slice is demoable or verifiable on its own; its acceptance criteria are things a person can check by hand.
- Each slice fits in a single fresh context window.
- Look for prefactoring that makes later work easier and schedule it first ("make the change easy, then make the easy change"). For an empty project, the first slice is the smallest feature that runs and can be seen, not setup alone.
- Wide refactors (one mechanical change that breaks call sites everywhere) are the exception: sequence them expand → migrate in batches → contract, keeping the build green at every step.

Give each task its blocking edges: only the tasks that must be done before it can start. Do not add edges just to force an order. List tasks in dependency order (blockers first); work then proceeds along the frontier, the tasks whose blockers are all done, top to bottom.

For each task write: a title naming what the user can now do; what to build, from the user's perspective rather than a layer-by-layer list; implementation notes without file paths; the seam and behaviors its tests cover; acceptance criteria; and the user stories it covers.

Before work starts, the user reviews the breakdown: is the granularity right, are the blocking edges real, should any tasks be merged or split?
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

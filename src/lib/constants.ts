import type { Column, PipelineStatus, PrdStatus, Priority, ProjectStatus, Role, SkillStage } from '@/types/api';

export const STATUS_TEXT: Record<PipelineStatus, string> = {
  idle: '閒置', queued: '排隊中', running: '執行中', paused: '已暫停', waiting: '等待人工測試',
  feature_test: '功能待測試', stuck: '需要人工處理', error: '錯誤', complete: '已完成',
};
/** 狀態膠囊的色調：對應 StatusPill 的 tone。 */
export type Tone = 'idle' | 'running' | 'waiting' | 'stuck' | 'error' | 'complete' | 'queued' | 'paused' | 'feature_test';
export const STATUS_TONE: Record<PipelineStatus, Tone> = {
  idle: 'idle', queued: 'queued', running: 'running', paused: 'paused', waiting: 'waiting', feature_test: 'feature_test', stuck: 'stuck', error: 'error', complete: 'complete',
};
export const PROJECT_STATUS: Record<ProjectStatus, [string, Tone]> = {
  missing: ['找不到專案', 'error'],
  idle: ['閒置', 'idle'],
  drafting: ['PRD 起草中', 'running'],
  awaiting_approval: ['等待核准 PRD', 'waiting'],
  generating: ['產生任務中', 'running'],
  awaiting_tasks: ['等待核准任務', 'waiting'],
  awaiting_permission: ['等待你允許操作', 'waiting'],
  ready: ['可以開始', 'idle'],
  queued: ['排隊中', 'queued'],
  running: ['執行中', 'running'],
  paused: ['已暫停', 'paused'],
  waiting: ['等待人工測試', 'waiting'],
  feature_test: ['功能待測試', 'feature_test'],
  stuck: ['需要人工處理', 'stuck'],
  error: ['錯誤', 'error'],
  complete: ['已完成', 'complete'],
};
export const PRD_TEXT: Record<PrdStatus, string> = {
  none: '尚無', drafting: '起草中', reviewing: '審查中', revising: '修訂中', awaiting_approval: '等待核准', approved: '已核准',
};
export const PRIORITY_TEXT: Record<Priority, string> = { high: '高', medium: '中', low: '低' };
export const COLUMNS: [Column, string][] = [
  ['todo', '待辦'], ['doing', '進行中'], ['review', '審查中'], ['test', '等待測試'], ['done', '完成'],
];
export const COLUMN_LABELS = Object.fromEntries(COLUMNS) as Record<Column, string>;
/** 需要人回應的流程狀態：「我測完了，繼續」在這些狀態下變成主要按鈕。 */
export const NEEDS_HUMAN: PipelineStatus[] = ['waiting', 'feature_test', 'stuck', 'error'];
export const PROVIDER_LABEL: Record<string, string> = { claude: 'Claude', codex: 'Codex' };
export const PROVIDER_LONG: Record<string, string> = { claude: 'Claude Code', codex: 'Codex' };
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const TASK_STATUS_TEXT: Record<string, string> = { pending: '待處理', 'in-progress': '進行中', review: '審查中', done: '完成', blocked: '受阻', cancelled: '取消' };
export const BACKLOG_STATUS: Record<string, string> = { open: '待辦', in_progress: '進行中', done: '已完成' };
export const CHAT_STATUS: Record<string, string> = { pending: '準備中', running: '回覆中', done: '已回覆', error: '未完成', cancelled: '已停止' };
export const LOG_SCOPE_LABELS: Record<string, string> = { runner: '流程', prd: 'PRD', tasks: '拆任務', process: '背景程序' };
export const ROUND_KIND: Record<string, string> = { draft: '初稿', review: '審查', revise: '修訂', user_feedback: '使用者意見', 'user-feedback': '使用者意見' };

export const ROLE_ORDER: Role[] = ['interviewer', 'author', 'reviewer', 'task_planner', 'implementer', 'fixer', 'code_reviewer', 'handover', 'chat'];
export const ROLE_LABELS: Record<Role, string> = {
  interviewer: '需求釐清（Grill Me）', author: 'PRD 作者', reviewer: 'PRD 審查', task_planner: '拆任務', implementer: '實作',
  fixer: '修正', code_reviewer: '程式碼審查', handover: 'Handover（交接紀錄）', chat: '專案對話',
};
export const ROLE_HINTS: Record<Role, string> = {
  interviewer: '主持需求會議，每輪提問', author: '起草與修訂 PRD', reviewer: '審查 PRD，可雙人', task_planner: '把 PRD 拆成任務',
  implementer: '在新對話裡實作任務', fixer: '修驗證錯誤與審查意見', code_reviewer: '審 git diff，可雙人', handover: '寫下一個 session 的交接', chat: '唯讀的專案助理',
};
export const REVIEW_ROLES: Role[] = ['reviewer', 'code_reviewer'];
export const SKILL_STAGE_LABELS: Record<SkillStage, string> = { interview: '需求釐清', prd: 'PRD 起草／修訂', prd_review: 'PRD 審查', tasks: '拆解任務', implement: '實作', code_review: '程式碼審查', fix: '修正', handover: '交接' };
export const SKILL_RUN_STATUS: Record<string, string> = { running: '回覆中', done: '已回覆', error: '失敗' };
export const USAGE_STAGES: Record<string, string> = {
  interview: '需求釐清', prd: 'PRD 起草與修訂', prd_review: 'PRD 審查', tasks: '拆任務', implement: '實作', code_review: '程式碼審查',
  fix: '修正', handover: 'Handover', chat: '專案對話', skill: '技能會議', unknown: '舊紀錄（未分類）',
};
export const SAVING_FEATURES: Record<string, string> = {
  review_diff_filter: '審查略過 lockfile', prd_excerpt: '只附相關 PRD', dedupe_skills: '內建技能不重複', code_map: '專案圖譜',
};
export const WINDOW_NAMES: Record<string, string> = {
  'Current session': '目前 session（5 小時）', 'Current week (all models)': '本週（所有模型）',
  'Current week (Opus)': '本週（Opus）', 'Current week (Sonnet only)': '本週（Sonnet）',
};

/** 專案頁的畫面（左側導覽順序＝Ctrl+1…Ctrl+8）。 */
export const PROJECT_VIEWS = [
  { key: 'chat', label: '專案對話' },
  { key: 'backlog', label: '需求待辦' },
  { key: 'prd', label: 'PRD' },
  { key: 'board', label: '任務看板' },
  { key: 'records', label: '紀錄' },
  { key: 'graph', label: '架構圖' },
  { key: 'usage', label: '用量' },
  { key: 'skills', label: 'Skills' },
] as const;
export type ProjectView = (typeof PROJECT_VIEWS)[number]['key'];

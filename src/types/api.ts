// 後端（src-tauri/src/core/api.rs）回傳的資料形狀。欄位以前端實際用到的為主；其他欄位用 index signature 保留。

export type Provider = 'claude' | 'codex';
export type RoleChoice = Provider | 'both';
export type PipelineStatus = 'idle' | 'queued' | 'running' | 'paused' | 'waiting' | 'feature_test' | 'stuck' | 'error' | 'complete';
export type PrdStatus = 'none' | 'drafting' | 'reviewing' | 'revising' | 'awaiting_approval' | 'approved';
export type TaskStatus = 'pending' | 'in-progress' | 'review' | 'done' | 'blocked' | 'cancelled';
export type Priority = 'high' | 'medium' | 'low';
export type Column = 'todo' | 'doing' | 'review' | 'test' | 'done';
export type ProjectStatus =
  | 'missing' | 'idle' | 'drafting' | 'awaiting_approval' | 'generating' | 'awaiting_tasks' | 'awaiting_permission'
  | 'ready' | 'queued' | 'running' | 'paused' | 'waiting' | 'feature_test' | 'stuck' | 'error' | 'complete';

export interface Loose { [key: string]: unknown }

export interface ProjectSummary extends Loose {
  id: string;
  name: string;
  path: string;
  status: ProjectStatus;
  attention: boolean;
  feature?: string;
  reason?: string;
  progress?: { done: number; total: number };
}
export interface QueueEntry extends Loose { root: string }
export interface QueueSnapshot extends Loose { max: number; running: QueueEntry[]; waiting: QueueEntry[] }
export interface ProjectsPayload { projects: ProjectSummary[]; queue: QueueSnapshot }

export interface ModelSetting { model?: string; effort?: string }
export interface GlobalConfig extends Loose {
  mode: 'auto' | 'manual';
  max_concurrent_runs: number;
  max_fix_rounds: number;
  max_prd_rounds: number;
  num_tasks: number;
  branch_prefix: string;
  roles: Partial<Record<Role, RoleChoice>>;
  models: Partial<Record<Role, Partial<Record<Provider, ModelSetting>>>>;
  runtime: Partial<Record<Provider, 'auto' | 'windows' | 'wsl'>>;
  claude?: ModelSetting & Loose;
  codex?: ModelSetting & Loose;
  token_saving?: TokenSaving;
  skills?: Partial<Record<SkillStage, string[]>>;
}
export type Role = 'interviewer' | 'author' | 'reviewer' | 'task_planner' | 'implementer' | 'fixer' | 'code_reviewer' | 'handover' | 'chat';
export type SkillStage = 'interview' | 'prd' | 'prd_review' | 'tasks' | 'implement' | 'code_review' | 'fix' | 'handover';
export interface TokenSaving extends Loose {
  review_diff_filter?: boolean; prd_excerpt?: boolean; dedupe_skills?: boolean; code_map?: boolean;
  terse?: Partial<Record<'reviewer' | 'implementer' | 'fixer' | 'code_reviewer', boolean>>;
}
export interface ConfigPayload { config: GlobalConfig; home: string; text?: string; queue?: QueueSnapshot }

/** 專案自己的設定（project.json），其餘都來自全域設定。 */
export interface ProjectConfig extends GlobalConfig {
  feature?: string;
  commands?: { build?: string; test?: string; lint?: string };
  context_files?: string[];
}

export interface ModelInfo extends Loose { id: string; name: string; description?: string; efforts?: string[]; default?: boolean; defaultEffort?: string }
export interface ProviderModels extends Loose { models: ModelInfo[]; error?: string | null; defaultModel?: string; defaultEffort?: string; defaultSource?: string }
export interface ModelOptions { claude: ProviderModels; codex: ProviderModels }

export interface Subtask extends Loose { id: string | number; title: string; status?: TaskStatus; description?: string; details?: string; dependencies?: (string | number)[] }
export interface Task extends Loose {
  id: string | number;
  title: string;
  status?: TaskStatus;
  priority?: Priority;
  description?: string;
  details?: string;
  dependencies?: (string | number)[];
  acceptanceCriteria?: string[];
  manualChecks?: string[];
  testStrategy?: string;
  requirement_ids?: string[];
  skills?: string[];
  subtasks?: Subtask[];
  references?: string[];
  parent?: Task;
}
export interface TaskState extends Loose {
  phase?: 'implementing' | 'reviewing' | 'awaiting_test' | 'done' | 'stuck' | string;
  step?: string;
  fix_round?: number;
  attempts?: number;
  last_check_ok?: boolean | null;
  review_verdict?: string;
  review_verdicts?: Record<string, string>;
  commit?: string;
  error?: string;
  stuck_reasons?: string[];
}
export interface PrdRound extends Loose { round: number; kind: string; provider: string; verdict?: string; version?: number | string; file?: string; text?: string }
export interface PrdState extends Loose {
  status: PrdStatus;
  idea?: string;
  error?: string;
  started_at?: string;
  version?: number | string;
  reviewed_version?: number | string;
  human_edited_at?: string;
  reference_scope?: string | null;
  references?: string[];
  archive_dir?: string;
  rounds: PrdRound[];
}
export interface PipelineState extends Loose { status: PipelineStatus; reason?: string }
export interface AppState extends Loose {
  prd: PrdState;
  pipeline: PipelineState;
  control: { pause_requested?: boolean } & Loose;
  tasks: Record<string, TaskState>;
  runner?: { pid?: number; started_at?: string } & Loose;
  task_gen?: { status?: 'running' | 'done' | 'error'; count?: number; error?: string; started_at?: string; pid?: number } & Loose;
  task_approval?: { revision?: string } & Loose;
  usage_blocked?: { provider: Provider; message: string } & Loose;
  skill_job?: { id?: string; pid?: number } & Loose;
}

export interface PermissionRule { toolName: string; ruleContent?: string }
export interface PermissionEntry extends Loose {
  id: string; label?: string; scope?: string; provider: Provider; tool: string; display_name?: string; description?: string;
  input?: Loose; reason?: string; suggestions?: { rules?: PermissionRule[] }[];
}

export interface UsageTokens { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalTokens?: number }
export interface UsageWindow extends Loose { name: string; remainingPercent?: number; windowMinutes?: number; status?: string; expired?: boolean; resetsText?: string; resetsAt?: string }
export interface UsageProvider extends Loose {
  provider: Provider; runtime: string; distro?: string; tokens?: number;
  latest?: { label?: string; status?: string; tokens?: UsageTokens; context?: { remainingPercent?: number; remainingTokens?: number; capacity?: number; estimated?: boolean } } | null;
  limits?: { windows?: UsageWindow[]; error?: string; checkedAt?: string } | null;
}
export interface UsageSession extends Loose { id?: string; label: string; provider: string; runtime: string; status: string; tokens?: UsageTokens; savedEstimate?: number; terse?: boolean }
export interface UsageStage extends Loose { stage: string; sessions: number; tokens: number; savedEstimate?: number }
export interface UsageSnapshot extends Loose {
  totalTokens?: number; measuredSessions: number; unknownSessions: number; providers: UsageProvider[]; recent: UsageSession[];
  savedEstimate?: number; tokenSaving?: TokenSaving; byStage?: UsageStage[];
}

/** /api/p/<id>/state 與 state-<id> 事件的內容。 */
export interface Snapshot extends Loose {
  root: string;
  dataDir: string;
  project: { id: string; name: string };
  config: ProjectConfig;
  runnerAlive: boolean;
  prdBusy: boolean;
  taskGenBusy: boolean;
  skillBusy: boolean;
  queue: Loose | null;
  prd: string;
  tasks: Task[];
  taskTag: string;
  taskRevision: string;
  taskReferences: string[] | null;
  usage: UsageSnapshot;
  permissions: PermissionEntry[];
  state: AppState;
  guards: Record<string, string>;
}

export interface TaskDetail extends Loose {
  id: string; revision: string; tag: string; state: TaskState | null; task: Task;
  checks: string; diff: string; implement: string; log: string;
  reviews: { name: string; round: number; provider: string; text: string }[];
}

export interface BacklogItem extends Loose {
  id: string; title: string; detail?: string; status: 'open' | 'in_progress' | 'done'; references?: string[]; lock?: string; created_at?: string; updated_at?: string;
}
export interface BacklogPayload { items: BacklogItem[]; path: string }

export interface ChatMessage extends Loose { id?: string; role: 'user' | 'assistant' | string; text: string; at?: string; provider?: string; references?: string[] }
export type ChatStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';
export interface ChatSummary extends Loose { id: string; title?: string; status: ChatStatus; updated_at?: string; kind?: string }
export interface ChatSession extends ChatSummary {
  messages: ChatMessage[]; provider?: Provider; model?: string; effort?: string; turn?: string; error?: string; cancelRequested?: boolean;
  contextTruncated?: boolean; contextMessages?: number; contextReferencesTruncated?: boolean;
  requirementsReady?: boolean; requirementsSummary?: string; confirmedSummary?: string;
}
export interface RequirementsPayload { session: ChatSession | null; confirmed?: boolean; stale?: boolean }

export interface ReferenceItem extends Loose {
  id: string; name: string; kind: 'file' | 'folder' | string; sourcePath: string; fileCount: number; totalBytes: number; excludedCount?: number; warnings?: string[];
}
export interface ReferenceSuggestion extends Loose { id?: string; name: string; kind?: string; path?: string }

export interface SkillFile { path: string; bytes: number }
export interface Skill extends Loose {
  name: string; description?: string; error?: string; compatible: boolean; hasBuiltin?: boolean; dir?: string; text?: string; body?: string; files?: SkillFile[]; extensions?: string[];
}
export interface SkillRun extends Loose { id: string; name: string; status: 'running' | 'done' | 'error'; provider?: Provider; previousId?: string; messages?: ChatMessage[]; created_at?: string; updated_at?: string; error?: string }
export interface SkillsPayload { skills: Skill[]; stages: SkillStage[]; config: Partial<Record<SkillStage, string[]>> }

export interface ArchiveSummary extends Loose { name: string; feature?: string; idea?: string; progress?: { done: number; total: number }; completed_at?: string }
export interface ArchivePayload extends Loose {
  name: string; path: string; meta?: { feature?: string; idea?: string; approved_at?: string; completed_at?: string; tm_tag?: string; progress?: { done: number; total: number } } & Loose;
  prd?: string; rounds: { name: string; text: string }[]; tasks: Task[];
}

export interface GraphSummary extends Loose {
  exists: boolean; stats?: { files: number; nodes: number; edges: number; communities: number }; builtAt?: string; commit?: string; paths?: { report?: string }; report?: string; html?: string;
}

export interface DoctorPayload { lines: string[] }

import {
  type UserRow,
  type InsertUser,
  type Model,
  type InsertModel,
  type Pipeline,
  type InsertPipeline,
  type PipelineRun,
  type InsertPipelineRun,
  type StageExecution,
  type InsertStageExecution,
  type Question,
  type InsertQuestion,
  type ChatMessage,
  type InsertChatMessage,
  type LlmRequest,
  type InsertDelegationRequest,
  type DelegationRequestRow,
  type InsertLlmRequest,
  type InsertSpecializationProfile,
  type SpecializationProfileRow,
  type Skill,
  type InsertSkill,
  type InsertManagerIteration,
  type ManagerIterationRow,
  type TriggerRow,
  type InsertTrace,
  type TraceRow,
  type SkillVersionRow,
  type InsertSkillVersion,
  CONSILIUM_LOOP_TERMINAL_STATES,
  type TaskGroupRow,
  type InsertTaskGroup,
  type ConsiliumLoopRow,
  type InsertConsiliumLoop,
  type ConsiliumLoopRoundRow,
  type InsertConsiliumLoopRound,
  type ConsiliumLoopState,
  type TaskRow,
  type InsertTask,
  type TaskTraceRow,
  type InsertTaskTrace,
  type TaskGroupIterationRow,
  type InsertTaskGroupIteration,
  type TaskExecutionRow,
  type InsertTaskExecution,
  type TaskStatus,
  type TaskGroupStatus,
  type TaskExecutionMode,
  type TrackerConnectionRow,
  type InsertTrackerConnection,
  type ModelSkillBinding,
  type InsertModelSkillBinding,
  type ArgoCdConfigRow,
  type InsertArgoCdConfig,
  type WorkspaceRow,
  type InsertWorkspace,
  type SharedSessionRow,
  type WorkspaceConnectionRow,
  type InsertWorkspaceConnection,
  type McpToolCallRow,
  type InsertMcpToolCall,
  type InsertCostLedger,
  type CostLedgerRow,
  type BudgetRow,
  type InsertBudget,
  type UpdateBudget,
  type WorkspaceSettingsRow,
  type Lesson,
  type InsertLesson,
  type PracticeCardRow,
  type InsertPracticeCard,
  type PracticeCardRefreshRunRow,
  type PracticeCardReviewState,
  type PracticeCardStatus,
} from "@shared/schema";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig, TraceSpan, TaskTraceSpan, SkillVersionRecord, InsertSkillVersion as InsertSkillVersionType, SharedSession, CreateSharedSessionInput, SharePermissions, ShareRole, WorkspaceConnection, CreateWorkspaceConnectionInput, UpdateWorkspaceConnectionInput, McpToolCall, ConnectionUsageMetrics, RecordMcpToolCallInput, SessionConflict, DecisionLogEntry, RaiseConflictInput, CastConflictVoteInput, DebateJudgement, ExperimentBranchResult, ResolutionOutcome, ResearchReport, ExecutionTrace, ActionPoint } from "@shared/types";
import type { LessonRecallFilter } from "./memory/lessons/types";
import { randomUUID } from "crypto";
import { PgStorage } from "./storage-pg";
import { configLoader } from "./config/loader";

// ─── LLM Request query filters ───────────────────────────────────────────────

export interface LlmRequestFilters {
  runId?: string;
  provider?: string;
  modelSlug?: string;
  status?: string;
  from?: Date;
  to?: Date;
  page?: number;
  limit?: number;
}

export interface LlmRequestStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface LlmStatsByModel {
  modelSlug: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface LlmStatsByProvider {
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  avgLatencyMs: number;
  errorRate: number;
}

export interface LlmStatsByTeam {
  teamId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmStatsByWorkspace {
  workspaceId: string | null;
  workspaceName: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface LlmTimelinePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

/** Recency sort key for a lesson (createdAt may be null in degenerate rows). */
function lessonTime(lesson: Lesson): number {
  return lesson.createdAt?.getTime() ?? 0;
}

/** True when a lesson satisfies a recall filter (undefined fields ignored). */
function matchesLessonFilter(lesson: Lesson, filter: LessonRecallFilter): boolean {
  if (filter.workspaceId !== undefined && lesson.workspaceId !== filter.workspaceId) {
    return false;
  }
  if (filter.teamId !== undefined && lesson.teamId !== filter.teamId) return false;
  if (filter.outcome !== undefined && lesson.outcome !== filter.outcome) return false;
  return true;
}

export interface PracticeCardFilters {
  status?: PracticeCardStatus;
  reviewState?: PracticeCardReviewState;
  topic?: string;
  limit?: number;
  offset?: number;
}

/**
 * In-memory keyset pagination over `(completedAt desc, id desc)` for the history
 * finders. A null completedAt sorts LAST (treated as -Infinity). The cursor is
 * exclusive: only rows strictly older than (cursor.completedAt, cursor.id) are
 * returned. Returns at most `query.limit` rows.
 */
function keysetPage<T extends { id: string; completedAt: Date | null }>(
  rows: T[],
  query: RunHistoryQuery,
): T[] {
  const ts = (d: Date | null): number => (d ? d.getTime() : -Infinity);
  const sorted = [...rows].sort((a, b) => {
    const ta = ts(a.completedAt);
    const tb = ts(b.completedAt);
    if (ta !== tb) return tb - ta; // completedAt desc
    return b.id.localeCompare(a.id); // id desc
  });
  let filtered = sorted;
  if (query.cursor) {
    const cTs = new Date(query.cursor.completedAt).getTime();
    const cId = query.cursor.id;
    filtered = sorted.filter((r) => {
      const rt = ts(r.completedAt);
      if (rt < cTs) return true;
      if (rt > cTs) return false;
      return r.id.localeCompare(cId) < 0; // same ts, strictly smaller id
    });
  }
  return filtered.slice(0, query.limit);
}

/** Keyset-paginated history finder options (terminal-status runs only). */
export interface RunHistoryQuery {
  /** When set, restrict to runs owned by this user (non-admin scoping). Admins omit it. */
  ownerId?: string;
  /** Max rows to return (the caller clamps to <=100). */
  limit: number;
  /** Keyset cursor: only rows strictly older than (completedAt, id) are returned. */
  cursor?: { completedAt: string; id: string };
}

/** One row of pipeline-family run history (terminal). Metadata is classified by the route. */
export interface PipelineRunHistoryRow {
  id: string;
  status: string;
  workspaceId: string | null;
  triggeredBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
  currentStageIndex: number;
}

/** One row of task-group history (terminal). */
export interface TaskGroupHistoryRow {
  id: string;
  status: string;
  createdBy: string | null;
  startedAt: Date | null;
  completedAt: Date | null;
}

import {
  TASK_GROUP_V2_MAX_LIMIT,
  IterationConflictError,
  buildVirtualIteration,
  type IterationListQuery,
  type IterationExecutionSeed,
  type IterationStartInput,
  type VirtualIteration,
} from "./storage-task-groups-v2";
// Re-export the v2 storage contracts so existing consumers that import from
// `./storage` keep working (tests + routes reference these from here).
export {
  TASK_GROUP_V2_MAX_LIMIT,
  IterationConflictError,
} from "./storage-task-groups-v2";
export type {
  IterationListQuery,
  IterationExecutionSeed,
  IterationStartInput,
  VirtualIteration,
} from "./storage-task-groups-v2";

export interface IStorage {
  // Users (legacy scaffold — auth handled by AuthService)
  getUser(id: string): Promise<UserRow | undefined>;
  getUserByEmail(email: string): Promise<UserRow | undefined>;
  createUser(user: InsertUser): Promise<UserRow>;

  // Models
  getModels(): Promise<Model[]>;
  getActiveModels(): Promise<Model[]>;
  getModelBySlug(slug: string): Promise<Model | undefined>;
  createModel(model: InsertModel): Promise<Model>;
  /** Create the model if its slug is new, otherwise update the existing row. */
  upsertModelBySlug(model: InsertModel): Promise<Model>;
  updateModel(id: string, updates: Partial<InsertModel>): Promise<Model>;
  deleteModel(id: string): Promise<void>;

  // Pipelines
  getPipelines(): Promise<Pipeline[]>;
  getPipeline(id: string): Promise<Pipeline | undefined>;
  getTemplates(): Promise<Pipeline[]>;
  createPipeline(pipeline: InsertPipeline): Promise<Pipeline>;
  updatePipeline(id: string, updates: Partial<InsertPipeline>): Promise<Pipeline>;
  deletePipeline(id: string): Promise<void>;

  // Pipeline Runs
  getPipelineRuns(pipelineId?: string): Promise<PipelineRun[]>;
  /** Terminal-status pipeline-family runs, owner-filtered, keyset-paginated (completedAt desc, id desc). */
  listPipelineRunHistory(query: RunHistoryQuery): Promise<PipelineRunHistoryRow[]>;
  getPipelineRun(id: string): Promise<PipelineRun | undefined>;
  createPipelineRun(run: InsertPipelineRun): Promise<PipelineRun>;
  updatePipelineRun(id: string, updates: Partial<PipelineRun>): Promise<PipelineRun>;

  // Stage Executions
  getStageExecutions(runId: string): Promise<StageExecution[]>;
  getStageExecution(id: string): Promise<StageExecution | undefined>;
  createStageExecution(execution: InsertStageExecution): Promise<StageExecution>;
  updateStageExecution(id: string, updates: Partial<StageExecution>): Promise<StageExecution>;

  // Lessons (agent-experience memory — Track B)
  createLesson(lesson: InsertLesson): Promise<Lesson>;
  recallLessons(filter: LessonRecallFilter): Promise<Lesson[]>;
  getLessons(workspaceId?: string): Promise<Lesson[]>;

  // Questions
  getQuestions(runId: string): Promise<Question[]>;
  getPendingQuestions(runId?: string): Promise<Question[]>;
  getQuestion(id: string): Promise<Question | undefined>;
  createQuestion(question: InsertQuestion): Promise<Question>;
  answerQuestion(id: string, answer: string): Promise<Question>;
  dismissQuestion(id: string): Promise<Question>;

  // Chat Messages
  getChatMessages(runId?: string, limit?: number): Promise<ChatMessage[]>;
  createChatMessage(message: InsertChatMessage): Promise<ChatMessage>;

  // LLM Requests
  createLlmRequest(data: InsertLlmRequest): Promise<LlmRequest>;
  getLlmRequests(filters: LlmRequestFilters): Promise<{ rows: LlmRequest[]; total: number }>;
  getLlmRequestById(id: number): Promise<LlmRequest | undefined>;
  getLlmRequestStats(): Promise<LlmRequestStats>;
  getLlmStatsByModel(): Promise<LlmStatsByModel[]>;
  getLlmStatsByProvider(): Promise<LlmStatsByProvider[]>;
  getLlmStatsByTeam(): Promise<LlmStatsByTeam[]>;
  getLlmStatsByWorkspace(): Promise<LlmStatsByWorkspace[]>;
  getLlmTimeline(from: Date, to: Date, granularity: 'day' | 'week'): Promise<LlmTimelinePoint[]>;

  // Memories
  getMemories(scope: MemoryScope, scopeId?: string | null, type?: MemoryType): Promise<Memory[]>;
  searchMemories(query: string, scope?: MemoryScope): Promise<Memory[]>;
  upsertMemory(memory: InsertMemory): Promise<Memory>;
  deleteMemory(id: number): Promise<void>;
  decayMemories(excludeRunId: number, decayAmount: number): Promise<number>;
  deleteStaleMemories(threshold: number): Promise<number>;
  updateMemoryPublished(id: number, published: boolean): Promise<Memory | null>;

  // MCP Servers
  getMcpServers(): Promise<McpServerConfig[]>;
  getMcpServer(id: number): Promise<McpServerConfig | undefined>;
  createMcpServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig>;
  updateMcpServer(id: number, updates: Partial<McpServerConfig>): Promise<McpServerConfig>;
  deleteMcpServer(id: number): Promise<void>;

  // Delegation Requests (Phase 6.4)
  createDelegationRequest(data: InsertDelegationRequest): Promise<DelegationRequestRow>;
  getDelegationRequests(runId: string): Promise<DelegationRequestRow[]>;
  updateDelegationRequest(id: string, updates: Partial<DelegationRequestRow>): Promise<DelegationRequestRow>;
  // Specialization Profiles (Phase 5)
  getSpecializationProfiles(): Promise<SpecializationProfileRow[]>;
  createSpecializationProfile(profile: InsertSpecializationProfile): Promise<SpecializationProfileRow>;
  deleteSpecializationProfile(id: string): Promise<void>;

  // Skills
  getSkills(filter?: { teamId?: string; isBuiltin?: boolean }): Promise<Skill[]>;
  getSkill(id: string): Promise<Skill | undefined>;
  createSkill(data: InsertSkill): Promise<Skill>;
  updateSkill(id: string, updates: Partial<InsertSkill>): Promise<Skill>;
  deleteSkill(id: string): Promise<void>;

  // Skill Versions (Phase 6.16)
  getSkillVersions(skillId: string, limit: number, offset: number): Promise<{ rows: SkillVersionRecord[]; total: number }>;
  getSkillVersion(skillId: string, version: string): Promise<SkillVersionRecord | undefined>;
  createSkillVersion(data: InsertSkillVersionType): Promise<SkillVersionRecord>;

  incrementSkillUsage(id: string): Promise<number>;

  // Manager Iterations (Phase 6.6)
  createManagerIteration(data: InsertManagerIteration): Promise<ManagerIterationRow>;
  updateManagerIteration(
    runId: string,
    iterationNumber: number,
    updates: Partial<Pick<ManagerIterationRow, "teamResult" | "teamDurationMs">>,
  ): Promise<void>;
  getManagerIterations(runId: string, offset?: number, limit?: number): Promise<ManagerIterationRow[]>;
  countManagerIterations(runId: string): Promise<number>;

  // Triggers (Phase 6.3)
  getTriggers(pipelineId: string): Promise<TriggerRow[]>;
  /** T1: all triggers in the current project ALS (pipeline-based AND pipeline-less). */
  getProjectTriggers(): Promise<TriggerRow[]>;
  getTrigger(id: string): Promise<TriggerRow | undefined>;
  getEnabledTriggersByType(type: string): Promise<TriggerRow[]>;
  /** Cross-project query for system/background use: returns ALL enabled triggers of this type
   *  across every project. Must be called within runAsSystem(). See ADR-001 §3.1(d). */
  getAllEnabledTriggersByType(type: string): Promise<TriggerRow[]>;
  createTrigger(data: Omit<TriggerRow, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt' | 'suppressedCount'> & { secretEncrypted?: string | null }): Promise<TriggerRow>;
  updateTrigger(id: string, updates: Partial<TriggerRow>): Promise<TriggerRow>;
  deleteTrigger(id: string): Promise<void>;
  /** T1 policy rail: atomically bump a trigger's suppressed-fire counter (dedup/budget). */
  incrementTriggerSuppressed(id: string): Promise<void>;

  // Practice Cards (Active Knowledge Base)
  createPracticeCard(data: InsertPracticeCard): Promise<PracticeCardRow>;
  getPracticeCard(id: string): Promise<PracticeCardRow | null>;
  listPracticeCards(workspaceId: string, filters?: PracticeCardFilters): Promise<{ cards: PracticeCardRow[]; total: number }>;
  getPracticeCardsByWorkspace(workspaceId: string): Promise<PracticeCardRow[]>;
  updatePracticeCardState(id: string, updates: Partial<PracticeCardRow>): Promise<PracticeCardRow>;
  createRefreshRun(workspaceId: string, topic: string, trigger: string): Promise<PracticeCardRefreshRunRow>;
  getRefreshRun(id: string): Promise<PracticeCardRefreshRunRow | null>;
  updateRefreshRun(id: string, updates: Partial<PracticeCardRefreshRunRow>): Promise<PracticeCardRefreshRunRow>;

  // Traces (Phase 6.5)
  createTrace(data: InsertTrace): Promise<TraceRow>;
  getTraceByRunId(runId: string): Promise<TraceRow | null>;
  getTraceByTraceId(traceId: string): Promise<TraceRow | null>;
  getTraces(limit?: number, offset?: number): Promise<TraceRow[]>;
  updateTraceSpans(traceId: string, spans: TraceSpan[]): Promise<void>;

  // Task Groups (Task Orchestrator)
  getTaskGroups(): Promise<TaskGroupRow[]>;
  getTaskGroup(id: string): Promise<TaskGroupRow | undefined>;
  createTaskGroup(data: InsertTaskGroup): Promise<TaskGroupRow>;
  updateTaskGroup(id: string, updates: Partial<TaskGroupRow>): Promise<TaskGroupRow>;
  deleteTaskGroup(id: string): Promise<void>;

  // Tasks (Task Orchestrator)
  getTasksByGroup(groupId: string): Promise<TaskRow[]>;
  getTask(id: string): Promise<TaskRow | undefined>;
  createTask(data: InsertTask): Promise<TaskRow>;
  updateTask(id: string, updates: Partial<TaskRow>): Promise<TaskRow>;
  /** Hard-delete a single task by id (used by task-group edit). */
  deleteTask(id: string): Promise<void>;
  /** Terminal-status task groups, owner-filtered, keyset-paginated (completedAt desc, id desc). */
  listTaskGroupHistory(query: RunHistoryQuery): Promise<TaskGroupHistoryRow[]>;
  getReadyTasks(groupId: string): Promise<TaskRow[]>;
  getBlockedTasks(groupId: string): Promise<TaskRow[]>;

  // Task Traces (End-to-End Request Observability)
  createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow>;
  getTaskTrace(groupId: string): Promise<TaskTraceRow | null>;
  updateTaskTrace(id: string, updates: Partial<TaskTraceRow>): Promise<TaskTraceRow>;

  // ─── Task Group Iterations (task-groups-v2 §3.1 / BE2) ──────────────────────
  /** Insert one iteration; throws IterationConflictError on UNIQUE(group,number). */
  createIteration(data: InsertTaskGroupIteration): Promise<TaskGroupIterationRow>;
  /** Iterations for a group, keyset-paginated `iteration_number desc`. */
  getIterations(groupId: string, query: IterationListQuery): Promise<TaskGroupIterationRow[]>;
  /** A single iteration by (group, number); group is the mandatory scope key. */
  getIteration(groupId: string, iterationNumber: number): Promise<TaskGroupIterationRow | undefined>;
  /** The highest-numbered iteration for a group (the "current" run), if any. */
  getLatestIteration(groupId: string): Promise<TaskGroupIterationRow | undefined>;
  updateIteration(id: string, updates: Partial<TaskGroupIterationRow>): Promise<TaskGroupIterationRow>;
  /**
   * Atomically insert an iteration + all its seed executions (SF-1). Either all
   * rows commit or none do. Throws IterationConflictError on UNIQUE(group,number).
   */
  createIterationWithExecutions(
    groupId: string,
    start: IterationStartInput,
    seeds: IterationExecutionSeed[],
  ): Promise<{ iteration: TaskGroupIterationRow; executions: TaskExecutionRow[] }>;

  // ─── Task Executions (task-groups-v2 §3.2 / BE2 — MF-1 group-scoped) ────────
  createExecution(data: InsertTaskExecution): Promise<TaskExecutionRow>;
  /** Executions for an iteration, scoped to `groupId` (MF-1: mandatory scope key). */
  getExecutionsByIteration(groupId: string, iterationId: string): Promise<TaskExecutionRow[]>;
  /** A single execution by id, scoped to `groupId` (MF-1: never a bare child id). */
  getExecution(groupId: string, executionId: string): Promise<TaskExecutionRow | undefined>;
  updateExecution(id: string, updates: Partial<TaskExecutionRow>): Promise<TaskExecutionRow>;

  /**
   * Lazy virtual-iteration adapter (§8, MF-5): for a pre-v2 group with ZERO real
   * iteration rows, synthesize a read-only iteration 1 + executions from the
   * legacy `tasks` execution columns. Returns null if the group already has real
   * iterations (callers should read those) or the group does not exist. The route
   * MUST invoke this only inside an already-authorized handler.
   */
  getVirtualIteration(groupId: string): Promise<VirtualIteration | null>;

  // ─── Per-iteration trace (task-groups-v2 §3.4 / MF-3 group-scoped) ──────────
  /** The trace for a specific iteration, scoped to `groupId` (MF-3). */
  getTaskTraceByIteration(groupId: string, iterationId: string): Promise<TaskTraceRow | null>;

  // ─── Consilium Loops (Phase B — auto-versioned FSM, design §4) ──────────────
  /** Insert a loop. The DB partial-unique index rejects a 2nd active loop per
   *  group (Security H-3) — surfaces as a unique-violation the route maps to 409. */
  createLoop(data: InsertConsiliumLoop): Promise<ConsiliumLoopRow>;
  getLoop(id: string): Promise<ConsiliumLoopRow | undefined>;
  /** Loops created by `ownerId`, newest first (owner-scoped list, mirror task-groups). */
  getLoopsByOwner(ownerId: string): Promise<ConsiliumLoopRow[]>;
  /** All loops (admin list / poller backstop sweep). */
  getLoops(): Promise<ConsiliumLoopRow[]>;
  /** The active (non-terminal) loop for a group, if any (create-time conflict check). */
  getActiveLoopByGroup(groupId: string): Promise<ConsiliumLoopRow | undefined>;
  updateLoop(
    id: string,
    updates: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt">>,
  ): Promise<ConsiliumLoopRow>;
  /**
   * Carry-in (b) — SOURCE-CONDITIONAL archetype write (Stage 2a makes the archetype
   * LOAD-BEARING). A PLAIN partial update of the archetype columns that lands ONLY
   * when the row's `archetype_source IS DISTINCT FROM 'override'` (NULL/'proposed'
   * match; a human 'override' does NOT), so a model PROPOSAL can never clobber a
   * human override even under a sub-millisecond TOCTOU race. Returns the updated row,
   * or `undefined` when an override blocked the write (0 rows). NOT a state
   * transition (never touches `state`).
   */
  updateLoopArchetypeIfNotOverridden(
    id: string,
    updates: Pick<
      ConsiliumLoopRow,
      "archetype" | "archetypeSource" | "archetypeRationale" | "archetypeParams" | "archetypeDecidedAt"
    >,
  ): Promise<ConsiliumLoopRow | undefined>;
  /**
   * H-3 — atomic compare-and-swap on `state`. Sets the loop to `next` (+ any
   * extra fields) ONLY when its current state equals `expected`. Returns the
   * updated row when the CAS won (1 row), or `undefined` when it lost (0 rows —
   * another tick/instance already advanced it). The reducer's single source of
   * mutual exclusion: NO in-memory Set.
   */
  casLoopState(
    id: string,
    expected: ConsiliumLoopState,
    next: ConsiliumLoopState,
    extra?: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt" | "state">>,
  ): Promise<ConsiliumLoopRow | undefined>;
  /**
   * H-3 (re-drive) — atomically CLAIM a crash-stranded loop's re-drive across
   * instances. Conditional UPDATE that bumps `updatedAt` ONLY when the row is
   * still in `expected` state, its state-specific child ref is NULL (reviewing →
   * current_iteration_number IS NULL; developing → dev_group_id IS NULL), AND it
   * has been stranded longer than `graceMs` (updatedAt < now - graceMs). The
   * FIRST instance's UPDATE moves updatedAt to now, so a concurrent second
   * instance's `updatedAt < now-grace` predicate no longer matches → 0 rows →
   * `undefined` → it backs off. Returns the claimed row (run the side effect) or
   * undefined (lost the claim — no-op). Same atomic-DB-guard discipline as
   * casLoopState; closes the cross-instance re-drive double-fire.
   */
  claimRedrive(
    id: string,
    expected: ConsiliumLoopState,
    graceMs: number,
  ): Promise<ConsiliumLoopRow | undefined>;
  /**
   * Bug #7 (stranded-REVIEW recovery) — atomically CLAIM a stalled review round's
   * re-launch across instances. Unlike `claimRedrive` (which matches a NULL child
   * ref = a crash BEFORE the iteration was written), this matches a review whose
   * iteration IS set but has gone idle: a conditional UPDATE that bumps `updatedAt`
   * ONLY when the row is still `reviewing`, still on the SAME stale iteration
   * (`current_iteration_number = expectedIterationNumber`), AND untouched since
   * `staleThreshold` (updatedAt < staleThreshold). The winner's UPDATE moves
   * updatedAt to now, so a concurrent instance's predicate no longer matches → 0
   * rows → `undefined` → it backs off. Exactly one instance re-launches; a loser
   * (and a review that legitimately advanced its iteration in the meantime) no-op.
   */
  claimReviewRedrive(
    id: string,
    expectedIterationNumber: number,
    staleThreshold: Date,
  ): Promise<ConsiliumLoopRow | undefined>;
  /** Append one round (UNIQUE(loop, round) — idempotent re-append throws). */
  appendLoopRound(data: InsertConsiliumLoopRound): Promise<ConsiliumLoopRoundRow>;
  getLoopRounds(loopId: string): Promise<ConsiliumLoopRoundRow[]>;
  /**
   * Stage 2b: set the per-round `test_summary` (the convergence wire) AFTER the SDLC
   * run settles. Additive over the audit row recorded on entering `developing`;
   * no-op when the (loop, round) row is absent. Idempotent / best-effort.
   */
  updateLoopRoundTestSummary(loopId: string, round: number, testSummary: string): Promise<void>;
  /**
   * Stage 3 (research archetype): set the per-round structured `report` AFTER the
   * research run settles. Additive over the audit row recorded on entering
   * `developing`; no-op when the (loop, round) row is absent. Idempotent / best-effort
   * (mirror of updateLoopRoundTestSummary).
   */
  updateLoopRoundReport(loopId: string, round: number, report: ResearchReport): Promise<void>;
  /** Stage 4: persist the per-round execution trace out-of-band (mirror of report). */
  updateLoopRoundExecutionTrace(loopId: string, round: number, trace: ExecutionTrace): Promise<void>;
  /**
   * Stage B (design §5): persist the planner's per-criterion METHOD assignment onto the
   * round's `open_action_points` (each ActionPoint's additive `verificationMethod`). Mirror
   * of the trace/report updates — additive, no migration; no-op when the (loop, round) row
   * is absent. Idempotent / best-effort (observability only; the executor re-normalizes).
   */
  updateLoopRoundActionPoints(loopId: string, round: number, actionPoints: ActionPoint[]): Promise<void>;


  // Tracker Connections (Issue Tracker Integration)
  getTrackerConnectionsByGroup(taskGroupId: string): Promise<TrackerConnectionRow[]>;
  getTrackerConnection(id: string): Promise<TrackerConnectionRow | undefined>;
  createTrackerConnection(data: InsertTrackerConnection): Promise<TrackerConnectionRow>;
  deleteTrackerConnection(id: string): Promise<void>;

  // Model Skill Bindings (Phase 6.17)
  getModelSkillBindings(modelId: string): Promise<ModelSkillBinding[]>;
  getModelsWithSkillBindings(): Promise<string[]>;
  createModelSkillBinding(data: InsertModelSkillBinding): Promise<ModelSkillBinding>;
  deleteModelSkillBinding(modelId: string, skillId: string): Promise<void>;
  resolveSkillsForModel(modelId: string): Promise<Skill[]>;

  // ArgoCD Config
  getArgoCdConfig(): Promise<ArgoCdConfigRow | null>;
  saveArgoCdConfig(config: Partial<InsertArgoCdConfig>): Promise<ArgoCdConfigRow>;
  deleteArgoCdConfig(): Promise<void>;

  // Workspaces
  getWorkspaces(): Promise<WorkspaceRow[]>;
  getWorkspace(id: string): Promise<WorkspaceRow | null>;
  createWorkspace(data: InsertWorkspace & { id?: string }): Promise<WorkspaceRow>;
  updateWorkspace(id: string, updates: Partial<WorkspaceRow>): Promise<WorkspaceRow>;
  deleteWorkspace(id: string): Promise<void>;

  // Shared Sessions (Federation, issue #224)
  getSharedSession(id: string): Promise<SharedSession | null>;
  getSharedSessionByToken(token: string): Promise<SharedSession | null>;
  getSharedSessionsByRunId(runId: string): Promise<SharedSession[]>;
  createSharedSession(input: CreateSharedSessionInput): Promise<SharedSession>;
  deactivateSharedSession(id: string): Promise<void>;
  listActiveSharedSessions(): Promise<SharedSession[]>;
  updateSessionPermissions(
    id: string,
    permissions: { role?: string; allowedStages?: string[] | null; canChat?: boolean; canVote?: boolean; canViewMemories?: boolean },
  ): Promise<SharedSession | null>;

  // Workspace Connections (issue #266)
  getWorkspaceConnections(workspaceId: string): Promise<WorkspaceConnection[]>;
  getWorkspaceConnection(id: string): Promise<WorkspaceConnection | null>;
  createWorkspaceConnection(input: CreateWorkspaceConnectionInput): Promise<WorkspaceConnection>;
  updateWorkspaceConnection(id: string, updates: UpdateWorkspaceConnectionInput): Promise<WorkspaceConnection>;
  deleteWorkspaceConnection(id: string): Promise<void>;
  testWorkspaceConnection(id: string): Promise<WorkspaceConnection>;

  // MCP Tool Call Audit Log (issue #271)
  recordMcpToolCall(input: RecordMcpToolCallInput): Promise<McpToolCall>;
  getMcpToolCallsByConnection(
    connectionId: string,
    fromDate: Date,
    toDate: Date,
    limit?: number,
  ): Promise<McpToolCall[]>;
  getConnectionUsageMetrics(connectionId: string): Promise<ConnectionUsageMetrics>;

  // Cost Ledger + Budgets (issue #279)
  appendCostLedger(input: InsertCostLedger): Promise<CostLedgerRow>;
  getCostLedgerRows(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<CostLedgerRow[]>;
  getCostLedgerSum(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
  }): Promise<number>;
  getBudgetsByWorkspace(workspaceId: string): Promise<BudgetRow[]>;
  getBudget(id: string): Promise<BudgetRow | null>;
  createBudget(input: InsertBudget): Promise<BudgetRow>;
  updateBudget(id: string, updates: UpdateBudget): Promise<BudgetRow>;
  deleteBudget(id: string): Promise<void>;

  // Workspace Settings (issue #280)
  getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown> | null>;
  upsertWorkspaceSettings(workspaceId: string, patch: Record<string, unknown>): Promise<void>;

  // Conflict Resolution (issue #229)
  saveConflict(conflict: SessionConflict): Promise<void>;
  getConflict(conflictId: string): Promise<SessionConflict | null>;
  getSessionConflicts(sessionId: string): Promise<SessionConflict[]>;
  appendDecisionLog(entry: DecisionLogEntry): Promise<void>;
  getDecisionLog(sessionId?: string): Promise<DecisionLogEntry[]>;
}

/**
 * Enforce the practice_cards.ingested_by_user_id NOT NULL invariant in MemStorage,
 * mirroring the Postgres constraint so tests and dev parity catch a missing
 * trusted ingester id (the adversarial verify gate depends on it).
 */
function requireIngesterId(value: string | null | undefined): string {
  if (!value) {
    throw new Error("practice_cards.ingested_by_user_id must be non-null");
  }
  return value;
}

export class MemStorage implements IStorage {
  private usersMap: Map<string, UserRow>;
  private models: Map<string, Model>;
  private pipelinesMap: Map<string, Pipeline>;
  private runs: Map<string, PipelineRun>;
  private stages: Map<string, StageExecution>;
  private lessonsMap: Map<string, Lesson>;
  private questionsMap: Map<string, Question>;
  private messages: Map<string, ChatMessage>;
  private llmRequestsMap: Map<number, LlmRequest>;
  private llmRequestIdSeq: number;
  private memoriesMap: Map<number, Memory>;
  private nextMemoryId: number;
  private mcpServersMap: Map<number, McpServerConfig>;
  private nextMcpServerId: number;
  private delegationsMap: Map<string, DelegationRequestRow>;
  private managerIterationsMap: Map<string, ManagerIterationRow> = new Map();
  private specializationProfilesMap: Map<string, SpecializationProfileRow>;
  private workspaceSettingsMap: Map<string, Record<string, unknown>> = new Map();

  constructor() {
    this.usersMap = new Map();
    this.models = new Map();
    this.pipelinesMap = new Map();
    this.runs = new Map();
    this.stages = new Map();
    this.lessonsMap = new Map();
    this.questionsMap = new Map();
    this.messages = new Map();
    this.llmRequestsMap = new Map();
    this.llmRequestIdSeq = 1;
    this.memoriesMap = new Map();
    this.nextMemoryId = 1;
    this.mcpServersMap = new Map();
    this.nextMcpServerId = 1;
    this.delegationsMap = new Map();
    this.specializationProfilesMap = new Map();
  }

  // ─── Users ──────────────────────────────────────

  async getUser(id: string): Promise<UserRow | undefined> {
    return this.usersMap.get(id);
  }

  async getUserByEmail(email: string): Promise<UserRow | undefined> {
    return Array.from(this.usersMap.values()).find((u) => u.email === email);
  }

  async createUser(insertUser: InsertUser): Promise<UserRow> {
    const id = randomUUID();
    const user: UserRow = {
      id,
      email: insertUser.email,
      name: insertUser.name,
      passwordHash: insertUser.passwordHash ?? null,
      isActive: insertUser.isActive ?? true,
      role: (insertUser.role as 'user' | 'maintainer' | 'admin') ?? 'user',
      oauthProvider: (insertUser.oauthProvider as 'github' | 'gitlab' | null | undefined) ?? null,
      oauthId: insertUser.oauthId ?? null,
      avatarUrl: insertUser.avatarUrl ?? null,
      lastLoginAt: insertUser.lastLoginAt ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.usersMap.set(id, user);
    return user;
  }

  // ─── Models ─────────────────────────────────────

  async getModels(): Promise<Model[]> {
    return Array.from(this.models.values());
  }

  async getActiveModels(): Promise<Model[]> {
    return Array.from(this.models.values()).filter((m) => m.isActive);
  }

  async getModelBySlug(slug: string): Promise<Model | undefined> {
    return Array.from(this.models.values()).find((m) => m.slug === slug);
  }

  async createModel(insert: InsertModel): Promise<Model> {
    const id = randomUUID();
    const model: Model = {
      projectId: insert.projectId ?? null,
      id,
      name: insert.name,
      slug: insert.slug,
      modelId: insert.modelId ?? null,
      endpoint: insert.endpoint ?? null,
      provider: insert.provider ?? "mock",
      contextLimit: insert.contextLimit ?? 4096,
      capabilities: insert.capabilities ?? [],
      isActive: insert.isActive ?? true,
      createdAt: new Date(),
    };
    this.models.set(id, model);
    return model;
  }

  async upsertModelBySlug(insert: InsertModel): Promise<Model> {
    const existing = await this.getModelBySlug(insert.slug);
    if (!existing) return this.createModel(insert);
    return this.updateModel(existing.id, insert);
  }

  async updateModel(id: string, updates: Partial<InsertModel>): Promise<Model> {
    const model = this.models.get(id);
    if (!model) throw new Error(`Model not found: ${id}`);
    const updated = { ...model, ...updates };
    this.models.set(id, updated);
    return updated;
  }

  async deleteModel(id: string): Promise<void> {
    if (!this.models.has(id)) throw new Error(`Model not found: ${id}`);
    this.models.delete(id);
  }

  // ─── Pipelines ──────────────────────────────────

  async getPipelines(): Promise<Pipeline[]> {
    return Array.from(this.pipelinesMap.values());
  }

  async getPipeline(id: string): Promise<Pipeline | undefined> {
    return this.pipelinesMap.get(id);
  }

  async getTemplates(): Promise<Pipeline[]> {
    return Array.from(this.pipelinesMap.values()).filter((p) => p.isTemplate);
  }

  async createPipeline(insert: InsertPipeline): Promise<Pipeline> {
    const id = randomUUID();
    const now = new Date();
    const pipeline: Pipeline = {
      projectId: insert.projectId ?? null,
      id,
      name: insert.name,
      description: insert.description ?? null,
      stages: insert.stages ?? [],
      dag: insert.dag ?? null,
      createdBy: insert.createdBy ?? null,
      ownerId: insert.ownerId ?? null,
      isTemplate: insert.isTemplate ?? false,
      managerConfig: ((insert as { managerConfig?: unknown }).managerConfig ?? null) as import("@shared/types").ManagerConfig | null,
      createdAt: now,
      updatedAt: now,
    };
    this.pipelinesMap.set(id, pipeline);
    return pipeline;
  }

  async updatePipeline(
    id: string,
    updates: Partial<InsertPipeline>,
  ): Promise<Pipeline> {
    const pipeline = this.pipelinesMap.get(id);
    if (!pipeline) throw new Error(`Pipeline not found: ${id}`);
    const updated = { ...pipeline, ...updates, updatedAt: new Date() };
    this.pipelinesMap.set(id, updated);
    return updated;
  }

  async deletePipeline(id: string): Promise<void> {
    this.pipelinesMap.delete(id);
  }

  // ─── Pipeline Runs ──────────────────────────────

  async getPipelineRuns(pipelineId?: string): Promise<PipelineRun[]> {
    const all = Array.from(this.runs.values());
    if (pipelineId) return all.filter((r) => r.pipelineId === pipelineId);
    return all;
  }

  async listPipelineRunHistory(query: RunHistoryQuery): Promise<PipelineRunHistoryRow[]> {
    const terminal = new Set(["completed", "failed", "cancelled", "rejected"]);
    const rows = Array.from(this.runs.values())
      .filter((r) => terminal.has(r.status))
      .filter((r) => (query.ownerId == null ? true : r.triggeredBy === query.ownerId))
      .map((r) => ({
        id: r.id,
        status: r.status,
        workspaceId: r.workspaceId ?? null,
        triggeredBy: r.triggeredBy ?? null,
        startedAt: r.startedAt ?? null,
        completedAt: r.completedAt ?? null,
        currentStageIndex: r.currentStageIndex ?? 0,
      }));
    return keysetPage(rows, query);
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    return this.runs.get(id);
  }

  async createPipelineRun(insert: InsertPipelineRun): Promise<PipelineRun> {
    const id = randomUUID();
    const run: PipelineRun = {
      projectId: insert.projectId ?? null,
      id,
      pipelineId: insert.pipelineId,
      workspaceId: insert.workspaceId ?? null,
      status: insert.status ?? "pending",
      input: insert.input,
      output: insert.output ?? null,
      currentStageIndex: insert.currentStageIndex ?? 0,
      startedAt: insert.startedAt ?? null,
      completedAt: insert.completedAt ?? null,
      triggeredBy: insert.triggeredBy ?? null,
      dagMode: insert.dagMode ?? false,
      createdAt: new Date(),
    };
    this.runs.set(id, run);
    return run;
  }

  async updatePipelineRun(
    id: string,
    updates: Partial<PipelineRun>,
  ): Promise<PipelineRun> {
    const run = this.runs.get(id);
    if (!run) throw new Error(`Run not found: ${id}`);
    const updated = { ...run, ...updates };
    this.runs.set(id, updated);
    return updated;
  }

  // ─── Stage Executions ───────────────────────────

  async getStageExecutions(runId: string): Promise<StageExecution[]> {
    return Array.from(this.stages.values())
      .filter((s) => s.runId === runId)
      .sort((a, b) => a.stageIndex - b.stageIndex);
  }

  async getStageExecution(id: string): Promise<StageExecution | undefined> {
    return this.stages.get(id);
  }

  async createStageExecution(
    insert: InsertStageExecution,
  ): Promise<StageExecution> {
    const id = randomUUID();
    const stage: StageExecution = {
      projectId: insert.projectId ?? null,
      id,
      runId: insert.runId,
      stageIndex: insert.stageIndex,
      teamId: insert.teamId,
      modelSlug: insert.modelSlug,
      status: insert.status ?? "pending",
      input: insert.input,
      output: insert.output ?? null,
      tokensUsed: insert.tokensUsed ?? 0,
      startedAt: insert.startedAt ?? null,
      completedAt: insert.completedAt ?? null,
      sandboxResult: insert.sandboxResult ?? null,
      thoughtTree: insert.thoughtTree ?? null,
      approvalStatus: insert.approvalStatus ?? null,
      approvedAt: insert.approvedAt ?? null,
      approvedBy: insert.approvedBy ?? null,
      rejectionReason: insert.rejectionReason ?? null,
      error: insert.error ?? null,
      dagStageId: insert.dagStageId ?? null,
      swarmCloneResults: insert.swarmCloneResults ?? null,
      swarmMeta: insert.swarmMeta ?? null,
      createdAt: new Date(),
    };
    this.stages.set(id, stage);
    return stage;
  }

  async updateStageExecution(
    id: string,
    updates: Partial<StageExecution>,
  ): Promise<StageExecution> {
    const stage = this.stages.get(id);
    if (!stage) throw new Error(`Stage execution not found: ${id}`);
    const updated = { ...stage, ...updates };
    this.stages.set(id, updated);
    return updated;
  }

  // ─── Lessons (agent-experience memory — Track B) ──

  async createLesson(insert: InsertLesson): Promise<Lesson> {
    const id = randomUUID();
    const lesson: Lesson = {
      id,
      workspaceId: insert.workspaceId ?? null,
      runId: insert.runId ?? null,
      stageId: insert.stageId ?? null,
      teamId: insert.teamId ?? null,
      modelSlug: insert.modelSlug ?? null,
      outcome: insert.outcome,
      category: insert.category ?? null,
      errorPattern: insert.errorPattern ?? null,
      title: insert.title,
      summary: insert.summary,
      detail: insert.detail ?? null,
      createdAt: new Date(),
    };
    this.lessonsMap.set(id, lesson);
    return lesson;
  }

  async recallLessons(filter: LessonRecallFilter): Promise<Lesson[]> {
    const limit = filter.limit ?? 10;
    return Array.from(this.lessonsMap.values())
      .filter((l) => matchesLessonFilter(l, filter))
      .sort((a, b) => lessonTime(b) - lessonTime(a))
      .slice(0, limit);
  }

  async getLessons(workspaceId?: string): Promise<Lesson[]> {
    return Array.from(this.lessonsMap.values())
      .filter((l) => workspaceId == null || l.workspaceId === workspaceId)
      .sort((a, b) => lessonTime(b) - lessonTime(a));
  }

  // ─── Questions ──────────────────────────────────

  async getQuestions(runId: string): Promise<Question[]> {
    return Array.from(this.questionsMap.values()).filter(
      (q) => q.runId === runId,
    );
  }

  async getPendingQuestions(runId?: string): Promise<Question[]> {
    return Array.from(this.questionsMap.values()).filter(
      (q) =>
        q.status === "pending" && (runId ? q.runId === runId : true),
    );
  }

  async getQuestion(id: string): Promise<Question | undefined> {
    return this.questionsMap.get(id);
  }

  async createQuestion(insert: InsertQuestion): Promise<Question> {
    const id = randomUUID();
    const question: Question = {
      projectId: insert.projectId ?? null,
      id,
      runId: insert.runId,
      stageExecutionId: insert.stageExecutionId,
      question: insert.question,
      context: insert.context ?? null,
      answer: insert.answer ?? null,
      status: insert.status ?? "pending",
      createdAt: new Date(),
      answeredAt: insert.answeredAt ?? null,
    };
    this.questionsMap.set(id, question);
    return question;
  }

  async answerQuestion(id: string, answer: string): Promise<Question> {
    const question = this.questionsMap.get(id);
    if (!question) throw new Error(`Question not found: ${id}`);
    const updated = {
      ...question,
      answer,
      status: "answered" as const,
      answeredAt: new Date(),
    };
    this.questionsMap.set(id, updated);
    return updated;
  }

  async dismissQuestion(id: string): Promise<Question> {
    const question = this.questionsMap.get(id);
    if (!question) throw new Error(`Question not found: ${id}`);
    const updated = { ...question, status: "dismissed" as const };
    this.questionsMap.set(id, updated);
    return updated;
  }

  // ─── Chat Messages ─────────────────────────────

  async getChatMessages(
    runId?: string,
    limit?: number,
  ): Promise<ChatMessage[]> {
    let msgs = Array.from(this.messages.values());
    if (runId) msgs = msgs.filter((m) => m.runId === runId);
    msgs.sort(
      (a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
    if (limit) msgs = msgs.slice(-limit);
    return msgs;
  }

  async createChatMessage(insert: InsertChatMessage): Promise<ChatMessage> {
    const id = randomUUID();
    const msg: ChatMessage = {
      projectId: insert.projectId ?? null,
      id,
      runId: insert.runId ?? null,
      role: insert.role,
      agentTeam: insert.agentTeam ?? null,
      modelSlug: insert.modelSlug ?? null,
      content: insert.content,
      metadata: insert.metadata ?? null,
      createdAt: new Date(),
    };
    this.messages.set(id, msg);
    return msg;
  }

  // ─── LLM Requests ───────────────────────────────

  async createLlmRequest(data: InsertLlmRequest): Promise<LlmRequest> {
    const id = this.llmRequestIdSeq++;
    const req: LlmRequest = {
      projectId: data.projectId ?? null,
      id,
      runId: data.runId ?? null,
      stageExecutionId: data.stageExecutionId ?? null,
      modelSlug: data.modelSlug,
      provider: data.provider,
      messages: data.messages,
      systemPrompt: data.systemPrompt ?? null,
      temperature: data.temperature ?? null,
      maxTokens: data.maxTokens ?? null,
      responseContent: data.responseContent ?? "",
      inputTokens: data.inputTokens ?? 0,
      outputTokens: data.outputTokens ?? 0,
      totalTokens: data.totalTokens ?? 0,
      latencyMs: data.latencyMs ?? 0,
      estimatedCostUsd: data.estimatedCostUsd ?? null,
      status: data.status ?? "success",
      errorMessage: data.errorMessage ?? null,
      teamId: data.teamId ?? null,
      tags: data.tags ?? [],
      createdAt: new Date(),
    };
    this.llmRequestsMap.set(id, req);
    return req;
  }

  async getLlmRequests(filters: LlmRequestFilters): Promise<{ rows: LlmRequest[]; total: number }> {
    let rows = Array.from(this.llmRequestsMap.values());

    if (filters.runId) rows = rows.filter((r) => r.runId === filters.runId);
    if (filters.provider) rows = rows.filter((r) => r.provider === filters.provider);
    if (filters.modelSlug) rows = rows.filter((r) => r.modelSlug === filters.modelSlug);
    if (filters.status) rows = rows.filter((r) => r.status === filters.status);
    if (filters.from) rows = rows.filter((r) => r.createdAt && r.createdAt >= filters.from!);
    if (filters.to) rows = rows.filter((r) => r.createdAt && r.createdAt <= filters.to!);

    rows.sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));

    const total = rows.length;
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const start = (page - 1) * limit;
    rows = rows.slice(start, start + limit);

    return { rows, total };
  }

  async getLlmRequestById(id: number): Promise<LlmRequest | undefined> {
    return this.llmRequestsMap.get(id);
  }

  async getLlmRequestStats(): Promise<LlmRequestStats> {
    const all = Array.from(this.llmRequestsMap.values());
    return {
      totalRequests: all.length,
      totalInputTokens: all.reduce((s, r) => s + (r.inputTokens ?? 0), 0),
      totalOutputTokens: all.reduce((s, r) => s + (r.outputTokens ?? 0), 0),
      totalCostUsd: all.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0),
    };
  }

  async getLlmStatsByModel(): Promise<LlmStatsByModel[]> {
    const all = Array.from(this.llmRequestsMap.values());
    const map = new Map<string, LlmStatsByModel>();
    for (const r of all) {
      const key = r.modelSlug;
      const existing = map.get(key) ?? {
        modelSlug: r.modelSlug,
        provider: r.provider,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        avgLatencyMs: 0,
        errorRate: 0,
      };
      existing.requests++;
      existing.inputTokens += r.inputTokens ?? 0;
      existing.outputTokens += r.outputTokens ?? 0;
      existing.costUsd += r.estimatedCostUsd ?? 0;
      existing.avgLatencyMs += r.latencyMs ?? 0;
      if (r.status === "error") existing.errorRate++;
      map.set(key, existing);
    }
    return Array.from(map.values()).map((s) => ({
      ...s,
      avgLatencyMs: s.requests > 0 ? s.avgLatencyMs / s.requests : 0,
      errorRate: s.requests > 0 ? s.errorRate / s.requests : 0,
    }));
  }

  async getLlmStatsByProvider(): Promise<LlmStatsByProvider[]> {
    const all = Array.from(this.llmRequestsMap.values());
    const map = new Map<string, LlmStatsByProvider>();
    for (const r of all) {
      const key = r.provider;
      const existing = map.get(key) ?? {
        provider: r.provider,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        avgLatencyMs: 0,
        errorRate: 0,
      };
      existing.requests++;
      existing.inputTokens += r.inputTokens ?? 0;
      existing.outputTokens += r.outputTokens ?? 0;
      existing.costUsd += r.estimatedCostUsd ?? 0;
      existing.avgLatencyMs += r.latencyMs ?? 0;
      if (r.status === "error") existing.errorRate++;
      map.set(key, existing);
    }
    return Array.from(map.values()).map((s) => ({
      ...s,
      avgLatencyMs: s.requests > 0 ? s.avgLatencyMs / s.requests : 0,
      errorRate: s.requests > 0 ? s.errorRate / s.requests : 0,
    }));
  }

  async getLlmStatsByTeam(): Promise<LlmStatsByTeam[]> {
    const all = Array.from(this.llmRequestsMap.values()).filter((r) => r.teamId);
    const map = new Map<string, LlmStatsByTeam>();
    for (const r of all) {
      const key = r.teamId!;
      const existing = map.get(key) ?? {
        teamId: key,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      existing.requests++;
      existing.inputTokens += r.inputTokens ?? 0;
      existing.outputTokens += r.outputTokens ?? 0;
      existing.costUsd += r.estimatedCostUsd ?? 0;
      map.set(key, existing);
    }
    return Array.from(map.values());
  }

  async getLlmStatsByWorkspace(): Promise<LlmStatsByWorkspace[]> {
    // Attribution (read-side only): llm_requests.runId holds a task_groups.id in
    // the consilium path (the gateway is called with runId = group.id). We resolve
    // a group -> workspace via consilium_loops.groupId -> repoPath -> workspaces.path.
    //
    // Single-count guard: a group may own MANY consilium_loops rows (terminal loops
    // accumulate across re-runs) and MANY tasks. We therefore build a runId ->
    // single-workspace map FIRST (one deterministic workspace per group), then fold
    // each request into exactly one bucket. There is no request-to-loop fan-out
    // join, so a request's tokens/cost are summed exactly once.

    // path -> workspace (deterministic: lowest id wins on a duplicate path).
    const wsByPath = new Map<string, WorkspaceRow>();
    for (const w of Array.from(this.workspacesMap.values()).sort((a, b) => a.id.localeCompare(b.id))) {
      if (!wsByPath.has(w.path)) wsByPath.set(w.path, w);
    }

    // group -> one workspace: the newest loop (createdAt desc, id desc) whose
    // repoPath resolves wins; older loops of the same group never override it.
    const loops = Array.from(this.consiliumLoopsMap.values()).sort((a, b) => {
      const ta = a.createdAt?.getTime() ?? 0;
      const tb = b.createdAt?.getTime() ?? 0;
      if (ta !== tb) return tb - ta;
      return b.id.localeCompare(a.id);
    });
    const groupToWs = new Map<string, WorkspaceRow>();
    for (const loop of loops) {
      if (groupToWs.has(loop.groupId)) continue;
      const w = wsByPath.get(loop.repoPath);
      if (w) groupToWs.set(loop.groupId, w);
    }

    // Fold each request into exactly one workspace (or the Unattributed bucket).
    const UNATTRIBUTED = "\u0000unattributed";
    const map = new Map<string, LlmStatsByWorkspace>();
    for (const r of this.llmRequestsMap.values()) {
      const ws = r.runId ? groupToWs.get(r.runId) : undefined;
      const key = ws ? ws.id : UNATTRIBUTED;
      const existing = map.get(key) ?? {
        workspaceId: ws ? ws.id : null,
        workspaceName: ws ? ws.name : "Unattributed",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      existing.requests++;
      existing.inputTokens += r.inputTokens ?? 0;
      existing.outputTokens += r.outputTokens ?? 0;
      existing.costUsd += r.estimatedCostUsd ?? 0;
      map.set(key, existing);
    }
    return Array.from(map.values());
  }

  async getLlmTimeline(from: Date, to: Date, granularity: 'day' | 'week'): Promise<LlmTimelinePoint[]> {
    const all = Array.from(this.llmRequestsMap.values()).filter((r) => {
      const ts = r.createdAt;
      return ts && ts >= from && ts <= to;
    });

    const buckets = new Map<string, LlmTimelinePoint>();
    for (const r of all) {
      const d = r.createdAt!;
      let key: string;
      if (granularity === 'week') {
        const weekStart = new Date(d);
        weekStart.setDate(d.getDate() - d.getDay());
        key = weekStart.toISOString().slice(0, 10);
      } else {
        key = d.toISOString().slice(0, 10);
      }
      const existing = buckets.get(key) ?? { date: key, requests: 0, tokens: 0, costUsd: 0 };
      existing.requests++;
      existing.tokens += (r.inputTokens ?? 0) + (r.outputTokens ?? 0);
      existing.costUsd += r.estimatedCostUsd ?? 0;
      buckets.set(key, existing);
    }

    return Array.from(buckets.values()).sort((a, b) => a.date.localeCompare(b.date));
  }

  // ─── Memories ───────────────────────────────────

  async getMemories(scope: MemoryScope, scopeId?: string | null, type?: MemoryType): Promise<Memory[]> {
    return Array.from(this.memoriesMap.values()).filter((m) => {
      if (m.scope !== scope) return false;
      if (scopeId !== undefined && m.scopeId !== scopeId) return false;
      if (type && m.type !== type) return false;
      return true;
    });
  }

  async searchMemories(query: string, scope?: MemoryScope): Promise<Memory[]> {
    const lower = query.toLowerCase();
    return Array.from(this.memoriesMap.values()).filter((m) => {
      if (scope && m.scope !== scope) return false;
      return (
        m.key.toLowerCase().includes(lower) ||
        m.content.toLowerCase().includes(lower)
      );
    });
  }

  async upsertMemory(insert: InsertMemory): Promise<Memory> {
    const existing = Array.from(this.memoriesMap.values()).find(
      (m) =>
        m.scope === insert.scope &&
        m.scopeId === (insert.scopeId ?? null) &&
        m.key === insert.key,
    );

    if (existing) {
      const updated: Memory = {
        ...existing,
        content: insert.content,
        confidence: insert.confidence ?? existing.confidence,
        source: insert.source ?? existing.source,
        updatedAt: new Date(),
      };
      this.memoriesMap.set(existing.id, updated);
      return updated;
    }

    const id = this.nextMemoryId++;
    const now = new Date();
    const memory: Memory = {
      id,
      scope: insert.scope,
      scopeId: insert.scopeId ?? null,
      type: insert.type,
      key: insert.key,
      content: insert.content,
      source: insert.source ?? null,
      confidence: insert.confidence ?? 1.0,
      tags: insert.tags ?? [],
      createdAt: now,
      updatedAt: now,
      expiresAt: insert.expiresAt ?? null,
      createdByRunId: insert.createdByRunId ?? null,
      published: insert.published ?? false,
    };
    this.memoriesMap.set(id, memory);
    return memory;
  }

  async deleteMemory(id: number): Promise<void> {
    this.memoriesMap.delete(id);
  }

  async decayMemories(excludeRunId: number, decayAmount: number): Promise<number> {
    let count = 0;
    for (const [id, m] of this.memoriesMap) {
      if (m.createdByRunId !== excludeRunId) {
        const updated = { ...m, confidence: m.confidence - decayAmount, updatedAt: new Date() };
        this.memoriesMap.set(id, updated);
        count++;
      }
    }
    return count;
  }

  async deleteStaleMemories(threshold: number): Promise<number> {
    let count = 0;
    for (const [id, m] of this.memoriesMap) {
      if (m.confidence < threshold) {
        this.memoriesMap.delete(id);
        count++;
      }
    }
    return count;
  }

  async updateMemoryPublished(id: number, published: boolean): Promise<Memory | null> {
    const m = this.memoriesMap.get(id);
    if (!m) return null;
    const updated = { ...m, published, updatedAt: new Date() };
    this.memoriesMap.set(id, updated);
    return updated;
  }

  // ─── MCP Servers ───────────────────────────────

  async getMcpServers(): Promise<McpServerConfig[]> {
    return Array.from(this.mcpServersMap.values());
  }

  async getMcpServer(id: number): Promise<McpServerConfig | undefined> {
    return this.mcpServersMap.get(id);
  }

  async createMcpServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig> {
    const id = this.nextMcpServerId++;
    const server: McpServerConfig = {
      ...config,
      id,
      toolCount: config.toolCount ?? 0,
      createdAt: new Date(),
    };
    this.mcpServersMap.set(id, server);
    return server;
  }

  async updateMcpServer(id: number, updates: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const server = this.mcpServersMap.get(id);
    if (!server) throw new Error(`MCP server not found: ${id}`);
    const updated = { ...server, ...updates };
    this.mcpServersMap.set(id, updated);
    return updated;
  }

  async deleteMcpServer(id: number): Promise<void> {
    this.mcpServersMap.delete(id);
  }

  // ─── Delegation Requests (Phase 6.4) ────────────────────────────────────

  async createDelegationRequest(data: InsertDelegationRequest): Promise<DelegationRequestRow> {
    const id = randomUUID();
    const now = new Date();
    const row: DelegationRequestRow = {
      projectId: data.projectId ?? null,
      id,
      runId: data.runId,
      fromStage: data.fromStage,
      toStage: data.toStage,
      task: data.task,
      context: (data.context ?? {}) as Record<string, unknown>,
      priority: data.priority ?? "blocking",
      timeout: data.timeout ?? 30000,
      depth: data.depth ?? 0,
      status: data.status ?? "pending",
      result: (data.result ?? null) as Record<string, unknown> | null,
      errorMessage: data.errorMessage ?? null,
      startedAt: data.startedAt ?? now,
      completedAt: data.completedAt ?? null,
      createdAt: now,
    };
    this.delegationsMap.set(id, row);
    return row;
  }

  async getDelegationRequests(runId: string): Promise<DelegationRequestRow[]> {
    return Array.from(this.delegationsMap.values())
      .filter((d) => d.runId === runId)
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  }

  async updateDelegationRequest(
    id: string,
    updates: Partial<DelegationRequestRow>,
  ): Promise<DelegationRequestRow> {
    const row = this.delegationsMap.get(id);
    if (!row) throw new Error(`Delegation request not found: ${id}`);
    const updated = { ...row, ...updates };
    this.delegationsMap.set(id, updated);
    return updated;
  }

  // ─── Specialization Profiles ──────────────────

  async getSpecializationProfiles(): Promise<SpecializationProfileRow[]> {
    return Array.from(this.specializationProfilesMap.values());
  }

  async createSpecializationProfile(profile: InsertSpecializationProfile): Promise<SpecializationProfileRow> {
    const id = randomUUID();
    const row: SpecializationProfileRow = {
      projectId: profile.projectId ?? null,
      id,
      name: profile.name,
      isBuiltIn: profile.isBuiltIn ?? false,
      assignments: (profile.assignments ?? {}) as Record<string, string>,
      createdAt: new Date(),
    };
    this.specializationProfilesMap.set(id, row);
    return row;
  }

  async deleteSpecializationProfile(id: string): Promise<void> {
    this.specializationProfilesMap.delete(id);
  }

  // ─── Skills ─────────────────────────────────────

  private skillsMap: Map<string, Skill> = new Map();

  async getSkills(filter?: { teamId?: string; isBuiltin?: boolean }): Promise<Skill[]> {
    let result = Array.from(this.skillsMap.values());
    if (filter?.teamId !== undefined) {
      result = result.filter((s) => s.teamId === filter.teamId);
    }
    if (filter?.isBuiltin !== undefined) {
      result = result.filter((s) => s.isBuiltin === filter.isBuiltin);
    }
    return result.sort((a, b) => a.name.localeCompare(b.name));
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    return this.skillsMap.get(id);
  }

  async createSkill(data: InsertSkill): Promise<Skill> {
    const id = (data.id as string | undefined) ?? randomUUID();
    const now = new Date();
    const skill: Skill = {
      projectId: data.projectId ?? null,
      id,
      name: data.name,
      description: data.description ?? "",
      teamId: data.teamId,
      systemPromptOverride: data.systemPromptOverride ?? "",
      tools: (data.tools as string[] | undefined) ?? [],
      modelPreference: data.modelPreference ?? null,
      outputSchema: (data.outputSchema as Record<string, unknown> | undefined) ?? null,
      tags: (data.tags as string[] | undefined) ?? [],
      isBuiltin: data.isBuiltin ?? false,
      isPublic: data.isPublic ?? true,
      createdBy: data.createdBy ?? "system",
      version: data.version ?? "1.0.0",
      sharing: (data.sharing ?? "public") as "private" | "team" | "public",
      usageCount: data.usageCount ?? 0,
      forkedFrom: data.forkedFrom ?? null,
      sourceType: (data.sourceType ?? "manual") as "manual" | "git",
      gitSourceId: data.gitSourceId ?? null,
      externalSource: data.externalSource ?? null,
      externalId: data.externalId ?? null,
      externalVersion: data.externalVersion ?? null,
      installedAt: data.installedAt ?? null,
      autoUpdate: data.autoUpdate ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.skillsMap.set(id, skill);
    return skill;
  }

  async updateSkill(id: string, updates: Partial<InsertSkill>): Promise<Skill> {
    const existing = this.skillsMap.get(id);
    if (!existing) throw new Error(`Skill not found: ${id}`);
    const updated: Skill = {
      ...existing,
      ...updates,
      tools: (updates.tools as string[] | undefined) ?? existing.tools,
      tags: (updates.tags as string[] | undefined) ?? existing.tags,
      sharing: (updates.sharing as "private" | "team" | "public" | undefined) ?? existing.sharing,
      sourceType: (updates.sourceType as "manual" | "git" | undefined) ?? existing.sourceType,
      updatedAt: new Date(),
    };
    this.skillsMap.set(id, updated);
    return updated;
  }

  async deleteSkill(id: string): Promise<void> {
    this.skillsMap.delete(id);
  }

  // ─── Skill Versions (Phase 6.16) ────────────────────────────────────────────

  private skillVersionsMap: Map<string, SkillVersionRow> = new Map();

  async getSkillVersions(
    skillId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: SkillVersionRecord[]; total: number }> {
    const all = Array.from(this.skillVersionsMap.values())
      .filter((v) => v.skillId === skillId)
      .sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
    const total = all.length;
    const rows = all.slice(offset, offset + limit);
    return { rows, total };
  }

  async getSkillVersion(
    skillId: string,
    version: string,
  ): Promise<SkillVersionRecord | undefined> {
    return Array.from(this.skillVersionsMap.values()).find(
      (v) => v.skillId === skillId && v.version === version,
    );
  }

  async createSkillVersion(data: InsertSkillVersionType): Promise<SkillVersionRecord> {
    const id = randomUUID();
    const row: SkillVersionRow = {
      projectId: null,
      id,
      skillId: data.skillId,
      version: data.version,
      config: data.config,
      changelog: data.changelog,
      createdBy: data.createdBy,
      createdAt: new Date(),
    };
    this.skillVersionsMap.set(id, row);
    return row;
  }

  async incrementSkillUsage(id: string): Promise<number> {
    const skill = this.skillsMap.get(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    const currentCount = (skill as Skill & { usageCount?: number }).usageCount ?? 0;
    const updated = { ...skill, usageCount: currentCount + 1 };
    this.skillsMap.set(id, updated as Skill);
    return currentCount + 1;
  }

  // ─── Manager Iterations (Phase 6.6) ────────────────────────────────────────

  async createManagerIteration(data: InsertManagerIteration): Promise<ManagerIterationRow> {
    const id = crypto.randomUUID();
    const now = new Date();
    const row: ManagerIterationRow = {
      id,
      runId: data.runId,
      iterationNumber: data.iterationNumber,
      decision: data.decision as ManagerIterationRow["decision"],
      teamResult: data.teamResult ?? null,
      tokensUsed: data.tokensUsed ?? 0,
      decisionDurationMs: data.decisionDurationMs ?? 0,
      teamDurationMs: data.teamDurationMs ?? null,
      createdAt: now,
    };
    if (!this.managerIterationsMap) {
      this.managerIterationsMap = new Map();
    }
    this.managerIterationsMap.set(id, row);
    return row;
  }

  async updateManagerIteration(
    runId: string,
    iterationNumber: number,
    updates: Partial<Pick<ManagerIterationRow, "teamResult" | "teamDurationMs">>,
  ): Promise<void> {
    if (!this.managerIterationsMap) return;
    for (const [id, row] of this.managerIterationsMap) {
      if (row.runId === runId && row.iterationNumber === iterationNumber) {
        this.managerIterationsMap.set(id, { ...row, ...updates });
        return;
      }
    }
  }

  async getManagerIterations(
    runId: string,
    offset = 0,
    limit = 50,
  ): Promise<ManagerIterationRow[]> {
    if (!this.managerIterationsMap) return [];
    const rows = Array.from(this.managerIterationsMap.values())
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.iterationNumber - b.iterationNumber);
    return rows.slice(offset, offset + limit);
  }

  async countManagerIterations(runId: string): Promise<number> {
    if (!this.managerIterationsMap) return 0;
    return Array.from(this.managerIterationsMap.values()).filter((r) => r.runId === runId)
      .length;
  }

  // ─── Consilium Loops (Phase B — auto-versioned FSM) ───────────────────────

  private consiliumLoopsMap: Map<string, ConsiliumLoopRow> = new Map();
  private consiliumLoopRoundsMap: Map<string, ConsiliumLoopRoundRow> = new Map();

  /** Mirror the DB partial-unique index: at most one non-terminal loop/group. */
  private isLoopActive(row: ConsiliumLoopRow): boolean {
    return !CONSILIUM_LOOP_TERMINAL_STATES.includes(
      row.state as (typeof CONSILIUM_LOOP_TERMINAL_STATES)[number],
    );
  }

  async createLoop(data: InsertConsiliumLoop): Promise<ConsiliumLoopRow> {
    const state = (data.state as ConsiliumLoopState | undefined) ?? "pending";
    // H-3: emulate the partial-unique index — reject a 2nd active loop per group.
    if (!CONSILIUM_LOOP_TERMINAL_STATES.includes(state as (typeof CONSILIUM_LOOP_TERMINAL_STATES)[number])) {
      for (const existing of this.consiliumLoopsMap.values()) {
        if (existing.groupId === data.groupId && this.isLoopActive(existing)) {
          throw new Error("consilium_loops_one_active_per_group");
        }
      }
    }
    const now = new Date();
    const row: ConsiliumLoopRow = {
      id: randomUUID(),
      projectId: data.projectId ?? null,
      groupId: data.groupId,
      state,
      round: data.round ?? 0,
      maxRounds: data.maxRounds ?? 6,
      repoPath: data.repoPath,
      lastReviewedCommit: data.lastReviewedCommit ?? null,
      reviewRef: data.reviewRef ?? null,
      // Single-verifier re-review: per-loop mode (nullable; null ⇒ operator default).
      reviewMode: data.reviewMode ?? null,
      // Stage 1: engineer instruction + archetype planner columns (all nullable).
      engineerInstruction: data.engineerInstruction ?? null,
      // Stage 2: applied-skill provenance (nullable jsonb).
      appliedSkills: data.appliedSkills ?? null,
      triggerProvenance: data.triggerProvenance ?? null,
      archetype: data.archetype ?? null,
      archetypeSource: data.archetypeSource ?? null,
      archetypeRationale: data.archetypeRationale ?? null,
      archetypeParams: data.archetypeParams ?? null,
      archetypeDecidedAt: data.archetypeDecidedAt ?? null,
      currentIterationNumber: data.currentIterationNumber ?? null,
      reviewRedrive: data.reviewRedrive ?? null,
      devGroupId: data.devGroupId ?? null,
      prRef: data.prRef ?? null,
      headCommitAtReview: data.headCommitAtReview ?? null,
      openP0: data.openP0 ?? null,
      error: data.error ?? null,
      createdBy: data.createdBy ?? null,
      createdAt: now,
      updatedAt: now,
      completedAt: data.completedAt ?? null,
    };
    this.consiliumLoopsMap.set(row.id, row);
    return row;
  }

  async getLoop(id: string): Promise<ConsiliumLoopRow | undefined> {
    return this.consiliumLoopsMap.get(id);
  }

  async getLoopsByOwner(ownerId: string): Promise<ConsiliumLoopRow[]> {
    return Array.from(this.consiliumLoopsMap.values())
      .filter((l) => l.createdBy === ownerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async getLoops(): Promise<ConsiliumLoopRow[]> {
    return Array.from(this.consiliumLoopsMap.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async getActiveLoopByGroup(groupId: string): Promise<ConsiliumLoopRow | undefined> {
    return Array.from(this.consiliumLoopsMap.values()).find(
      (l) => l.groupId === groupId && this.isLoopActive(l),
    );
  }

  async updateLoop(
    id: string,
    updates: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt">>,
  ): Promise<ConsiliumLoopRow> {
    const existing = this.consiliumLoopsMap.get(id);
    if (!existing) throw new Error(`ConsiliumLoop ${id} not found`);
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.consiliumLoopsMap.set(id, updated);
    return updated;
  }

  async updateLoopArchetypeIfNotOverridden(
    id: string,
    updates: Pick<
      ConsiliumLoopRow,
      "archetype" | "archetypeSource" | "archetypeRationale" | "archetypeParams" | "archetypeDecidedAt"
    >,
  ): Promise<ConsiliumLoopRow | undefined> {
    const existing = this.consiliumLoopsMap.get(id);
    if (!existing) return undefined;
    // IS DISTINCT FROM 'override': a human override is sacrosanct (NULL/'proposed'
    // both write). An override blocks the write → 0 rows → undefined.
    if (existing.archetypeSource === "override") return undefined;
    const updated = { ...existing, ...updates, updatedAt: new Date() };
    this.consiliumLoopsMap.set(id, updated);
    return updated;
  }

  async casLoopState(
    id: string,
    expected: ConsiliumLoopState,
    next: ConsiliumLoopState,
    extra?: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt" | "state">>,
  ): Promise<ConsiliumLoopRow | undefined> {
    const existing = this.consiliumLoopsMap.get(id);
    if (!existing || existing.state !== expected) return undefined;
    const updated: ConsiliumLoopRow = {
      ...existing,
      ...extra,
      state: next,
      updatedAt: new Date(),
    };
    this.consiliumLoopsMap.set(id, updated);
    return updated;
  }

  async claimRedrive(
    id: string,
    expected: ConsiliumLoopState,
    graceMs: number,
  ): Promise<ConsiliumLoopRow | undefined> {
    const existing = this.consiliumLoopsMap.get(id);
    if (!existing || existing.state !== expected) return undefined;
    // State-specific null-ref predicate (mirrors the Pg WHERE).
    const nullRef =
      expected === "reviewing"
        ? existing.currentIterationNumber == null
        : expected === "developing"
          ? existing.devGroupId == null
          : false;
    if (!nullRef) return undefined;
    // Past-grace predicate: updatedAt < now - graceMs.
    if (Date.now() - existing.updatedAt.getTime() < graceMs) return undefined;
    // Atomic claim: bump updatedAt to now so a concurrent claim's grace check fails.
    const claimed: ConsiliumLoopRow = { ...existing, updatedAt: new Date() };
    this.consiliumLoopsMap.set(id, claimed);
    return claimed;
  }

  async claimReviewRedrive(
    id: string,
    expectedIterationNumber: number,
    staleThreshold: Date,
  ): Promise<ConsiliumLoopRow | undefined> {
    const existing = this.consiliumLoopsMap.get(id);
    if (!existing || existing.state !== "reviewing") return undefined;
    // Same STALE iteration (a review that advanced its iteration since we read it
    // no longer matches → the winner-of-a-just-finished-review race no-ops).
    if (existing.currentIterationNumber !== expectedIterationNumber) return undefined;
    // Untouched since the stall window opened (mirrors the Pg `updatedAt < threshold`).
    if (existing.updatedAt.getTime() >= staleThreshold.getTime()) return undefined;
    // Atomic claim: bump updatedAt so a concurrent instance's predicate fails.
    const claimed: ConsiliumLoopRow = { ...existing, updatedAt: new Date() };
    this.consiliumLoopsMap.set(id, claimed);
    return claimed;
  }

  async appendLoopRound(data: InsertConsiliumLoopRound): Promise<ConsiliumLoopRoundRow> {
    // UNIQUE(loop, round): reject a duplicate round append.
    for (const r of this.consiliumLoopRoundsMap.values()) {
      if (r.loopId === data.loopId && r.round === data.round) {
        throw new Error("consilium_loop_rounds_uq");
      }
    }
    const row: ConsiliumLoopRoundRow = {
      id: randomUUID(),
      loopId: data.loopId,
      round: data.round,
      iterationNumber: data.iterationNumber,
      converged: data.converged ?? null,
      openP0: data.openP0 ?? null,
      openActionPoints: data.openActionPoints ?? null,
      baselineCommit: data.baselineCommit ?? null,
      headCommit: data.headCommit ?? null,
      testSummary: data.testSummary ?? null,
      report: data.report ?? null,
      executionTrace: data.executionTrace ?? null,
      createdAt: new Date(),
    };
    this.consiliumLoopRoundsMap.set(row.id, row);
    return row;
  }

  async getLoopRounds(loopId: string): Promise<ConsiliumLoopRoundRow[]> {
    return Array.from(this.consiliumLoopRoundsMap.values())
      .filter((r) => r.loopId === loopId)
      .sort((a, b) => a.round - b.round);
  }

  async updateLoopRoundTestSummary(loopId: string, round: number, testSummary: string): Promise<void> {
    for (const r of this.consiliumLoopRoundsMap.values()) {
      if (r.loopId === loopId && r.round === round) {
        this.consiliumLoopRoundsMap.set(r.id, { ...r, testSummary });
        return;
      }
    }
  }

  async updateLoopRoundReport(loopId: string, round: number, report: ResearchReport): Promise<void> {
    for (const r of this.consiliumLoopRoundsMap.values()) {
      if (r.loopId === loopId && r.round === round) {
        this.consiliumLoopRoundsMap.set(r.id, { ...r, report });
        return;
      }
    }
  }

  async updateLoopRoundExecutionTrace(loopId: string, round: number, trace: ExecutionTrace): Promise<void> {
    for (const r of this.consiliumLoopRoundsMap.values()) {
      if (r.loopId === loopId && r.round === round) {
        this.consiliumLoopRoundsMap.set(r.id, { ...r, executionTrace: trace });
        return;
      }
    }
  }

  async updateLoopRoundActionPoints(loopId: string, round: number, actionPoints: ActionPoint[]): Promise<void> {
    for (const r of this.consiliumLoopRoundsMap.values()) {
      if (r.loopId === loopId && r.round === round) {
        this.consiliumLoopRoundsMap.set(r.id, { ...r, openActionPoints: actionPoints });
        return;
      }
    }
  }

  // ─── Triggers (Phase 6.3) ─────────────────────────────────────────────────

  private triggersMap: Map<string, TriggerRow> = new Map();

  async getTriggers(pipelineId: string): Promise<TriggerRow[]> {
    return Array.from(this.triggersMap.values()).filter((t) => t.pipelineId === pipelineId);
  }

  async getProjectTriggers(): Promise<TriggerRow[]> {
    // MemStorage has no project isolation — return all triggers.
    return Array.from(this.triggersMap.values());
  }

  async getTrigger(id: string): Promise<TriggerRow | undefined> {
    return this.triggersMap.get(id);
  }

  async getEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return Array.from(this.triggersMap.values()).filter((t) => t.enabled && t.type === type);
  }

  // Cross-project: in MemStorage there is no project isolation, so this is
  // identical to getEnabledTriggersByType. Both return all matching triggers.
  async getAllEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return Array.from(this.triggersMap.values()).filter((t) => t.enabled && t.type === type);
  }

  async createTrigger(
    data: Omit<TriggerRow, 'id' | 'projectId' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt' | 'suppressedCount'> & { secretEncrypted?: string | null },
  ): Promise<TriggerRow> {
    const id = randomUUID();
    const now = new Date();
    const row: TriggerRow = {
      id,
      projectId: null, // MemStorage has no project context; projectId is null in-memory
      pipelineId: data.pipelineId ?? null, // T1: loop-template triggers carry no pipeline
      type: data.type as TriggerRow["type"],
      config: (data.config ?? {}) as TriggerRow["config"],
      secretEncrypted: data.secretEncrypted ?? null,
      enabled: data.enabled ?? true,
      lastTriggeredAt: null,
      suppressedCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.triggersMap.set(id, row);
    return row;
  }

  async updateTrigger(id: string, updates: Partial<TriggerRow>): Promise<TriggerRow> {
    const existing = this.triggersMap.get(id);
    if (!existing) throw new Error(`Trigger not found: ${id}`);
    const updated: TriggerRow = { ...existing, ...updates, updatedAt: new Date() };
    this.triggersMap.set(id, updated);
    return updated;
  }

  async deleteTrigger(id: string): Promise<void> {
    this.triggersMap.delete(id);
  }

  async incrementTriggerSuppressed(id: string): Promise<void> {
    const existing = this.triggersMap.get(id);
    if (!existing) return;
    this.triggersMap.set(id, {
      ...existing,
      suppressedCount: (existing.suppressedCount ?? 0) + 1,
      updatedAt: new Date(),
    });
  }

  // ─── Traces (Phase 6.5) ───────────────────────────────────────────────────

  private tracesById: Map<string, TraceRow> = new Map();   // keyed by traceId
  private tracesByRunId: Map<string, TraceRow> = new Map(); // keyed by runId

  async createTrace(data: InsertTrace): Promise<TraceRow> {
    const id = randomUUID();
    const now = new Date();
    const row: TraceRow = {
      id,
      traceId: data.traceId,
      runId: data.runId,
      spans: data.spans as TraceSpan[],
      createdAt: now,
      updatedAt: now,
    };
    this.tracesById.set(data.traceId, row);
    this.tracesByRunId.set(data.runId, row);
    return row;
  }

  async getTraceByRunId(runId: string): Promise<TraceRow | null> {
    return this.tracesByRunId.get(runId) ?? null;
  }

  async getTraceByTraceId(traceId: string): Promise<TraceRow | null> {
    return this.tracesById.get(traceId) ?? null;
  }

  async getTraces(limit = 50, offset = 0): Promise<TraceRow[]> {
    const all = Array.from(this.tracesById.values()).sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    );
    return all.slice(offset, offset + limit);
  }

  async updateTraceSpans(traceId: string, spans: TraceSpan[]): Promise<void> {
    const row = this.tracesById.get(traceId);
    if (!row) return;
    const updated: TraceRow = { ...row, spans: spans as TraceSpan[], updatedAt: new Date() };
    this.tracesById.set(traceId, updated);
    this.tracesByRunId.set(row.runId, updated);
  }

  // ─── Task Groups (Task Orchestrator) — MemStorage stubs ─────────────────────

  private taskGroupsMap = new Map<string, TaskGroupRow>();
  private tasksMap = new Map<string, TaskRow>();

  async getTaskGroups(): Promise<TaskGroupRow[]> {
    return Array.from(this.taskGroupsMap.values()).sort(
      (a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0),
    );
  }

  async getTaskGroup(id: string): Promise<TaskGroupRow | undefined> {
    return this.taskGroupsMap.get(id);
  }

  async createTaskGroup(data: InsertTaskGroup): Promise<TaskGroupRow> {
    const id = randomUUID();
    const row: TaskGroupRow = { id, projectId: data.projectId ?? null, name: data.name, description: data.description, input: data.input, status: (data.status as TaskGroupRow["status"]) ?? "pending", output: data.output ?? null, traceId: (data as Record<string, unknown>).traceId as string | null ?? null, createdBy: data.createdBy ?? null, startedAt: data.startedAt ?? null, completedAt: data.completedAt ?? null, createdAt: new Date() };
    this.taskGroupsMap.set(id, row);
    return row;
  }

  async updateTaskGroup(id: string, updates: Partial<TaskGroupRow>): Promise<TaskGroupRow> {
    const existing = this.taskGroupsMap.get(id);
    if (!existing) throw new Error(`TaskGroup ${id} not found`);
    const updated = { ...existing, ...updates };
    this.taskGroupsMap.set(id, updated);
    return updated;
  }

  async deleteTaskGroup(id: string): Promise<void> {
    this.taskGroupsMap.delete(id);
    for (const [tid, t] of this.tasksMap) {
      if (t.groupId === id) this.tasksMap.delete(tid);
    }
    // Cascade (emulates ON DELETE cascade): iterations + executions + traces.
    for (const [iid, it] of this.iterationsMap) {
      if (it.groupId === id) this.iterationsMap.delete(iid);
    }
    for (const [eid, ex] of this.executionsMap) {
      if (ex.groupId === id) this.executionsMap.delete(eid);
    }
    for (const [trid, tr] of this.taskTracesMap) {
      if (tr.groupId === id) {
        this.taskTracesMap.delete(trid);
        this.taskTracesByGroupId.delete(tr.groupId);
      }
    }
  }

  async getTasksByGroup(groupId: string): Promise<TaskRow[]> {
    return Array.from(this.tasksMap.values())
      .filter((t) => t.groupId === groupId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    return this.tasksMap.get(id);
  }

  async createTask(data: InsertTask): Promise<TaskRow> {
    const id = randomUUID();
    const row: TaskRow = {
      id,
      projectId: data.projectId ?? null,
      groupId: data.groupId,
      name: data.name,
      description: data.description,
      status: (data.status as TaskRow["status"]) ?? "pending",
      executionMode: (data.executionMode as TaskRow["executionMode"]) ?? "direct_llm",
      dependsOn: data.dependsOn ?? [],
      input: data.input ?? {},
      sortOrder: data.sortOrder ?? 0,
      pipelineId: data.pipelineId ?? null,
      pipelineRunId: data.pipelineRunId ?? null,
      workspaceId: data.workspaceId ?? null,
      modelSlug: data.modelSlug ?? null,
      teamId: data.teamId ?? null,
      labels: (data.labels as string[]) ?? [],
      output: data.output ?? null,
      summary: data.summary ?? null,
      artifacts: data.artifacts ?? null,
      decisions: data.decisions ?? null,
      errorMessage: data.errorMessage ?? null,
      startedAt: data.startedAt ?? null,
      completedAt: data.completedAt ?? null,
      createdAt: new Date(),
    };
    this.tasksMap.set(id, row);
    return row;
  }

  async updateTask(id: string, updates: Partial<TaskRow>): Promise<TaskRow> {
    const existing = this.tasksMap.get(id);
    if (!existing) throw new Error(`Task ${id} not found`);
    const updated = { ...existing, ...updates };
    this.tasksMap.set(id, updated);
    return updated;
  }

  async getReadyTasks(groupId: string): Promise<TaskRow[]> {
    return Array.from(this.tasksMap.values())
      .filter((t) => t.groupId === groupId && t.status === "ready")
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async getBlockedTasks(groupId: string): Promise<TaskRow[]> {
    return Array.from(this.tasksMap.values())
      .filter((t) => t.groupId === groupId && t.status === "blocked")
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }

  async deleteTask(id: string): Promise<void> {
    this.tasksMap.delete(id);
    // SEC1: emulate ON DELETE SET NULL on task_executions.task_id — historical
    // executions SURVIVE (immutable iteration history, §6/R2); only the now-
    // dangling task_id is nulled. task_name was denormalized at seed time so the
    // history stays readable after the definition is gone.
    for (const [eid, ex] of this.executionsMap) {
      if (ex.taskId === id) this.executionsMap.set(eid, { ...ex, taskId: null });
    }
  }

  async listTaskGroupHistory(query: RunHistoryQuery): Promise<TaskGroupHistoryRow[]> {
    const terminal = new Set(["completed", "failed", "cancelled"]);
    const rows = Array.from(this.taskGroupsMap.values())
      .filter((g) => terminal.has(g.status))
      .filter((g) => (query.ownerId == null ? true : g.createdBy === query.ownerId))
      .map((g) => ({
        id: g.id,
        status: g.status,
        createdBy: g.createdBy ?? null,
        startedAt: g.startedAt ?? null,
        completedAt: g.completedAt ?? null,
      }));
    return keysetPage(rows, query);
  }

  // ─── Task Traces (End-to-End Request Observability) ──────────────────────────

  private taskTracesMap = new Map<string, TaskTraceRow>();
  private taskTracesByGroupId = new Map<string, TaskTraceRow>();

  async createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow> {
    const id = randomUUID();
    const now = new Date();
    const row: TaskTraceRow = {
      id,
      groupId: data.groupId,
      iterationId: data.iterationId ?? null,
      traceId: data.traceId,
      rootSpan: (data.rootSpan as TaskTraceSpan) ?? null,
      spans: (data.spans as TaskTraceSpan[]) ?? [],
      totalDurationMs: data.totalDurationMs ?? 0,
      totalTokens: data.totalTokens ?? 0,
      totalCostUsd: data.totalCostUsd ?? 0,
      createdAt: now,
      updatedAt: now,
    };
    this.taskTracesMap.set(id, row);
    this.taskTracesByGroupId.set(data.groupId, row);
    return row;
  }

  async getTaskTrace(groupId: string): Promise<TaskTraceRow | null> {
    return this.taskTracesByGroupId.get(groupId) ?? null;
  }

  async updateTaskTrace(id: string, updates: Partial<TaskTraceRow>): Promise<TaskTraceRow> {
    const existing = this.taskTracesMap.get(id);
    if (!existing) throw new Error(`TaskTrace ${id} not found`);
    const updated: TaskTraceRow = { ...existing, ...updates, updatedAt: new Date() };
    this.taskTracesMap.set(id, updated);
    this.taskTracesByGroupId.set(updated.groupId, updated);
    return updated;
  }

  // ─── Tracker Connections (Issue Tracker Integration) — MemStorage stubs ─────

  private trackerConnectionsMap = new Map<string, TrackerConnectionRow>();

  async getTrackerConnectionsByGroup(taskGroupId: string): Promise<TrackerConnectionRow[]> {
    return Array.from(this.trackerConnectionsMap.values()).filter(
      (c) => c.taskGroupId === taskGroupId,
    );
  }

  async getTrackerConnection(id: string): Promise<TrackerConnectionRow | undefined> {
    return this.trackerConnectionsMap.get(id);
  }

  async createTrackerConnection(data: InsertTrackerConnection): Promise<TrackerConnectionRow> {
    const id = randomUUID();
    const row: TrackerConnectionRow = {
      projectId: data.projectId ?? null,
      id,
      taskGroupId: data.taskGroupId,
      provider: data.provider as TrackerConnectionRow["provider"],
      issueUrl: data.issueUrl,
      issueKey: data.issueKey,
      projectKey: data.projectKey ?? null,
      syncComments: data.syncComments ?? true,
      syncSubtasks: data.syncSubtasks ?? true,
      apiToken: data.apiToken ?? null,
      baseUrl: data.baseUrl ?? null,
      metadata: data.metadata ?? null,
      createdAt: new Date(),
    };
    this.trackerConnectionsMap.set(id, row);
    return row;
  }

  async deleteTrackerConnection(id: string): Promise<void> {
    this.trackerConnectionsMap.delete(id);
  }


  // ─── Model Skill Bindings ────────────────────────────────────────────────

  private modelSkillBindingsMap: Map<string, ModelSkillBinding> = new Map();

  async getModelSkillBindings(modelId: string): Promise<ModelSkillBinding[]> {
    return Array.from(this.modelSkillBindingsMap.values()).filter(
      (b) => b.modelId === modelId,
    );
  }

  async getModelsWithSkillBindings(): Promise<string[]> {
    const modelIds = new Set<string>();
    for (const b of this.modelSkillBindingsMap.values()) {
      modelIds.add(b.modelId);
    }
    return Array.from(modelIds).sort();
  }

  async createModelSkillBinding(data: InsertModelSkillBinding): Promise<ModelSkillBinding> {
    // Check uniqueness
    const duplicate = Array.from(this.modelSkillBindingsMap.values()).find(
      (b) => b.modelId === data.modelId && b.skillId === data.skillId,
    );
    if (duplicate) {
      const err = new Error("Unique constraint violation: model_skill_bindings_model_id_skill_id_unique");
      (err as NodeJS.ErrnoException).code = "23505";
      throw err;
    }
    const id = randomUUID();
    const binding: ModelSkillBinding = {
      projectId: data.projectId ?? null,
      id,
      modelId: data.modelId,
      skillId: data.skillId,
      createdBy: data.createdBy ?? null,
      createdAt: new Date(),
    };
    this.modelSkillBindingsMap.set(id, binding);
    return binding;
  }

  async deleteModelSkillBinding(modelId: string, skillId: string): Promise<void> {
    for (const [key, binding] of this.modelSkillBindingsMap.entries()) {
      if (binding.modelId === modelId && binding.skillId === skillId) {
        this.modelSkillBindingsMap.delete(key);
        return;
      }
    }
    throw new Error(`Binding not found for model ${modelId} skill ${skillId}`);
  }

  async resolveSkillsForModel(modelId: string): Promise<Skill[]> {
    const bindings = await this.getModelSkillBindings(modelId);
    if (bindings.length === 0) return [];
    const result: Skill[] = [];
    for (const b of bindings) {
      const skill = this.skillsMap.get(b.skillId);
      if (skill) result.push(skill);
    }
    return result;
  }


  // ─── ArgoCD Config ────────────────────────────────────────────────────────

  private argoCdConfigRow: ArgoCdConfigRow | null = null;

  async getArgoCdConfig(): Promise<ArgoCdConfigRow | null> {
    return this.argoCdConfigRow;
  }

  async saveArgoCdConfig(config: Partial<InsertArgoCdConfig>): Promise<ArgoCdConfigRow> {
    const now = new Date();
    if (this.argoCdConfigRow) {
      // Update existing
      this.argoCdConfigRow = {
        ...this.argoCdConfigRow,
        ...config,
        updatedAt: now,
      } as ArgoCdConfigRow;
    } else {
      // Create new; id is a serial auto-inc (no longer singleton id=1)
      this.argoCdConfigRow = {
        id: 1, // MemStorage uses a single in-memory row; id is irrelevant here
        projectId: null, // MemStorage has no project context
        serverUrl: config.serverUrl ?? null,
        tokenEnc: config.tokenEnc ?? null,
        verifySsl: config.verifySsl ?? true,
        enabled: config.enabled ?? false,
        mcpServerId: config.mcpServerId ?? null,
        lastHealthCheckAt: null,
        healthStatus: "unknown",
        healthError: null,
        createdAt: now,
        updatedAt: now,
        ...config,
      } as ArgoCdConfigRow;
    }
    return this.argoCdConfigRow;
  }

  async deleteArgoCdConfig(): Promise<void> {
    this.argoCdConfigRow = null;
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────

  private workspacesMap: Map<string, WorkspaceRow> = new Map();

  async getWorkspaces(): Promise<WorkspaceRow[]> {
    return Array.from(this.workspacesMap.values()).sort(
      (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
  }

  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    return this.workspacesMap.get(id) ?? null;
  }

  async createWorkspace(data: InsertWorkspace & { id?: string }): Promise<WorkspaceRow> {
    const id = data.id ?? randomUUID();
    const now = new Date();
    const row: WorkspaceRow = {
      projectId: data.projectId ?? null,
      id,
      name: data.name,
      type: data.type as "local" | "remote",
      path: data.path,
      branch: data.branch ?? "main",
      status: (data.status ?? "active") as "active" | "syncing" | "error",
      lastSyncAt: data.lastSyncAt ?? null,
      createdAt: now,
      ownerId: data.ownerId ?? null,
      indexStatus: (data.indexStatus ?? "idle") as "idle" | "indexing" | "ready" | "error",
    };
    this.workspacesMap.set(id, row);
    return row;
  }

  async updateWorkspace(id: string, updates: Partial<WorkspaceRow>): Promise<WorkspaceRow> {
    const existing = this.workspacesMap.get(id);
    if (!existing) throw new Error(`Workspace not found: ${id}`);
    const updated = { ...existing, ...updates };
    this.workspacesMap.set(id, updated);
    return updated;
  }

  async deleteWorkspace(id: string): Promise<void> {
    this.workspacesMap.delete(id);
  }

  // ─── Shared Sessions (Federation, issue #224) ─────────────────────────────

  private sharedSessionsMap: Map<string, SharedSession> = new Map();

  async getSharedSession(id: string): Promise<SharedSession | null> {
    return this.sharedSessionsMap.get(id) ?? null;
  }

  async getSharedSessionByToken(token: string): Promise<SharedSession | null> {
    for (const session of this.sharedSessionsMap.values()) {
      if (session.shareToken === token) return session;
    }
    return null;
  }

  async getSharedSessionsByRunId(runId: string): Promise<SharedSession[]> {
    return Array.from(this.sharedSessionsMap.values()).filter(
      (s) => s.runId === runId && s.isActive,
    );
  }

  async createSharedSession(input: CreateSharedSessionInput): Promise<SharedSession> {
    const id = randomUUID();
    const role = (input.role ?? "collaborator") as ShareRole;
    const session: SharedSession = {
      id,
      runId: input.runId,
      shareToken: input.shareToken,
      ownerInstanceId: input.ownerInstanceId,
      createdBy: input.createdBy,
      expiresAt: input.expiresAt ?? null,
      isActive: true,
      createdAt: new Date(),
      permissions: {
        role,
        allowedStages: input.allowedStages ?? null,
        canChat: input.canChat ?? (role !== "viewer"),
        canVote: input.canVote ?? (role !== "viewer"),
        canViewMemories: input.canViewMemories ?? true,
      },
    };
    this.sharedSessionsMap.set(id, session);
    return session;
  }

  async deactivateSharedSession(id: string): Promise<void> {
    const session = this.sharedSessionsMap.get(id);
    if (session) {
      this.sharedSessionsMap.set(id, { ...session, isActive: false });
    }
  }

  async listActiveSharedSessions(): Promise<SharedSession[]> {
    const now = new Date();
    return Array.from(this.sharedSessionsMap.values()).filter(
      (s) => s.isActive && (!s.expiresAt || s.expiresAt > now),
    );
  }
  async updateSessionPermissions(
    id: string,
    permissions: { role?: string; allowedStages?: string[] | null; canChat?: boolean; canVote?: boolean; canViewMemories?: boolean },
  ): Promise<SharedSession | null> {
    const session = this.sharedSessionsMap.get(id);
    if (!session) return null;

    const current = session.permissions ?? {
      role: "collaborator" as ShareRole,
      allowedStages: null,
      canChat: true,
      canVote: true,
      canViewMemories: true,
    };
    const updated: SharedSession = {
      ...session,
      permissions: {
        role: (permissions.role as ShareRole) ?? current.role,
        allowedStages: permissions.allowedStages !== undefined ? permissions.allowedStages : current.allowedStages,
        canChat: permissions.canChat ?? current.canChat,
        canVote: permissions.canVote ?? current.canVote,
        canViewMemories: permissions.canViewMemories ?? current.canViewMemories,
      },
    };
    this.sharedSessionsMap.set(id, updated);
    return updated;
  }

  // ─── Workspace Connections (issue #266) ──────────────────────────────────

  private workspaceConnectionsMap: Map<string, WorkspaceConnection> = new Map();

  async getWorkspaceConnections(workspaceId: string): Promise<WorkspaceConnection[]> {
    return Array.from(this.workspaceConnectionsMap.values())
      .filter((c) => c.workspaceId === workspaceId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getWorkspaceConnection(id: string): Promise<WorkspaceConnection | null> {
    return this.workspaceConnectionsMap.get(id) ?? null;
  }

  async createWorkspaceConnection(input: CreateWorkspaceConnectionInput): Promise<WorkspaceConnection> {
    const id = randomUUID();
    const now = new Date();
    const conn: WorkspaceConnection = {
      id,
      workspaceId: input.workspaceId,
      type: input.type,
      name: input.name,
      config: input.config,
      hasSecrets: !!(input.secrets && Object.keys(input.secrets).length > 0),
      status: "active",
      lastTestedAt: null,
      createdAt: now,
      updatedAt: now,
      createdBy: input.createdBy ?? null,
    };
    this.workspaceConnectionsMap.set(id, conn);
    return conn;
  }

  async updateWorkspaceConnection(
    id: string,
    updates: UpdateWorkspaceConnectionInput,
  ): Promise<WorkspaceConnection> {
    const existing = this.workspaceConnectionsMap.get(id);
    if (!existing) throw new Error(`WorkspaceConnection not found: ${id}`);
    const updated: WorkspaceConnection = {
      ...existing,
      ...(updates.name !== undefined && { name: updates.name }),
      ...(updates.config !== undefined && { config: updates.config }),
      ...(updates.secrets !== undefined && { hasSecrets: updates.secrets !== null && Object.keys(updates.secrets).length > 0 }),
      ...(updates.status !== undefined && { status: updates.status }),
      ...(updates.lastTestedAt !== undefined && { lastTestedAt: updates.lastTestedAt }),
      updatedAt: new Date(),
    };
    this.workspaceConnectionsMap.set(id, updated);
    return updated;
  }

  async deleteWorkspaceConnection(id: string): Promise<void> {
    this.workspaceConnectionsMap.delete(id);
  }

  async testWorkspaceConnection(id: string): Promise<WorkspaceConnection> {
    const existing = this.workspaceConnectionsMap.get(id);
    if (!existing) throw new Error(`WorkspaceConnection not found: ${id}`);
    const updated: WorkspaceConnection = {
      ...existing,
      lastTestedAt: new Date(),
      updatedAt: new Date(),
    };
    this.workspaceConnectionsMap.set(id, updated);
    return updated;
  }

  // ─── MCP Tool Call Audit Log (issue #271) ────────────────────────────────

  private mcpToolCallsMap: Map<string, McpToolCall> = new Map();

  async recordMcpToolCall(input: RecordMcpToolCallInput): Promise<McpToolCall> {
    const id = randomUUID();
    const record: McpToolCall = {
      id,
      pipelineRunId: input.pipelineRunId ?? null,
      stageId: input.stageId ?? null,
      connectionId: input.connectionId,
      toolName: input.toolName,
      argsJson: input.argsJson,
      resultJson: input.resultJson ?? null,
      error: input.error ?? null,
      durationMs: input.durationMs,
      startedAt: input.startedAt ?? new Date(),
    };
    this.mcpToolCallsMap.set(id, record);
    return record;
  }

  async getMcpToolCallsByConnection(
    connectionId: string,
    fromDate: Date,
    toDate: Date,
    limit = 10_000,
  ): Promise<McpToolCall[]> {
    return Array.from(this.mcpToolCallsMap.values())
      .filter(
        (r) =>
          r.connectionId === connectionId &&
          r.startedAt >= fromDate &&
          r.startedAt <= toDate,
      )
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())
      .slice(0, limit);
  }

  async getConnectionUsageMetrics(connectionId: string): Promise<ConnectionUsageMetrics> {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const all30 = await this.getMcpToolCallsByConnection(connectionId, d30, now);
    const all7 = all30.filter((r) => r.startedAt >= d7);

    // Calls per day
    const dayMap = new Map<string, number>();
    for (const r of all30) {
      const day = r.startedAt.toISOString().slice(0, 10);
      dayMap.set(day, (dayMap.get(day) ?? 0) + 1);
    }
    const callsPerDay = Array.from(dayMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    // Top tools
    const toolMap = new Map<string, number>();
    for (const r of all30) {
      toolMap.set(r.toolName, (toolMap.get(r.toolName) ?? 0) + 1);
    }
    const topTools = Array.from(toolMap.entries())
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([toolName, count]) => ({ toolName, count }));

    // Error rate 7d
    const errorRate7d =
      all7.length === 0 ? 0 : all7.filter((r) => r.error !== null).length / all7.length;

    // P95 latency
    const durations = all30.map((r) => r.durationMs).sort((a, b) => a - b);
    const p95LatencyMs =
      durations.length === 0
        ? 0
        : durations[Math.floor(durations.length * 0.95)] ?? durations[durations.length - 1];

    return {
      connectionId,
      callsPerDay,
      topTools,
      errorRate7d,
      p95LatencyMs,
      isOrphan: all30.length === 0,
    };
  }

  // ── Cost Ledger + Budgets (issue #279) — MemStorage stubs ────────────────

  private costLedgerMap: Map<string, CostLedgerRow> = new Map();
  private budgetsMap: Map<string, BudgetRow> = new Map();

  async appendCostLedger(input: InsertCostLedger): Promise<CostLedgerRow> {
    const row: CostLedgerRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider,
      model: input.model,
      pipelineRunId: input.pipelineRunId ?? null,
      stageId: input.stageId ?? null,
      promptTokens: input.promptTokens ?? 0,
      completionTokens: input.completionTokens ?? 0,
      costUsd: input.costUsd ?? 0,
      ts: new Date(),
    };
    this.costLedgerMap.set(row.id, row);
    return row;
  }

  async getCostLedgerRows(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<CostLedgerRow[]> {
    const rows = Array.from(this.costLedgerMap.values()).filter(
      (r) =>
        r.workspaceId === params.workspaceId &&
        r.ts >= params.from &&
        r.ts <= params.to &&
        (params.provider === undefined || r.provider === params.provider),
    );
    return params.limit ? rows.slice(0, params.limit) : rows;
  }

  async getCostLedgerSum(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
  }): Promise<number> {
    const rows = await this.getCostLedgerRows(params);
    return rows.reduce((sum, r) => sum + r.costUsd, 0);
  }

  async getBudgetsByWorkspace(workspaceId: string): Promise<BudgetRow[]> {
    return Array.from(this.budgetsMap.values()).filter((b) => b.workspaceId === workspaceId);
  }

  async getBudget(id: string): Promise<BudgetRow | null> {
    return this.budgetsMap.get(id) ?? null;
  }

  async createBudget(input: InsertBudget): Promise<BudgetRow> {
    const now = new Date();
    const row: BudgetRow = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      provider: input.provider ?? null,
      period: input.period ?? "month",
      limitUsd: input.limitUsd,
      hard: input.hard ?? false,
      notifyAtPct: input.notifyAtPct ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.budgetsMap.set(row.id, row);
    return row;
  }

  async updateBudget(id: string, updates: UpdateBudget): Promise<BudgetRow> {
    const existing = this.budgetsMap.get(id);
    if (!existing) throw new Error(`Budget ${id} not found`);
    const updated: BudgetRow = { ...existing, ...updates, updatedAt: new Date() };
    this.budgetsMap.set(id, updated);
    return updated;
  }

  async deleteBudget(id: string): Promise<void> {
    this.budgetsMap.delete(id);
  }

  async getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown> | null> {
    return this.workspaceSettingsMap.get(workspaceId) ?? null;
  }

  async upsertWorkspaceSettings(workspaceId: string, patch: Record<string, unknown>): Promise<void> {
    const existing = this.workspaceSettingsMap.get(workspaceId) ?? {};
    this.workspaceSettingsMap.set(workspaceId, { ...existing, ...patch });
  }

  // ── Conflict Resolution (issue #229) ────────────────────────────────────────

  private conflictsMap: Map<string, SessionConflict> = new Map();
  private decisionLogEntries: DecisionLogEntry[] = [];

  async saveConflict(conflict: SessionConflict): Promise<void> {
    this.conflictsMap.set(conflict.id, { ...conflict });
  }

  async getConflict(conflictId: string): Promise<SessionConflict | null> {
    return this.conflictsMap.get(conflictId) ?? null;
  }

  async getSessionConflicts(sessionId: string): Promise<SessionConflict[]> {
    return Array.from(this.conflictsMap.values()).filter(
      (c) => c.sessionId === sessionId,
    );
  }

  async appendDecisionLog(entry: DecisionLogEntry): Promise<void> {
    this.decisionLogEntries.push({ ...entry });
  }

  async getDecisionLog(sessionId?: string): Promise<DecisionLogEntry[]> {
    if (sessionId) {
      return this.decisionLogEntries.filter((e) => e.sessionId === sessionId);
    }
    return [...this.decisionLogEntries];
  }

  // ─── Practice Cards (Active Knowledge Base) ───────────────────────────────

  private practiceCardsMap: Map<string, PracticeCardRow> = new Map();
  private refreshRunsMap: Map<string, PracticeCardRefreshRunRow> = new Map();

  async createPracticeCard(data: InsertPracticeCard): Promise<PracticeCardRow> {
    // Idempotent upsert by (workspaceId, contentHash) — ON CONFLICT DO NOTHING.
    const existing = Array.from(this.practiceCardsMap.values()).find(
      (c) => c.workspaceId === data.workspaceId && c.contentHash === data.contentHash,
    );
    if (existing) return existing;

    const id = randomUUID();
    const now = new Date();
    const row: PracticeCardRow = {
      id,
      workspaceId: data.workspaceId,
      topic: data.topic,
      statement: data.statement,
      rationale: data.rationale,
      appliesTo: data.appliesTo ?? { tool: "terraform" },
      sources: data.sources ?? [],
      confidence: data.confidence ?? 0,
      status: (data.status ?? "active") as PracticeCardStatus,
      supersedes: data.supersedes ?? [],
      supersededBy: data.supersededBy ?? [],
      ingestedBy: data.ingestedBy,
      // Parity with the DB NOT NULL constraint: a bound ingester id is required.
      ingestedByUserId: requireIngesterId(data.ingestedByUserId),
      verifiedBy: data.verifiedBy ?? null,
      verifiedByUserId: data.verifiedByUserId ?? null,
      verification: data.verification ?? {},
      reviewState: (data.reviewState ?? "pending_verification") as PracticeCardReviewState,
      contentHash: data.contentHash,
      lastVerifiedAt: data.lastVerifiedAt ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.practiceCardsMap.set(id, row);
    return row;
  }

  async getPracticeCard(id: string): Promise<PracticeCardRow | null> {
    return this.practiceCardsMap.get(id) ?? null;
  }

  async listPracticeCards(
    workspaceId: string,
    filters: PracticeCardFilters = {},
  ): Promise<{ cards: PracticeCardRow[]; total: number }> {
    let cards = Array.from(this.practiceCardsMap.values()).filter(
      (c) => c.workspaceId === workspaceId,
    );
    if (filters.status) cards = cards.filter((c) => c.status === filters.status);
    if (filters.reviewState) cards = cards.filter((c) => c.reviewState === filters.reviewState);
    if (filters.topic) cards = cards.filter((c) => c.topic === filters.topic);
    cards.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = cards.length;
    const offset = filters.offset ?? 0;
    const limit = filters.limit ?? 50;
    return { cards: cards.slice(offset, offset + limit), total };
  }

  async getPracticeCardsByWorkspace(workspaceId: string): Promise<PracticeCardRow[]> {
    return Array.from(this.practiceCardsMap.values()).filter(
      (c) => c.workspaceId === workspaceId,
    );
  }

  async updatePracticeCardState(
    id: string,
    updates: Partial<PracticeCardRow>,
  ): Promise<PracticeCardRow> {
    const existing = this.practiceCardsMap.get(id);
    if (!existing) throw new Error(`Practice card not found: ${id}`);
    const updated: PracticeCardRow = { ...existing, ...updates, id: existing.id, updatedAt: new Date() };
    this.practiceCardsMap.set(id, updated);
    return updated;
  }

  async createRefreshRun(
    workspaceId: string,
    topic: string,
    trigger: string,
  ): Promise<PracticeCardRefreshRunRow> {
    const id = randomUUID();
    const row: PracticeCardRefreshRunRow = {
      id,
      workspaceId,
      topic,
      trigger,
      status: "running",
      report: {},
      startedAt: new Date(),
      completedAt: null,
    };
    this.refreshRunsMap.set(id, row);
    return row;
  }

  async getRefreshRun(id: string): Promise<PracticeCardRefreshRunRow | null> {
    return this.refreshRunsMap.get(id) ?? null;
  }

  async updateRefreshRun(
    id: string,
    updates: Partial<PracticeCardRefreshRunRow>,
  ): Promise<PracticeCardRefreshRunRow> {
    const existing = this.refreshRunsMap.get(id);
    if (!existing) throw new Error(`Refresh run not found: ${id}`);
    const updated: PracticeCardRefreshRunRow = { ...existing, ...updates, id: existing.id };
    this.refreshRunsMap.set(id, updated);
    return updated;
  }

  // ─── Task Groups v2 — iterations / executions / templates (BE2) ─────────────
  // MemStorage EMULATES the DB constraints so unit tests are meaningful:
  //  - UNIQUE(group_id, iteration_number) and UNIQUE(iteration_id, task_id) throw
  //  - cascade deletes remove children (group -> iterations -> executions/traces;
  //    task -> executions). See deleteTaskGroup / deleteTask below.

  private iterationsMap = new Map<string, TaskGroupIterationRow>();
  private executionsMap = new Map<string, TaskExecutionRow>();

  private iterationExists(groupId: string, iterationNumber: number): boolean {
    for (const it of this.iterationsMap.values()) {
      if (it.groupId === groupId && it.iterationNumber === iterationNumber) return true;
    }
    return false;
  }

  private executionExists(iterationId: string, taskId: string): boolean {
    for (const ex of this.executionsMap.values()) {
      if (ex.iterationId === iterationId && ex.taskId === taskId) return true;
    }
    return false;
  }

  private buildIterationRow(data: InsertTaskGroupIteration): TaskGroupIterationRow {
    return {
      id: randomUUID(),
      projectId: data.projectId ?? null,
      groupId: data.groupId,
      iterationNumber: data.iterationNumber,
      status: (data.status as TaskGroupStatus) ?? "running",
      input: data.input,
      output: (data.output as Record<string, unknown>) ?? null,
      humanNote: (data as { humanNote?: string | null }).humanNote ?? null,
      traceId: data.traceId ?? null,
      triggeredBy: data.triggeredBy ?? null,
      startedAt: data.startedAt ?? null,
      completedAt: data.completedAt ?? null,
      createdAt: new Date(),
    };
  }

  async createIteration(data: InsertTaskGroupIteration): Promise<TaskGroupIterationRow> {
    if (this.iterationExists(data.groupId, data.iterationNumber)) {
      throw new IterationConflictError(data.groupId, data.iterationNumber);
    }
    const row = this.buildIterationRow(data);
    this.iterationsMap.set(row.id, row);
    return row;
  }

  async getIterations(groupId: string, query: IterationListQuery): Promise<TaskGroupIterationRow[]> {
    const limit = Math.min(query.limit, TASK_GROUP_V2_MAX_LIMIT);
    const sorted = Array.from(this.iterationsMap.values())
      .filter((it) => it.groupId === groupId)
      .sort((a, b) => b.iterationNumber - a.iterationNumber); // desc
    const filtered = query.cursor
      ? sorted.filter((it) => it.iterationNumber < query.cursor!.iterationNumber)
      : sorted;
    return filtered.slice(0, limit);
  }

  async getIteration(groupId: string, iterationNumber: number): Promise<TaskGroupIterationRow | undefined> {
    for (const it of this.iterationsMap.values()) {
      if (it.groupId === groupId && it.iterationNumber === iterationNumber) return it;
    }
    return undefined;
  }

  async getLatestIteration(groupId: string): Promise<TaskGroupIterationRow | undefined> {
    let latest: TaskGroupIterationRow | undefined;
    for (const it of this.iterationsMap.values()) {
      if (it.groupId !== groupId) continue;
      if (!latest || it.iterationNumber > latest.iterationNumber) latest = it;
    }
    return latest;
  }

  async updateIteration(id: string, updates: Partial<TaskGroupIterationRow>): Promise<TaskGroupIterationRow> {
    const existing = this.iterationsMap.get(id);
    if (!existing) throw new Error(`Iteration ${id} not found`);
    const updated = { ...existing, ...updates };
    this.iterationsMap.set(id, updated);
    return updated;
  }

  async createIterationWithExecutions(
    groupId: string,
    start: IterationStartInput,
    seeds: IterationExecutionSeed[],
  ): Promise<{ iteration: TaskGroupIterationRow; executions: TaskExecutionRow[] }> {
    // All-or-nothing: reject the duplicate-N race BEFORE writing anything.
    if (this.iterationExists(groupId, start.iterationNumber)) {
      throw new IterationConflictError(groupId, start.iterationNumber);
    }
    const iteration = this.buildIterationRow({
      groupId,
      iterationNumber: start.iterationNumber,
      status: "running",
      input: start.input,
      triggeredBy: start.triggeredBy ?? null,
      traceId: start.traceId ?? null,
      startedAt: new Date(),
    });
    const executions: TaskExecutionRow[] = seeds.map((seed) =>
      this.buildExecutionRow({
        iterationId: iteration.id,
        taskId: seed.taskId,
        taskName: seed.taskName,
        groupId,
        status: seed.status,
        modelSlug: seed.modelSlug ?? null,
      }),
    );
    // Commit only after every row is built (no partial state on a build throw).
    this.iterationsMap.set(iteration.id, iteration);
    for (const ex of executions) this.executionsMap.set(ex.id, ex);
    return { iteration, executions };
  }

  private buildExecutionRow(data: InsertTaskExecution): TaskExecutionRow {
    return {
      id: randomUUID(),
      projectId: data.projectId ?? null,
      iterationId: data.iterationId,
      taskId: data.taskId ?? null,
      taskName: data.taskName ?? null,
      groupId: data.groupId,
      status: (data.status as TaskStatus) ?? "pending",
      output: data.output ?? null,
      summary: data.summary ?? null,
      artifacts: (data.artifacts as Record<string, unknown>[]) ?? null,
      decisions: (data.decisions as string[]) ?? null,
      errorMessage: data.errorMessage ?? null,
      modelSlug: data.modelSlug ?? null,
      pipelineRunId: data.pipelineRunId ?? null,
      startedAt: data.startedAt ?? null,
      completedAt: data.completedAt ?? null,
      createdAt: new Date(),
    };
  }

  async createExecution(data: InsertTaskExecution): Promise<TaskExecutionRow> {
    // Null task_id rows are historical (definition deleted) — PG treats nulls as
    // DISTINCT, so they never collide; only dedup live (non-null) definitions.
    if (data.taskId != null && this.executionExists(data.iterationId, data.taskId)) {
      throw new Error(
        `Execution already exists for iteration ${data.iterationId} task ${data.taskId}`,
      );
    }
    const row = this.buildExecutionRow(data);
    this.executionsMap.set(row.id, row);
    return row;
  }

  async getExecutionsByIteration(groupId: string, iterationId: string): Promise<TaskExecutionRow[]> {
    // MF-1: group is a mandatory scope key — never trust a bare iterationId.
    return Array.from(this.executionsMap.values())
      .filter((ex) => ex.iterationId === iterationId && ex.groupId === groupId)
      .sort((a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0));
  }

  async getExecution(groupId: string, executionId: string): Promise<TaskExecutionRow | undefined> {
    // MF-1: a row whose groupId !== the authorized group is invisible (no leak).
    const row = this.executionsMap.get(executionId);
    if (!row || row.groupId !== groupId) return undefined;
    return row;
  }

  async updateExecution(id: string, updates: Partial<TaskExecutionRow>): Promise<TaskExecutionRow> {
    const existing = this.executionsMap.get(id);
    if (!existing) throw new Error(`Execution ${id} not found`);
    const updated = { ...existing, ...updates };
    this.executionsMap.set(id, updated);
    return updated;
  }

  async getVirtualIteration(groupId: string): Promise<VirtualIteration | null> {
    const group = this.taskGroupsMap.get(groupId);
    if (!group) return null;
    // Only synthesize when there are NO real iterations (MF-5 / §8 lazy adapter).
    for (const it of this.iterationsMap.values()) {
      if (it.groupId === groupId) return null;
    }
    return buildVirtualIteration(group, await this.getTasksByGroup(groupId));
  }

  async getTaskTraceByIteration(groupId: string, iterationId: string): Promise<TaskTraceRow | null> {
    // MF-3: scope by group AND iteration; the trace must belong to both.
    for (const tr of this.taskTracesMap.values()) {
      if (tr.iterationId === iterationId && tr.groupId === groupId) return tr;
    }
    return null;
  }

}

export const storage: IStorage = configLoader.get().database.url
  ? new PgStorage()
  : new MemStorage();

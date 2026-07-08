import { eq, desc, and, or, ilike, lt, ne, gte, lte, asc, isNull, isNotNull, inArray, sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, withProject, withProjectList, withProjectInsert, withProjectOrGlobal } from "./db";
import { unscopedSystemQuery, getProjectId } from "./context";
import type { IStorage, PracticeCardFilters, LlmRequestFilters, LlmRequestStats, LlmStatsByModel, LlmStatsByProvider, LlmStatsByTeam, LlmStatsByWorkspace, LlmTimelinePoint, RunHistoryQuery, TaskGroupHistoryRow, WorkspaceTaskModelUsage } from "./storage";
import {
  TASK_GROUP_V2_MAX_LIMIT,
  IterationConflictError,
  buildVirtualIteration,
} from "./storage-task-groups-v2";
import type {
  IterationListQuery,
  IterationExecutionSeed,
  IterationStartInput,
  VirtualIteration,
} from "./storage-task-groups-v2";
import type { McpServerConfig } from "@shared/types";
import {
  users, models,
  questions, chatMessages, llmRequests,
  lessons,
  mcpServers,
  specializationProfiles,
  skills,
  skillVersions,
  modelSkillBindings,
  triggers,
  traces,
  argoCdConfig,
  workspaces,
  practiceCards,
  practiceCardRefreshRuns,
  type PracticeCardRow,
  type InsertPracticeCard,
  type PracticeCardRefreshRunRow,
  type PracticeCardReviewState,
  type PracticeCardStatus,
  type UserRow, type InsertUser,
  type Model, type InsertModel,
  type Lesson, type InsertLesson,
  type Question, type InsertQuestion,
  type ChatMessage, type InsertChatMessage,
  type LlmRequest, type InsertLlmRequest,
  type InsertSpecializationProfile,
  type SpecializationProfileRow,
  type Skill, type InsertSkill,
  type SkillVersionRow,
  type TriggerRow,
  type InsertTrace,
  type TraceRow,
  taskGroups,
  tasks,
  taskTraces,
  taskGroupIterations,
  taskExecutions,
  consiliumLoops,
  consiliumLoopRounds,
  experienceItems,
  type ExperienceItemRow,
  type InsertExperienceItem,
  skillProposals,
  type SkillProposalRow,
  type InsertSkillProposal,
  type ConsiliumLoopRow,
  type InsertConsiliumLoop,
  type ConsiliumLoopRoundRow,
  type InsertConsiliumLoopRound,
  type ConsiliumLoopState,
  CONSILIUM_LOOP_TERMINAL_STATES,
  type ConsiliumLoopSkillStat,
  type ConsiliumLoopOutcomeStats,
  trackerConnections,
  type TaskGroupRow,
  type InsertTaskGroup,
  type TaskRow,
  type InsertTask,
  type TaskTraceRow,
  type InsertTaskTrace,
  type TaskGroupIterationRow,
  type InsertTaskGroupIteration,
  type TaskExecutionRow,
  type InsertTaskExecution,
  type TrackerConnectionRow,
  type InsertTrackerConnection,
  type ModelSkillBinding,
  type InsertModelSkillBinding,
  type ArgoCdConfigRow,
  type InsertArgoCdConfig,
  type WorkspaceRow,
  type InsertWorkspace,
  sharedSessions,
  type SharedSessionRow,
  workspaceConnections,
  mcpToolCalls,
  type WorkspaceConnectionRow,
  type McpToolCallRow,
  costLedger,
  budgets,
  type InsertCostLedger,
  type CostLedgerRow,
  type BudgetRow,
  type InsertBudget,
  type UpdateBudget,
  workspaceSettings,
  sessionConflicts,
  decisionLog,
  type SessionConflictRow,
  type DecisionLogRow,
} from "@shared/schema";
// ROLE-1 (standing-role.md §3/§8): the StandingRole table + types. Separate localized
// import so the shared `@shared/schema` import block above stays a single merge point.
import { standingRoles, type StandingRoleRow, type InsertStandingRole } from "@shared/schema";
import type { LessonRecallFilter } from "./memory/lessons/types";
import type { TraceSpan, SkillVersionRecord, InsertSkillVersion, SharedSession, CreateSharedSessionInput, ShareRole, WorkspaceConnection, CreateWorkspaceConnectionInput, UpdateWorkspaceConnectionInput, McpToolCall, ConnectionUsageMetrics, RecordMcpToolCallInput, SessionConflict, DecisionLogEntry, RaiseConflictInput, CastConflictVoteInput, DebateJudgement, ExperimentBranchResult, ResolutionOutcome, ResearchReport, ExecutionTrace, ActionPoint, SkillProposalStatus } from "@shared/types";

import { encrypt } from "./crypto";
// [ADR-001 Wave-2] credentialProvider routes all decrypt() calls through the broker.
import { credentialProvider } from "./credentials/db-crypto-provider";

export class PgStorage implements IStorage {

  // ─── Users ──────────────────────────────────────────

  async getUser(id: string): Promise<UserRow | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async getUserByEmail(email: string): Promise<UserRow | undefined> {
    const [row] = await db.select().from(users).where(eq(users.email, email));
    return row;
  }

  async createUser(user: InsertUser): Promise<UserRow> {
    const [row] = await db.insert(users).values(user).returning();
    return row;
  }

  // ─── Models ─────────────────────────────────────────

  async getModels(): Promise<Model[]> {
    // GLOBAL CATALOG: shared rows (project_id IS NULL) are visible in every
    // project; project-specific rows are visible only in their own project.
    // System context (startup seed / catalog reconcile) sees the whole catalog.
    return db.select().from(models).where(withProjectOrGlobal(models));
  }

  async getActiveModels(): Promise<Model[]> {
    // GLOBAL CATALOG (see getModels): global-or-current visibility, active only.
    return db.select().from(models).where(withProjectOrGlobal(models, eq(models.isActive, true)));
  }

  async getModelBySlug(slug: string): Promise<Model | undefined> {
    const [row] = await db.select().from(models).where(withProjectOrGlobal(models, eq(models.slug, slug)));
    return row;
  }

  async createModel(model: InsertModel): Promise<Model> {
    const [row] = await db.insert(models).values(withProjectInsert(models, model)).returning();
    return row;
  }

  async upsertModelBySlug(model: InsertModel): Promise<Model> {
    // Parameterized upsert keyed on the unique slug column. On conflict we
    // refresh the mutable fields (name/provider/modelId/contextLimit/isActive)
    // but keep the existing id/createdAt.
    const [row] = await db
      .insert(models)
      .values(withProjectInsert(models, model))
      .onConflictDoUpdate({
        target: models.slug,
        set: {
          name: model.name,
          provider: model.provider,
          modelId: model.modelId ?? null,
          contextLimit: model.contextLimit,
          isActive: model.isActive ?? true,
        },
      })
      .returning();
    return row;
  }

  async updateModel(id: string, updates: Partial<InsertModel>): Promise<Model> {
    const [row] = await db
      .update(models)
      .set(updates)
      .where(withProject(models, eq(models.id, id)))
      .returning();
    if (!row) throw new Error(`Model not found: ${id}`);
    return row;
  }

  async deleteModel(id: string): Promise<void> {
    await db.delete(models).where(withProject(models, eq(models.id, id)));
  }

  // ─── Lessons (agent-experience memory — Track B) ─────

  async createLesson(lesson: InsertLesson): Promise<Lesson> {
    const [row] = await db.insert(lessons).values(withProjectInsert(lessons, lesson)).returning();
    return row;
  }

  async recallLessons(filter: LessonRecallFilter): Promise<Lesson[]> {
    const conditions: SQL[] = [];
    if (filter.workspaceId !== undefined) {
      conditions.push(
        filter.workspaceId === null
          ? isNull(lessons.workspaceId)
          : eq(lessons.workspaceId, filter.workspaceId),
      );
    }
    if (filter.teamId !== undefined) {
      conditions.push(
        filter.teamId === null
          ? isNull(lessons.teamId)
          : eq(lessons.teamId, filter.teamId),
      );
    }
    if (filter.outcome !== undefined) {
      conditions.push(eq(lessons.outcome, filter.outcome));
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return db
      .select()
      .from(lessons)
      .where(withProject(lessons, where))
      .orderBy(desc(lessons.createdAt))
      .limit(filter.limit ?? 10);
  }

  async getLessons(workspaceId?: string): Promise<Lesson[]> {
    const where =
      workspaceId != null ? eq(lessons.workspaceId, workspaceId) : undefined;
    return db
      .select()
      .from(lessons)
      .where(withProject(lessons, where))
      .orderBy(desc(lessons.createdAt));
  }

  // ─── Questions ──────────────────────────────────────

  async getQuestions(runId: string): Promise<Question[]> {
    return db
      .select()
      .from(questions)
      .where(withProject(questions, eq(questions.runId, runId)))
      .orderBy(questions.createdAt);
  }

  async getPendingQuestions(runId?: string): Promise<Question[]> {
    if (runId) {
      return db
        .select()
        .from(questions)
        .where(withProject(questions, and(eq(questions.status, "pending"), eq(questions.runId, runId)),));
    }
    return db
      .select()
      .from(questions)
      .where(withProject(questions, eq(questions.status, "pending")));
  }

  async getQuestion(id: string): Promise<Question | undefined> {
    const [row] = await db
      .select()
      .from(questions)
      .where(withProject(questions, eq(questions.id, id)));
    return row;
  }

  async createQuestion(question: InsertQuestion): Promise<Question> {
    const [row] = await db.insert(questions).values(withProjectInsert(questions, question)).returning();
    return row;
  }

  async answerQuestion(id: string, answer: string): Promise<Question> {
    const [row] = await db
      .update(questions)
      .set({ answer, status: "answered", answeredAt: new Date() })
      .where(withProject(questions, eq(questions.id, id)))
      .returning();
    if (!row) throw new Error(`Question not found: ${id}`);
    return row;
  }

  async dismissQuestion(id: string): Promise<Question> {
    const [row] = await db
      .update(questions)
      .set({ status: "dismissed" })
      .where(withProject(questions, eq(questions.id, id)))
      .returning();
    if (!row) throw new Error(`Question not found: ${id}`);
    return row;
  }

  // ─── Chat Messages ──────────────────────────────────

  async getChatMessages(runId?: string, limit?: number): Promise<ChatMessage[]> {
    // ALWAYS project-scoped at the base — even when runId is omitted. Previously a
    // no-runId call applied NO filter and dumped chat messages across every project.
    // When runId is provided it is AND-ed with the project filter.
    const filter = runId
      ? withProjectList(chatMessages, eq(chatMessages.runId, runId))
      : withProjectList(chatMessages);
    const rows = await db
      .select()
      .from(chatMessages)
      .where(filter)
      .orderBy(chatMessages.createdAt);
    return limit ? rows.slice(-limit) : rows;
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [row] = await db.insert(chatMessages).values(withProjectInsert(chatMessages, message)).returning();
    return row;
  }

  // ─── LLM Requests ───────────────────────────────────

  async createLlmRequest(data: InsertLlmRequest): Promise<LlmRequest> {
    const [row] = await db.insert(llmRequests).values(withProjectInsert(llmRequests, data)).returning();
    return row;
  }

  async getLlmRequests(filters: LlmRequestFilters): Promise<{ rows: LlmRequest[]; total: number }> {
    const conditions = [];
    if (filters.runId) conditions.push(eq(llmRequests.runId, filters.runId));
    if (filters.provider) conditions.push(eq(llmRequests.provider, filters.provider));
    if (filters.modelSlug) conditions.push(eq(llmRequests.modelSlug, filters.modelSlug));
    if (filters.status) conditions.push(eq(llmRequests.status, filters.status));
    if (filters.from) conditions.push(gte(llmRequests.createdAt, filters.from));
    if (filters.to) conditions.push(lte(llmRequests.createdAt, filters.to));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // Count total
    const [countRow] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(llmRequests)
      .where(withProject(llmRequests, whereClause));
    const total = countRow?.count ?? 0;

    // Paginated rows
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const offset = (page - 1) * limit;

    const rows = await db
      .select()
      .from(llmRequests)
      .where(withProject(llmRequests, whereClause))
      .orderBy(desc(llmRequests.createdAt))
      .limit(limit)
      .offset(offset);

    return { rows, total };
  }

  async getLlmRequestById(id: number): Promise<LlmRequest | undefined> {
    const [row] = await db
      .select()
      .from(llmRequests)
      .where(withProject(llmRequests, eq(llmRequests.id, id)));
    return row;
  }

  async getLlmRequestStats(): Promise<LlmRequestStats> {
    const [row] = await db
      .select({
        totalRequests: drizzleSql<number>`count(*)::int`,
        totalInputTokens: drizzleSql<number>`coalesce(sum(input_tokens), 0)::int`,
        totalOutputTokens: drizzleSql<number>`coalesce(sum(output_tokens), 0)::int`,
        totalCostUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests));

    return {
      totalRequests: row?.totalRequests ?? 0,
      totalInputTokens: row?.totalInputTokens ?? 0,
      totalOutputTokens: row?.totalOutputTokens ?? 0,
      totalCostUsd: row?.totalCostUsd ?? 0,
    };
  }

  async getLlmStatsByModel(): Promise<LlmStatsByModel[]> {
    const rows = await db
      .select({
        modelSlug: llmRequests.modelSlug,
        provider: llmRequests.provider,
        requests: drizzleSql<number>`count(*)::int`,
        inputTokens: drizzleSql<number>`coalesce(sum(input_tokens), 0)::int`,
        outputTokens: drizzleSql<number>`coalesce(sum(output_tokens), 0)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
        avgLatencyMs: drizzleSql<number>`coalesce(avg(latency_ms), 0)::float`,
        errorCount: drizzleSql<number>`count(*) filter (where status = 'error')::int`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests))
      .groupBy(llmRequests.modelSlug, llmRequests.provider);

    return rows.map((r) => ({
      modelSlug: r.modelSlug,
      provider: r.provider,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      avgLatencyMs: r.avgLatencyMs,
      errorRate: r.requests > 0 ? r.errorCount / r.requests : 0,
    }));
  }

  async getLlmStatsByProvider(): Promise<LlmStatsByProvider[]> {
    const rows = await db
      .select({
        provider: llmRequests.provider,
        requests: drizzleSql<number>`count(*)::int`,
        inputTokens: drizzleSql<number>`coalesce(sum(input_tokens), 0)::int`,
        outputTokens: drizzleSql<number>`coalesce(sum(output_tokens), 0)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
        avgLatencyMs: drizzleSql<number>`coalesce(avg(latency_ms), 0)::float`,
        errorCount: drizzleSql<number>`count(*) filter (where status = 'error')::int`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests))
      .groupBy(llmRequests.provider);

    return rows.map((r) => ({
      provider: r.provider,
      requests: r.requests,
      inputTokens: r.inputTokens,
      outputTokens: r.outputTokens,
      costUsd: r.costUsd,
      avgLatencyMs: r.avgLatencyMs,
      errorRate: r.requests > 0 ? r.errorCount / r.requests : 0,
    }));
  }

  async getLlmStatsByTeam(): Promise<LlmStatsByTeam[]> {
    const rows = await db
      .select({
        teamId: llmRequests.teamId,
        requests: drizzleSql<number>`count(*)::int`,
        inputTokens: drizzleSql<number>`coalesce(sum(input_tokens), 0)::int`,
        outputTokens: drizzleSql<number>`coalesce(sum(output_tokens), 0)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests, drizzleSql`team_id is not null`))
      .groupBy(llmRequests.teamId);

    return rows
      .filter((r) => r.teamId !== null)
      .map((r) => ({
        teamId: r.teamId as string,
        requests: r.requests,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        costUsd: r.costUsd,
      }));
  }

  async getLlmStatsByWorkspace(): Promise<LlmStatsByWorkspace[]> {
    // Read-side workspace attribution. See MemStorage.getLlmStatsByWorkspace for the
    // full rationale. Chosen join: llm_requests.runId (= task_groups.id in the
    // consilium path) -> consilium_loops.groupId -> repoPath -> workspaces.path.
    //
    // Single-count guard: rather than JOIN requests to the (potentially many)
    // consilium_loops / tasks rows of a group -- which fans out and double-counts
    // tokens/cost -- we (1) aggregate requests grouped by runId (each request lands
    // in exactly ONE runId bucket, project-scoped), then (2) resolve each runId to a
    // SINGLE workspace and fold. No request-to-loop join exists, so no fan-out.

    // 1. Per-runId aggregation, project-scoped exactly like every other stat.
    const reqRows = await db
      .select({
        runId: llmRequests.runId,
        requests: drizzleSql<number>`count(*)::int`,
        inputTokens: drizzleSql<number>`coalesce(sum(input_tokens), 0)::int`,
        outputTokens: drizzleSql<number>`coalesce(sum(output_tokens), 0)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests))
      .groupBy(llmRequests.runId);

    // 2a. path -> workspace (deterministic: lowest id wins on a duplicate path).
    const wsRows = await db
      .select({ id: workspaces.id, name: workspaces.name, path: workspaces.path })
      .from(workspaces)
      .where(withProject(workspaces));
    const wsByPath = new Map<string, { id: string; name: string }>();
    for (const w of [...wsRows].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!wsByPath.has(w.path)) wsByPath.set(w.path, w);
    }

    // 2b. group -> one workspace: the newest resolving loop wins.
    const loopRows = await db
      .select({ groupId: consiliumLoops.groupId, repoPath: consiliumLoops.repoPath })
      .from(consiliumLoops)
      .where(withProject(consiliumLoops))
      .orderBy(desc(consiliumLoops.createdAt), desc(consiliumLoops.id));
    const groupToWs = new Map<string, { id: string; name: string }>();
    for (const loop of loopRows) {
      if (groupToWs.has(loop.groupId)) continue;
      const w = wsByPath.get(loop.repoPath);
      if (w) groupToWs.set(loop.groupId, w);
    }

    // 3. Fold each runId bucket into its single workspace (or Unattributed).
    const UNATTRIBUTED = "\u0000unattributed";
    const out = new Map<string, LlmStatsByWorkspace>();
    for (const r of reqRows) {
      const ws = r.runId ? groupToWs.get(r.runId) : undefined;
      const key = ws ? ws.id : UNATTRIBUTED;
      const existing = out.get(key) ?? {
        workspaceId: ws ? ws.id : null,
        workspaceName: ws ? ws.name : "Unattributed",
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      existing.requests += r.requests;
      existing.inputTokens += r.inputTokens;
      existing.outputTokens += r.outputTokens;
      existing.costUsd += r.costUsd;
      out.set(key, existing);
    }
    return Array.from(out.values());
  }

  async getLlmTimeline(from: Date, to: Date, granularity: 'day' | 'week'): Promise<LlmTimelinePoint[]> {
    const truncFn = granularity === 'week' ? 'week' : 'day';
    const rows = await db
      .select({
        date: drizzleSql<string>`date_trunc('${drizzleSql.raw(truncFn)}', created_at)::date::text`,
        requests: drizzleSql<number>`count(*)::int`,
        tokens: drizzleSql<number>`coalesce(sum(input_tokens + output_tokens), 0)::int`,
        costUsd: drizzleSql<number>`coalesce(sum(estimated_cost_usd), 0)::float`,
      })
      .from(llmRequests)
      .where(withProject(llmRequests, and(gte(llmRequests.createdAt, from), lte(llmRequests.createdAt, to))))
      .groupBy(drizzleSql`date_trunc('${drizzleSql.raw(truncFn)}', created_at)`)
      .orderBy(drizzleSql`date_trunc('${drizzleSql.raw(truncFn)}', created_at)`);

    return rows.map((r) => ({
      date: r.date,
      requests: r.requests,
      tokens: r.tokens,
      costUsd: r.costUsd,
    }));
  }

  // ─── MCP Servers ────────────────────────────────────

  private rowToMcpServer(row: typeof mcpServers.$inferSelect): McpServerConfig {
    return {
      id: row.id,
      name: row.name,
      transport: row.transport as McpServerConfig['transport'],
      command: row.command ?? null,
      args: (row.args as string[] | null) ?? null,
      url: row.url ?? null,
      env: (row.env as Record<string, string> | null) ?? null,
      enabled: row.enabled,
      autoConnect: row.autoConnect,
      toolCount: row.toolCount ?? 0,
      lastConnectedAt: row.lastConnectedAt ?? null,
      createdAt: row.createdAt ?? null,
    };
  }

  async getMcpServers(): Promise<McpServerConfig[]> {
    const rows = await db.select().from(mcpServers).where(withProjectList(mcpServers)).orderBy(mcpServers.name);
    return rows.map((r) => this.rowToMcpServer(r));
  }

  async getMcpServer(id: number): Promise<McpServerConfig | undefined> {
    const [row] = await db.select().from(mcpServers).where(withProject(mcpServers, eq(mcpServers.id, id)));
    return row ? this.rowToMcpServer(row) : undefined;
  }

  async createMcpServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig> {
    const [row] = await db
      .insert(mcpServers)
      .values(withProjectInsert(mcpServers, {
        name: config.name,
        transport: config.transport,
        command: config.command ?? null,
        args: config.args ?? null,
        url: config.url ?? null,
        env: config.env ?? null,
        enabled: config.enabled,
        autoConnect: config.autoConnect,
        toolCount: config.toolCount ?? 0,
        lastConnectedAt: config.lastConnectedAt ?? null,
      }))
      .returning();
    return this.rowToMcpServer(row);
  }

  async updateMcpServer(id: number, updates: Partial<McpServerConfig>): Promise<McpServerConfig> {
    const [row] = await db
      .update(mcpServers)
      .set({
        ...(updates.name !== undefined && { name: updates.name }),
        ...(updates.transport !== undefined && { transport: updates.transport }),
        ...(updates.command !== undefined && { command: updates.command }),
        ...(updates.args !== undefined && { args: updates.args }),
        ...(updates.url !== undefined && { url: updates.url }),
        ...(updates.env !== undefined && { env: updates.env }),
        ...(updates.enabled !== undefined && { enabled: updates.enabled }),
        ...(updates.autoConnect !== undefined && { autoConnect: updates.autoConnect }),
        ...(updates.toolCount !== undefined && { toolCount: updates.toolCount }),
        ...(updates.lastConnectedAt !== undefined && { lastConnectedAt: updates.lastConnectedAt }),
      })
      .where(withProject(mcpServers, eq(mcpServers.id, id)))
      .returning();
    if (!row) throw new Error(`MCP server not found: ${id}`);
    return this.rowToMcpServer(row);
  }

  async deleteMcpServer(id: number): Promise<void> {
    await db.delete(mcpServers).where(withProject(mcpServers, eq(mcpServers.id, id)));
  }

  // ─── Specialization Profiles (Phase 5) ──────────────────────────────────────

  async getSpecializationProfiles(): Promise<SpecializationProfileRow[]> {
    return db.select().from(specializationProfiles).where(withProjectList(specializationProfiles)).orderBy(specializationProfiles.createdAt);
  }

  async createSpecializationProfile(profile: InsertSpecializationProfile): Promise<SpecializationProfileRow> {
    const [row] = await db.insert(specializationProfiles).values(withProjectInsert(specializationProfiles, {
      name: profile.name,
      isBuiltIn: profile.isBuiltIn ?? false,
      assignments: (profile.assignments ?? {}) as Record<string, string>,
    })).returning();
    return row;
  }

  async deleteSpecializationProfile(id: string): Promise<void> {
    await db.delete(specializationProfiles).where(withProject(specializationProfiles, eq(specializationProfiles.id, id)));
  }

  // ─── Skills ─────────────────────────────────────────────────────────────────

  async getSkills(filter?: { teamId?: string; isBuiltin?: boolean }): Promise<Skill[]> {
    const conditions = [];
    if (filter?.teamId !== undefined) conditions.push(eq(skills.teamId, filter.teamId));
    if (filter?.isBuiltin !== undefined) conditions.push(eq(skills.isBuiltin, filter.isBuiltin));

    return conditions.length > 0
      ? db.select().from(skills).where(withProject(skills, and(...conditions))).orderBy(skills.name)
      : db.select().from(skills).where(withProjectList(skills)).orderBy(skills.name);
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const [row] = await db.select().from(skills).where(withProject(skills, eq(skills.id, id)));
    return row;
  }

  async getSkillIdByName(name: string): Promise<string | null> {
    // withProjectList: the DREAM-4 proposer resolves the link under a SYSTEM context (all
    // projects). A READ only — never a write to the skill registry (§5 boundary).
    const [row] = await db
      .select({ id: skills.id })
      .from(skills)
      .where(withProjectList(skills, eq(skills.name, name)))
      .limit(1);
    return row?.id ?? null;
  }

  async createSkill(data: InsertSkill): Promise<Skill> {
    type SkillInsert = Parameters<typeof db.insert<typeof skills>>[0] extends object ? Parameters<ReturnType<typeof db.insert<typeof skills>>["values"]>[0] : never;
    const [row] = await db.insert(skills).values(withProjectInsert(skills, data as unknown as SkillInsert)).returning();
    return row;
  }

  async updateSkill(id: string, updates: Partial<InsertSkill>): Promise<Skill> {
    const { sharing: rawSharing, ...rest } = updates;
    const setPayload: Parameters<typeof db.update<typeof skills>>[0] extends never ? never : object = {
      ...rest,
      ...(rawSharing !== undefined ? { sharing: rawSharing as "private" | "team" | "public" } : {}),
      updatedAt: new Date(),
    };
    const [row] = await db
      .update(skills)
      .set({ ...(updates as Record<string, unknown>), updatedAt: new Date() } as Parameters<ReturnType<typeof db.update<typeof skills>>["set"]>[0])
      .where(withProject(skills, eq(skills.id, id)))
      .returning();
    if (!row) throw new Error(`Skill not found: ${id}`);
    return row;
  }

  async deleteSkill(id: string): Promise<void> {
    await db.delete(skills).where(withProject(skills, eq(skills.id, id)));
  }

  // ─── Skill Versions (Phase 6.16) ──────────────────────────────────────────

  async getSkillVersions(
    skillId: string,
    limit: number,
    offset: number,
  ): Promise<{ rows: SkillVersionRecord[]; total: number }> {
    const countResult = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(skillVersions)
      .where(withProject(skillVersions, eq(skillVersions.skillId, skillId)));
    const total = countResult[0]?.count ?? 0;

    const rows = await db
      .select()
      .from(skillVersions)
      .where(withProject(skillVersions, eq(skillVersions.skillId, skillId)))
      .orderBy(desc(skillVersions.createdAt))
      .limit(limit)
      .offset(offset);

    return { rows, total };
  }

  async getSkillVersion(
    skillId: string,
    version: string,
  ): Promise<SkillVersionRecord | undefined> {
    const [row] = await db
      .select()
      .from(skillVersions)
      .where(withProject(skillVersions, and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.version, version),
        ),));
    return row;
  }

  async createSkillVersion(data: InsertSkillVersion): Promise<SkillVersionRecord> {
    const [row] = await db
      .insert(skillVersions)
      .values(withProjectInsert(skillVersions, {
        skillId: data.skillId,
        version: data.version,
        config: data.config,
        changelog: data.changelog,
        createdBy: data.createdBy,
      }))
      .returning();
    return row;
  }

  async incrementSkillUsage(id: string): Promise<number> {
    const [row] = await db
      .update(skills)
      .set({
        usageCount: drizzleSql`${skills.usageCount} + 1`,
      })
      .where(withProject(skills, eq(skills.id, id)))
      .returning({ usageCount: skills.usageCount });
    return row?.usageCount ?? 0;
  }


  // ─── Consilium Loops (Phase B — auto-versioned FSM) ───────────────────────

  async createLoop(data: InsertConsiliumLoop): Promise<ConsiliumLoopRow> {
    // H-3: the partial-unique index `consilium_loops_one_active_per_group`
    // rejects a 2nd non-terminal loop on the same group at the DB level — the
    // create route maps the unique-violation to a 409.
    const [row] = await db.insert(consiliumLoops).values(withProjectInsert(consiliumLoops, data)).returning();
    return row;
  }

  async getLoop(id: string): Promise<ConsiliumLoopRow | undefined> {
    const [row] = await db.select().from(consiliumLoops).where(withProject(consiliumLoops, eq(consiliumLoops.id, id)));
    return row;
  }

  async getLoopsByOwner(ownerId: string): Promise<ConsiliumLoopRow[]> {
    return db
      .select()
      .from(consiliumLoops)
      .where(withProject(consiliumLoops, eq(consiliumLoops.createdBy, ownerId)))
      .orderBy(desc(consiliumLoops.createdAt));
  }

  async getLoops(): Promise<ConsiliumLoopRow[]> {
    // consilium_loops has NO project_id column of its own (a loop belongs to a
    // task group). Scope by sub-querying the loop's group through task_groups,
    // which IS project-scoped — so only loops whose group is in the current
    // project are returned. Same runId->pipeline_runs idea as getTraces().
    return db
      .select()
      .from(consiliumLoops)
      .where(
        inArray(
          consiliumLoops.groupId,
          db.select({ id: taskGroups.id }).from(taskGroups).where(withProjectList(taskGroups)),
        ),
      )
      .orderBy(desc(consiliumLoops.createdAt));
  }

  async getActiveLoopByGroup(groupId: string): Promise<ConsiliumLoopRow | undefined> {
    const [row] = await db
      .select()
      .from(consiliumLoops)
      .where(withProject(consiliumLoops, and(
          eq(consiliumLoops.groupId, groupId),
          inArray(
            consiliumLoops.state,
            ["pending", "building_context", "reviewing", "deciding", "developing", "awaiting_merge"],
          ),
        ),))
      .limit(1);
    return row;
  }

  /** Task #52.2: shared project-scoped fetch of TERMINAL-state loops' skill/state
   *  columns only (replaces the mock contour observability aggregates). */
  private async getTerminalLoopStatsRows(): Promise<
    { appliedSkills: ConsiliumLoopRow["appliedSkills"]; state: ConsiliumLoopRow["state"] }[]
  > {
    return db
      .select({ appliedSkills: consiliumLoops.appliedSkills, state: consiliumLoops.state })
      .from(consiliumLoops)
      .where(
        and(
          inArray(
            consiliumLoops.groupId,
            db.select({ id: taskGroups.id }).from(taskGroups).where(withProjectList(taskGroups)),
          ),
          inArray(consiliumLoops.state, [...CONSILIUM_LOOP_TERMINAL_STATES]),
        ),
      );
  }

  async getConsiliumLoopSkillStats(): Promise<ConsiliumLoopSkillStat[]> {
    const rows = await this.getTerminalLoopStatsRows();
    const acc = new Map<string, { appliedCount: number; convergedCount: number }>();
    for (const loop of rows) {
      for (const ref of loop.appliedSkills ?? []) {
        if (ref.dropped) continue; // dropped ⇒ never actually applied
        const entry = acc.get(ref.id) ?? { appliedCount: 0, convergedCount: 0 };
        entry.appliedCount += 1;
        if (loop.state === "converged") entry.convergedCount += 1;
        acc.set(ref.id, entry);
      }
    }
    return Array.from(acc.entries()).map(([skillId, { appliedCount, convergedCount }]) => ({
      skillId,
      appliedCount,
      convergedCount,
      successRate: appliedCount > 0 ? convergedCount / appliedCount : 0,
    }));
  }

  async getConsiliumLoopOutcomeStats(): Promise<ConsiliumLoopOutcomeStats> {
    const rows = await this.getTerminalLoopStatsRows();
    const totalTerminalLoops = rows.length;
    const convergedCount = rows.filter((l) => l.state === "converged").length;
    const escalatedCount = rows.filter((l) => l.state === "escalated").length;
    return {
      totalTerminalLoops,
      convergedRate: totalTerminalLoops > 0 ? convergedCount / totalTerminalLoops : 0,
      escalatedRate: totalTerminalLoops > 0 ? escalatedCount / totalTerminalLoops : 0,
    };
  }

  async updateLoop(
    id: string,
    updates: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt">>,
  ): Promise<ConsiliumLoopRow> {
    const [row] = await db
      .update(consiliumLoops)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(consiliumLoops, eq(consiliumLoops.id, id)))
      .returning();
    if (!row) throw new Error(`ConsiliumLoop ${id} not found`);
    return row;
  }

  async updateLoopArchetypeIfNotOverridden(
    id: string,
    updates: Pick<
      ConsiliumLoopRow,
      "archetype" | "archetypeSource" | "archetypeRationale" | "archetypeParams" | "archetypeDecidedAt"
    >,
  ): Promise<ConsiliumLoopRow | undefined> {
    // Carry-in (b): the WHERE pins id AND archetype_source IS DISTINCT FROM
    // 'override' — NULL (never decided) and 'proposed' both MATCH; only a human
    // 'override' is excluded → 0 rows → undefined (proposal dropped, override kept).
    // IS DISTINCT FROM (not <>) is required so a NULL source still matches. Never
    // touches `state` — writing a column on a terminal loop cannot transition it.
    const [row] = await db
      .update(consiliumLoops)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(consiliumLoops, and(
        eq(consiliumLoops.id, id),
        drizzleSql`${consiliumLoops.archetypeSource} IS DISTINCT FROM 'override'`,
      )))
      .returning();
    return row;
  }

  async casLoopState(
    id: string,
    expected: ConsiliumLoopState,
    next: ConsiliumLoopState,
    extra?: Partial<Omit<ConsiliumLoopRow, "id" | "createdAt" | "state">>,
  ): Promise<ConsiliumLoopRow | undefined> {
    // H-3: atomic compare-and-swap. The WHERE pins BOTH id AND the expected
    // state, so a concurrent tick/instance that already advanced the loop loses
    // the race (0 rows → undefined). This is the FSM's sole mutual exclusion.
    const [row] = await db
      .update(consiliumLoops)
      .set({ ...extra, state: next, updatedAt: new Date() })
      .where(withProject(consiliumLoops, and(eq(consiliumLoops.id, id), eq(consiliumLoops.state, expected))))
      .returning();
    return row;
  }

  async claimRedrive(
    id: string,
    expected: ConsiliumLoopState,
    graceMs: number,
  ): Promise<ConsiliumLoopRow | undefined> {
    // H-3 (re-drive): atomic cross-instance claim. The conditional UPDATE matches
    // ONLY a row still in `expected` state, with its state-specific child ref
    // NULL, that has been stranded past the grace window. It bumps updated_at to
    // now — so a concurrent second instance's `updated_at < threshold` predicate
    // no longer matches → 0 rows → undefined → that instance backs off. Same
    // discipline as casLoopState; the re-drive side effect runs ONLY for the
    // winner. NOTE: read the threshold off the DB row time, but the SET below
    // also reads now() consistently per-statement.
    const threshold = new Date(Date.now() - graceMs);
    const nullRefCond =
      expected === "reviewing"
        ? isNull(consiliumLoops.currentIterationNumber)
        : isNull(consiliumLoops.devGroupId);
    const [row] = await db
      .update(consiliumLoops)
      .set({ updatedAt: new Date() })
      .where(withProject(consiliumLoops, and(
          eq(consiliumLoops.id, id),
          eq(consiliumLoops.state, expected),
          nullRefCond,
          lt(consiliumLoops.updatedAt, threshold),
        ),))
      .returning();
    return row;
  }

  async claimReviewRedrive(
    id: string,
    expectedIterationNumber: number,
    staleThreshold: Date,
  ): Promise<ConsiliumLoopRow | undefined> {
    // Bug #7: atomic cross-instance claim for a STALLED (not crash-null) review.
    // The conditional UPDATE matches ONLY a row still `reviewing`, still on the
    // SAME stale iteration, untouched since `staleThreshold`. It bumps updated_at to
    // now — so a concurrent instance (or a tick that raced a just-advanced review)
    // no longer matches → 0 rows → undefined → back off. Same discipline as
    // casLoopState/claimRedrive; the re-launch side effect runs ONLY for the winner.
    const [row] = await db
      .update(consiliumLoops)
      .set({ updatedAt: new Date() })
      .where(withProject(consiliumLoops, and(
          eq(consiliumLoops.id, id),
          eq(consiliumLoops.state, "reviewing"),
          eq(consiliumLoops.currentIterationNumber, expectedIterationNumber),
          lt(consiliumLoops.updatedAt, staleThreshold),
        ),))
      .returning();
    return row;
  }

  async appendLoopRound(data: InsertConsiliumLoopRound): Promise<ConsiliumLoopRoundRow> {
    const [row] = await db.insert(consiliumLoopRounds).values(withProjectInsert(consiliumLoopRounds, data)).returning();
    return row;
  }

  async getLoopRounds(loopId: string): Promise<ConsiliumLoopRoundRow[]> {
    // consilium_loop_rounds has NO project_id (a round belongs to a loop, which
    // belongs to a task group). Scope through loop → group → task_groups, like
    // getLoops()/getTraces(). In a system context withProjectList returns all.
    return db
      .select()
      .from(consiliumLoopRounds)
      .where(
        and(
          eq(consiliumLoopRounds.loopId, loopId),
          inArray(
            consiliumLoopRounds.loopId,
            db
              .select({ id: consiliumLoops.id })
              .from(consiliumLoops)
              .where(
                inArray(
                  consiliumLoops.groupId,
                  db.select({ id: taskGroups.id }).from(taskGroups).where(withProjectList(taskGroups)),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(consiliumLoopRounds.round));
  }

  async updateLoopRoundTestSummary(loopId: string, round: number, testSummary: string): Promise<void> {
    // Scope by (loop, round). consilium_loop_rounds has no project_id of its own; the
    // loopId is already project-scoped at write time, and round is unique per loop.
    await db
      .update(consiliumLoopRounds)
      .set({ testSummary })
      .where(and(eq(consiliumLoopRounds.loopId, loopId), eq(consiliumLoopRounds.round, round)));
  }

  async updateLoopRoundReport(loopId: string, round: number, report: ResearchReport): Promise<void> {
    // Stage 3: same (loop, round) scoping + out-of-band settle wire as testSummary.
    await db
      .update(consiliumLoopRounds)
      .set({ report })
      .where(and(eq(consiliumLoopRounds.loopId, loopId), eq(consiliumLoopRounds.round, round)));
  }

  async updateLoopRoundExecutionTrace(loopId: string, round: number, trace: ExecutionTrace): Promise<void> {
    // Stage 4: same (loop, round) scoping + out-of-band settle wire as report/testSummary.
    await db
      .update(consiliumLoopRounds)
      .set({ executionTrace: trace })
      .where(and(eq(consiliumLoopRounds.loopId, loopId), eq(consiliumLoopRounds.round, round)));
  }

  async updateLoopRoundActionPoints(loopId: string, round: number, actionPoints: ActionPoint[]): Promise<void> {
    // Stage B: same (loop, round) scoping — persist the planner's per-criterion method
    // assignment onto the additive `verificationMethod` field of each openActionPoint.
    await db
      .update(consiliumLoopRounds)
      .set({ openActionPoints: actionPoints })
      .where(and(eq(consiliumLoopRounds.loopId, loopId), eq(consiliumLoopRounds.round, round)));
  }

  // ─── Experience plane — the "Dream" distillation, WRITE side (DREAM-1) ─────

  async createExperienceItems(items: InsertExperienceItem[]): Promise<ExperienceItemRow[]> {
    if (items.length === 0) return [];
    // The distiller sets each item's projectId EXPLICITLY (the source loop's own), so
    // this insert does NOT stamp the ambient context (it runs cross-project under
    // runAsSystem). ONE insert per loop ⇒ atomic: a re-observe sees "already distilled".
    return db.insert(experienceItems).values(items).returning();
  }

  async getExperienceItemsBySourceLoop(loopId: string): Promise<ExperienceItemRow[]> {
    // withProjectList: system context (the distiller) sees ALL projects' items so the
    // idempotency dedup is global; a project-scoped caller (DREAM-2) sees only its own.
    return db
      .select()
      .from(experienceItems)
      .where(withProjectList(experienceItems, eq(experienceItems.sourceLoopId, loopId)));
  }

  async listExperienceItems(limit = 200): Promise<ExperienceItemRow[]> {
    return db
      .select()
      .from(experienceItems)
      .where(withProjectList(experienceItems))
      .orderBy(desc(experienceItems.createdAt))
      .limit(limit);
  }

  // ─── Experience plane — the "Dream" distillation, CONSOLIDATE side (DREAM-3) ──
  // The scheduled consolidator merges/decays/recomputes items IN PLACE. withProjectList
  // lets the system-context pass (runAsSystem) update/delete across all projects; a
  // project-scoped caller would be confined to its own rows. Writes ONLY this table.

  async updateExperienceItem(
    id: string,
    patch: Partial<ExperienceItemRow>,
  ): Promise<ExperienceItemRow | undefined> {
    // Never let a patch change identity/lineage columns.
    const { id: _i, createdAt: _c, sourceLoopId: _s, projectId: _p, ...safe } = patch;
    if (Object.keys(safe).length === 0) return undefined;
    const [row] = await db
      .update(experienceItems)
      .set(safe)
      .where(withProjectList(experienceItems, eq(experienceItems.id, id)))
      .returning();
    return row;
  }

  async deleteExperienceItems(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await db
      .delete(experienceItems)
      .where(withProjectList(experienceItems, inArray(experienceItems.id, ids)));
  }

  // ─── DREAM-4 — Experience → SKILL.md feedback proposals (§5/§9) ─────────────
  // The proposer writes ONLY here, ALWAYS `status: 'unverified'` (the ADR-0002 envelope
  // entry). It reads experience_items (read-only) + the skill registry; it NEVER mutates a
  // SKILL.md, the `skills` table, experience_items, or the state graph. withProjectList lets
  // the system-context pass insert/read cross-project; a project-scoped caller (the review
  // route) sees only its own. Forward status moves are human/CODEOWNERS decisions.

  async createSkillProposals(items: InsertSkillProposal[]): Promise<SkillProposalRow[]> {
    if (items.length === 0) return [];
    // ON CONFLICT (dedup_key) DO NOTHING — the unique index is the race backstop so a proven
    // pattern yields ONE proposal even if two passes overlap. Returns only inserted rows.
    return db
      .insert(skillProposals)
      .values(items)
      .onConflictDoNothing({ target: skillProposals.dedupKey })
      .returning();
  }

  async listSkillProposals(opts?: {
    status?: SkillProposalStatus;
    limit?: number;
  }): Promise<SkillProposalRow[]> {
    const where = opts?.status
      ? withProjectList(skillProposals, eq(skillProposals.status, opts.status))
      : withProjectList(skillProposals);
    return db
      .select()
      .from(skillProposals)
      .where(where)
      .orderBy(desc(skillProposals.createdAt))
      .limit(opts?.limit ?? 200);
  }

  async listSkillProposalDedupKeys(): Promise<string[]> {
    const rows = await db
      .select({ dedupKey: skillProposals.dedupKey })
      .from(skillProposals)
      .where(withProjectList(skillProposals));
    return rows.map((r) => r.dedupKey);
  }

  async updateSkillProposalStatus(
    id: string,
    status: SkillProposalStatus,
    reviewNote?: string | null,
  ): Promise<SkillProposalRow | undefined> {
    const set: Partial<SkillProposalRow> = { status, updatedAt: new Date() };
    if (reviewNote !== undefined) set.reviewNote = reviewNote;
    const [row] = await db
      .update(skillProposals)
      .set(set)
      .where(withProjectList(skillProposals, eq(skillProposals.id, id)))
      .returning();
    return row;
  }

  // ─── Triggers (Phase 6.3) ─────────────────────────────────────────────────

  async getProjectTriggers(): Promise<TriggerRow[]> {
    // T1: project-scoped list (the ALS project filter only) so pipeline-less,
    // loop-template triggers are returned alongside any legacy pipeline triggers.
    return db.select().from(triggers).where(withProject(triggers)).orderBy(triggers.createdAt);
  }

  async getTrigger(id: string): Promise<TriggerRow | undefined> {
    const [row] = await db.select().from(triggers).where(withProject(triggers, eq(triggers.id, id)));
    return row;
  }

  async getEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return db
      .select()
      .from(triggers)
      .where(withProject(triggers, and(eq(triggers.enabled, true), eq(triggers.type, type as TriggerRow["type"]))));
  }

  /**
   * Cross-project query: returns ALL enabled triggers of this type across every
   * project. Intended for background/system callers (CronScheduler, FileWatcher,
   * GitHub event handler). MUST be called within runAsSystem(). See ADR-001 §3.1(d).
   */
  async getAllEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return unscopedSystemQuery("getAllEnabledTriggersByType", () =>
      db
        .select()
        .from(triggers)
        .where(and(eq(triggers.enabled, true), eq(triggers.type, type as TriggerRow["type"]))),
    );
  }

  async createTrigger(
    data: Omit<TriggerRow, "id" | "projectId" | "createdAt" | "updatedAt" | "lastTriggeredAt" | "suppressedCount" | "lastFiredAt" | "firedCount"> & { secretEncrypted?: string | null },
  ): Promise<TriggerRow> {
    const [row] = await db
      .insert(triggers)
      .values(withProjectInsert(triggers, {
        type: data.type as TriggerRow["type"],
        config: data.config,
        secretEncrypted: data.secretEncrypted ?? null,
        enabled: data.enabled ?? true,
      }))
      .returning();
    return row;
  }

  async updateTrigger(id: string, updates: Partial<TriggerRow>): Promise<TriggerRow> {
    const [row] = await db
      .update(triggers)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(triggers, eq(triggers.id, id)))
      .returning();
    if (!row) throw new Error(`Trigger not found: ${id}`);
    return row;
  }

  async deleteTrigger(id: string): Promise<void> {
    await db.delete(triggers).where(withProject(triggers, eq(triggers.id, id)));
  }

  /**
   * T1 policy rail: atomically bump the suppressed-fire counter. Called from
   * `fireTrigger` (background/system context) when a fire is suppressed by dedup.
   * The `+ 1` is computed in SQL (no read-modify-write race). Scoped like every
   * other trigger write; in the system context `withProject` applies no filter.
   */
  async incrementTriggerSuppressed(id: string): Promise<void> {
    await db
      .update(triggers)
      .set({
        suppressedCount: drizzleSql`${triggers.suppressedCount} + 1`,
        updatedAt: new Date(),
      })
      .where(withProject(triggers, eq(triggers.id, id)));
  }

  /**
   * WRITE-on-fire rail: set `last_fired_at` and atomically bump `fired_count` when a
   * trigger ACTUALLY launches a loop. Called from `launchReviewWithDedup` (via the
   * injected `recordFire` dep) ONLY on the successful-launch branch — never on
   * dedup-suppress (that rides `incrementTriggerSuppressed`). The `+ 1` is computed
   * in SQL (no read-modify-write race between concurrent webhook + poller fires);
   * `firedAt` is the loop's provenance instant, threaded in for determinism. Scoped
   * like every other trigger write; in the system context `withProject` applies no filter.
   */
  async incrementTriggerFired(id: string, firedAt: Date): Promise<void> {
    await db
      .update(triggers)
      .set({
        lastFiredAt: firedAt,
        firedCount: drizzleSql`${triggers.firedCount} + 1`,
        updatedAt: new Date(),
      })
      .where(withProject(triggers, eq(triggers.id, id)));
  }

  // ─── Traces (Phase 6.5) ────────────────────────────────────────────────────

  async createTrace(data: InsertTrace): Promise<TraceRow> {
    const [row] = await db.insert(traces).values(withProjectInsert(traces, data)).returning();
    return row;
  }

  async getTraceByRunId(_runId: string): Promise<TraceRow | null> {
    // traces has no project_id column; its only scoping mechanism was a
    // subquery through pipeline_runs.project_id, which is retired along with
    // the pipelines engine. Returning null (never the unscoped row) avoids a
    // cross-project data leak — see migration 0053 / task #29.
    return null;
  }

  async getTraceByTraceId(traceId: string): Promise<TraceRow | null> {
    const [row] = await db.select().from(traces).where(withProject(traces, eq(traces.traceId, traceId))).limit(1);
    return row ?? null;
  }

  async getTraces(_limit = 50, _offset = 0): Promise<TraceRow[]> {
    // traces has no project_id column; it was scoped by sub-querying through
    // pipeline_runs.project_id, which is retired along with the pipelines
    // engine. Returning [] (never the unscoped rows) avoids a cross-project
    // data leak — see migration 0053 / task #29 (WorkspaceTraces repoint).
    return [];
  }

  async updateTraceSpans(traceId: string, spans: TraceSpan[]): Promise<void> {
    await db.update(traces)
      .set({ spans: spans as TraceRow["spans"], updatedAt: new Date() })
      .where(withProject(traces, eq(traces.traceId, traceId)));
  }

  // ─── Task Groups (Task Orchestrator) ────────────────────────────────────────

  async getTaskGroups(): Promise<TaskGroupRow[]> {
    return db.select().from(taskGroups).where(withProject(taskGroups)).orderBy(desc(taskGroups.createdAt));
  }

  async getTaskGroup(id: string): Promise<TaskGroupRow | undefined> {
    const [row] = await db.select().from(taskGroups).where(withProject(taskGroups, eq(taskGroups.id, id)));
    return row;
  }

  async createTaskGroup(data: InsertTaskGroup): Promise<TaskGroupRow> {
    const [row] = await db.insert(taskGroups).values(withProjectInsert(taskGroups, data as typeof taskGroups.$inferInsert)).returning();
    return row;
  }

  async updateTaskGroup(id: string, updates: Partial<TaskGroupRow>): Promise<TaskGroupRow> {
    const [row] = await db.update(taskGroups).set(updates).where(withProject(taskGroups, eq(taskGroups.id, id))).returning();
    return row;
  }

  async deleteTaskGroup(id: string): Promise<void> {
    await db.delete(taskGroups).where(withProject(taskGroups, eq(taskGroups.id, id)));
  }

  // ─── Tasks (Task Orchestrator) ──────────────────────────────────────────────

  async getTasksByGroup(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(withProject(tasks, eq(tasks.groupId, groupId)))
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
  }

  async getWorkspaceTaskModelUsage(workspaceId: string): Promise<WorkspaceTaskModelUsage[]> {
    const rows = await db
      .select({ taskId: tasks.id, modelSlug: tasks.modelSlug })
      .from(tasks)
      .where(withProject(
        tasks,
        and(eq(tasks.workspaceId, workspaceId), isNotNull(tasks.modelSlug)),
      ));
    return rows
      .filter((r): r is { taskId: string; modelSlug: string } => r.modelSlug !== null)
      .map((r) => ({ taskId: r.taskId, modelSlug: r.modelSlug }));
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    const [row] = await db.select().from(tasks).where(withProject(tasks, eq(tasks.id, id)));
    return row;
  }

  async createTask(data: InsertTask): Promise<TaskRow> {
    const [row] = await db.insert(tasks).values(withProjectInsert(tasks, data as typeof tasks.$inferInsert)).returning();
    return row;
  }

  async updateTask(id: string, updates: Partial<TaskRow>): Promise<TaskRow> {
    const [row] = await db.update(tasks).set(updates).where(withProject(tasks, eq(tasks.id, id))).returning();
    return row;
  }

  async getReadyTasks(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(withProject(tasks, and(eq(tasks.groupId, groupId), eq(tasks.status, "ready"))))
      .orderBy(asc(tasks.sortOrder));
  }

  async getBlockedTasks(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(withProject(tasks, and(eq(tasks.groupId, groupId), eq(tasks.status, "blocked"))))
      .orderBy(asc(tasks.sortOrder));
  }

  async deleteTask(id: string): Promise<void> {
    await db.delete(tasks).where(withProject(tasks, eq(tasks.id, id)));
  }

  async listTaskGroupHistory(query: RunHistoryQuery): Promise<TaskGroupHistoryRow[]> {
    const conditions: SQL[] = [
      inArray(taskGroups.status, ["completed", "failed", "cancelled"]),
    ];
    if (query.ownerId != null) conditions.push(eq(taskGroups.createdBy, query.ownerId));
    if (query.cursor) {
      const c = new Date(query.cursor.completedAt);
      conditions.push(
        or(
          lt(taskGroups.completedAt, c),
          and(eq(taskGroups.completedAt, c), lt(taskGroups.id, query.cursor.id)),
        )!,
      );
    }
    const rows = await db
      .select({
        id: taskGroups.id,
        status: taskGroups.status,
        createdBy: taskGroups.createdBy,
        startedAt: taskGroups.startedAt,
        completedAt: taskGroups.completedAt,
      })
      .from(taskGroups)
      .where(withProject(taskGroups, and(...conditions)))
      .orderBy(desc(taskGroups.completedAt), desc(taskGroups.id))
      .limit(query.limit);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      createdBy: r.createdBy ?? null,
      startedAt: r.startedAt ?? null,
      completedAt: r.completedAt ?? null,
    }));
  }

  // ─── Task Traces (End-to-End Request Observability) ──────────────────────────

  async createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow> {
    const [row] = await db.insert(taskTraces).values(withProjectInsert(taskTraces, data as typeof taskTraces.$inferInsert)).returning();
    return row;
  }

  async getTaskTrace(groupId: string): Promise<TaskTraceRow | null> {
    const [row] = await db.select().from(taskTraces).where(withProject(taskTraces, eq(taskTraces.groupId, groupId)));
    return row ?? null;
  }

  async updateTaskTrace(id: string, updates: Partial<TaskTraceRow>): Promise<TaskTraceRow> {
    const [row] = await db.update(taskTraces)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(taskTraces, eq(taskTraces.id, id)))
      .returning();
    return row;
  }

  // ─── Workspace-scoped task traces (task #29 — WorkspaceTraces repoint) ──────
  // task_groups (and task_traces) have no workspace_id / project_id column —
  // only `tasks.workspace_id` + `tasks.project_id` do. Scope through `tasks`
  // (withProject there is safe — the column exists) and only pass the
  // resulting, already-authorized groupIds into the taskTraces query; do NOT
  // wrap the taskTraces query itself in withProject (that table has no
  // projectId column and withProject() hard-throws on tables missing it).

  async getWorkspaceTaskTraces(workspaceId: string, limit = 50, offset = 0): Promise<TaskTraceRow[]> {
    const groupRows = await db
      .selectDistinct({ groupId: tasks.groupId })
      .from(tasks)
      .where(withProject(tasks, eq(tasks.workspaceId, workspaceId)));
    const groupIds = groupRows.map((r) => r.groupId);
    if (groupIds.length === 0) return [];

    return db
      .select()
      .from(taskTraces)
      .where(inArray(taskTraces.groupId, groupIds))
      .orderBy(desc(taskTraces.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async getWorkspaceTaskTraceByGroupId(workspaceId: string, groupId: string): Promise<TaskTraceRow | null> {
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(withProject(tasks, and(eq(tasks.groupId, groupId), eq(tasks.workspaceId, workspaceId))))
      .limit(1);
    if (!task) return null;

    const [row] = await db
      .select()
      .from(taskTraces)
      .where(eq(taskTraces.groupId, groupId))
      .orderBy(desc(taskTraces.createdAt))
      .limit(1);
    return row ?? null;
  }

  // ─── Tracker Connections (Issue Tracker Integration) ────────────────────────

  /**
   * Decrypt the api_token column for a tracker connection row. Null-safe.
   * [ADR-001 Wave-2] Routes crypto.decrypt() through the credential broker.
   */
  private async decryptTrackerToken(row: typeof trackerConnections.$inferSelect): Promise<TrackerConnectionRow> {
    if (!row.apiToken) {
      return { ...row, apiToken: null };
    }
    // In project context row.projectId should always be set (withProject scoping).
    // Fall back to getProjectId() for legacy null-projectId rows to avoid empty string.
    const projectId = row.projectId ?? getProjectId();
    const plaintext = await credentialProvider.accessSecret({
      ciphertext: row.apiToken,
      credentialId: `trackerConn:${row.id}`,
      projectId,
      purpose: "tracker-api-token-read",
    });
    return { ...row, apiToken: plaintext };
  }

  async getTrackerConnectionsByGroup(taskGroupId: string): Promise<TrackerConnectionRow[]> {
    const rows = await db.select().from(trackerConnections)
      .where(withProject(trackerConnections, eq(trackerConnections.taskGroupId, taskGroupId)));
    return Promise.all(rows.map((r) => this.decryptTrackerToken(r)));
  }

  async getTrackerConnection(id: string): Promise<TrackerConnectionRow | undefined> {
    const [row] = await db.select().from(trackerConnections)
      .where(withProject(trackerConnections, eq(trackerConnections.id, id)));
    return row ? this.decryptTrackerToken(row) : undefined;
  }

  async createTrackerConnection(data: InsertTrackerConnection): Promise<TrackerConnectionRow> {
    // Encrypt the token before persisting; decrypt on the way out so callers always
    // receive plaintext regardless of storage layer.
    const encryptedData = {
      ...data,
      apiToken: data.apiToken ? encrypt(data.apiToken) : (data.apiToken ?? null),
    };
    const [row] = await db.insert(trackerConnections)
      .values(withProjectInsert(trackerConnections, encryptedData as typeof trackerConnections.$inferInsert))
      .returning();
    return this.decryptTrackerToken(row);
  }

  async deleteTrackerConnection(id: string): Promise<void> {
    await db.delete(trackerConnections).where(withProject(trackerConnections, eq(trackerConnections.id, id)));
  }

  // ─── Model Skill Bindings (Phase 6.17) ──────────────────────────────────────

  async getModelSkillBindings(modelId: string): Promise<ModelSkillBinding[]> {
    return db.select().from(modelSkillBindings)
      .where(withProject(modelSkillBindings, eq(modelSkillBindings.modelId, modelId)))
      .orderBy(asc(modelSkillBindings.createdAt));
  }

  async getAllModelSkillBindings(): Promise<ModelSkillBinding[]> {
    return db.select().from(modelSkillBindings)
      .where(withProjectList(modelSkillBindings))
      .orderBy(asc(modelSkillBindings.createdAt));
  }

  async getModelsWithSkillBindings(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ modelId: modelSkillBindings.modelId })
      .from(modelSkillBindings)
      .where(withProjectList(modelSkillBindings))
      .orderBy(asc(modelSkillBindings.modelId));
    return rows.map((r) => r.modelId);
  }

  async createModelSkillBinding(data: InsertModelSkillBinding): Promise<ModelSkillBinding> {
    const [row] = await db.insert(modelSkillBindings)
      .values(withProjectInsert(modelSkillBindings, data as typeof modelSkillBindings.$inferInsert))
      .returning();
    return row;
  }

  async deleteModelSkillBinding(modelId: string, skillId: string): Promise<void> {
    const result = await db.delete(modelSkillBindings)
      .where(withProject(modelSkillBindings, and(
          eq(modelSkillBindings.modelId, modelId),
          eq(modelSkillBindings.skillId, skillId),
        ),))
      .returning();
    if (result.length === 0) {
      throw new Error(`Binding not found for model ${modelId} skill ${skillId}`);
    }
  }

  async resolveSkillsForModel(modelId: string): Promise<Skill[]> {
    const rows = await db
      .select({ skill: skills })
      .from(modelSkillBindings)
      .innerJoin(skills, eq(modelSkillBindings.skillId, skills.id))
      .where(withProject(modelSkillBindings, eq(modelSkillBindings.modelId, modelId)))
      .orderBy(asc(modelSkillBindings.createdAt));
    return rows.map((r) => r.skill);
  }


  // ─── ArgoCD Config ────────────────────────────────────────────────────────
  // ADR-001 PR-0c [R3-SEC-5]: converted from id=1 singleton to per-project rows.
  // All three functions use withProject(argoCdConfig) for project-scoped access.
  // They will throw without a project context (same as all other scoped tables);
  // this is intentional — enforce as soon as requireProject is wired (PR-0b).

  async getArgoCdConfig(): Promise<ArgoCdConfigRow | null> {
    const [row] = await db.select().from(argoCdConfig).where(withProject(argoCdConfig));
    return row ?? null;
  }

  async saveArgoCdConfig(config: Partial<InsertArgoCdConfig>): Promise<ArgoCdConfigRow> {
    const now = new Date();
    const existing = await this.getArgoCdConfig();

    if (existing) {
      // Update existing row for the current project
      const updates: Record<string, unknown> = { updatedAt: now };
      if (config.serverUrl !== undefined) updates.serverUrl = config.serverUrl;
      if (config.tokenEnc !== undefined) updates.tokenEnc = config.tokenEnc;
      if (config.verifySsl !== undefined) updates.verifySsl = config.verifySsl;
      if (config.enabled !== undefined) updates.enabled = config.enabled;
      if (config.mcpServerId !== undefined) updates.mcpServerId = config.mcpServerId;
      if ((config as Record<string, unknown>).healthStatus !== undefined) updates.healthStatus = (config as Record<string, unknown>).healthStatus;
      if ((config as Record<string, unknown>).healthError !== undefined) updates.healthError = (config as Record<string, unknown>).healthError;
      if ((config as Record<string, unknown>).lastHealthCheckAt !== undefined) updates.lastHealthCheckAt = (config as Record<string, unknown>).lastHealthCheckAt;

      const [row] = await db
        .update(argoCdConfig)
        .set(updates)
        .where(withProject(argoCdConfig, eq(argoCdConfig.id, existing.id)))
        .returning();
      return row;
    } else {
      // Insert new row; withProjectInsert injects projectId from ALS context
      const [row] = await db
        .insert(argoCdConfig)
        .values(withProjectInsert(argoCdConfig, {
          serverUrl: config.serverUrl ?? null,
          tokenEnc: config.tokenEnc ?? null,
          verifySsl: config.verifySsl ?? true,
          enabled: config.enabled ?? false,
          mcpServerId: config.mcpServerId ?? null,
          healthStatus: ((config as Record<string, unknown>).healthStatus as string) ?? "unknown",
          healthError: ((config as Record<string, unknown>).healthError as string) ?? null,
          updatedAt: now,
        } as typeof argoCdConfig.$inferInsert))
        .returning();
      return row;
    }
  }

  async deleteArgoCdConfig(): Promise<void> {
    await db.delete(argoCdConfig).where(withProject(argoCdConfig));
  }

  // ─── Workspaces ───────────────────────────────────────────────────────────

  async getWorkspaces(): Promise<WorkspaceRow[]> {
    return db.select().from(workspaces)
      .where(withProject(workspaces))
      .orderBy(asc(workspaces.createdAt));
  }

  async getWorkspace(id: string): Promise<WorkspaceRow | null> {
    const [row] = await db.select().from(workspaces).where(withProject(workspaces, eq(workspaces.id, id)));
    return row ?? null;
  }

  async createWorkspace(data: InsertWorkspace & { id?: string }): Promise<WorkspaceRow> {
    const [row] = await db
      .insert(workspaces)
      .values(withProjectInsert(workspaces, data as typeof workspaces.$inferInsert))
      .returning();
    return row;
  }

  async updateWorkspace(id: string, updates: Partial<WorkspaceRow>): Promise<WorkspaceRow> {
    const [row] = await db
      .update(workspaces)
      .set(updates)
      .where(withProject(workspaces, eq(workspaces.id, id)))
      .returning();
    if (!row) throw new Error(`Workspace not found: ${id}`);
    return row;
  }

  async deleteWorkspace(id: string): Promise<void> {
    await db.delete(workspaces).where(withProject(workspaces, eq(workspaces.id, id)));
  }

  // ─── Shared Sessions (Federation, issue #224) ─────────────────────────────

  private rowToSharedSession(row: SharedSessionRow): SharedSession {
    const r = row as Record<string, unknown>;
    const role = (r.role as string) ?? "collaborator";
    const rawStages = r.allowedStages;
    return {
      id: row.id,
      runId: row.runId,
      shareToken: row.shareToken,
      ownerInstanceId: row.ownerInstanceId,
      createdBy: row.createdBy,
      expiresAt: row.expiresAt ?? null,
      isActive: row.isActive,
      createdAt: row.createdAt,
      permissions: {
        role: role as ShareRole,
        allowedStages: Array.isArray(rawStages) ? rawStages as string[] : null,
        canChat: (r.canChat as boolean) ?? true,
        canVote: (r.canVote as boolean) ?? true,
        canViewMemories: (r.canViewMemories as boolean) ?? true,
      },
    };
  }

  async getSharedSession(id: string): Promise<SharedSession | null> {
    const [row] = await db.select().from(sharedSessions).where(withProject(sharedSessions, eq(sharedSessions.id, id)));
    return row ? this.rowToSharedSession(row) : null;
  }

  async getSharedSessionByToken(token: string): Promise<SharedSession | null> {
    const [row] = await db.select().from(sharedSessions).where(withProject(sharedSessions, eq(sharedSessions.shareToken, token)));
    return row ? this.rowToSharedSession(row) : null;
  }

  async getSharedSessionsByRunId(runId: string): Promise<SharedSession[]> {
    const rows = await db
      .select()
      .from(sharedSessions)
      .where(withProject(sharedSessions, and(eq(sharedSessions.runId, runId), eq(sharedSessions.isActive, true))));
    return rows.map((r) => this.rowToSharedSession(r));
  }

  async createSharedSession(input: CreateSharedSessionInput): Promise<SharedSession> {
    const [row] = await db
      .insert(sharedSessions)
      .values(withProjectInsert(sharedSessions, {
        runId: input.runId,
        shareToken: input.shareToken,
        ownerInstanceId: input.ownerInstanceId,
        createdBy: input.createdBy,
        expiresAt: input.expiresAt ?? null,
        role: input.role ?? "collaborator",
        allowedStages: input.allowedStages ?? null,
        canChat: input.canChat ?? (input.role !== "viewer"),
        canVote: input.canVote ?? (input.role !== "viewer"),
        canViewMemories: input.canViewMemories ?? true,
      } as typeof sharedSessions.$inferInsert))
      .returning();
    return this.rowToSharedSession(row);
  }

  async deactivateSharedSession(id: string): Promise<void> {
    await db
      .update(sharedSessions)
      .set({ isActive: false })
      .where(withProject(sharedSessions, eq(sharedSessions.id, id)));
  }

  async listActiveSharedSessions(): Promise<SharedSession[]> {
    const rows = await db
      .select()
      .from(sharedSessions)
      .where(withProject(sharedSessions, eq(sharedSessions.isActive, true)))
      .orderBy(desc(sharedSessions.createdAt));
    const now = new Date();
    return rows
      .filter((r) => !r.expiresAt || r.expiresAt > now)
      .map((r) => this.rowToSharedSession(r));
  }
  async updateSessionPermissions(
    id: string,
    permissions: { role?: string; allowedStages?: string[] | null; canChat?: boolean; canVote?: boolean; canViewMemories?: boolean },
  ): Promise<SharedSession | null> {
    const updates: Record<string, unknown> = {};
    if (permissions.role !== undefined) updates.role = permissions.role;
    if (permissions.allowedStages !== undefined) updates.allowedStages = permissions.allowedStages;
    if (permissions.canChat !== undefined) updates.canChat = permissions.canChat;
    if (permissions.canVote !== undefined) updates.canVote = permissions.canVote;
    if (permissions.canViewMemories !== undefined) updates.canViewMemories = permissions.canViewMemories;

    if (Object.keys(updates).length === 0) {
      return this.getSharedSession(id);
    }

    const [row] = await db
      .update(sharedSessions)
      .set(updates)
      .where(withProject(sharedSessions, eq(sharedSessions.id, id)))
      .returning();
    return row ? this.rowToSharedSession(row) : null;
  }

  // ─── Workspace Connections (issue #266) ──────────────────────────────────

  /** Convert a DB row to the public WorkspaceConnection shape (no secrets). */
  private rowToWorkspaceConnection(row: WorkspaceConnectionRow): WorkspaceConnection {
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      type: row.type as WorkspaceConnection["type"],
      name: row.name,
      config: (row.configJson ?? {}) as Record<string, unknown>,
      hasSecrets: row.secretsEncrypted !== null,
      status: row.status as WorkspaceConnection["status"],
      lastTestedAt: row.lastTestedAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      createdBy: row.createdBy,
    };
  }

  async getWorkspaceConnections(workspaceId: string): Promise<WorkspaceConnection[]> {
    const rows = await db
      .select()
      .from(workspaceConnections)
      .where(withProject(workspaceConnections, eq(workspaceConnections.workspaceId, workspaceId)))
      .orderBy(asc(workspaceConnections.createdAt));
    return rows.map((r) => this.rowToWorkspaceConnection(r));
  }

  async getWorkspaceConnection(id: string): Promise<WorkspaceConnection | null> {
    const [row] = await db
      .select()
      .from(workspaceConnections)
      .where(withProject(workspaceConnections, eq(workspaceConnections.id, id)));
    return row ? this.rowToWorkspaceConnection(row) : null;
  }

  async createWorkspaceConnection(input: CreateWorkspaceConnectionInput): Promise<WorkspaceConnection> {
    const secretsEncrypted = input.secrets && Object.keys(input.secrets).length > 0
      ? encrypt(JSON.stringify(input.secrets))
      : null;

    const [row] = await db
      .insert(workspaceConnections)
      .values(withProjectInsert(workspaceConnections, {
        workspaceId: input.workspaceId,
        type: input.type,
        name: input.name,
        configJson: input.config,
        secretsEncrypted,
        status: "active",
        createdBy: input.createdBy ?? null,
      } as typeof workspaceConnections.$inferInsert))
      .returning();
    return this.rowToWorkspaceConnection(row);
  }

  async updateWorkspaceConnection(
    id: string,
    updates: UpdateWorkspaceConnectionInput,
  ): Promise<WorkspaceConnection> {
    const patch: Record<string, unknown> = { updatedAt: new Date() };

    if (updates.name !== undefined) patch.name = updates.name;
    if (updates.config !== undefined) patch.configJson = updates.config;
    if (updates.status !== undefined) patch.status = updates.status;
    if (updates.lastTestedAt !== undefined) patch.lastTestedAt = updates.lastTestedAt;

    if (updates.secrets !== undefined) {
      if (updates.secrets === null) {
        patch.secretsEncrypted = null;
      } else if (Object.keys(updates.secrets).length > 0) {
        patch.secretsEncrypted = encrypt(JSON.stringify(updates.secrets));
      }
    }

    const [row] = await db
      .update(workspaceConnections)
      .set(patch)
      .where(withProject(workspaceConnections, eq(workspaceConnections.id, id)))
      .returning();

    if (!row) throw new Error(`WorkspaceConnection not found: ${id}`);
    return this.rowToWorkspaceConnection(row);
  }

  async deleteWorkspaceConnection(id: string): Promise<void> {
    await db.delete(workspaceConnections).where(withProject(workspaceConnections, eq(workspaceConnections.id, id)));
  }

  async testWorkspaceConnection(id: string): Promise<WorkspaceConnection> {
    // Marks last_tested_at; actual connectivity test is caller's responsibility.
    return this.updateWorkspaceConnection(id, { lastTestedAt: new Date() });
  }

  // ─── MCP Tool Call Audit Log (issue #271) ────────────────────────────────

  async recordMcpToolCall(input: RecordMcpToolCallInput): Promise<McpToolCall> {
    const [row] = await db
      .insert(mcpToolCalls)
      .values(withProjectInsert(mcpToolCalls, {
        runId: input.runId ?? null,
        stageId: input.stageId ?? null,
        connectionId: input.connectionId,
        toolName: input.toolName,
        argsJson: input.argsJson,
        resultJson: input.resultJson ?? null,
        error: input.error ?? null,
        durationMs: input.durationMs,
        startedAt: input.startedAt ?? new Date(),
      } as typeof mcpToolCalls.$inferInsert))
      .returning();
    return this.rowToMcpToolCall(row);
  }

  async getMcpToolCallsByConnection(
    connectionId: string,
    fromDate: Date,
    toDate: Date,
    limit = 10_000,
  ): Promise<McpToolCall[]> {
    const rows = await db
      .select()
      .from(mcpToolCalls)
      .where(withProject(mcpToolCalls, and(
          eq(mcpToolCalls.connectionId, connectionId),
          gte(mcpToolCalls.startedAt, fromDate),
          lte(mcpToolCalls.startedAt, toDate),
        ),))
      .orderBy(asc(mcpToolCalls.startedAt))
      .limit(limit);
    return rows.map((r) => this.rowToMcpToolCall(r));
  }

  async getConnectionUsageMetrics(connectionId: string): Promise<ConnectionUsageMetrics> {
    const now = new Date();
    const d30 = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d7 = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const all30 = await this.getMcpToolCallsByConnection(connectionId, d30, now);
    const all7 = all30.filter((r) => r.startedAt >= d7);

    // Calls per day (30d)
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

    // Error rate (7d)
    const errorRate7d =
      all7.length === 0 ? 0 : all7.filter((r) => r.error !== null).length / all7.length;

    // P95 latency (30d)
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

  private rowToMcpToolCall(row: McpToolCallRow): McpToolCall {
    return {
      id: row.id,
      runId: row.runId ?? null,
      stageId: row.stageId ?? null,
      connectionId: row.connectionId,
      toolName: row.toolName,
      argsJson: (row.argsJson ?? {}) as Record<string, unknown>,
      resultJson: row.resultJson ?? null,
      error: row.error ?? null,
      durationMs: row.durationMs,
      startedAt: row.startedAt,
    };
  }

  // ── Cost Ledger + Budgets (issue #279) ──────────────────────────────────────

  async appendCostLedger(input: InsertCostLedger): Promise<CostLedgerRow> {
    const [row] = await db
      .insert(costLedger)
      .values(withProjectInsert(costLedger, {
        workspaceId: input.workspaceId,
        provider: input.provider,
        model: input.model,
        runId: input.runId ?? null,
        stageId: input.stageId ?? null,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        costUsd: input.costUsd ?? 0,
      } as typeof costLedger.$inferInsert))
      .returning();
    return row;
  }

  async getCostLedgerRows(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
    limit?: number;
  }): Promise<CostLedgerRow[]> {
    const conditions = [
      eq(costLedger.workspaceId, params.workspaceId),
      gte(costLedger.ts, params.from),
      lte(costLedger.ts, params.to),
    ];
    if (params.provider !== undefined) {
      conditions.push(eq(costLedger.provider, params.provider));
    }

    const q = db
      .select()
      .from(costLedger)
      .where(withProject(costLedger, and(...conditions)))
      .orderBy(asc(costLedger.ts));

    if (params.limit !== undefined) {
      return q.limit(params.limit);
    }
    return q;
  }

  async getCostLedgerSum(params: {
    workspaceId: string;
    provider?: string;
    from: Date;
    to: Date;
  }): Promise<number> {
    const conditions = [
      eq(costLedger.workspaceId, params.workspaceId),
      gte(costLedger.ts, params.from),
      lte(costLedger.ts, params.to),
    ];
    if (params.provider !== undefined) {
      conditions.push(eq(costLedger.provider, params.provider));
    }

    const [result] = await db
      .select({ total: drizzleSql<number>`COALESCE(SUM(${costLedger.costUsd}), 0)` })
      .from(costLedger)
      .where(withProject(costLedger, and(...conditions)));

    return result?.total ?? 0;
  }

  async getBudgetsByWorkspace(workspaceId: string): Promise<BudgetRow[]> {
    return db
      .select()
      .from(budgets)
      .where(withProject(budgets, eq(budgets.workspaceId, workspaceId)))
      .orderBy(asc(budgets.createdAt));
  }

  async getBudget(id: string): Promise<BudgetRow | null> {
    const [row] = await db.select().from(budgets).where(withProject(budgets, eq(budgets.id, id)));
    return row ?? null;
  }

  async createBudget(input: InsertBudget): Promise<BudgetRow> {
    const [row] = await db
      .insert(budgets)
      .values(withProjectInsert(budgets, {
        workspaceId: input.workspaceId,
        provider: input.provider ?? null,
        period: input.period ?? "month",
        limitUsd: input.limitUsd,
        hard: input.hard ?? false,
        notifyAtPct: input.notifyAtPct ?? [],
      } as typeof budgets.$inferInsert))
      .returning();
    return row;
  }

  async updateBudget(id: string, updates: UpdateBudget): Promise<BudgetRow> {
    const [row] = await db
      .update(budgets)
      .set({ ...updates, updatedAt: new Date() } as Partial<typeof budgets.$inferInsert>)
      .where(withProject(budgets, eq(budgets.id, id)))
      .returning();
    if (!row) throw new Error(`Budget ${id} not found`);
    return row;
  }

  async deleteBudget(id: string): Promise<void> {
    await db.delete(budgets).where(withProject(budgets, eq(budgets.id, id)));
  }

  async getWorkspaceSettings(workspaceId: string): Promise<Record<string, unknown> | null> {
    const rows = await db
      .select()
      .from(workspaceSettings)
      .where(withProject(workspaceSettings, eq(workspaceSettings.workspaceId, workspaceId)));
    if (rows.length === 0) return null;
    // Merge all key-value rows into a single object
    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  }

  async upsertWorkspaceSettings(workspaceId: string, patch: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(patch)) {
      await db
        .insert(workspaceSettings)
        .values(withProjectInsert(workspaceSettings, { workspaceId, key, value: value as Record<string, unknown>, updatedAt: new Date() }))
        .onConflictDoUpdate({
          target: [workspaceSettings.workspaceId, workspaceSettings.key],
          set: { value: value as Record<string, unknown>, updatedAt: new Date() },
        });
    }
  }

  // ── Conflict Resolution (issue #229) ──────────────────────────────────────

  private rowToSessionConflict(row: SessionConflictRow): SessionConflict {
    return {
      id: row.id,
      sessionId: row.sessionId,
      raisedBy: row.raisedBy,
      raisedByInstance: row.raisedByInstance,
      question: row.question,
      context: row.context ?? undefined,
      strategy: row.strategy as SessionConflict["strategy"],
      status: row.status as SessionConflict["status"],
      proposals: (row.proposals as SessionConflict["proposals"]) ?? [],
      votes: (row.votes as SessionConflict["votes"]) ?? [],
      quorumThreshold: row.quorumThreshold,
      timeoutMs: row.timeoutMs,
      judgement: row.judgement as SessionConflict["judgement"] ?? undefined,
      experimentResults: row.experimentResults as SessionConflict["experimentResults"] ?? undefined,
      outcome: row.outcome as SessionConflict["outcome"] ?? undefined,
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    };
  }

  private rowToDecisionLogEntry(row: DecisionLogRow): DecisionLogEntry {
    return {
      id: row.id,
      sessionId: row.sessionId,
      conflictId: row.conflictId,
      question: row.question,
      strategy: row.strategy as DecisionLogEntry["strategy"],
      outcome: row.outcome as DecisionLogEntry["outcome"],
      participantCount: row.participantCount,
      proposalCount: row.proposalCount,
      durationMs: row.durationMs,
      recordedAt: row.recordedAt.getTime(),
    };
  }

  async saveConflict(conflict: SessionConflict): Promise<void> {
    await db
      .insert(sessionConflicts)
      .values(withProjectInsert(sessionConflicts, {
        id: conflict.id,
        sessionId: conflict.sessionId,
        raisedBy: conflict.raisedBy,
        raisedByInstance: conflict.raisedByInstance,
        question: conflict.question,
        context: conflict.context ?? null,
        strategy: conflict.strategy,
        status: conflict.status,
        proposals: conflict.proposals as unknown as typeof sessionConflicts.$inferInsert["proposals"],
        votes: conflict.votes as unknown as typeof sessionConflicts.$inferInsert["votes"],
        quorumThreshold: conflict.quorumThreshold,
        timeoutMs: conflict.timeoutMs,
        judgement: conflict.judgement as unknown as typeof sessionConflicts.$inferInsert["judgement"] ?? null,
        experimentResults: conflict.experimentResults as unknown as typeof sessionConflicts.$inferInsert["experimentResults"] ?? null,
        outcome: conflict.outcome as unknown as typeof sessionConflicts.$inferInsert["outcome"] ?? null,
        createdAt: new Date(conflict.createdAt),
        updatedAt: new Date(conflict.updatedAt),
      } as typeof sessionConflicts.$inferInsert))
      .onConflictDoUpdate({
        target: sessionConflicts.id,
        set: {
          status: conflict.status,
          proposals: conflict.proposals as unknown as typeof sessionConflicts.$inferInsert["proposals"],
          votes: conflict.votes as unknown as typeof sessionConflicts.$inferInsert["votes"],
          judgement: conflict.judgement as unknown as typeof sessionConflicts.$inferInsert["judgement"] ?? null,
          experimentResults: conflict.experimentResults as unknown as typeof sessionConflicts.$inferInsert["experimentResults"] ?? null,
          outcome: conflict.outcome as unknown as typeof sessionConflicts.$inferInsert["outcome"] ?? null,
          updatedAt: new Date(conflict.updatedAt),
        },
      });
  }

  async getConflict(conflictId: string): Promise<SessionConflict | null> {
    const [row] = await db
      .select()
      .from(sessionConflicts)
      .where(withProject(sessionConflicts, eq(sessionConflicts.id, conflictId)));
    return row ? this.rowToSessionConflict(row) : null;
  }

  async getSessionConflicts(sessionId: string): Promise<SessionConflict[]> {
    const rows = await db
      .select()
      .from(sessionConflicts)
      .where(withProject(sessionConflicts, eq(sessionConflicts.sessionId, sessionId)))
      .orderBy(desc(sessionConflicts.createdAt));
    return rows.map((r) => this.rowToSessionConflict(r));
  }

  async appendDecisionLog(entry: DecisionLogEntry): Promise<void> {
    await db.insert(decisionLog).values(withProjectInsert(decisionLog, {
      id: entry.id,
      sessionId: entry.sessionId,
      conflictId: entry.conflictId,
      question: entry.question,
      strategy: entry.strategy,
      outcome: entry.outcome as unknown as typeof decisionLog.$inferInsert["outcome"],
      participantCount: entry.participantCount,
      proposalCount: entry.proposalCount,
      durationMs: entry.durationMs,
      recordedAt: new Date(entry.recordedAt),
    } as typeof decisionLog.$inferInsert));
  }

  async getDecisionLog(sessionId?: string): Promise<DecisionLogEntry[]> {
    const query = db
      .select()
      .from(decisionLog)
      .orderBy(desc(decisionLog.recordedAt));

    const rows = sessionId
      ? await query.where(withProject(decisionLog, eq(decisionLog.sessionId, sessionId)))
      : await query;

    return rows.map((r) => this.rowToDecisionLogEntry(r));
  }

  // ─── Practice Cards (Active Knowledge Base) ───────────────────────────────

  async createPracticeCard(data: InsertPracticeCard): Promise<PracticeCardRow> {
    // Idempotent: ON CONFLICT (workspace_id, content_hash) DO NOTHING.
    const [inserted] = await db
      .insert(practiceCards)
      .values(withProjectInsert(practiceCards, data as typeof practiceCards.$inferInsert))
      .onConflictDoNothing({ target: [practiceCards.workspaceId, practiceCards.contentHash] })
      .returning();
    if (inserted) return inserted;
    // Conflict occurred — return the existing row for this content hash.
    const [existing] = await db
      .select()
      .from(practiceCards)
      .where(withProject(practiceCards, and(
          eq(practiceCards.workspaceId, data.workspaceId),
          eq(practiceCards.contentHash, data.contentHash),
        ),));
    return existing;
  }

  async getPracticeCard(id: string): Promise<PracticeCardRow | null> {
    const [row] = await db.select().from(practiceCards).where(withProject(practiceCards, eq(practiceCards.id, id)));
    return row ?? null;
  }

  async listPracticeCards(
    workspaceId: string,
    filters: PracticeCardFilters = {},
  ): Promise<{ cards: PracticeCardRow[]; total: number }> {
    const conditions = [eq(practiceCards.workspaceId, workspaceId)];
    if (filters.status) {
      conditions.push(eq(practiceCards.status, filters.status as PracticeCardStatus));
    }
    if (filters.reviewState) {
      conditions.push(eq(practiceCards.reviewState, filters.reviewState as PracticeCardReviewState));
    }
    if (filters.topic) {
      conditions.push(eq(practiceCards.topic, filters.topic));
    }
    const where = and(...conditions);

    const [{ count }] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(practiceCards)
      .where(withProject(practiceCards, where));

    const cards = await db
      .select()
      .from(practiceCards)
      .where(withProject(practiceCards, where))
      .orderBy(desc(practiceCards.createdAt))
      .limit(filters.limit ?? 50)
      .offset(filters.offset ?? 0);

    return { cards, total: count ?? 0 };
  }

  async getPracticeCardsByWorkspace(workspaceId: string): Promise<PracticeCardRow[]> {
    return db.select().from(practiceCards).where(withProject(practiceCards, eq(practiceCards.workspaceId, workspaceId)));
  }

  async updatePracticeCardState(
    id: string,
    updates: Partial<PracticeCardRow>,
  ): Promise<PracticeCardRow> {
    const { id: _ignore, createdAt: _c, ...rest } = updates;
    const [row] = await db
      .update(practiceCards)
      .set({ ...rest, updatedAt: new Date() } as Partial<typeof practiceCards.$inferInsert>)
      .where(withProject(practiceCards, eq(practiceCards.id, id)))
      .returning();
    if (!row) throw new Error(`Practice card not found: ${id}`);
    return row;
  }

  async createRefreshRun(
    workspaceId: string,
    topic: string,
    trigger: string,
  ): Promise<PracticeCardRefreshRunRow> {
    const [row] = await db
      .insert(practiceCardRefreshRuns)
      .values(withProjectInsert(practiceCardRefreshRuns, { workspaceId, topic, trigger, status: "running", report: {} }))
      .returning();
    return row;
  }

  async getRefreshRun(id: string): Promise<PracticeCardRefreshRunRow | null> {
    const [row] = await db
      .select()
      .from(practiceCardRefreshRuns)
      .where(withProject(practiceCardRefreshRuns, eq(practiceCardRefreshRuns.id, id)));
    return row ?? null;
  }

  async updateRefreshRun(
    id: string,
    updates: Partial<PracticeCardRefreshRunRow>,
  ): Promise<PracticeCardRefreshRunRow> {
    const { id: _ignore, ...rest } = updates;
    const [row] = await db
      .update(practiceCardRefreshRuns)
      .set(rest as Partial<typeof practiceCardRefreshRuns.$inferInsert>)
      .where(withProject(practiceCardRefreshRuns, eq(practiceCardRefreshRuns.id, id)))
      .returning();
    if (!row) throw new Error(`Refresh run not found: ${id}`);
    return row;
  }

  // ─── Task Groups v2 — iterations / executions / templates (BE2) ─────────────

  async createIteration(data: InsertTaskGroupIteration): Promise<TaskGroupIterationRow> {
    // UNIQUE(group_id, iteration_number) is the race backstop: insert-or-detect.
    const [row] = await db
      .insert(taskGroupIterations)
      .values(withProjectInsert(taskGroupIterations, data as typeof taskGroupIterations.$inferInsert))
      .onConflictDoNothing({
        target: [taskGroupIterations.groupId, taskGroupIterations.iterationNumber],
      })
      .returning();
    if (!row) throw new IterationConflictError(data.groupId, data.iterationNumber);
    return row;
  }

  async getIterations(groupId: string, query: IterationListQuery): Promise<TaskGroupIterationRow[]> {
    const limit = Math.min(query.limit, TASK_GROUP_V2_MAX_LIMIT);
    const conditions: SQL[] = [eq(taskGroupIterations.groupId, groupId)];
    if (query.cursor) {
      conditions.push(lt(taskGroupIterations.iterationNumber, query.cursor.iterationNumber));
    }
    return db
      .select()
      .from(taskGroupIterations)
      .where(withProject(taskGroupIterations, and(...conditions)))
      .orderBy(desc(taskGroupIterations.iterationNumber))
      .limit(limit);
  }

  async getIteration(groupId: string, iterationNumber: number): Promise<TaskGroupIterationRow | undefined> {
    const [row] = await db
      .select()
      .from(taskGroupIterations)
      .where(withProject(taskGroupIterations, and(
          eq(taskGroupIterations.groupId, groupId),
          eq(taskGroupIterations.iterationNumber, iterationNumber),
        ),));
    return row;
  }

  async getLatestIteration(groupId: string): Promise<TaskGroupIterationRow | undefined> {
    const [row] = await db
      .select()
      .from(taskGroupIterations)
      .where(withProject(taskGroupIterations, eq(taskGroupIterations.groupId, groupId)))
      .orderBy(desc(taskGroupIterations.iterationNumber))
      .limit(1);
    return row;
  }

  async updateIteration(id: string, updates: Partial<TaskGroupIterationRow>): Promise<TaskGroupIterationRow> {
    const [row] = await db
      .update(taskGroupIterations)
      .set(updates)
      .where(withProject(taskGroupIterations, eq(taskGroupIterations.id, id)))
      .returning();
    return row;
  }

  async createIterationWithExecutions(
    groupId: string,
    start: IterationStartInput,
    seeds: IterationExecutionSeed[],
  ): Promise<{ iteration: TaskGroupIterationRow; executions: TaskExecutionRow[] }> {
    // SF-1: iteration + all executions commit atomically or roll back together.
    return db.transaction(async (tx) => {
      const [iteration] = await tx
        .insert(taskGroupIterations)
        .values(withProjectInsert(taskGroupIterations, {
          groupId,
          iterationNumber: start.iterationNumber,
          status: "running",
          input: start.input,
          triggeredBy: start.triggeredBy ?? null,
          traceId: start.traceId ?? null,
          startedAt: new Date(),
        }))
        .onConflictDoNothing({
          target: [taskGroupIterations.groupId, taskGroupIterations.iterationNumber],
        })
        .returning();
      if (!iteration) throw new IterationConflictError(groupId, start.iterationNumber);
      if (seeds.length === 0) return { iteration, executions: [] };
      const executions = await tx
        .insert(taskExecutions)
        .values(withProjectInsert(taskExecutions, seeds.map((seed) => ({
            iterationId: iteration.id,
            taskId: seed.taskId,
            taskName: seed.taskName,
            groupId,
            status: seed.status,
            modelSlug: seed.modelSlug ?? null,
          })),))
        .returning();
      return { iteration, executions };
    });
  }

  async createExecution(data: InsertTaskExecution): Promise<TaskExecutionRow> {
    const [row] = await db
      .insert(taskExecutions)
      .values(withProjectInsert(taskExecutions, data as typeof taskExecutions.$inferInsert))
      .returning();
    return row;
  }

  async getExecutionsByIteration(groupId: string, iterationId: string): Promise<TaskExecutionRow[]> {
    // MF-1: group is a mandatory scope key in the WHERE — never a bare child id.
    return db
      .select()
      .from(taskExecutions)
      .where(withProject(taskExecutions, and(
          eq(taskExecutions.iterationId, iterationId),
          eq(taskExecutions.groupId, groupId),
        ),))
      .orderBy(asc(taskExecutions.createdAt));
  }

  async getExecution(groupId: string, executionId: string): Promise<TaskExecutionRow | undefined> {
    // MF-1: filter by group in SQL so a cross-group id resolves to "not found".
    const [row] = await db
      .select()
      .from(taskExecutions)
      .where(withProject(taskExecutions, and(
          eq(taskExecutions.id, executionId),
          eq(taskExecutions.groupId, groupId),
        ),));
    return row;
  }

  async updateExecution(id: string, updates: Partial<TaskExecutionRow>): Promise<TaskExecutionRow> {
    const [row] = await db
      .update(taskExecutions)
      .set(updates)
      .where(withProject(taskExecutions, eq(taskExecutions.id, id)))
      .returning();
    return row;
  }

  async getVirtualIteration(groupId: string): Promise<VirtualIteration | null> {
    const group = await this.getTaskGroup(groupId);
    if (!group) return null;
    // Only synthesize when there are NO real iterations (MF-5 / §8 lazy adapter).
    const [existing] = await db
      .select({ id: taskGroupIterations.id })
      .from(taskGroupIterations)
      .where(withProject(taskGroupIterations, eq(taskGroupIterations.groupId, groupId)))
      .limit(1);
    if (existing) return null;
    const groupTasks = await this.getTasksByGroup(groupId);
    return buildVirtualIteration(group, groupTasks);
  }

  async getTaskTraceByIteration(groupId: string, iterationId: string): Promise<TaskTraceRow | null> {
    // MF-3: trace must belong to BOTH the iteration and the authorized group.
    const [row] = await db
      .select()
      .from(taskTraces)
      .where(withProject(taskTraces, and(
          eq(taskTraces.iterationId, iterationId),
          eq(taskTraces.groupId, groupId),
        ),));
    return row ?? null;
  }

  // ─── Standing Roles (ROLE-1 — standing-role.md §3/§8) ──────────────────────
  // All queries are PROJECT-scoped via withProject/withProjectList/withProjectInsert
  // (owner/member isolation from the caller's ALS) — mirrors the skills CRUD exactly.

  async getStandingRoles(): Promise<StandingRoleRow[]> {
    return db.select().from(standingRoles).where(withProjectList(standingRoles)).orderBy(standingRoles.name);
  }

  async getStandingRole(id: string): Promise<StandingRoleRow | undefined> {
    const [row] = await db
      .select()
      .from(standingRoles)
      .where(withProject(standingRoles, eq(standingRoles.id, id)));
    return row;
  }

  async createStandingRole(data: InsertStandingRole): Promise<StandingRoleRow> {
    type RoleInsert = Parameters<ReturnType<typeof db.insert<typeof standingRoles>>["values"]>[0];
    const [row] = await db
      .insert(standingRoles)
      .values(withProjectInsert(standingRoles, data as unknown as RoleInsert))
      .returning();
    return row;
  }

  async updateStandingRole(id: string, updates: Partial<InsertStandingRole>): Promise<StandingRoleRow> {
    const [row] = await db
      .update(standingRoles)
      .set({ ...(updates as Record<string, unknown>), updatedAt: new Date() } as Parameters<ReturnType<typeof db.update<typeof standingRoles>>["set"]>[0])
      .where(withProject(standingRoles, eq(standingRoles.id, id)))
      .returning();
    if (!row) throw new Error(`Standing role not found: ${id}`);
    return row;
  }

  async deleteStandingRole(id: string): Promise<void> {
    await db.delete(standingRoles).where(withProject(standingRoles, eq(standingRoles.id, id)));
  }

}

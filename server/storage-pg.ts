import { eq, desc, and, or, ilike, lt, ne, gte, lte, asc, isNull, inArray, sql as drizzleSql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, withProject } from "./db";
import type { IStorage, PracticeCardFilters, MorningBriefFilters, NewsItemFilters, LlmRequestFilters, LlmRequestStats, LlmStatsByModel, LlmStatsByProvider, LlmStatsByTeam, LlmTimelinePoint, RunHistoryQuery, PipelineRunHistoryRow, TaskGroupHistoryRow } from "./storage";
import {
  TASK_GROUP_V2_MAX_LIMIT,
  IterationConflictError,
  buildVirtualIteration,
} from "./storage-task-groups-v2";
import type {
  IterationListQuery,
  TaskTemplateListQuery,
  IterationExecutionSeed,
  IterationStartInput,
  VirtualIteration,
} from "./storage-task-groups-v2";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig } from "@shared/types";
import {
  users, models, pipelines, pipelineRuns,
  stageExecutions, questions, chatMessages, llmRequests,
  lessons,
  memories,
  mcpServers,
  delegationRequests,
  specializationProfiles,
  skills,
  skillVersions,
  skillTeams,
  modelSkillBindings,
  triggers,
  managerIterations,
  orchestratorRuns,
  orchestratorSteps,
  orchestratorDebates,
  orchestratorResearch,
  consensusRuns,
  consensusRounds,
  consensusCriticalIssues,
  traces,
  argoCdConfig,
  workspaces,
  practiceCards,
  practiceCardRefreshRuns,
  newsProfile,
  morningBrief,
  newsItem,
  type PracticeCardRow,
  type InsertPracticeCard,
  type PracticeCardRefreshRunRow,
  type PracticeCardReviewState,
  type PracticeCardStatus,
  type NewsProfileRow,
  type InsertNewsProfile,
  type MorningBriefRow,
  type InsertMorningBrief,
  type NewsItemRow,
  type InsertNewsItem,
  type BriefStatus,
  type NewsFeedback,
  type NewsReadState,
  type UserRow, type InsertUser,
  type Model, type InsertModel,
  type Pipeline, type InsertPipeline,
  type PipelineRun, type InsertPipelineRun,
  type StageExecution, type InsertStageExecution,
  type Lesson, type InsertLesson,
  type Question, type InsertQuestion,
  type ChatMessage, type InsertChatMessage,
  type LlmRequest, type InsertLlmRequest,
  type InsertDelegationRequest, type DelegationRequestRow,
  type InsertSpecializationProfile,
  type SpecializationProfileRow,
  type Skill, type InsertSkill,
  type SkillVersionRow,
  type SkillTeam, type InsertSkillTeam,
  type InsertManagerIteration, type ManagerIterationRow,
  type InsertOrchestratorRun, type OrchestratorRunRow,
  type InsertOrchestratorStep, type OrchestratorStepRow,
  type InsertOrchestratorDebate, type OrchestratorDebateRow,
  type InsertOrchestratorResearch, type OrchestratorResearchRow,
  type InsertConsensusRun, type ConsensusRunRow,
  type InsertConsensusRound, type ConsensusRoundRow,
  type InsertConsensusCriticalIssue, type ConsensusCriticalIssueRow,
  type TriggerRow,
  type InsertTrace,
  type TraceRow,
  taskGroups,
  tasks,
  taskTraces,
  taskGroupIterations,
  taskExecutions,
  taskTemplates,
  consiliumLoops,
  consiliumLoopRounds,
  type ConsiliumLoopRow,
  type InsertConsiliumLoop,
  type ConsiliumLoopRoundRow,
  type InsertConsiliumLoopRound,
  type ConsiliumLoopState,
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
  type TaskTemplateRow,
  type InsertTaskTemplate,
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
import type { LessonRecallFilter } from "./memory/lessons/types";
import type { TraceSpan, SkillVersionRecord, MarketplaceSkill, MarketplaceFilters, InsertSkillVersion, SharedSession, CreateSharedSessionInput, ShareRole, WorkspaceConnection, CreateWorkspaceConnectionInput, UpdateWorkspaceConnectionInput, McpToolCall, ConnectionUsageMetrics, RecordMcpToolCallInput, SessionConflict, DecisionLogEntry, RaiseConflictInput, CastConflictVoteInput, DebateJudgement, ExperimentBranchResult, ResolutionOutcome } from "@shared/types";

import { encrypt, decrypt } from "./crypto";

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
    return db.select().from(models);
  }

  async getActiveModels(): Promise<Model[]> {
    return db.select().from(models).where(withProject(models, eq(models.isActive, true)));
  }

  async getModelBySlug(slug: string): Promise<Model | undefined> {
    const [row] = await db.select().from(models).where(withProject(models, eq(models.slug, slug)));
    return row;
  }

  async createModel(model: InsertModel): Promise<Model> {
    const [row] = await db.insert(models).values(model).returning();
    return row;
  }

  async upsertModelBySlug(model: InsertModel): Promise<Model> {
    // Parameterized upsert keyed on the unique slug column. On conflict we
    // refresh the mutable fields (name/provider/modelId/contextLimit/isActive)
    // but keep the existing id/createdAt.
    const [row] = await db
      .insert(models)
      .values(model)
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

  // ─── Pipelines ──────────────────────────────────────

  async getPipelines(): Promise<Pipeline[]> {
    return db.select().from(pipelines);
  }

  async getPipeline(id: string): Promise<Pipeline | undefined> {
    const [row] = await db.select().from(pipelines).where(withProject(pipelines, eq(pipelines.id, id)));
    return row;
  }

  async getTemplates(): Promise<Pipeline[]> {
    return db.select().from(pipelines).where(withProject(pipelines, eq(pipelines.isTemplate, true)));
  }

  async createPipeline(pipeline: InsertPipeline): Promise<Pipeline> {
    const [row] = await db.insert(pipelines).values(pipeline).returning();
    return row;
  }

  async updatePipeline(id: string, updates: Partial<InsertPipeline>): Promise<Pipeline> {
    const [row] = await db
      .update(pipelines)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(pipelines, eq(pipelines.id, id)))
      .returning();
    if (!row) throw new Error(`Pipeline not found: ${id}`);
    return row;
  }

  async deletePipeline(id: string): Promise<void> {
    await db.delete(pipelines).where(withProject(pipelines, eq(pipelines.id, id)));
  }

  // ─── Pipeline Runs ──────────────────────────────────

  async getPipelineRuns(pipelineId?: string): Promise<PipelineRun[]> {
    if (pipelineId) {
      return db
        .select()
        .from(pipelineRuns)
        .where(withProject(pipelineRuns, eq(pipelineRuns.pipelineId, pipelineId)))
        .orderBy(desc(pipelineRuns.createdAt));
    }
    return db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.createdAt));
  }

  async listPipelineRunHistory(query: RunHistoryQuery): Promise<PipelineRunHistoryRow[]> {
    const conditions: SQL[] = [
      inArray(pipelineRuns.status, ["completed", "failed", "cancelled", "rejected"]),
    ];
    if (query.ownerId != null) conditions.push(eq(pipelineRuns.triggeredBy, query.ownerId));
    if (query.cursor) {
      const c = new Date(query.cursor.completedAt);
      conditions.push(
        or(
          lt(pipelineRuns.completedAt, c),
          and(eq(pipelineRuns.completedAt, c), lt(pipelineRuns.id, query.cursor.id)),
        )!,
      );
    }
    const rows = await db
      .select({
        id: pipelineRuns.id,
        status: pipelineRuns.status,
        workspaceId: pipelineRuns.workspaceId,
        triggeredBy: pipelineRuns.triggeredBy,
        startedAt: pipelineRuns.startedAt,
        completedAt: pipelineRuns.completedAt,
        currentStageIndex: pipelineRuns.currentStageIndex,
      })
      .from(pipelineRuns)
      .where(withProject(pipelineRuns, and(...conditions)))
      .orderBy(desc(pipelineRuns.completedAt), desc(pipelineRuns.id))
      .limit(query.limit);
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      workspaceId: r.workspaceId ?? null,
      triggeredBy: r.triggeredBy ?? null,
      startedAt: r.startedAt ?? null,
      completedAt: r.completedAt ?? null,
      currentStageIndex: r.currentStageIndex ?? 0,
    }));
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(withProject(pipelineRuns, eq(pipelineRuns.id, id)));
    return row;
  }

  async createPipelineRun(run: InsertPipelineRun): Promise<PipelineRun> {
    const [row] = await db.insert(pipelineRuns).values(run).returning();
    return row;
  }

  async updatePipelineRun(id: string, updates: Partial<PipelineRun>): Promise<PipelineRun> {
    const [row] = await db
      .update(pipelineRuns)
      .set(updates)
      .where(withProject(pipelineRuns, eq(pipelineRuns.id, id)))
      .returning();
    if (!row) throw new Error(`Run not found: ${id}`);
    return row;
  }

  // ─── Stage Executions ───────────────────────────────

  async getStageExecutions(runId: string): Promise<StageExecution[]> {
    return db
      .select()
      .from(stageExecutions)
      .where(withProject(stageExecutions, eq(stageExecutions.runId, runId)))
      .orderBy(stageExecutions.stageIndex);
  }

  async getStageExecution(id: string): Promise<StageExecution | undefined> {
    const [row] = await db
      .select()
      .from(stageExecutions)
      .where(withProject(stageExecutions, eq(stageExecutions.id, id)));
    return row;
  }

  async createStageExecution(execution: InsertStageExecution): Promise<StageExecution> {
    const [row] = await db.insert(stageExecutions).values(execution).returning();
    return row;
  }

  async updateStageExecution(
    id: string,
    updates: Partial<StageExecution>,
  ): Promise<StageExecution> {
    const [row] = await db
      .update(stageExecutions)
      .set(updates)
      .where(withProject(stageExecutions, eq(stageExecutions.id, id)))
      .returning();
    if (!row) throw new Error(`Stage execution not found: ${id}`);
    return row;
  }

  // ─── Lessons (agent-experience memory — Track B) ─────

  async createLesson(lesson: InsertLesson): Promise<Lesson> {
    const [row] = await db.insert(lessons).values(lesson).returning();
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
    const [row] = await db.insert(questions).values(question).returning();
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
    let query = db
      .select()
      .from(chatMessages)
      .orderBy(chatMessages.createdAt)
      .$dynamic();

    if (runId) {
      query = query.where(withProject(chatMessages, eq(chatMessages.runId, runId)));
    }

    const rows = await query;
    return limit ? rows.slice(-limit) : rows;
  }

  async createChatMessage(message: InsertChatMessage): Promise<ChatMessage> {
    const [row] = await db.insert(chatMessages).values(message).returning();
    return row;
  }

  // ─── LLM Requests ───────────────────────────────────

  async createLlmRequest(data: InsertLlmRequest): Promise<LlmRequest> {
    const [row] = await db.insert(llmRequests).values(data).returning();
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
      .from(llmRequests);

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

  // ─── Memories ───────────────────────────────────────

  private rowToMemory(row: typeof memories.$inferSelect): Memory {
    return {
      id: row.id,
      scope: row.scope as Memory['scope'],
      scopeId: row.scopeId ?? null,
      type: row.type as Memory['type'],
      key: row.key,
      content: row.content,
      source: row.source ?? null,
      confidence: row.confidence,
      tags: row.tags ?? [],
      createdAt: row.createdAt ?? null,
      updatedAt: row.updatedAt ?? null,
      expiresAt: row.expiresAt ?? null,
      createdByRunId: row.createdByRunId ?? null,
      published: row.published ?? false,
    };
  }

  async getMemories(scope: MemoryScope, scopeId?: string | null, type?: MemoryType): Promise<Memory[]> {
    const conditions = [eq(memories.scope, scope)];

    if (scopeId !== undefined) {
      conditions.push(scopeId === null
        ? drizzleSql`${memories.scopeId} IS NULL`
        : eq(memories.scopeId, scopeId));
    }

    if (type) {
      conditions.push(eq(memories.type, type));
    }

    const rows = await db.select().from(memories).where(withProject(memories, and(...conditions)));
    return rows.map((r) => this.rowToMemory(r));
  }

  async searchMemories(query: string, scope?: MemoryScope): Promise<Memory[]> {
    const searchPattern = `%${query}%`;
    const textMatch = or(
      ilike(memories.key, searchPattern),
      ilike(memories.content, searchPattern),
    );

    const condition = scope
      ? and(textMatch, eq(memories.scope, scope))
      : textMatch;

    const rows = await db.select().from(memories).where(withProject(memories, condition));
    return rows.map((r) => this.rowToMemory(r));
  }

  async upsertMemory(insert: InsertMemory): Promise<Memory> {
    const [row] = await db
      .insert(memories)
      .values({
        scope: insert.scope,
        scopeId: insert.scopeId ?? null,
        type: insert.type,
        key: insert.key,
        content: insert.content,
        source: insert.source ?? null,
        confidence: insert.confidence ?? 1.0,
        tags: insert.tags ?? [],
        expiresAt: insert.expiresAt ?? null,
        createdByRunId: insert.createdByRunId ?? null,
        published: insert.published ?? false,
      })
      .onConflictDoUpdate({
        target: [memories.scope, memories.scopeId, memories.key],
        set: {
          content: insert.content,
          confidence: insert.confidence ?? 1.0,
          source: insert.source ?? null,
          updatedAt: new Date(),
        },
      })
      .returning();
    return this.rowToMemory(row);
  }

  async deleteMemory(id: number): Promise<void> {
    await db.delete(memories).where(withProject(memories, eq(memories.id, id)));
  }

  async decayMemories(excludeRunId: number, decayAmount: number): Promise<number> {
    const result = await db
      .update(memories)
      .set({
        confidence: drizzleSql`${memories.confidence} - ${decayAmount}`,
        updatedAt: new Date(),
      })
      .where(withProject(memories, and(
          ne(memories.createdByRunId, excludeRunId),
          drizzleSql`${memories.confidence} > ${decayAmount}`,
        ),))
      .returning({ id: memories.id });
    return result.length;
  }

  async deleteStaleMemories(threshold: number): Promise<number> {
    const result = await db
      .delete(memories)
      .where(withProject(memories, lt(memories.confidence, threshold)))
      .returning({ id: memories.id });
    return result.length;
  }

  async updateMemoryPublished(id: number, published: boolean): Promise<Memory | null> {
    const [row] = await db
      .update(memories)
      .set({ published, updatedAt: new Date() })
      .where(withProject(memories, eq(memories.id, id)))
      .returning();
    return row ? this.rowToMemory(row) : null;
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
    const rows = await db.select().from(mcpServers).orderBy(mcpServers.name);
    return rows.map((r) => this.rowToMcpServer(r));
  }

  async getMcpServer(id: number): Promise<McpServerConfig | undefined> {
    const [row] = await db.select().from(mcpServers).where(withProject(mcpServers, eq(mcpServers.id, id)));
    return row ? this.rowToMcpServer(row) : undefined;
  }

  async createMcpServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig> {
    const [row] = await db
      .insert(mcpServers)
      .values({
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
      })
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

  // ─── Delegation Requests (Phase 6.4) ────────────────────────────────────

  async createDelegationRequest(data: InsertDelegationRequest): Promise<DelegationRequestRow> {
    const [row] = await db.insert(delegationRequests).values(data).returning();
    return row;
  }

  async getDelegationRequests(runId: string): Promise<DelegationRequestRow[]> {
    return db
      .select()
      .from(delegationRequests)
      .where(withProject(delegationRequests, eq(delegationRequests.runId, runId)))
      .orderBy(asc(delegationRequests.createdAt));
  }

  async updateDelegationRequest(
    id: string,
    updates: Partial<DelegationRequestRow>,
  ): Promise<DelegationRequestRow> {
    const [row] = await db
      .update(delegationRequests)
      .set(updates)
      .where(withProject(delegationRequests, eq(delegationRequests.id, id)))
      .returning();
    if (!row) throw new Error(`Delegation request not found: ${id}`);
    return row;
  }

  // ─── Specialization Profiles (Phase 5) ──────────────────────────────────────

  async getSpecializationProfiles(): Promise<SpecializationProfileRow[]> {
    return db.select().from(specializationProfiles).orderBy(specializationProfiles.createdAt);
  }

  async createSpecializationProfile(profile: InsertSpecializationProfile): Promise<SpecializationProfileRow> {
    const [row] = await db.insert(specializationProfiles).values({
      name: profile.name,
      isBuiltIn: profile.isBuiltIn ?? false,
      assignments: (profile.assignments ?? {}) as Record<string, string>,
    }).returning();
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
      : db.select().from(skills).orderBy(skills.name);
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const [row] = await db.select().from(skills).where(withProject(skills, eq(skills.id, id)));
    return row;
  }

  async createSkill(data: InsertSkill): Promise<Skill> {
    type SkillInsert = Parameters<typeof db.insert<typeof skills>>[0] extends object ? Parameters<ReturnType<typeof db.insert<typeof skills>>["values"]>[0] : never;
    const [row] = await db.insert(skills).values(data as unknown as SkillInsert).returning();
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
      .values({
        skillId: data.skillId,
        version: data.version,
        config: data.config,
        changelog: data.changelog,
        createdBy: data.createdBy,
      })
      .returning();
    return row;
  }

  // ─── Marketplace (Phase 6.16) ─────────────────────────────────────────────

  async getMarketplaceSkills(
    filters: MarketplaceFilters,
  ): Promise<{ skills: MarketplaceSkill[]; total: number }> {
    const conditions = [
      or(
        eq(skills.sharing, "public"),
        eq(skills.sharing, "team"),
      ),
    ];

    if (filters.search) {
      const searchTerm = `%${filters.search}%`;
      conditions.push(
        or(
          ilike(skills.name, searchTerm),
          ilike(skills.description, searchTerm),
        )!,
      );
    }

    if (filters.teamId) {
      conditions.push(eq(skills.teamId, filters.teamId));
    }

    if (filters.author) {
      conditions.push(eq(skills.createdBy, filters.author));
    }

    const whereClause = and(...conditions);

    const countResult = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(skills)
      .where(withProject(skills, whereClause));
    const total = countResult[0]?.count ?? 0;

    let orderBy;
    switch (filters.sort) {
      case "usageCount":
        orderBy = desc(skills.usageCount);
        break;
      case "name":
        orderBy = asc(skills.name);
        break;
      case "newest":
      default:
        orderBy = desc(skills.createdAt);
        break;
    }

    const rows = await db
      .select({
        skill: skills,
        authorName: users.name,
      })
      .from(skills)
      .leftJoin(users, eq(skills.createdBy, users.id))
      .where(withProject(skills, whereClause))
      .orderBy(orderBy)
      .limit(filters.limit)
      .offset(filters.offset);

    const mapped: MarketplaceSkill[] = rows.map(({ skill: s, authorName }) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      teamId: s.teamId,
      tags: s.tags as string[],
      version: s.version,
      author: authorName ?? s.createdBy,
      usageCount: s.usageCount,
      sharing: s.sharing as 'private' | 'team' | 'public',
      modelPreference: s.modelPreference,
      createdAt: s.createdAt ?? new Date(),
      updatedAt: s.updatedAt ?? new Date(),
    }));

    // Post-filter by tags if needed (JSONB array matching)
    let filtered = mapped;
    if (filters.tags && filters.tags.length > 0) {
      filtered = mapped.filter((s) =>
        filters.tags!.some((t) => s.tags.includes(t)),
      );
    }

    return { skills: filtered, total };
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

  // ─── Skill Teams ─────────────────────────────────────────────────────────────

  async getSkillTeams(): Promise<SkillTeam[]> {
    return db.select().from(skillTeams).orderBy(skillTeams.createdAt);
  }

  async createSkillTeam(data: InsertSkillTeam): Promise<SkillTeam> {
    const [row] = await db.insert(skillTeams).values(data).returning();
    return row;
  }

  async deleteSkillTeam(id: string): Promise<void> {
    await db.delete(skillTeams).where(withProject(skillTeams, eq(skillTeams.id, id)));
  }

  // ─── Manager Iterations (Phase 6.6) ────────────────────────────────────────

  async createManagerIteration(data: InsertManagerIteration): Promise<ManagerIterationRow> {
    const [row] = await db.insert(managerIterations).values(data).returning();
    return row;
  }

  async updateManagerIteration(
    runId: string,
    iterationNumber: number,
    updates: Partial<Pick<ManagerIterationRow, "teamResult" | "teamDurationMs">>,
  ): Promise<void> {
    await db
      .update(managerIterations)
      .set(updates)
      .where(withProject(managerIterations, and(
          eq(managerIterations.runId, runId),
          eq(managerIterations.iterationNumber, iterationNumber),
        ),));
  }

  async getManagerIterations(
    runId: string,
    offset = 0,
    limit = 50,
  ): Promise<ManagerIterationRow[]> {
    return db
      .select()
      .from(managerIterations)
      .where(withProject(managerIterations, eq(managerIterations.runId, runId)))
      .orderBy(asc(managerIterations.iterationNumber))
      .limit(limit)
      .offset(offset);
  }

  async countManagerIterations(runId: string): Promise<number> {
    const result = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(managerIterations)
      .where(withProject(managerIterations, eq(managerIterations.runId, runId)));
    return result[0]?.count ?? 0;
  }

  // ─── Debate-Research Orchestrator ───────────────────────────────────────────

  async createOrchestratorRun(data: InsertOrchestratorRun): Promise<OrchestratorRunRow> {
    const [row] = await db.insert(orchestratorRuns).values(data).returning();
    return row;
  }

  async getOrchestratorRun(runId: string): Promise<OrchestratorRunRow | undefined> {
    const [row] = await db
      .select()
      .from(orchestratorRuns)
      .where(withProject(orchestratorRuns, eq(orchestratorRuns.runId, runId)));
    return row;
  }

  async updateOrchestratorRun(
    runId: string,
    updates: Partial<Omit<OrchestratorRunRow, "id" | "runId" | "createdAt">>,
  ): Promise<void> {
    await db.update(orchestratorRuns).set(updates).where(withProject(orchestratorRuns, eq(orchestratorRuns.runId, runId)));
  }

  async createOrchestratorStep(data: InsertOrchestratorStep): Promise<OrchestratorStepRow> {
    const [row] = await db.insert(orchestratorSteps).values(data).returning();
    return row;
  }

  async updateOrchestratorStep(
    stepId: string,
    updates: Partial<Omit<OrchestratorStepRow, "id" | "runId" | "createdAt">>,
  ): Promise<void> {
    await db.update(orchestratorSteps).set(updates).where(withProject(orchestratorSteps, eq(orchestratorSteps.id, stepId)));
  }

  async getOrchestratorSteps(runId: string): Promise<OrchestratorStepRow[]> {
    return db
      .select()
      .from(orchestratorSteps)
      .where(withProject(orchestratorSteps, eq(orchestratorSteps.runId, runId)))
      .orderBy(asc(orchestratorSteps.stepIndex));
  }

  async createOrchestratorDebate(data: InsertOrchestratorDebate): Promise<OrchestratorDebateRow> {
    const [row] = await db.insert(orchestratorDebates).values(data).returning();
    return row;
  }

  async getOrchestratorDebates(runId: string): Promise<OrchestratorDebateRow[]> {
    return db
      .select()
      .from(orchestratorDebates)
      .where(withProject(orchestratorDebates, eq(orchestratorDebates.runId, runId)))
      .orderBy(asc(orchestratorDebates.createdAt));
  }

  async createOrchestratorResearch(
    data: InsertOrchestratorResearch,
  ): Promise<OrchestratorResearchRow> {
    const [row] = await db.insert(orchestratorResearch).values(data).returning();
    return row;
  }

  async getOrchestratorResearch(runId: string): Promise<OrchestratorResearchRow[]> {
    return db
      .select()
      .from(orchestratorResearch)
      .where(withProject(orchestratorResearch, eq(orchestratorResearch.runId, runId)))
      .orderBy(asc(orchestratorResearch.createdAt));
  }

  // ─── Consilium Loops (Phase B — auto-versioned FSM) ───────────────────────

  async createLoop(data: InsertConsiliumLoop): Promise<ConsiliumLoopRow> {
    // H-3: the partial-unique index `consilium_loops_one_active_per_group`
    // rejects a 2nd non-terminal loop on the same group at the DB level — the
    // create route maps the unique-violation to a 409.
    const [row] = await db.insert(consiliumLoops).values(data).returning();
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
    return db.select().from(consiliumLoops).orderBy(desc(consiliumLoops.createdAt));
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

  async appendLoopRound(data: InsertConsiliumLoopRound): Promise<ConsiliumLoopRoundRow> {
    const [row] = await db.insert(consiliumLoopRounds).values(data).returning();
    return row;
  }

  async getLoopRounds(loopId: string): Promise<ConsiliumLoopRoundRow[]> {
    return db
      .select()
      .from(consiliumLoopRounds)
      .where(withProject(consiliumLoopRounds, eq(consiliumLoopRounds.loopId, loopId)))
      .orderBy(asc(consiliumLoopRounds.round));
  }

  // ─── /consensus run mode ──────────────────────────────────────────────────

  async createConsensusRun(data: InsertConsensusRun): Promise<ConsensusRunRow> {
    const [row] = await db.insert(consensusRuns).values(data).returning();
    return row;
  }

  async getConsensusRun(runId: string): Promise<ConsensusRunRow | undefined> {
    const [row] = await db.select().from(consensusRuns).where(withProject(consensusRuns, eq(consensusRuns.runId, runId)));
    return row;
  }

  async updateConsensusRun(
    runId: string,
    updates: Partial<Omit<ConsensusRunRow, "id" | "runId" | "createdAt">>,
  ): Promise<void> {
    await db.update(consensusRuns).set(updates).where(withProject(consensusRuns, eq(consensusRuns.runId, runId)));
  }

  async createConsensusRound(data: InsertConsensusRound): Promise<ConsensusRoundRow> {
    // MF-5: the (run_id, round, phase) unique constraint guarantees a blind row
    // can never be duplicated; the insert throws on a duplicate.
    const [row] = await db.insert(consensusRounds).values(data).returning();
    return row;
  }

  async getConsensusRounds(runId: string): Promise<ConsensusRoundRow[]> {
    return db
      .select()
      .from(consensusRounds)
      .where(withProject(consensusRounds, eq(consensusRounds.runId, runId)))
      .orderBy(asc(consensusRounds.createdAt));
  }

  async upsertConsensusIssue(
    data: InsertConsensusCriticalIssue,
  ): Promise<ConsensusCriticalIssueRow> {
    const [row] = await db
      .insert(consensusCriticalIssues)
      .values(data)
      .onConflictDoUpdate({
        target: [consensusCriticalIssues.runId, consensusCriticalIssues.issueKey],
        set: {
          status: data.status ?? "open",
          resolution: data.resolution ?? null,
          dismissalJustification: data.dismissalJustification ?? null,
          summary: data.summary,
          closedRound: data.closedRound ?? null,
        },
      })
      .returning();
    return row;
  }

  async getConsensusIssues(runId: string): Promise<ConsensusCriticalIssueRow[]> {
    return db
      .select()
      .from(consensusCriticalIssues)
      .where(withProject(consensusCriticalIssues, eq(consensusCriticalIssues.runId, runId)))
      .orderBy(asc(consensusCriticalIssues.createdAt));
  }

  // ─── Triggers (Phase 6.3) ─────────────────────────────────────────────────

  async getTriggers(pipelineId: string): Promise<TriggerRow[]> {
    return db.select().from(triggers).where(withProject(triggers, eq(triggers.pipelineId, pipelineId))).orderBy(triggers.createdAt);
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

  async createTrigger(
    data: Omit<TriggerRow, "id" | "createdAt" | "updatedAt" | "lastTriggeredAt"> & { secretEncrypted?: string | null },
  ): Promise<TriggerRow> {
    const [row] = await db
      .insert(triggers)
      .values({
        pipelineId: data.pipelineId,
        type: data.type as TriggerRow["type"],
        config: data.config,
        secretEncrypted: data.secretEncrypted ?? null,
        enabled: data.enabled ?? true,
      })
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

  // ─── Traces (Phase 6.5) ────────────────────────────────────────────────────

  async createTrace(data: InsertTrace): Promise<TraceRow> {
    const [row] = await db.insert(traces).values(data).returning();
    return row;
  }

  async getTraceByRunId(runId: string): Promise<TraceRow | null> {
    const [row] = await db.select().from(traces).where(withProject(traces, eq(traces.runId, runId))).limit(1);
    return row ?? null;
  }

  async getTraceByTraceId(traceId: string): Promise<TraceRow | null> {
    const [row] = await db.select().from(traces).where(withProject(traces, eq(traces.traceId, traceId))).limit(1);
    return row ?? null;
  }

  async getTraces(limit = 50, offset = 0): Promise<TraceRow[]> {
    return db.select().from(traces)
      .orderBy(desc(traces.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async updateTraceSpans(traceId: string, spans: TraceSpan[]): Promise<void> {
    await db.update(traces)
      .set({ spans: spans as TraceRow["spans"], updatedAt: new Date() })
      .where(withProject(traces, eq(traces.traceId, traceId)));
  }

  // ─── Task Groups (Task Orchestrator) ────────────────────────────────────────

  async getTaskGroups(): Promise<TaskGroupRow[]> {
    return db.select().from(taskGroups).orderBy(desc(taskGroups.createdAt));
  }

  async getTaskGroup(id: string): Promise<TaskGroupRow | undefined> {
    const [row] = await db.select().from(taskGroups).where(withProject(taskGroups, eq(taskGroups.id, id)));
    return row;
  }

  async createTaskGroup(data: InsertTaskGroup): Promise<TaskGroupRow> {
    const [row] = await db.insert(taskGroups).values(data as typeof taskGroups.$inferInsert).returning();
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

  async getTask(id: string): Promise<TaskRow | undefined> {
    const [row] = await db.select().from(tasks).where(withProject(tasks, eq(tasks.id, id)));
    return row;
  }

  async createTask(data: InsertTask): Promise<TaskRow> {
    const [row] = await db.insert(tasks).values(data as typeof tasks.$inferInsert).returning();
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
    const [row] = await db.insert(taskTraces).values(data as typeof taskTraces.$inferInsert).returning();
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

  // ─── Tracker Connections (Issue Tracker Integration) ────────────────────────

  async getTrackerConnectionsByGroup(taskGroupId: string): Promise<TrackerConnectionRow[]> {
    return db.select().from(trackerConnections)
      .where(withProject(trackerConnections, eq(trackerConnections.taskGroupId, taskGroupId)));
  }

  async getTrackerConnection(id: string): Promise<TrackerConnectionRow | undefined> {
    const [row] = await db.select().from(trackerConnections)
      .where(withProject(trackerConnections, eq(trackerConnections.id, id)));
    return row;
  }

  async createTrackerConnection(data: InsertTrackerConnection): Promise<TrackerConnectionRow> {
    const [row] = await db.insert(trackerConnections)
      .values(data as typeof trackerConnections.$inferInsert)
      .returning();
    return row;
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

  async getModelsWithSkillBindings(): Promise<string[]> {
    const rows = await db
      .selectDistinct({ modelId: modelSkillBindings.modelId })
      .from(modelSkillBindings)
      .orderBy(asc(modelSkillBindings.modelId));
    return rows.map((r) => r.modelId);
  }

  async createModelSkillBinding(data: InsertModelSkillBinding): Promise<ModelSkillBinding> {
    const [row] = await db.insert(modelSkillBindings)
      .values(data as typeof modelSkillBindings.$inferInsert)
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

  async getArgoCdConfig(): Promise<ArgoCdConfigRow | null> {
    const [row] = await db.select().from(argoCdConfig).where(eq(argoCdConfig.id, 1));
    return row ?? null;
  }

  async saveArgoCdConfig(config: Partial<InsertArgoCdConfig> & { id?: number }): Promise<ArgoCdConfigRow> {
    const now = new Date();
    const existing = await this.getArgoCdConfig();

    if (existing) {
      // Update existing row
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
        .where(eq(argoCdConfig.id, 1))
        .returning();
      return row;
    } else {
      // Insert new row
      const [row] = await db
        .insert(argoCdConfig)
        .values({
          id: config.id ?? 1,
          serverUrl: config.serverUrl ?? null,
          tokenEnc: config.tokenEnc ?? null,
          verifySsl: config.verifySsl ?? true,
          enabled: config.enabled ?? false,
          mcpServerId: config.mcpServerId ?? null,
          healthStatus: ((config as Record<string, unknown>).healthStatus as string) ?? "unknown",
          healthError: ((config as Record<string, unknown>).healthError as string) ?? null,
          updatedAt: now,
        } as typeof argoCdConfig.$inferInsert)
        .returning();
      return row;
    }
  }

  async deleteArgoCdConfig(): Promise<void> {
    await db.delete(argoCdConfig).where(eq(argoCdConfig.id, 1));
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
      .values(data as typeof workspaces.$inferInsert)
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
      .values({
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
      } as typeof sharedSessions.$inferInsert)
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
      .values({
        workspaceId: input.workspaceId,
        type: input.type,
        name: input.name,
        configJson: input.config,
        secretsEncrypted,
        status: "active",
        createdBy: input.createdBy ?? null,
      } as typeof workspaceConnections.$inferInsert)
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
      .values({
        pipelineRunId: input.pipelineRunId ?? null,
        stageId: input.stageId ?? null,
        connectionId: input.connectionId,
        toolName: input.toolName,
        argsJson: input.argsJson,
        resultJson: input.resultJson ?? null,
        error: input.error ?? null,
        durationMs: input.durationMs,
        startedAt: input.startedAt ?? new Date(),
      } as typeof mcpToolCalls.$inferInsert)
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
      pipelineRunId: row.pipelineRunId ?? null,
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
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider,
        model: input.model,
        pipelineRunId: input.pipelineRunId ?? null,
        stageId: input.stageId ?? null,
        promptTokens: input.promptTokens ?? 0,
        completionTokens: input.completionTokens ?? 0,
        costUsd: input.costUsd ?? 0,
      } as typeof costLedger.$inferInsert)
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
      .values({
        workspaceId: input.workspaceId,
        provider: input.provider ?? null,
        period: input.period ?? "month",
        limitUsd: input.limitUsd,
        hard: input.hard ?? false,
        notifyAtPct: input.notifyAtPct ?? [],
      } as typeof budgets.$inferInsert)
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
        .values({ workspaceId, key, value: value as Record<string, unknown>, updatedAt: new Date() })
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
      .values({
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
      } as typeof sessionConflicts.$inferInsert)
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
    await db.insert(decisionLog).values({
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
    } as typeof decisionLog.$inferInsert);
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
      .values(data as typeof practiceCards.$inferInsert)
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
      .values({ workspaceId, topic, trigger, status: "running", report: {} })
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

  // ─── Morning News Board ──────────────────────────────────────────────────

  async getNewsProfile(workspaceId: string, userId: string): Promise<NewsProfileRow | null> {
    const [row] = await db
      .select()
      .from(newsProfile)
      .where(withProject(newsProfile, and(eq(newsProfile.workspaceId, workspaceId), eq(newsProfile.userId, userId))));
    return row ?? null;
  }

  async upsertNewsProfile(data: InsertNewsProfile): Promise<NewsProfileRow> {
    const [row] = await db
      .insert(newsProfile)
      .values(data as typeof newsProfile.$inferInsert)
      .onConflictDoUpdate({
        target: [newsProfile.workspaceId, newsProfile.userId],
        set: {
          role: data.role,
          stack: data.stack,
          mutedCategories: data.mutedCategories,
          updatedAt: new Date(),
        },
      })
      .returning();
    return row;
  }

  async createMorningBrief(data: InsertMorningBrief): Promise<{ brief: MorningBriefRow; claimed: boolean }> {
    // Atomic claim: UNIQUE(workspace_id,user_id,brief_date) IS the gen lock.
    // ON CONFLICT DO NOTHING — an empty return means another worker holds it.
    const [inserted] = await db
      .insert(morningBrief)
      .values(data as typeof morningBrief.$inferInsert)
      .onConflictDoNothing({
        target: [morningBrief.workspaceId, morningBrief.userId, morningBrief.briefDate],
      })
      .returning();
    if (inserted) return { brief: inserted, claimed: true };
    const existing = await this.getMorningBriefByDate(data.workspaceId, data.userId, data.briefDate);
    if (!existing) throw new Error("Morning brief claim failed and no existing row found");
    return { brief: existing, claimed: false };
  }

  async getMorningBriefByDate(workspaceId: string, userId: string, briefDate: string): Promise<MorningBriefRow | null> {
    const [row] = await db
      .select()
      .from(morningBrief)
      .where(withProject(morningBrief, and(
          eq(morningBrief.workspaceId, workspaceId),
          eq(morningBrief.userId, userId),
          eq(morningBrief.briefDate, briefDate),
        ),));
    return row ?? null;
  }

  async getMorningBrief(id: string): Promise<MorningBriefRow | null> {
    const [row] = await db.select().from(morningBrief).where(withProject(morningBrief, eq(morningBrief.id, id)));
    return row ?? null;
  }

  async listMorningBriefs(workspaceId: string, filters: MorningBriefFilters = {}): Promise<{ briefs: MorningBriefRow[]; total: number }> {
    const conditions = [eq(morningBrief.workspaceId, workspaceId)];
    if (filters.userId) conditions.push(eq(morningBrief.userId, filters.userId));
    if (filters.status) conditions.push(eq(morningBrief.status, filters.status));
    const where = and(...conditions);

    const [{ count }] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(morningBrief)
      .where(withProject(morningBrief, where));

    const briefs = await db
      .select()
      .from(morningBrief)
      .where(withProject(morningBrief, where))
      .orderBy(desc(morningBrief.briefDate))
      .limit(filters.limit ?? 14)
      .offset(filters.offset ?? 0);

    return { briefs, total: count ?? 0 };
  }

  async updateMorningBriefStatus(id: string, updates: { status?: BriefStatus; internalDegraded?: boolean; meta?: Record<string, unknown> }): Promise<MorningBriefRow> {
    const set: Partial<typeof morningBrief.$inferInsert> = { updatedAt: new Date() };
    if (updates.status !== undefined) set.status = updates.status;
    if (updates.internalDegraded !== undefined) set.internalDegraded = updates.internalDegraded;
    if (updates.meta !== undefined) set.meta = updates.meta;
    const [row] = await db.update(morningBrief).set(set).where(withProject(morningBrief, eq(morningBrief.id, id))).returning();
    if (!row) throw new Error(`Morning brief not found: ${id}`);
    return row;
  }

  async upsertNewsItems(items: InsertNewsItem[]): Promise<NewsItemRow[]> {
    if (items.length === 0) return [];
    // onConflict(brief_id, content_hash) DO NOTHING — idempotent dedup.
    await db
      .insert(newsItem)
      .values(items as Array<typeof newsItem.$inferInsert>)
      .onConflictDoNothing({ target: [newsItem.briefId, newsItem.contentHash] });
    // Return the persisted rows for these (briefId, contentHash) pairs.
    const briefIds = Array.from(new Set(items.map((i) => i.briefId)));
    const rows = await db
      .select()
      .from(newsItem)
      .where(withProject(newsItem, inArray(newsItem.briefId, briefIds)));
    const wanted = new Set(items.map((i) => `${i.briefId}::${i.contentHash}`));
    return rows.filter((r) => wanted.has(`${r.briefId}::${r.contentHash}`));
  }

  async setNewsItemFeedback(id: string, updates: { feedback?: NewsFeedback; readState?: NewsReadState }): Promise<NewsItemRow> {
    const set: Partial<typeof newsItem.$inferInsert> = {};
    if (updates.feedback !== undefined) set.feedback = updates.feedback;
    if (updates.readState !== undefined) set.readState = updates.readState;
    const [row] = await db.update(newsItem).set(set).where(withProject(newsItem, eq(newsItem.id, id))).returning();
    if (!row) throw new Error(`News item not found: ${id}`);
    return row;
  }

  async getNewsItem(id: string): Promise<NewsItemRow | null> {
    const [row] = await db.select().from(newsItem).where(withProject(newsItem, eq(newsItem.id, id)));
    return row ?? null;
  }

  async listNewsItems(briefId: string, filters: NewsItemFilters = {}): Promise<NewsItemRow[]> {
    const conditions = [eq(newsItem.briefId, briefId)];
    if (filters.category) conditions.push(eq(newsItem.category, filters.category));
    if (filters.readState) conditions.push(eq(newsItem.readState, filters.readState));
    return db
      .select()
      .from(newsItem)
      .where(withProject(newsItem, and(...conditions)))
      .orderBy(desc(newsItem.relevanceScore));
  }

  // ─── Task Groups v2 — iterations / executions / templates (BE2) ─────────────

  async createIteration(data: InsertTaskGroupIteration): Promise<TaskGroupIterationRow> {
    // UNIQUE(group_id, iteration_number) is the race backstop: insert-or-detect.
    const [row] = await db
      .insert(taskGroupIterations)
      .values(data as typeof taskGroupIterations.$inferInsert)
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
        .values({
          groupId,
          iterationNumber: start.iterationNumber,
          status: "running",
          input: start.input,
          triggeredBy: start.triggeredBy ?? null,
          traceId: start.traceId ?? null,
          startedAt: new Date(),
        })
        .onConflictDoNothing({
          target: [taskGroupIterations.groupId, taskGroupIterations.iterationNumber],
        })
        .returning();
      if (!iteration) throw new IterationConflictError(groupId, start.iterationNumber);
      if (seeds.length === 0) return { iteration, executions: [] };
      const executions = await tx
        .insert(taskExecutions)
        .values(
          seeds.map((seed) => ({
            iterationId: iteration.id,
            taskId: seed.taskId,
            taskName: seed.taskName,
            groupId,
            status: seed.status,
            modelSlug: seed.modelSlug ?? null,
          })),
        )
        .returning();
      return { iteration, executions };
    });
  }

  async createExecution(data: InsertTaskExecution): Promise<TaskExecutionRow> {
    const [row] = await db
      .insert(taskExecutions)
      .values(data as typeof taskExecutions.$inferInsert)
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

  async getTaskTemplates(query: TaskTemplateListQuery): Promise<TaskTemplateRow[]> {
    const limit = Math.min(query.limit, TASK_GROUP_V2_MAX_LIMIT);
    const conditions: SQL[] = [];
    // MF-4: ownership filter applied BEFORE/with the label match in the same WHERE.
    if (!query.isAdmin && query.ownerId != null) {
      conditions.push(eq(taskTemplates.createdBy, query.ownerId));
    }
    if (query.label != null) {
      // SF-2: jsonb containment via a Drizzle bind param (never interpolated).
      conditions.push(
        drizzleSql`${taskTemplates.labels} @> ${JSON.stringify([query.label])}::jsonb`,
      );
    }
    if (query.cursor) {
      const c = new Date(query.cursor.createdAt);
      conditions.push(
        or(
          lt(taskTemplates.createdAt, c),
          and(eq(taskTemplates.createdAt, c), lt(taskTemplates.id, query.cursor.id)),
        )!,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;
    return db
      .select()
      .from(taskTemplates)
      .where(withProject(taskTemplates, where))
      .orderBy(desc(taskTemplates.createdAt), desc(taskTemplates.id))
      .limit(limit);
  }

  async getTaskTemplate(id: string): Promise<TaskTemplateRow | undefined> {
    const [row] = await db.select().from(taskTemplates).where(withProject(taskTemplates, eq(taskTemplates.id, id)));
    return row;
  }

  async createTaskTemplate(data: InsertTaskTemplate): Promise<TaskTemplateRow> {
    const [row] = await db
      .insert(taskTemplates)
      .values(data as typeof taskTemplates.$inferInsert)
      .returning();
    return row;
  }

  async updateTaskTemplate(id: string, updates: Partial<TaskTemplateRow>): Promise<TaskTemplateRow> {
    const [row] = await db
      .update(taskTemplates)
      .set({ ...updates, updatedAt: new Date() })
      .where(withProject(taskTemplates, eq(taskTemplates.id, id)))
      .returning();
    return row;
  }

  async deleteTaskTemplate(id: string): Promise<void> {
    // FK onDelete:"set null" on tasks.template_id clears provenance automatically.
    await db.delete(taskTemplates).where(withProject(taskTemplates, eq(taskTemplates.id, id)));
  }

}

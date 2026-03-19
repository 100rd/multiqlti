import { eq, desc, and, or, ilike, lt, ne, gte, lte, asc, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import type { IStorage, LlmRequestFilters, LlmRequestStats, LlmStatsByModel, LlmStatsByProvider, LlmStatsByTeam, LlmTimelinePoint } from "./storage";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig } from "@shared/types";
import {
  users, models, pipelines, pipelineRuns,
  stageExecutions, questions, chatMessages, llmRequests,
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
  traces,
  type UserRow, type InsertUser,
  type Model, type InsertModel,
  type Pipeline, type InsertPipeline,
  type PipelineRun, type InsertPipelineRun,
  type StageExecution, type InsertStageExecution,
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
  type TriggerRow,
  type InsertTrace,
  type TraceRow,
  taskGroups,
  tasks,
  taskTraces,
  trackerConnections,
  type TaskGroupRow,
  type InsertTaskGroup,
  type TaskRow,
  type InsertTask,
  type TaskTraceRow,
  type InsertTaskTrace,
  type TrackerConnectionRow,
  type InsertTrackerConnection,
  type ModelSkillBinding,
  type InsertModelSkillBinding,
} from "@shared/schema";
import type { TraceSpan, SkillVersionRecord, MarketplaceSkill, MarketplaceFilters, InsertSkillVersion } from "@shared/types";

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
    return db.select().from(models).where(eq(models.isActive, true));
  }

  async getModelBySlug(slug: string): Promise<Model | undefined> {
    const [row] = await db.select().from(models).where(eq(models.slug, slug));
    return row;
  }

  async createModel(model: InsertModel): Promise<Model> {
    const [row] = await db.insert(models).values(model).returning();
    return row;
  }

  async updateModel(id: string, updates: Partial<InsertModel>): Promise<Model> {
    const [row] = await db
      .update(models)
      .set(updates)
      .where(eq(models.id, id))
      .returning();
    if (!row) throw new Error(`Model not found: ${id}`);
    return row;
  }

  async deleteModel(id: string): Promise<void> {
    await db.delete(models).where(eq(models.id, id));
  }

  // ─── Pipelines ──────────────────────────────────────

  async getPipelines(): Promise<Pipeline[]> {
    return db.select().from(pipelines);
  }

  async getPipeline(id: string): Promise<Pipeline | undefined> {
    const [row] = await db.select().from(pipelines).where(eq(pipelines.id, id));
    return row;
  }

  async getTemplates(): Promise<Pipeline[]> {
    return db.select().from(pipelines).where(eq(pipelines.isTemplate, true));
  }

  async createPipeline(pipeline: InsertPipeline): Promise<Pipeline> {
    const [row] = await db.insert(pipelines).values(pipeline).returning();
    return row;
  }

  async updatePipeline(id: string, updates: Partial<InsertPipeline>): Promise<Pipeline> {
    const [row] = await db
      .update(pipelines)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(pipelines.id, id))
      .returning();
    if (!row) throw new Error(`Pipeline not found: ${id}`);
    return row;
  }

  async deletePipeline(id: string): Promise<void> {
    await db.delete(pipelines).where(eq(pipelines.id, id));
  }

  // ─── Pipeline Runs ──────────────────────────────────

  async getPipelineRuns(pipelineId?: string): Promise<PipelineRun[]> {
    if (pipelineId) {
      return db
        .select()
        .from(pipelineRuns)
        .where(eq(pipelineRuns.pipelineId, pipelineId))
        .orderBy(desc(pipelineRuns.createdAt));
    }
    return db.select().from(pipelineRuns).orderBy(desc(pipelineRuns.createdAt));
  }

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    const [row] = await db
      .select()
      .from(pipelineRuns)
      .where(eq(pipelineRuns.id, id));
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
      .where(eq(pipelineRuns.id, id))
      .returning();
    if (!row) throw new Error(`Run not found: ${id}`);
    return row;
  }

  // ─── Stage Executions ───────────────────────────────

  async getStageExecutions(runId: string): Promise<StageExecution[]> {
    return db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.runId, runId))
      .orderBy(stageExecutions.stageIndex);
  }

  async getStageExecution(id: string): Promise<StageExecution | undefined> {
    const [row] = await db
      .select()
      .from(stageExecutions)
      .where(eq(stageExecutions.id, id));
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
      .where(eq(stageExecutions.id, id))
      .returning();
    if (!row) throw new Error(`Stage execution not found: ${id}`);
    return row;
  }

  // ─── Questions ──────────────────────────────────────

  async getQuestions(runId: string): Promise<Question[]> {
    return db
      .select()
      .from(questions)
      .where(eq(questions.runId, runId))
      .orderBy(questions.createdAt);
  }

  async getPendingQuestions(runId?: string): Promise<Question[]> {
    if (runId) {
      return db
        .select()
        .from(questions)
        .where(
          and(eq(questions.status, "pending"), eq(questions.runId, runId)),
        );
    }
    return db
      .select()
      .from(questions)
      .where(eq(questions.status, "pending"));
  }

  async getQuestion(id: string): Promise<Question | undefined> {
    const [row] = await db
      .select()
      .from(questions)
      .where(eq(questions.id, id));
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
      .where(eq(questions.id, id))
      .returning();
    if (!row) throw new Error(`Question not found: ${id}`);
    return row;
  }

  async dismissQuestion(id: string): Promise<Question> {
    const [row] = await db
      .update(questions)
      .set({ status: "dismissed" })
      .where(eq(questions.id, id))
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
      query = query.where(eq(chatMessages.runId, runId));
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
      .where(whereClause);
    const total = countRow?.count ?? 0;

    // Paginated rows
    const page = filters.page ?? 1;
    const limit = filters.limit ?? 50;
    const offset = (page - 1) * limit;

    const rows = await db
      .select()
      .from(llmRequests)
      .where(whereClause)
      .orderBy(desc(llmRequests.createdAt))
      .limit(limit)
      .offset(offset);

    return { rows, total };
  }

  async getLlmRequestById(id: number): Promise<LlmRequest | undefined> {
    const [row] = await db
      .select()
      .from(llmRequests)
      .where(eq(llmRequests.id, id));
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
      .where(drizzleSql`team_id is not null`)
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
      .where(and(gte(llmRequests.createdAt, from), lte(llmRequests.createdAt, to)))
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

    const rows = await db.select().from(memories).where(and(...conditions));
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

    const rows = await db.select().from(memories).where(condition);
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
    await db.delete(memories).where(eq(memories.id, id));
  }

  async decayMemories(excludeRunId: number, decayAmount: number): Promise<number> {
    const result = await db
      .update(memories)
      .set({
        confidence: drizzleSql`${memories.confidence} - ${decayAmount}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          ne(memories.createdByRunId, excludeRunId),
          drizzleSql`${memories.confidence} > ${decayAmount}`,
        ),
      )
      .returning({ id: memories.id });
    return result.length;
  }

  async deleteStaleMemories(threshold: number): Promise<number> {
    const result = await db
      .delete(memories)
      .where(lt(memories.confidence, threshold))
      .returning({ id: memories.id });
    return result.length;
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
    const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
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
      .where(eq(mcpServers.id, id))
      .returning();
    if (!row) throw new Error(`MCP server not found: ${id}`);
    return this.rowToMcpServer(row);
  }

  async deleteMcpServer(id: number): Promise<void> {
    await db.delete(mcpServers).where(eq(mcpServers.id, id));
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
      .where(eq(delegationRequests.runId, runId))
      .orderBy(asc(delegationRequests.createdAt));
  }

  async updateDelegationRequest(
    id: string,
    updates: Partial<DelegationRequestRow>,
  ): Promise<DelegationRequestRow> {
    const [row] = await db
      .update(delegationRequests)
      .set(updates)
      .where(eq(delegationRequests.id, id))
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
    await db.delete(specializationProfiles).where(eq(specializationProfiles.id, id));
  }

  // ─── Skills ─────────────────────────────────────────────────────────────────

  async getSkills(filter?: { teamId?: string; isBuiltin?: boolean }): Promise<Skill[]> {
    const conditions = [];
    if (filter?.teamId !== undefined) conditions.push(eq(skills.teamId, filter.teamId));
    if (filter?.isBuiltin !== undefined) conditions.push(eq(skills.isBuiltin, filter.isBuiltin));

    return conditions.length > 0
      ? db.select().from(skills).where(and(...conditions)).orderBy(skills.name)
      : db.select().from(skills).orderBy(skills.name);
  }

  async getSkill(id: string): Promise<Skill | undefined> {
    const [row] = await db.select().from(skills).where(eq(skills.id, id));
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
      .where(eq(skills.id, id))
      .returning();
    if (!row) throw new Error(`Skill not found: ${id}`);
    return row;
  }

  async deleteSkill(id: string): Promise<void> {
    await db.delete(skills).where(eq(skills.id, id));
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
      .where(eq(skillVersions.skillId, skillId));
    const total = countResult[0]?.count ?? 0;

    const rows = await db
      .select()
      .from(skillVersions)
      .where(eq(skillVersions.skillId, skillId))
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
      .where(
        and(
          eq(skillVersions.skillId, skillId),
          eq(skillVersions.version, version),
        ),
      );
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
      .where(whereClause);
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
      .select()
      .from(skills)
      .where(whereClause)
      .orderBy(orderBy)
      .limit(filters.limit)
      .offset(filters.offset);

    const mapped: MarketplaceSkill[] = rows.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      teamId: s.teamId,
      tags: s.tags as string[],
      version: s.version,
      author: s.createdBy,
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
      .where(eq(skills.id, id))
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
    await db.delete(skillTeams).where(eq(skillTeams.id, id));
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
      .where(
        and(
          eq(managerIterations.runId, runId),
          eq(managerIterations.iterationNumber, iterationNumber),
        ),
      );
  }

  async getManagerIterations(
    runId: string,
    offset = 0,
    limit = 50,
  ): Promise<ManagerIterationRow[]> {
    return db
      .select()
      .from(managerIterations)
      .where(eq(managerIterations.runId, runId))
      .orderBy(asc(managerIterations.iterationNumber))
      .limit(limit)
      .offset(offset);
  }

  async countManagerIterations(runId: string): Promise<number> {
    const result = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(managerIterations)
      .where(eq(managerIterations.runId, runId));
    return result[0]?.count ?? 0;
  }

  // ─── Triggers (Phase 6.3) ─────────────────────────────────────────────────

  async getTriggers(pipelineId: string): Promise<TriggerRow[]> {
    return db.select().from(triggers).where(eq(triggers.pipelineId, pipelineId)).orderBy(triggers.createdAt);
  }

  async getTrigger(id: string): Promise<TriggerRow | undefined> {
    const [row] = await db.select().from(triggers).where(eq(triggers.id, id));
    return row;
  }

  async getEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return db
      .select()
      .from(triggers)
      .where(and(eq(triggers.enabled, true), eq(triggers.type, type as TriggerRow["type"])));
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
      .where(eq(triggers.id, id))
      .returning();
    if (!row) throw new Error(`Trigger not found: ${id}`);
    return row;
  }

  async deleteTrigger(id: string): Promise<void> {
    await db.delete(triggers).where(eq(triggers.id, id));
  }

  // ─── Traces (Phase 6.5) ────────────────────────────────────────────────────

  async createTrace(data: InsertTrace): Promise<TraceRow> {
    const [row] = await db.insert(traces).values(data).returning();
    return row;
  }

  async getTraceByRunId(runId: string): Promise<TraceRow | null> {
    const [row] = await db.select().from(traces).where(eq(traces.runId, runId)).limit(1);
    return row ?? null;
  }

  async getTraceByTraceId(traceId: string): Promise<TraceRow | null> {
    const [row] = await db.select().from(traces).where(eq(traces.traceId, traceId)).limit(1);
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
      .where(eq(traces.traceId, traceId));
  }

  // ─── Task Groups (Task Orchestrator) ────────────────────────────────────────

  async getTaskGroups(): Promise<TaskGroupRow[]> {
    return db.select().from(taskGroups).orderBy(desc(taskGroups.createdAt));
  }

  async getTaskGroup(id: string): Promise<TaskGroupRow | undefined> {
    const [row] = await db.select().from(taskGroups).where(eq(taskGroups.id, id));
    return row;
  }

  async createTaskGroup(data: InsertTaskGroup): Promise<TaskGroupRow> {
    const [row] = await db.insert(taskGroups).values(data as typeof taskGroups.$inferInsert).returning();
    return row;
  }

  async updateTaskGroup(id: string, updates: Partial<TaskGroupRow>): Promise<TaskGroupRow> {
    const [row] = await db.update(taskGroups).set(updates).where(eq(taskGroups.id, id)).returning();
    return row;
  }

  async deleteTaskGroup(id: string): Promise<void> {
    await db.delete(taskGroups).where(eq(taskGroups.id, id));
  }

  // ─── Tasks (Task Orchestrator) ──────────────────────────────────────────────

  async getTasksByGroup(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(eq(tasks.groupId, groupId))
      .orderBy(asc(tasks.sortOrder), asc(tasks.createdAt));
  }

  async getTask(id: string): Promise<TaskRow | undefined> {
    const [row] = await db.select().from(tasks).where(eq(tasks.id, id));
    return row;
  }

  async createTask(data: InsertTask): Promise<TaskRow> {
    const [row] = await db.insert(tasks).values(data as typeof tasks.$inferInsert).returning();
    return row;
  }

  async updateTask(id: string, updates: Partial<TaskRow>): Promise<TaskRow> {
    const [row] = await db.update(tasks).set(updates).where(eq(tasks.id, id)).returning();
    return row;
  }

  async getReadyTasks(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(and(eq(tasks.groupId, groupId), eq(tasks.status, "ready")))
      .orderBy(asc(tasks.sortOrder));
  }

  async getBlockedTasks(groupId: string): Promise<TaskRow[]> {
    return db.select().from(tasks)
      .where(and(eq(tasks.groupId, groupId), eq(tasks.status, "blocked")))
      .orderBy(asc(tasks.sortOrder));
  }

  // ─── Task Traces (End-to-End Request Observability) ──────────────────────────

  async createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow> {
    const [row] = await db.insert(taskTraces).values(data as typeof taskTraces.$inferInsert).returning();
    return row;
  }

  async getTaskTrace(groupId: string): Promise<TaskTraceRow | null> {
    const [row] = await db.select().from(taskTraces).where(eq(taskTraces.groupId, groupId));
    return row ?? null;
  }

  async updateTaskTrace(id: string, updates: Partial<TaskTraceRow>): Promise<TaskTraceRow> {
    const [row] = await db.update(taskTraces)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(taskTraces.id, id))
      .returning();
    return row;
  }

  // ─── Tracker Connections (Issue Tracker Integration) ────────────────────────

  async getTrackerConnectionsByGroup(taskGroupId: string): Promise<TrackerConnectionRow[]> {
    return db.select().from(trackerConnections)
      .where(eq(trackerConnections.taskGroupId, taskGroupId));
  }

  async getTrackerConnection(id: string): Promise<TrackerConnectionRow | undefined> {
    const [row] = await db.select().from(trackerConnections)
      .where(eq(trackerConnections.id, id));
    return row;
  }

  async createTrackerConnection(data: InsertTrackerConnection): Promise<TrackerConnectionRow> {
    const [row] = await db.insert(trackerConnections)
      .values(data as typeof trackerConnections.$inferInsert)
      .returning();
    return row;
  }

  async deleteTrackerConnection(id: string): Promise<void> {
    await db.delete(trackerConnections).where(eq(trackerConnections.id, id));
  }

  // ─── Model Skill Bindings (Phase 6.17) ──────────────────────────────────────

  async getModelSkillBindings(modelId: string): Promise<ModelSkillBinding[]> {
    return db.select().from(modelSkillBindings)
      .where(eq(modelSkillBindings.modelId, modelId))
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
      .where(
        and(
          eq(modelSkillBindings.modelId, modelId),
          eq(modelSkillBindings.skillId, skillId),
        ),
      )
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
      .where(eq(modelSkillBindings.modelId, modelId))
      .orderBy(asc(modelSkillBindings.createdAt));
    return rows.map((r) => r.skill);
  }

}

import { eq, desc, and, or, ilike, lt, ne, gte, lte, asc, sql as drizzleSql } from "drizzle-orm";
import { db } from "./db";
import type { IStorage, LlmRequestFilters, LlmRequestStats, LlmStatsByModel, LlmStatsByProvider, LlmStatsByTeam, LlmTimelinePoint, PendingApprovalRow } from "./storage";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig } from "@shared/types";
import {
  users, models, pipelines, pipelineRuns,
  stageExecutions, questions, chatMessages, llmRequests,
  memories,
  mcpServers,
  delegationRequests,
  specializationProfiles,
  skills,
  triggers,
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
  type TriggerRow,
} from "@shared/schema";

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
    if (filters.stageExecutionId) conditions.push(eq(llmRequests.stageExecutionId, filters.stageExecutionId));
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
    const [row] = await db.insert(skills).values(data).returning();
    return row;
  }

  async updateSkill(id: string, updates: Partial<InsertSkill>): Promise<Skill> {
    const [row] = await db
      .update(skills)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(skills.id, id))
      .returning();
    if (!row) throw new Error(`Skill not found: ${id}`);
    return row;
  }

  async deleteSkill(id: string): Promise<void> {
    await db.delete(skills).where(eq(skills.id, id));
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

  // ─── Pending Approvals (Phase 3.4) ──────────────────────────────────────

  async getPendingApprovals(filters: {
    pipelineId?: string;
    limit: number;
    offset: number;
  }): Promise<{ rows: PendingApprovalRow[]; total: number }> {
    const conditions = [
      eq(stageExecutions.status, "awaiting_approval"),
      eq(stageExecutions.approvalStatus, "pending"),
    ];

    if (filters.pipelineId) {
      conditions.push(eq(pipelineRuns.pipelineId, filters.pipelineId));
    }

    const whereClause = and(...conditions);

    // Count total
    const [countRow] = await db
      .select({ count: drizzleSql<number>`count(*)::int` })
      .from(stageExecutions)
      .innerJoin(pipelineRuns, eq(stageExecutions.runId, pipelineRuns.id))
      .where(whereClause);
    const total = countRow?.count ?? 0;

    // Fetch rows with pipeline name
    const rows = await db
      .select({
        runId: stageExecutions.runId,
        pipelineId: pipelineRuns.pipelineId,
        pipelineName: pipelines.name,
        stageIndex: stageExecutions.stageIndex,
        stageExecutionId: stageExecutions.id,
        teamId: stageExecutions.teamId,
        modelSlug: stageExecutions.modelSlug,
        gateConfig: stageExecutions.approvalGateConfig,
        startedAt: stageExecutions.startedAt,
        createdAt: stageExecutions.createdAt,
        output: stageExecutions.output,
      })
      .from(stageExecutions)
      .innerJoin(pipelineRuns, eq(stageExecutions.runId, pipelineRuns.id))
      .innerJoin(pipelines, eq(pipelineRuns.pipelineId, pipelines.id))
      .where(whereClause)
      .orderBy(asc(stageExecutions.startedAt))
      .limit(filters.limit)
      .offset(filters.offset);

    const mapped: PendingApprovalRow[] = rows.map((r) => ({
      runId: r.runId,
      pipelineId: r.pipelineId,
      pipelineName: r.pipelineName,
      stageIndex: r.stageIndex,
      stageExecutionId: r.stageExecutionId,
      teamId: r.teamId,
      modelSlug: r.modelSlug,
      gateConfig: r.gateConfig as Record<string, unknown> | null,
      awaitingSince: (r.startedAt ?? r.createdAt ?? new Date()).toISOString(),
      output: r.output as Record<string, unknown> | null,
    }));

    return { rows: mapped, total };
  }

}

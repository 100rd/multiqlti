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
  type InsertLlmRequest,
} from "@shared/schema";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig } from "@shared/types";
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

export interface LlmTimelinePoint {
  date: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

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
  getPipelineRun(id: string): Promise<PipelineRun | undefined>;
  createPipelineRun(run: InsertPipelineRun): Promise<PipelineRun>;
  updatePipelineRun(id: string, updates: Partial<PipelineRun>): Promise<PipelineRun>;

  // Stage Executions
  getStageExecutions(runId: string): Promise<StageExecution[]>;
  getStageExecution(id: string): Promise<StageExecution | undefined>;
  createStageExecution(execution: InsertStageExecution): Promise<StageExecution>;
  updateStageExecution(id: string, updates: Partial<StageExecution>): Promise<StageExecution>;

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
  getLlmTimeline(from: Date, to: Date, granularity: 'day' | 'week'): Promise<LlmTimelinePoint[]>;

  // Memories
  getMemories(scope: MemoryScope, scopeId?: string | null, type?: MemoryType): Promise<Memory[]>;
  searchMemories(query: string, scope?: MemoryScope): Promise<Memory[]>;
  upsertMemory(memory: InsertMemory): Promise<Memory>;
  deleteMemory(id: number): Promise<void>;
  decayMemories(excludeRunId: number, decayAmount: number): Promise<number>;
  deleteStaleMemories(threshold: number): Promise<number>;

  // MCP Servers
  getMcpServers(): Promise<McpServerConfig[]>;
  getMcpServer(id: number): Promise<McpServerConfig | undefined>;
  createMcpServer(config: Omit<McpServerConfig, 'id'>): Promise<McpServerConfig>;
  updateMcpServer(id: number, updates: Partial<McpServerConfig>): Promise<McpServerConfig>;
  deleteMcpServer(id: number): Promise<void>;
}

export class MemStorage implements IStorage {
  private usersMap: Map<string, UserRow>;
  private models: Map<string, Model>;
  private pipelinesMap: Map<string, Pipeline>;
  private runs: Map<string, PipelineRun>;
  private stages: Map<string, StageExecution>;
  private questionsMap: Map<string, Question>;
  private messages: Map<string, ChatMessage>;
  private llmRequestsMap: Map<number, LlmRequest>;
  private llmRequestIdSeq: number;
  private memoriesMap: Map<number, Memory>;
  private nextMemoryId: number;
  private mcpServersMap: Map<number, McpServerConfig>;
  private nextMcpServerId: number;

  constructor() {
    this.usersMap = new Map();
    this.models = new Map();
    this.pipelinesMap = new Map();
    this.runs = new Map();
    this.stages = new Map();
    this.questionsMap = new Map();
    this.messages = new Map();
    this.llmRequestsMap = new Map();
    this.llmRequestIdSeq = 1;
    this.memoriesMap = new Map();
    this.nextMemoryId = 1;
    this.mcpServersMap = new Map();
    this.nextMcpServerId = 1;
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
      passwordHash: insertUser.passwordHash,
      isActive: insertUser.isActive ?? true,
      role: (insertUser.role as 'user' | 'maintainer' | 'admin') ?? 'user',
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
      id,
      name: insert.name,
      description: insert.description ?? null,
      stages: insert.stages ?? [],
      createdBy: insert.createdBy ?? null,
      ownerId: insert.ownerId ?? null,
      isTemplate: insert.isTemplate ?? false,
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

  async getPipelineRun(id: string): Promise<PipelineRun | undefined> {
    return this.runs.get(id);
  }

  async createPipelineRun(insert: InsertPipelineRun): Promise<PipelineRun> {
    const id = randomUUID();
    const run: PipelineRun = {
      id,
      pipelineId: insert.pipelineId,
      status: insert.status ?? "pending",
      input: insert.input,
      output: insert.output ?? null,
      currentStageIndex: insert.currentStageIndex ?? 0,
      startedAt: insert.startedAt ?? null,
      completedAt: insert.completedAt ?? null,
      triggeredBy: insert.triggeredBy ?? null,
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

}

export const storage: IStorage = configLoader.get().database.url
  ? new PgStorage()
  : new MemStorage();

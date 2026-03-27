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
  type TaskGroupRow,
  type InsertTaskGroup,
  type TaskRow,
  type InsertTask,
  type TaskTraceRow,
  type InsertTaskTrace,
  type TrackerConnectionRow,
  type InsertTrackerConnection,
  type SkillTeam,
  type InsertSkillTeam,
  type ModelSkillBinding,
  type InsertModelSkillBinding,
  type ArgoCdConfigRow,
  type InsertArgoCdConfig,
  type WorkspaceRow,
  type InsertWorkspace,
  type SharedSessionRow,
} from "@shared/schema";
import type { Memory, InsertMemory, MemoryScope, MemoryType, McpServerConfig, TraceSpan, TaskTraceSpan, SkillVersionRecord, MarketplaceSkill, MarketplaceFilters, InsertSkillVersion as InsertSkillVersionType, SharedSession, CreateSharedSessionInput, SharePermissions, ShareRole } from "@shared/types";
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

  // Marketplace (Phase 6.16)
  getMarketplaceSkills(filters: MarketplaceFilters): Promise<{ skills: MarketplaceSkill[]; total: number }>;
  incrementSkillUsage(id: string): Promise<number>;

  // Skill Teams
  getSkillTeams(): Promise<SkillTeam[]>;
  createSkillTeam(data: InsertSkillTeam): Promise<SkillTeam>;
  deleteSkillTeam(id: string): Promise<void>;

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
  getTrigger(id: string): Promise<TriggerRow | undefined>;
  getEnabledTriggersByType(type: string): Promise<TriggerRow[]>;
  createTrigger(data: Omit<TriggerRow, 'id' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt'> & { secretEncrypted?: string | null }): Promise<TriggerRow>;
  updateTrigger(id: string, updates: Partial<TriggerRow>): Promise<TriggerRow>;
  deleteTrigger(id: string): Promise<void>;

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
  getReadyTasks(groupId: string): Promise<TaskRow[]>;
  getBlockedTasks(groupId: string): Promise<TaskRow[]>;

  // Task Traces (End-to-End Request Observability)
  createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow>;
  getTaskTrace(groupId: string): Promise<TaskTraceRow | null>;
  updateTaskTrace(id: string, updates: Partial<TaskTraceRow>): Promise<TaskTraceRow>;

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
  saveArgoCdConfig(config: Partial<InsertArgoCdConfig> & { id?: number }): Promise<ArgoCdConfigRow>;
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
  private delegationsMap: Map<string, DelegationRequestRow>;
  private managerIterationsMap: Map<string, ManagerIterationRow> = new Map();
  private specializationProfilesMap: Map<string, SpecializationProfileRow>;

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

  // ─── Marketplace (Phase 6.16) ───────────────────────────────────────────────

  async getMarketplaceSkills(
    filters: MarketplaceFilters,
  ): Promise<{ skills: MarketplaceSkill[]; total: number }> {
    let result = Array.from(this.skillsMap.values()).filter((s) => {
      const sharing = (s as Skill & { sharing?: string }).sharing ?? "public";
      return sharing === "public" || sharing === "team";
    });

    if (filters.search) {
      const lower = filters.search.toLowerCase();
      result = result.filter(
        (s) =>
          s.name.toLowerCase().includes(lower) ||
          s.description.toLowerCase().includes(lower) ||
          (s.tags as string[]).some((t) => t.toLowerCase().includes(lower)),
      );
    }

    if (filters.tags && filters.tags.length > 0) {
      result = result.filter((s) =>
        filters.tags!.some((t) => (s.tags as string[]).includes(t)),
      );
    }

    if (filters.teamId) {
      result = result.filter((s) => s.teamId === filters.teamId);
    }

    if (filters.author) {
      result = result.filter((s) => s.createdBy === filters.author);
    }

    const mapped: MarketplaceSkill[] = result.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      teamId: s.teamId,
      tags: s.tags as string[],
      version: (s as Skill & { version?: string }).version ?? "1.0.0",
      author: s.createdBy,
      usageCount: (s as Skill & { usageCount?: number }).usageCount ?? 0,
      sharing: ((s as Skill & { sharing?: string }).sharing ?? "public") as MarketplaceSkill["sharing"],
      modelPreference: s.modelPreference,
      createdAt: s.createdAt ?? new Date(),
      updatedAt: s.updatedAt ?? new Date(),
    }));

    switch (filters.sort) {
      case "usageCount":
        mapped.sort((a, b) => b.usageCount - a.usageCount);
        break;
      case "name":
        mapped.sort((a, b) => a.name.localeCompare(b.name));
        break;
      case "newest":
      default:
        mapped.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        break;
    }

    const total = mapped.length;
    const skills = mapped.slice(filters.offset, filters.offset + filters.limit);
    return { skills, total };
  }

  async incrementSkillUsage(id: string): Promise<number> {
    const skill = this.skillsMap.get(id);
    if (!skill) throw new Error(`Skill not found: ${id}`);
    const currentCount = (skill as Skill & { usageCount?: number }).usageCount ?? 0;
    const updated = { ...skill, usageCount: currentCount + 1 };
    this.skillsMap.set(id, updated as Skill);
    return currentCount + 1;
  }

  // ─── Skill Teams ────────────────────────────────────────────────

  private skillTeamsMap: Map<string, SkillTeam> = new Map();

  async getSkillTeams(): Promise<SkillTeam[]> {
    return Array.from(this.skillTeamsMap.values()).sort((a, b) =>
      a.createdAt.getTime() - b.createdAt.getTime(),
    );
  }

  async createSkillTeam(data: InsertSkillTeam): Promise<SkillTeam> {
    const id = randomUUID();
    const row: SkillTeam = {
      id,
      name: data.name,
      description: data.description ?? "",
      createdBy: data.createdBy ?? null,
      createdAt: new Date(),
    };
    this.skillTeamsMap.set(id, row);
    return row;
  }

  async deleteSkillTeam(id: string): Promise<void> {
    this.skillTeamsMap.delete(id);
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

  // ─── Triggers (Phase 6.3) ─────────────────────────────────────────────────

  private triggersMap: Map<string, TriggerRow> = new Map();

  async getTriggers(pipelineId: string): Promise<TriggerRow[]> {
    return Array.from(this.triggersMap.values()).filter((t) => t.pipelineId === pipelineId);
  }

  async getTrigger(id: string): Promise<TriggerRow | undefined> {
    return this.triggersMap.get(id);
  }

  async getEnabledTriggersByType(type: string): Promise<TriggerRow[]> {
    return Array.from(this.triggersMap.values()).filter((t) => t.enabled && t.type === type);
  }

  async createTrigger(
    data: Omit<TriggerRow, 'id' | 'createdAt' | 'updatedAt' | 'lastTriggeredAt'> & { secretEncrypted?: string | null },
  ): Promise<TriggerRow> {
    const id = randomUUID();
    const now = new Date();
    const row: TriggerRow = {
      id,
      pipelineId: data.pipelineId,
      type: data.type as TriggerRow["type"],
      config: (data.config ?? {}) as TriggerRow["config"],
      secretEncrypted: data.secretEncrypted ?? null,
      enabled: data.enabled ?? true,
      lastTriggeredAt: null,
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
    const row: TaskGroupRow = { id, name: data.name, description: data.description, input: data.input, status: (data.status as TaskGroupRow["status"]) ?? "pending", output: data.output ?? null, traceId: (data as Record<string, unknown>).traceId as string | null ?? null, createdBy: data.createdBy ?? null, startedAt: data.startedAt ?? null, completedAt: data.completedAt ?? null, createdAt: new Date() };
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
      modelSlug: data.modelSlug ?? null,
      teamId: data.teamId ?? null,
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

  // ─── Task Traces (End-to-End Request Observability) ──────────────────────────

  private taskTracesMap = new Map<string, TaskTraceRow>();
  private taskTracesByGroupId = new Map<string, TaskTraceRow>();

  async createTaskTrace(data: InsertTaskTrace): Promise<TaskTraceRow> {
    const id = randomUUID();
    const now = new Date();
    const row: TaskTraceRow = {
      id,
      groupId: data.groupId,
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

  async saveArgoCdConfig(config: Partial<InsertArgoCdConfig> & { id?: number }): Promise<ArgoCdConfigRow> {
    const now = new Date();
    if (this.argoCdConfigRow) {
      // Update existing
      this.argoCdConfigRow = {
        ...this.argoCdConfigRow,
        ...config,
        updatedAt: now,
      } as ArgoCdConfigRow;
    } else {
      // Create new
      this.argoCdConfigRow = {
        id: config.id ?? 1,
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

}

export const storage: IStorage = configLoader.get().database.url
  ? new PgStorage()
  : new MemStorage();

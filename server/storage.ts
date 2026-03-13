import {
  type User,
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
} from "@shared/schema";
import { randomUUID } from "crypto";

export interface IStorage {
  // Users
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;

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
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private models: Map<string, Model>;
  private pipelinesMap: Map<string, Pipeline>;
  private runs: Map<string, PipelineRun>;
  private stages: Map<string, StageExecution>;
  private questionsMap: Map<string, Question>;
  private messages: Map<string, ChatMessage>;

  constructor() {
    this.users = new Map();
    this.models = new Map();
    this.pipelinesMap = new Map();
    this.runs = new Map();
    this.stages = new Map();
    this.questionsMap = new Map();
    this.messages = new Map();
  }

  // ─── Users ──────────────────────────────────────

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
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
}

export const storage = new MemStorage();

import { eq, desc, and } from "drizzle-orm";
import { db } from "./db";
import type { IStorage } from "./storage";
import {
  users, models, pipelines, pipelineRuns,
  stageExecutions, questions, chatMessages,
  type User, type InsertUser,
  type Model, type InsertModel,
  type Pipeline, type InsertPipeline,
  type PipelineRun, type InsertPipelineRun,
  type StageExecution, type InsertStageExecution,
  type Question, type InsertQuestion,
  type ChatMessage, type InsertChatMessage,
} from "@shared/schema";

export class PgStorage implements IStorage {

  // ─── Users ──────────────────────────────────────────

  async getUser(id: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.id, id));
    return row;
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    const [row] = await db.select().from(users).where(eq(users.username, username));
    return row;
  }

  async createUser(user: InsertUser): Promise<User> {
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
}

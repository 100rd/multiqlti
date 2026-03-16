import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  varchar,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  real,
  unique,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { MaintenanceCategoryConfig, ScoutFinding, TriggerConfig, TriggerType, TraceSpan } from "./types.js";

// ─── RBAC ────────────────────────────────────────────

export const USER_ROLES = ["user", "maintainer", "admin"] as const;
export type UserRole = typeof USER_ROLES[number];

// ─── Users ──────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  role: text("role").notNull().default("user").$type<UserRole>(),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({ role: z.enum(USER_ROLES).optional() });

export type InsertUser = z.infer<typeof insertUserSchema>;
export type UserRow = typeof users.$inferSelect;

// ─── Sessions ────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type SessionRow = typeof sessions.$inferSelect;

// ─── Models ─────────────────────────────────────────

export const models = pgTable("models", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  // Provider-side model identifier, e.g. "claude-sonnet-4-6", "grok-3"
  // Null for self-hosted models where model name IS the modelId.
  modelId: text("model_id"),
  endpoint: text("endpoint"),
  provider: text("provider").notNull().default("mock"),
  contextLimit: integer("context_limit").notNull().default(4096),
  capabilities: jsonb("capabilities").notNull().default(sql`'[]'::jsonb`),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertModelSchema = createInsertSchema(models).omit({
  id: true,
  createdAt: true,
});

export type InsertModel = z.infer<typeof insertModelSchema>;
export type Model = typeof models.$inferSelect;

// ─── Pipelines ──────────────────────────────────────

export const pipelines = pgTable("pipelines", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description"),
  stages: jsonb("stages").notNull().default(sql`'[]'::jsonb`),
  dag: jsonb("dag"),
  createdBy: varchar("created_by"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  isTemplate: boolean("is_template").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertPipelineSchema = createInsertSchema(pipelines).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertPipeline = z.infer<typeof insertPipelineSchema>;
export type Pipeline = typeof pipelines.$inferSelect;

// ─── Pipeline Runs ──────────────────────────────────

export const pipelineRuns = pgTable("pipeline_runs", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  pipelineId: varchar("pipeline_id").notNull(),
  status: text("status").notNull().default("pending"),
  input: text("input").notNull(),
  output: jsonb("output"),
  currentStageIndex: integer("current_stage_index").notNull().default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
  dagMode: boolean("dag_mode").notNull().default(false),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertPipelineRunSchema = createInsertSchema(pipelineRuns).omit({
  id: true,
  createdAt: true,
});

export type InsertPipelineRun = z.infer<typeof insertPipelineRunSchema>;
export type PipelineRun = typeof pipelineRuns.$inferSelect;

// ─── Stage Executions ───────────────────────────────

export const stageExecutions = pgTable("stage_executions", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull(),
  stageIndex: integer("stage_index").notNull(),
  teamId: text("team_id").notNull(),
  modelSlug: text("model_slug").notNull(),
  status: text("status").notNull().default("pending"),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  tokensUsed: integer("tokens_used").default(0),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  sandboxResult: jsonb("sandbox_result"),
  thoughtTree: jsonb("thought_tree"),
  // ─── Approval Gate Fields ───────────────────────
  approvalStatus: text("approval_status"),  // 'pending' | 'approved' | 'rejected'
  approvedAt: timestamp("approved_at"),
  approvedBy: text("approved_by"),
  rejectionReason: text("rejection_reason"),
  dagStageId: text("dag_stage_id"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertStageExecutionSchema = createInsertSchema(
  stageExecutions,
).omit({
  id: true,
  createdAt: true,
});

export type InsertStageExecution = z.infer<typeof insertStageExecutionSchema>;
export type StageExecution = typeof stageExecutions.$inferSelect;

// ─── Questions ──────────────────────────────────────

export const questions = pgTable("questions", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull(),
  stageExecutionId: varchar("stage_execution_id").notNull(),
  question: text("question").notNull(),
  context: text("context"),
  answer: text("answer"),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
  answeredAt: timestamp("answered_at"),
});

export const insertQuestionSchema = createInsertSchema(questions).omit({
  id: true,
  createdAt: true,
});

export type InsertQuestion = z.infer<typeof insertQuestionSchema>;
export type Question = typeof questions.$inferSelect;

// ─── Chat Messages ──────────────────────────────────

export const chatMessages = pgTable("chat_messages", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  runId: varchar("run_id"),
  role: text("role").notNull(),
  agentTeam: text("agent_team"),
  modelSlug: text("model_slug"),
  content: text("content").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertChatMessageSchema = createInsertSchema(chatMessages).omit({
  id: true,
  createdAt: true,
});

export type InsertChatMessage = z.infer<typeof insertChatMessageSchema>;
export type ChatMessage = typeof chatMessages.$inferSelect;

// ─── Provider Keys ──────────────────────────────────

export const providerKeys = pgTable("provider_keys", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  provider: text("provider").notNull().unique(),
  apiKeyEncrypted: text("api_key_encrypted").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type ProviderKey = typeof providerKeys.$inferSelect;

// ─── Anonymization Patterns ──────────────────────────────────────────────────

export const anonymizationPatterns = pgTable("anonymization_patterns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  entityType: text("entity_type").notNull().default("custom_pattern"),
  regexPattern: text("regex_pattern").notNull(),
  severity: text("severity").notNull().default("high"),
  pseudonymTemplate: text("pseudonym_template"),
  allowlist: jsonb("allowlist").$type<string[]>().default([]).notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertAnonymizationPatternSchema = createInsertSchema(anonymizationPatterns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type AnonymizationPattern = typeof anonymizationPatterns.$inferSelect;

// ─── Anonymization Audit Log ─────────────────────────────────────────────────

export const anonymizationLog = pgTable("anonymization_log", {
  id: serial("id").primaryKey(),
  runId: text("run_id"),
  sessionId: text("session_id").notNull(),
  level: text("level").notNull(),
  entitiesFound: integer("entities_found").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
});

export type AnonymizationLogEntry = typeof anonymizationLog.$inferSelect;

// ─── LLM Requests ───────────────────────────────────

export const llmRequests = pgTable("llm_requests", {
  id: serial("id").primaryKey(),
  runId: varchar("run_id"),
  stageExecutionId: varchar("stage_execution_id"),
  modelSlug: text("model_slug").notNull(),
  provider: text("provider").notNull(),
  messages: jsonb("messages").notNull(),
  systemPrompt: text("system_prompt"),
  temperature: real("temperature"),
  maxTokens: integer("max_tokens"),
  responseContent: text("response_content").notNull().default(""),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  totalTokens: integer("total_tokens").notNull().default(0),
  latencyMs: integer("latency_ms").notNull().default(0),
  estimatedCostUsd: real("estimated_cost_usd"),
  status: text("status").notNull().default("success"),
  errorMessage: text("error_message"),
  teamId: text("team_id"),
  tags: jsonb("tags").default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertLlmRequestSchema = createInsertSchema(llmRequests).omit({
  id: true,
  createdAt: true,
});

export type InsertLlmRequest = z.infer<typeof insertLlmRequestSchema>;
export type LlmRequest = typeof llmRequests.$inferSelect;

// ─── Memories ────────────────────────────────────────────────────────────────

export const memories = pgTable("memories", {
  id: serial("id").primaryKey(),
  scope: text("scope").notNull(),
  scopeId: text("scope_id"),
  type: text("type").notNull(),
  key: text("key").notNull(),
  content: text("content").notNull(),
  source: text("source"),
  confidence: real("confidence").notNull().default(1.0),
  tags: text("tags").array().default(sql`'{}'::text[]`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
  expiresAt: timestamp("expires_at"),
  createdByRunId: integer("created_by_run_id"),
}, (table) => ({
  scopeKeyUnique: unique().on(table.scope, table.scopeId, table.key),
}));

export type MemoryRow = typeof memories.$inferSelect;

// ─── MCP Servers ─────────────────────────────────────────────────────────────

export const mcpServers = pgTable("mcp_servers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  transport: text("transport").notNull(),  // 'stdio' | 'sse' | 'streamable-http'
  command: text("command"),
  args: jsonb("args").$type<string[]>(),
  url: text("url"),
  env: jsonb("env").$type<Record<string, string>>(),
  enabled: boolean("enabled").notNull().default(true),
  autoConnect: boolean("auto_connect").notNull().default(false),
  toolCount: integer("tool_count").default(0),
  lastConnectedAt: timestamp("last_connected_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertMcpServerSchema = createInsertSchema(mcpServers).omit({
  id: true,
  createdAt: true,
});

export type InsertMcpServer = z.infer<typeof insertMcpServerSchema>;
export type McpServerRow = typeof mcpServers.$inferSelect;

// ─── Workspaces ──────────────────────────────────────────────────────────────

export const workspaces = pgTable("workspaces", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull().$type<"local" | "remote">(),
  path: text("path").notNull(),
  branch: text("branch").notNull().default("main"),
  status: text("status").notNull().default("active").$type<"active" | "syncing" | "error">(),
  lastSyncAt: timestamp("last_sync_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertWorkspaceSchema = createInsertSchema(workspaces).omit({
  id: true,
  createdAt: true,
});

export type InsertWorkspace = z.infer<typeof insertWorkspaceSchema>;
export type WorkspaceRow = typeof workspaces.$inferSelect;

// ─── Maintenance Autopilot Schema (Phase 4.5) ────────────────────────────────

export const maintenancePolicies = pgTable("maintenance_policies", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  workspaceId: varchar("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),
  enabled: boolean("enabled").notNull().default(true),
  schedule: text("schedule").notNull().default("0 9 * * 1"),
  categories: jsonb("categories")
    .notNull()
    .$type<MaintenanceCategoryConfig[]>()
    .default(sql`'[]'::jsonb`),
  severityThreshold: text("severity_threshold").notNull().default("high"),
  autoMerge: boolean("auto_merge").notNull().default(false),
  notifyChannels: jsonb("notify_channels")
    .$type<string[]>()
    .default(sql`'[]'::jsonb`),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export type MaintenancePolicyRow = typeof maintenancePolicies.$inferSelect;

export const maintenanceScans = pgTable("maintenance_scans", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  policyId: varchar("policy_id").references(() => maintenancePolicies.id, {
    onDelete: "cascade",
  }),
  workspaceId: varchar("workspace_id").references(() => workspaces.id, {
    onDelete: "cascade",
  }),
  status: text("status").notNull().default("running"),
  findings: jsonb("findings")
    .notNull()
    .$type<ScoutFinding[]>()
    .default(sql`'[]'::jsonb`),
  importantCount: integer("important_count").notNull().default(0),
  triggeredPipelineId: varchar("triggered_pipeline_id"),
  startedAt: timestamp("started_at").defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").defaultNow(),
});

export type MaintenanceScanRow = typeof maintenanceScans.$inferSelect;

// ─── Delegation Requests (Phase 6.4) ─────────────────────────────────────────

export const delegationRequests = pgTable("delegation_requests", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull(),
  fromStage: text("from_stage").notNull(),
  toStage: text("to_stage").notNull(),
  task: text("task").notNull(),
  context: jsonb("context").notNull().default(sql`'{}'::jsonb`),
  priority: text("priority").notNull().default("blocking"),
  timeout: integer("timeout").notNull().default(30000),
  depth: integer("depth").notNull().default(0),
  status: text("status").notNull().default("pending"),
  result: jsonb("result"),
  errorMessage: text("error_message"),
  startedAt: timestamp("started_at").notNull().defaultNow(),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertDelegationRequestSchema = createInsertSchema(delegationRequests).omit({
  id: true,
  createdAt: true,
});

export type InsertDelegationRequest = z.infer<typeof insertDelegationRequestSchema>;
export type DelegationRequestRow = typeof delegationRequests.$inferSelect;
// ─── Specialization Profiles (Phase 5) ───────────────────────────────────────

export const specializationProfiles = pgTable("specialization_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  isBuiltIn: boolean("is_built_in").notNull().default(false),
  assignments: jsonb("assignments").notNull().$type<Record<string, string>>().default(sql`'{}'::jsonb`),
  createdAt: timestamp("created_at").defaultNow(),
});

export const insertSpecializationProfileSchema = createInsertSchema(specializationProfiles).omit({ id: true, createdAt: true });
export type InsertSpecializationProfile = z.infer<typeof insertSpecializationProfileSchema>;
export type SpecializationProfileRow = typeof specializationProfiles.$inferSelect;

// ─── Skills (Phase 3.1b) ─────────────────────────────────────────────────────

export const skills = pgTable("skills", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  teamId: text("team_id").notNull(),
  systemPromptOverride: text("system_prompt_override").notNull().default(""),
  tools: jsonb("tools").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
  modelPreference: text("model_preference"),
  outputSchema: jsonb("output_schema").$type<Record<string, unknown>>(),
  tags: jsonb("tags").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  isPublic: boolean("is_public").notNull().default(true),
  createdBy: text("created_by").notNull().default("system"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSkillSchema = createInsertSchema(skills).omit({ createdAt: true, updatedAt: true });
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skills.$inferSelect;

// ─── Pipeline Triggers (Phase 6.3) ───────────────────────────────────────────

export const TRIGGER_TYPES = ["webhook", "schedule", "github_event", "file_change"] as const;


export const triggers = pgTable(
  "triggers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    pipelineId: varchar("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    type: text("type").notNull().$type<TriggerType>(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<TriggerConfig>(),
    secretEncrypted: text("secret_encrypted"),
    enabled: boolean("enabled").notNull().default(true),
    lastTriggeredAt: timestamp("last_triggered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    pipelineIdIdx: index("triggers_pipeline_id_idx").on(table.pipelineId),
    enabledTypeIdx: index("triggers_enabled_type_idx").on(table.enabled, table.type),
  }),
);

export const insertTriggerSchema = createInsertSchema(triggers).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastTriggeredAt: true,
  secretEncrypted: true,
});

export type TriggerRow = typeof triggers.$inferSelect;
export type InsertTriggerRow = z.infer<typeof insertTriggerSchema>;

// ─── Traces (Phase 6.5) ──────────────────────────────────────────────────────

export const traces = pgTable(
  "traces",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    traceId: text("trace_id").notNull().unique(),
    runId: varchar("run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "cascade" }),
    spans: jsonb("spans").notNull().default(sql`'[]'::jsonb`).$type<TraceSpan[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    traceIdIdx: index("traces_trace_id_idx").on(table.traceId),
    runIdIdx: index("traces_run_id_idx").on(table.runId),
  }),
);

export const insertTraceSchema = createInsertSchema(traces).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTrace = z.infer<typeof insertTraceSchema>;
export type TraceRow = typeof traces.$inferSelect;

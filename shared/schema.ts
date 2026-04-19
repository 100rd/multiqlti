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
import { vector } from "drizzle-orm/pg-core/columns/vector_extension/vector";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { MaintenanceCategoryConfig, ScoutFinding, TriggerConfig, TriggerType, ManagerConfig, ManagerDecision, TraceSpan, SwarmCloneResult, SwarmMerger, SwarmSplitter, LogSourceConfig, SkillVersionConfig, TaskTraceSpan, TrackerProvider } from "./types.js";

// ─── RBAC ────────────────────────────────────────────

export const USER_ROLES = ["user", "maintainer", "admin"] as const;
export type UserRole = typeof USER_ROLES[number];

export const OAUTH_PROVIDERS = ["github", "gitlab"] as const;
export type OAuthProvider = typeof OAUTH_PROVIDERS[number];

// ─── Users ──────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash"),
  isActive: boolean("is_active").notNull().default(true),
  role: text("role").notNull().default("user").$type<UserRole>(),
  oauthProvider: text("oauth_provider").$type<OAuthProvider>(),
  oauthId: text("oauth_id"),
  avatarUrl: text("avatar_url"),
  lastLoginAt: timestamp("last_login_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  unique("users_oauth_provider_id").on(table.oauthProvider, table.oauthId),
]);

export const insertUserSchema = createInsertSchema(users)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    role: z.enum(USER_ROLES).optional(),
    passwordHash: z.string().nullable().optional(),
    oauthProvider: z.enum(OAUTH_PROVIDERS).nullable().optional(),
    oauthId: z.string().nullable().optional(),
    avatarUrl: z.string().nullable().optional(),
  });

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
  role: text("role").notNull().default("collaborator"),
  allowedStages: jsonb("allowed_stages"),
  canChat: boolean("can_chat").notNull().default(true),
  canVote: boolean("can_vote").notNull().default(true),
  canViewMemories: boolean("can_view_memories").notNull().default(true),
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
  /** Manager mode configuration. If non-null, pipeline runs in manager mode. */
  managerConfig: jsonb("manager_config").$type<ManagerConfig>(),
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
  swarmCloneResults: jsonb("swarm_clone_results").$type<SwarmCloneResult[]>(),
  swarmMeta: jsonb("swarm_meta").$type<{
    cloneCount: number;
    succeededCount: number;
    failedCount: number;
    mergerUsed: SwarmMerger;
    splitterUsed: SwarmSplitter;
    totalTokensUsed: number;
    durationMs: number;
  }>(),
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
  published: boolean("published").notNull().default(false),
}, (table) => ({
  scopeKeyUnique: unique().on(table.scope, table.scopeId, table.key),
  publishedIdx: index("memories_published_idx").on(table.published).where(sql`published = true`),
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

// ─── ArgoCD Config (Phase 6.10) ───────────────────────────────────────────────

export const ARGOCD_HEALTH_STATUS = ['connected', 'error', 'unknown'] as const;
export type ArgoCdHealthStatus = typeof ARGOCD_HEALTH_STATUS[number];

export const argoCdConfig = pgTable('argocd_config', {
  id: integer('id').primaryKey().default(1),
  serverUrl: text('server_url'),
  tokenEnc: text('token_enc'),
  verifySsl: boolean('verify_ssl').notNull().default(true),
  enabled: boolean('enabled').notNull().default(false),
  mcpServerId: integer('mcp_server_id').references(() => mcpServers.id, { onDelete: 'set null' }),
  lastHealthCheckAt: timestamp('last_health_check_at'),
  healthStatus: text('health_status').notNull().default('unknown').$type<ArgoCdHealthStatus>(),
  healthError: text('health_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const insertArgoCdConfigSchema = createInsertSchema(argoCdConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertArgoCdConfig = z.infer<typeof insertArgoCdConfigSchema>;
export type ArgoCdConfigRow = typeof argoCdConfig.$inferSelect;

// ─── Workspaces ──────────────────────────────────────────────────────────────

// ─── Workspace Index Status ────────────────────────────────────────────────
export const WORKSPACE_INDEX_STATUS = ["idle", "indexing", "ready", "error"] as const;
export type WorkspaceIndexStatus = typeof WORKSPACE_INDEX_STATUS[number];

export const SYMBOL_KINDS = [
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "export",
  "import",
] as const;
export type SymbolKind = typeof SYMBOL_KINDS[number];

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
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  indexStatus: text("index_status").notNull().default("idle").$type<WorkspaceIndexStatus>(),
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
  autoTriggerPipelineId: varchar("auto_trigger_pipeline_id"),
  autoTriggerEnabled: boolean("auto_trigger_enabled").notNull().default(false),
  logSourceConfig: jsonb("log_source_config").$type<LogSourceConfig | null>(),
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

// ─── Auto-Trigger Audit (Phase 6.11) ─────────────────────────────────────────

export const autoTriggerAudit = pgTable("auto_trigger_audit", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  scanId: varchar("scan_id")
    .notNull()
    .references(() => maintenanceScans.id, { onDelete: "restrict" }),
  findingId: varchar("finding_id").notNull(),
  pipelineRunId: varchar("pipeline_run_id").notNull(),
  triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
  triggeredBy: varchar("triggered_by").references(() => users.id, { onDelete: "restrict" }),
});

export type AutoTriggerAuditRow = typeof autoTriggerAudit.$inferSelect;

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

// ─── Git Skill Sources (issue #161) ─────────────────────────────────────────

export const gitSkillSources = pgTable("git_skill_sources", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  repoUrl: text("repo_url").notNull(),
  branch: text("branch").notNull().default("main"),
  path: text("path").notNull().default("/"),
  syncOnStart: boolean("sync_on_start").notNull().default(false),
  lastSyncedAt: timestamp("last_synced_at"),
  lastError: text("last_error"),
  // Encrypted PAT for private repos (AES-256-GCM, same as provider keys)
  encryptedPat: text("encrypted_pat"),
  createdBy: varchar("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertGitSkillSourceSchema = createInsertSchema(gitSkillSources).omit({ id: true, createdAt: true });
export type InsertGitSkillSource = z.infer<typeof insertGitSkillSourceSchema>;
export type GitSkillSourceRow = typeof gitSkillSources.$inferSelect;

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
  // Phase 6.16 columns
  version: text("version").notNull().default("1.0.0"),
  sharing: text("sharing").notNull().default("public").$type<"private" | "team" | "public">(),
  usageCount: integer("usage_count").notNull().default(0),
  forkedFrom: varchar("forked_from"),
  // Git skill source tracking (issue #161)
  sourceType: text("source_type").notNull().default("manual").$type<"manual" | "git">(),
  gitSourceId: varchar("git_source_id").references(() => gitSkillSources.id, { onDelete: "set null" }),
  // Phase 9: Skill Market columns (issue #208)
  externalSource: text("external_source"),
  externalId: text("external_id"),
  externalVersion: text("external_version"),
  installedAt: timestamp("installed_at"),
  autoUpdate: boolean("auto_update").default(false),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertSkillSchema = createInsertSchema(skills).omit({ createdAt: true, updatedAt: true });
export type InsertSkill = z.infer<typeof insertSkillSchema>;
export type Skill = typeof skills.$inferSelect;

// ─── Skill Versions (Phase 6.16) ────────────────────────────────────────────

export const skillVersions = pgTable("skill_versions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  skillId: varchar("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  config: jsonb("config").notNull().$type<SkillVersionConfig>(),
  changelog: text("changelog").notNull().default(""),
  createdBy: text("created_by").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => ({
  skillVersionIdx: index("skill_versions_skill_id_idx").on(table.skillId),
  uniqueSkillVersion: unique().on(table.skillId, table.version),
}));

export const insertSkillVersionSchema = createInsertSchema(skillVersions).omit({
  id: true,
  createdAt: true,
});

export type InsertSkillVersion = z.infer<typeof insertSkillVersionSchema>;
export type SkillVersionRow = typeof skillVersions.$inferSelect;

// ─── Skill Teams ─────────────────────────────────────────────────────────────

export const skillTeams = pgTable("skill_teams", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSkillTeamSchema = createInsertSchema(skillTeams).omit({ id: true, createdAt: true });
export type InsertSkillTeam = z.infer<typeof insertSkillTeamSchema>;
export type SkillTeam = typeof skillTeams.$inferSelect;

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

// ─── Manager Iterations (Phase 6.6) ─────────────────────────────────────────

export const managerIterations = pgTable(
  "manager_iterations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    runId: varchar("run_id")
      .notNull()
      .references(() => pipelineRuns.id, { onDelete: "cascade" }),
    iterationNumber: integer("iteration_number").notNull(),
    decision: jsonb("decision").notNull().$type<ManagerDecision>(),
    teamResult: text("team_result"),
    tokensUsed: integer("tokens_used").notNull().default(0),
    decisionDurationMs: integer("decision_duration_ms").notNull().default(0),
    teamDurationMs: integer("team_duration_ms"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    runIdIdx: index("manager_iterations_run_id_idx").on(table.runId),
    runIterationUnique: unique("manager_iterations_run_iteration_unique").on(
      table.runId,
      table.iterationNumber,
    ),
  }),
);

export const insertManagerIterationSchema = createInsertSchema(managerIterations).omit({
  id: true,
  createdAt: true,
});

export type InsertManagerIteration = z.infer<typeof insertManagerIterationSchema>;
export type ManagerIterationRow = typeof managerIterations.$inferSelect;

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

// ─── workspace_symbols (Phase 6.9) ────────────────────────────────────────────

export const workspaceSymbols = pgTable(
  "workspace_symbols",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    filePath: text("file_path").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().$type<SymbolKind>(),
    line: integer("line").notNull(),
    col: integer("col").notNull().default(0),
    signature: text("signature"),
    fileHash: text("file_hash").notNull(),
    exportedFrom: text("exported_from"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    nameIdx: index("workspace_symbols_name_idx").on(table.workspaceId, table.name),
    fileIdx: index("workspace_symbols_file_idx").on(table.workspaceId, table.filePath),
    kindIdx: index("workspace_symbols_kind_idx").on(table.workspaceId, table.kind),
    uniqueSymbol: unique("workspace_symbols_unique").on(
      table.workspaceId,
      table.filePath,
      table.name,
      table.kind,
    ),
  }),
);

export const insertWorkspaceSymbolSchema = createInsertSchema(workspaceSymbols).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertWorkspaceSymbol = z.infer<typeof insertWorkspaceSymbolSchema>;
export type WorkspaceSymbolRow = typeof workspaceSymbols.$inferSelect;

// ─── Task Groups (Task Orchestrator) ────────────────────────────────────────

export const TASK_GROUP_STATUSES = ["pending", "running", "completed", "failed", "cancelled"] as const;
export type TaskGroupStatus = typeof TASK_GROUP_STATUSES[number];

export const taskGroups = pgTable("task_groups", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  description: text("description").notNull(),
  status: text("status").notNull().default("pending").$type<TaskGroupStatus>(),
  input: text("input").notNull(),
  output: jsonb("output"),
  traceId: text("trace_id"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTaskGroupSchema = createInsertSchema(taskGroups).omit({
  id: true,
  createdAt: true,
});

export type InsertTaskGroup = z.infer<typeof insertTaskGroupSchema>;
export type TaskGroupRow = typeof taskGroups.$inferSelect;

// ─── Tasks (Task Orchestrator) ──────────────────────────────────────────────

export const TASK_STATUSES = ["pending", "blocked", "ready", "running", "completed", "failed", "cancelled"] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

export const TASK_EXECUTION_MODES = ["pipeline_run", "direct_llm"] as const;
export type TaskExecutionMode = typeof TASK_EXECUTION_MODES[number];

export const tasks = pgTable(
  "tasks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: varchar("group_id")
      .notNull()
      .references(() => taskGroups.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("pending").$type<TaskStatus>(),
    executionMode: text("execution_mode").notNull().default("direct_llm").$type<TaskExecutionMode>(),
    dependsOn: jsonb("depends_on").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    pipelineId: varchar("pipeline_id"),
    pipelineRunId: varchar("pipeline_run_id"),
    modelSlug: text("model_slug"),
    teamId: text("team_id"),
    input: jsonb("input").notNull().default(sql`'{}'::jsonb`),
    output: jsonb("output"),
    summary: text("summary"),
    artifacts: jsonb("artifacts").$type<Record<string, unknown>[]>(),
    decisions: jsonb("decisions").$type<string[]>(),
    errorMessage: text("error_message"),
    sortOrder: integer("sort_order").notNull().default(0),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    groupIdIdx: index("tasks_group_id_idx").on(table.groupId),
    statusIdx: index("tasks_status_idx").on(table.status),
  }),
);

export const insertTaskSchema = createInsertSchema(tasks).omit({
  id: true,
  createdAt: true,
});

export type InsertTask = z.infer<typeof insertTaskSchema>;
export type TaskRow = typeof tasks.$inferSelect;

// ─── Library Channels (Phase 7) ─────────────────────────────────────────────

export const LIBRARY_CHANNEL_TYPES = ["rss", "manual", "github", "cve"] as const;
export type LibraryChannelType = typeof LIBRARY_CHANNEL_TYPES[number];

export const libraryChannels = pgTable("library_channels", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  type: text("type").notNull().$type<LibraryChannelType>(),
  url: text("url"),
  config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
  enabled: boolean("enabled").notNull().default(true),
  pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(60),
  lastPolledAt: timestamp("last_polled_at"),
  errorMessage: text("error_message"),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertLibraryChannelSchema = createInsertSchema(libraryChannels).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  lastPolledAt: true,
  errorMessage: true,
});

export type InsertLibraryChannel = z.infer<typeof insertLibraryChannelSchema>;
export type LibraryChannelRow = typeof libraryChannels.$inferSelect;

// ─── Library Items (Phase 7) ────────────────────────────────────────────────

export const libraryItems = pgTable(
  "library_items",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    channelId: varchar("channel_id").references(() => libraryChannels.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    url: text("url"),
    contentText: text("content_text"),
    summary: text("summary"),
    author: text("author"),
    tags: jsonb("tags").notNull().$type<string[]>().default(sql`'[]'::jsonb`),
    sourceType: text("source_type").notNull().default("manual"),
    /** De-duplication key — usually the item URL or a hash of the content */
    externalId: text("external_id"),
    publishedAt: timestamp("published_at"),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    channelIdx: index("library_items_channel_id_idx").on(table.channelId),
    externalIdx: index("library_items_external_id_idx").on(table.externalId),
    publishedIdx: index("library_items_published_at_idx").on(table.publishedAt),
  }),
);

export const insertLibraryItemSchema = createInsertSchema(libraryItems).omit({
  id: true,
  createdAt: true,
});

export type InsertLibraryItem = z.infer<typeof insertLibraryItemSchema>;
export type LibraryItemRow = typeof libraryItems.$inferSelect;

// ─── Task Traces (End-to-End Request Observability) ──────────────────────────

export const taskTraces = pgTable(
  "task_traces",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    groupId: varchar("group_id")
      .notNull()
      .references(() => taskGroups.id, { onDelete: "cascade" }),
    traceId: text("trace_id").notNull().unique(),
    rootSpan: jsonb("root_span").$type<TaskTraceSpan>(),
    spans: jsonb("spans").notNull().default(sql`'[]'::jsonb`).$type<TaskTraceSpan[]>(),
    totalDurationMs: integer("total_duration_ms").notNull().default(0),
    totalTokens: integer("total_tokens").notNull().default(0),
    totalCostUsd: real("total_cost_usd").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    groupIdIdx: index("task_traces_group_id_idx").on(table.groupId),
    traceIdIdx: index("task_traces_trace_id_idx").on(table.traceId),
  }),
);

export const insertTaskTraceSchema = createInsertSchema(taskTraces).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertTaskTrace = z.infer<typeof insertTaskTraceSchema>;
export type TaskTraceRow = typeof taskTraces.$inferSelect;

// ─── Tracker Connections (Issue Tracker Integration) ──────────────────────────

export const TRACKER_PROVIDERS = ["jira", "clickup", "linear", "github"] as const;

export const trackerConnections = pgTable("tracker_connections", {
  id: varchar("id")
    .primaryKey()
    .default(sql`gen_random_uuid()`),
  taskGroupId: varchar("task_group_id")
    .notNull()
    .references(() => taskGroups.id, { onDelete: "cascade" }),
  provider: text("provider").notNull().$type<TrackerProvider>(),
  issueUrl: text("issue_url").notNull(),
  issueKey: text("issue_key").notNull(),
  projectKey: text("project_key"),
  syncComments: boolean("sync_comments").notNull().default(true),
  syncSubtasks: boolean("sync_subtasks").notNull().default(true),
  apiToken: text("api_token"),
  baseUrl: text("base_url"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertTrackerConnectionSchema = createInsertSchema(trackerConnections).omit({
  id: true,
  createdAt: true,
});

export type InsertTrackerConnection = z.infer<typeof insertTrackerConnectionSchema>;
export type TrackerConnectionRow = typeof trackerConnections.$inferSelect;

// ─── Model Skill Bindings (Phase 6.17) ───────────────────────────────────────

export const modelSkillBindings = pgTable("model_skill_bindings", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  modelId: text("model_id").notNull(),
  skillId: varchar("skill_id").notNull().references(() => skills.id, { onDelete: "cascade" }),
  createdBy: text("created_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueModelSkill: unique().on(t.modelId, t.skillId),
  modelIdIdx: index("model_skill_bindings_model_id_idx").on(t.modelId),
}));

export const insertModelSkillBindingSchema = createInsertSchema(modelSkillBindings).omit({ id: true, createdAt: true });
export type InsertModelSkillBinding = z.infer<typeof insertModelSkillBindingSchema>;
export type ModelSkillBinding = typeof modelSkillBindings.$inferSelect;

// ── Phase 8: Remote Agents ────────────────────────────────────────────────

export const remoteAgents = pgTable("remote_agents", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull().unique(),
  environment: text("environment").notNull().default("kubernetes"),
  transport: text("transport").notNull().default("a2a-http"),
  endpoint: text("endpoint").notNull(),
  cluster: text("cluster"),
  namespace: text("namespace"),
  labels: jsonb("labels"),
  authTokenEnc: text("auth_token_enc"),
  enabled: boolean("enabled").notNull().default(true),
  autoConnect: boolean("auto_connect").notNull().default(false),
  status: text("status").notNull().default("offline"),
  lastHeartbeatAt: timestamp("last_heartbeat_at"),
  healthError: text("health_error"),
  agentCard: jsonb("agent_card"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const a2aTasks = pgTable("a2a_tasks", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  agentId: varchar("agent_id").notNull().references(() => remoteAgents.id),
  runId: varchar("run_id"),
  stageExecutionId: varchar("stage_execution_id"),
  skill: text("skill"),
  input: jsonb("input").notNull(),
  status: text("status").notNull().default("submitted"),
  output: jsonb("output"),
  error: text("error"),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertRemoteAgentSchema = createInsertSchema(remoteAgents);
export const insertA2ATaskSchema = createInsertSchema(a2aTasks);

// ── Phase 9: Skill Market ─────────────────────────────────────────────────

export const skillRegistrySources = pgTable("skill_registry_sources", {
  id: serial("id").primaryKey(),
  adapterId: text("adapter_id").notNull().unique(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  config: jsonb("config"),
  lastSyncAt: timestamp("last_sync_at"),
  lastHealthCheckAt: timestamp("last_health_check_at"),
  healthStatus: text("health_status").notNull().default("unknown"),
  healthError: text("health_error"),
  catalogCount: integer("catalog_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const skillInstallLog = pgTable("skill_install_log", {
  id: serial("id").primaryKey(),
  skillId: varchar("skill_id"),
  externalSource: text("external_source"),
  externalId: text("external_id"),
  action: text("action").notNull(),
  fromVersion: text("from_version"),
  toVersion: text("to_version"),
  userId: text("user_id"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSkillRegistrySourceSchema = createInsertSchema(skillRegistrySources);
export const insertSkillInstallLogSchema = createInsertSchema(skillInstallLog);

// ── Federation: Shared Sessions (issue #224) ────────────────────────────────

export const sharedSessions = pgTable("shared_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  runId: varchar("run_id").notNull(),
  shareToken: varchar("share_token").notNull().unique(),
  ownerInstanceId: text("owner_instance_id").notNull(),
  createdBy: text("created_by").notNull(),
  expiresAt: timestamp("expires_at"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const insertSharedSessionSchema = createInsertSchema(sharedSessions);

export type InsertSharedSession = z.infer<typeof insertSharedSessionSchema>;
export type SharedSessionRow = typeof sharedSessions.$inferSelect;

// ── Workspace Connections (issue #266) ───────────────────────────────────────

export const CONNECTION_TYPES = [
  "gitlab",
  "github",
  "kubernetes",
  "aws",
  "jira",
  "grafana",
  "generic_mcp",
] as const;

export const CONNECTION_STATUSES = ["active", "inactive", "error"] as const;

export const workspaceConnections = pgTable(
  "workspace_connections",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    type: text("type")
      .notNull()
      .$type<typeof CONNECTION_TYPES[number]>(),
    name: text("name").notNull(),
    /** Non-secret config (URL, project key, region, etc.) stored in plaintext. */
    configJson: jsonb("config_json")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    /** AES-GCM encrypted JSON blob of secret key/values. Null when no secrets. */
    secretsEncrypted: text("secrets_encrypted"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<typeof CONNECTION_STATUSES[number]>(),
    lastTestedAt: timestamp("last_tested_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  },
  (table) => ({
    workspaceIdIdx: index("workspace_connections_workspace_id_idx").on(table.workspaceId),
    workspaceTypeIdx: index("workspace_connections_workspace_type_idx").on(
      table.workspaceId,
      table.type,
    ),
  }),
);

export const insertWorkspaceConnectionSchema = createInsertSchema(workspaceConnections).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  secretsEncrypted: true, // never accepted from external input
});

export type InsertWorkspaceConnection = z.infer<typeof insertWorkspaceConnectionSchema>;
export type WorkspaceConnectionRow = typeof workspaceConnections.$inferSelect;

// ── Per-type config Zod schemas (issue #266) ─────────────────────────────────

export const GitLabConnectionConfigSchema = z.object({
  host: z.string().url().default("https://gitlab.com"),
  projectId: z.string().optional(),
  groupPath: z.string().optional(),
  apiVersion: z.literal("v4").default("v4"),
});

export const GitHubConnectionConfigSchema = z.object({
  host: z.string().url().default("https://api.github.com"),
  owner: z.string().min(1),
  repo: z.string().optional(),
  appId: z.string().optional(),
});

export const KubernetesConnectionConfigSchema = z.object({
  server: z.string().url(),
  namespace: z.string().default("default"),
  insecureSkipTlsVerify: z.boolean().default(false),
});

export const AwsConnectionConfigSchema = z.object({
  region: z.string().min(1),
  accountId: z.string().optional(),
  roleArn: z.string().optional(),
});

export const JiraConnectionConfigSchema = z.object({
  host: z.string().url(),
  email: z.string().email().optional(),
  projectKey: z.string().optional(),
});

export const GrafanaConnectionConfigSchema = z.object({
  host: z.string().url(),
  orgId: z.number().int().positive().default(1),
});

export const GenericMcpConnectionConfigSchema = z.object({
  endpoint: z.string().url(),
  transport: z.enum(["stdio", "sse", "streamable-http"]).default("sse"),
  description: z.string().optional(),
});

export type GitLabConnectionConfig = z.infer<typeof GitLabConnectionConfigSchema>;
export type GitHubConnectionConfig = z.infer<typeof GitHubConnectionConfigSchema>;
export type KubernetesConnectionConfig = z.infer<typeof KubernetesConnectionConfigSchema>;
export type AwsConnectionConfig = z.infer<typeof AwsConnectionConfigSchema>;
export type JiraConnectionConfig = z.infer<typeof JiraConnectionConfigSchema>;
export type GrafanaConnectionConfig = z.infer<typeof GrafanaConnectionConfigSchema>;
export type GenericMcpConnectionConfig = z.infer<typeof GenericMcpConnectionConfigSchema>;

/** Validate config JSON for a given connection type. Returns parsed data or throws ZodError. */
export function validateConnectionConfig(
  type: typeof CONNECTION_TYPES[number],
  config: unknown,
): Record<string, unknown> {
  switch (type) {
    case "gitlab":    return GitLabConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "github":    return GitHubConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "kubernetes": return KubernetesConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "aws":       return AwsConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "jira":      return JiraConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "grafana":   return GrafanaConnectionConfigSchema.parse(config) as Record<string, unknown>;
    case "generic_mcp": return GenericMcpConnectionConfigSchema.parse(config) as Record<string, unknown>;
    default: {
      const _exhaustive: never = type;
      throw new Error(`Unknown connection type: ${_exhaustive}`);
    }
  }
}

// ── MCP Tool Calls Audit Log (issue #271) ─────────────────────────────────────
// Records every MCP tool invocation with redacted args/results for audit,
// usage metrics, and OTel trace observability. Retention: 90 days default.

export const mcpToolCalls = pgTable(
  "mcp_tool_calls",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    /** Nullable — tool calls may occur outside a pipeline run context. */
    pipelineRunId: varchar("pipeline_run_id"),
    /** DAG stage ID within the run, if applicable. */
    stageId: text("stage_id"),
    /** Workspace connection that owns this tool. */
    connectionId: varchar("connection_id").notNull(),
    /** Fully-qualified tool name (e.g. "github__github_list_prs"). */
    toolName: text("tool_name").notNull(),
    /** Redacted copy of the input args — no secrets. */
    argsJson: jsonb("args_json").notNull().default(sql`'{}'::jsonb`),
    /** Redacted copy of the result — no secrets. Null on error. */
    resultJson: jsonb("result_json"),
    /** Error message (generic) when the call failed. */
    error: text("error"),
    /** Wall-clock duration in milliseconds. */
    durationMs: integer("duration_ms").notNull().default(0),
    startedAt: timestamp("started_at").notNull().defaultNow(),
  },
  (table) => ({
    connectionIdIdx: index("mcp_tool_calls_connection_id_idx").on(table.connectionId),
    pipelineRunIdIdx: index("mcp_tool_calls_pipeline_run_id_idx").on(table.pipelineRunId),
    startedAtIdx: index("mcp_tool_calls_started_at_idx").on(table.startedAt),
    connectionStartedIdx: index("mcp_tool_calls_connection_started_idx").on(
      table.connectionId,
      table.startedAt,
    ),
  }),
);

export const insertMcpToolCallSchema = createInsertSchema(mcpToolCalls).omit({
  id: true,
  startedAt: true,
});

export type InsertMcpToolCall = z.infer<typeof insertMcpToolCallSchema>;
export type McpToolCallRow = typeof mcpToolCalls.$inferSelect;

// ── Connections YAML Schema (issue #276) ─────────────────────────────────────
//
// Zod schemas for the .multiqlti/connections.yaml declarative config file.
// These are re-exported from shared/schema so both the server and the CLI
// validation script can import them without a circular dependency.

const SECRET_REF_REGEX = /^\$\{(env|file|vault):([^}]+)\}$/;

/**
 * A secret value must be a reference expression — never plaintext.
 * Accepted forms: ${env:NAME}, ${file:./path}, ${vault:secret/path}
 */
export const ConnectionSecretRefSchema = z
  .string()
  .refine(
    (v) => SECRET_REF_REGEX.test(v),
    (v) => ({
      message:
        `Plaintext secrets are not allowed in connections.yaml. ` +
        `Use \${env:VAR}, \${file:path}, or \${vault:path}. ` +
        `Received value starts with: "${v.slice(0, 12)}"`,
    }),
  );

export const YamlConnectionEntrySchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(CONNECTION_TYPES),
  config: z.record(z.unknown()).default({}),
  secrets: z.record(ConnectionSecretRefSchema).optional(),
});

export const ConnectionsYamlFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(YamlConnectionEntrySchema).default([]),
});

export type YamlConnectionEntry = z.infer<typeof YamlConnectionEntrySchema>;
export type ConnectionsYamlFile = z.infer<typeof ConnectionsYamlFileSchema>;

// ── Cost Ledger + Budgets (issue #279) ────────────────────────────────────────
//
// cost_ledger: append-only record of every billed LLM call per workspace.
// budgets:     configurable spending limits per workspace × provider × period.

export const BUDGET_PERIODS = ["day", "week", "month"] as const;
export type BudgetPeriod = typeof BUDGET_PERIODS[number];

export const costLedger = pgTable(
  "cost_ledger",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    pipelineRunId: varchar("pipeline_run_id"),
    stageId: text("stage_id"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (table) => [
    index("cost_ledger_workspace_ts_idx").on(table.workspaceId, table.ts),
    index("cost_ledger_workspace_provider_idx").on(table.workspaceId, table.provider),
    index("cost_ledger_run_idx").on(table.pipelineRunId),
  ],
);

export const insertCostLedgerSchema = createInsertSchema(costLedger).omit({
  id: true,
  ts: true,
});

export type InsertCostLedger = z.infer<typeof insertCostLedgerSchema>;
export type CostLedgerRow = typeof costLedger.$inferSelect;

export const budgets = pgTable(
  "budgets",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
    /** NULL means "applies to all providers". */
    provider: text("provider"),
    period: text("period").notNull().default("month").$type<BudgetPeriod>(),
    limitUsd: real("limit_usd").notNull(),
    hard: boolean("hard").notNull().default(false),
    /** Percentage thresholds for alert notifications, e.g. [50, 80, 100]. */
    notifyAtPct: integer("notify_at_pct").array().notNull().default(sql`'{}'`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("budgets_workspace_id_idx").on(table.workspaceId),
  ],
);

export const insertBudgetSchema = createInsertSchema(budgets)
  .omit({ id: true, createdAt: true, updatedAt: true })
  .extend({
    period: z.enum(BUDGET_PERIODS).default("month"),
    notifyAtPct: z.array(z.number().int().min(0).max(100)).default([]),
  });

export const updateBudgetSchema = insertBudgetSchema.partial().omit({ workspaceId: true });

export type InsertBudget = z.infer<typeof insertBudgetSchema>;
export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
export type BudgetRow = typeof budgets.$inferSelect;


// ─── Workspace Settings (issue #280) ─────────────────────────────────────────
// Generic key-value settings per workspace (JSONB values).
// Currently used to persist custom tool/skill source configurations.

export const workspaceSettings = pgTable(
  "workspace_settings",
  {
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    value: jsonb("value").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("workspace_settings_workspace_idx").on(table.workspaceId),
  ],
);

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;

// ─── Memory Chunks (issue #282 — hybrid RAG / pgvector) ───────────────────────
// Stores embedded text chunks for semantic search via pgvector ANN.
// Dimensions default to 1536 (OpenAI/Voyage); Ollama nomic-embed-text uses 768.
// The actual model dimension is stored in metadata.dim.

export const CHUNK_SOURCE_TYPES = ["code", "pipeline_run", "document", "memory_entry"] as const;
export type ChunkSourceType = typeof CHUNK_SOURCE_TYPES[number];

export const memoryChunks = pgTable(
  "memory_chunks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull().$type<ChunkSourceType>(),
    sourceId: text("source_id").notNull(),
    chunkText: text("chunk_text").notNull(),
    /** Vector embedding; nullable until embedding job completes. */
    embedding: vector("embedding", { dimensions: 1536 }),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (table) => [
    index("memory_chunks_workspace_source_idx").on(table.workspaceId, table.sourceType, table.sourceId),
    index("memory_chunks_ts_idx").on(table.workspaceId, table.ts),
  ],
);

export const insertMemoryChunkSchema = createInsertSchema(memoryChunks).omit({
  id: true,
  ts: true,
}).extend({
  sourceType: z.enum(CHUNK_SOURCE_TYPES),
  embedding: z.array(z.number()).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export type InsertMemoryChunk = z.infer<typeof insertMemoryChunkSchema>;
export type MemoryChunkRow = typeof memoryChunks.$inferSelect;

// ─── Embedding Provider Config (issue #282) ───────────────────────────────────
// Per-workspace embedding provider selection and configuration.

export const EMBEDDING_PROVIDERS = ["ollama", "openai", "voyage", "jina"] as const;
export type EmbeddingProviderName = typeof EMBEDDING_PROVIDERS[number];

export const embeddingProviderConfig = pgTable(
  "embedding_provider_config",
  {
    workspaceId: varchar("workspace_id")
      .notNull()
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().default("ollama").$type<EmbeddingProviderName>(),
    model: text("model").notNull().default("nomic-embed-text"),
    dimensions: integer("dimensions").notNull().default(768),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
);

export type EmbeddingProviderConfigRow = typeof embeddingProviderConfig.$inferSelect;

// ── Federation: Subjective Conflict Resolution (issue #229) ──────────────────

export const CONFLICT_STRATEGIES = [
  "structured_debate",
  "quorum_vote",
  "parallel_experiment",
  "defer_to_owner",
] as const;

export const CONFLICT_STATUSES = [
  "open",
  "debate_in_progress",
  "voting_in_progress",
  "experiment_in_progress",
  "resolved",
  "expired",
] as const;

/**
 * Active/open conflict records (mutable during dispute lifecycle).
 * Proposals, votes, and ephemeral state are stored as JSONB for flexibility.
 */
export const sessionConflicts = pgTable(
  "session_conflicts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: varchar("session_id").notNull(),
    raisedBy: text("raised_by").notNull(),
    raisedByInstance: text("raised_by_instance").notNull(),
    question: text("question").notNull(),
    context: text("context"),
    strategy: text("strategy").notNull().$type<typeof CONFLICT_STRATEGIES[number]>(),
    status: text("status").notNull().default("open").$type<typeof CONFLICT_STATUSES[number]>(),
    proposals: jsonb("proposals").notNull().default(sql`'[]'::jsonb`),
    votes: jsonb("votes").notNull().default(sql`'[]'::jsonb`),
    quorumThreshold: real("quorum_threshold").notNull().default(0.67),
    timeoutMs: integer("timeout_ms").notNull().default(300_000),
    judgement: jsonb("judgement"),
    experimentResults: jsonb("experiment_results"),
    outcome: jsonb("outcome"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("session_conflicts_session_idx").on(table.sessionId),
    index("session_conflicts_status_idx").on(table.status),
  ],
);

export type SessionConflictRow = typeof sessionConflicts.$inferSelect;

/**
 * Decision log (append-only).
 * Written once when a conflict resolves; never updated.
 */
export const decisionLog = pgTable(
  "decision_log",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    sessionId: varchar("session_id").notNull(),
    conflictId: varchar("conflict_id").notNull(),
    question: text("question").notNull(),
    strategy: text("strategy").notNull().$type<typeof CONFLICT_STRATEGIES[number]>(),
    outcome: jsonb("outcome").notNull(),
    participantCount: integer("participant_count").notNull().default(0),
    proposalCount: integer("proposal_count").notNull().default(0),
    durationMs: integer("duration_ms").notNull().default(0),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    index("decision_log_session_idx").on(table.sessionId),
    index("decision_log_conflict_idx").on(table.conflictId),
    index("decision_log_recorded_at_idx").on(table.recordedAt),
  ],
);

export type DecisionLogRow = typeof decisionLog.$inferSelect;

// ─── Config applies audit log (issue #319) ─────────────────────────────────

/**
 * Audit log for config-sync apply operations.
 * One row per apply attempt (success or failure).
 * Retrievable via `mqlti config history`.
 */
export const configApplies = pgTable(
  "config_applies",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    appliedAt: timestamp("applied_at").notNull().defaultNow(),
    appliedBy: text("applied_by").notNull(),
    gitCommitSha: text("git_commit_sha"),
    summaryJson: jsonb("summary_json").notNull().default(sql`'{}'::jsonb`).$type<ConfigApplySummary>(),
    success: boolean("success").notNull().default(false),
    error: text("error"),
  },
  (table) => [
    index("config_applies_applied_at_idx").on(table.appliedAt),
    index("config_applies_success_idx").on(table.success),
  ],
);

export interface ConfigApplySummary {
  dryRun?: boolean;
  repoPath?: string;
  totalCreated?: number;
  totalUpdated?: number;
  totalDeleted?: number;
  totalErrors?: number;
  entityTypes?: string[];
}

export type ConfigApplyRow = typeof configApplies.$inferSelect;
export type InsertConfigApply = typeof configApplies.$inferInsert;

// ─── Config events outbox (issue #321) ─────────────────────────────────────

/**
 * Transactional outbox for federation config-sync events.
 *
 * When any syncable entity is mutated the storage layer enqueues a row here.
 * The publisher loop reads unsent rows, sends them to connected peers via the
 * federation transport, and stamps `sent_at` on success.
 */
export const CONFIG_EVENT_OPERATIONS = ["create", "update", "delete"] as const;
export type ConfigEventOperation = typeof CONFIG_EVENT_OPERATIONS[number];

export const configEventsOutbox = pgTable(
  "config_events_outbox",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    operation: text("operation").notNull().$type<ConfigEventOperation>(),
    payloadJsonb: jsonb("payload_jsonb").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
  },
  (table) => [
    index("config_events_outbox_unsent_idx").on(table.createdAt).where(sql`${table.sentAt} IS NULL`),
    index("config_events_outbox_entity_idx").on(table.entityKind, table.entityId),
  ],
);

export type ConfigEventOutboxRow = typeof configEventsOutbox.$inferSelect;
export type InsertConfigEventOutbox = typeof configEventsOutbox.$inferInsert;

/**
 * Idempotency log for incoming federation config-sync events.
 *
 * Composite PK (peer_id, entity_kind, entity_id, version) prevents the same
 * event from being applied more than once on this instance.
 */
export const configEventsReceived = pgTable("config_events_received", {
  peerId: text("peer_id").notNull(),
  entityKind: text("entity_kind").notNull(),
  entityId: text("entity_id").notNull(),
  version: text("version").notNull(),
  receivedAt: timestamp("received_at").notNull().defaultNow(),
}, (table) => [
  {
    pk: {
      columns: [table.peerId, table.entityKind, table.entityId, table.version],
      name: "config_events_received_pkey",
    },
  },
]);

export type ConfigEventReceivedRow = typeof configEventsReceived.$inferSelect;

// ─── Peer pending events queue (issue #322) ────────────────────────────────

/**
 * Per-peer offline queue for config-sync events.
 *
 * When sending a config-sync event to a peer fails (peer offline), the event
 * is enqueued here.  On reconnect the queue is flushed in enqueued_at ASC
 * order.  Coalesce keeps only the latest event per (peer_id, entity_kind,
 * entity_id) to avoid redundant re-deliveries.  TTL prunes rows older than
 * the configured threshold (default 7 days) and signals the peer to perform
 * a full resync instead.
 */
export const PEER_PENDING_STATUSES = ["pending", "sending", "sent", "expired"] as const;
export type PeerPendingStatus = typeof PEER_PENDING_STATUSES[number];

export const peerPendingEvents = pgTable(
  "peer_pending_events",
  {
    peerId: text("peer_id").notNull(),
    eventId: varchar("event_id").notNull().references(() => configEventsOutbox.id, { onDelete: "cascade" }),
    enqueuedAt: timestamp("enqueued_at").notNull().defaultNow(),
    lastRetryAt: timestamp("last_retry_at"),
    retryCount: integer("retry_count").notNull().default(0),
    status: text("status").notNull().default("pending").$type<PeerPendingStatus>(),
  },
  (table) => [
    {
      pk: {
        columns: [table.peerId, table.eventId],
        name: "peer_pending_events_pkey",
      },
    },
    index("peer_pending_events_flush_idx").on(table.peerId, table.enqueuedAt).where(sql`${table.status} = 'pending'`),
    index("peer_pending_events_ttl_idx").on(table.enqueuedAt).where(sql`${table.status} = 'pending'`),
    index("peer_pending_events_peer_idx").on(table.peerId).where(sql`${table.status} = 'pending'`),
  ],
);

export type PeerPendingEventRow = typeof peerPendingEvents.$inferSelect;
export type InsertPeerPendingEvent = typeof peerPendingEvents.$inferInsert;

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
  uniqueIndex,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { vector } from "drizzle-orm/pg-core/columns/vector_extension/vector";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";
import type { TriggerConfig, TriggerType, TriggerProvenance, TraceSpan, SkillVersionConfig, TaskTraceSpan, TrackerProvider, ActionPoint, Archetype, ArchetypeSource, ResearchReport, RoundVerdict, RoundParticipant, RoundComment, ExecutionTrace, ReviewMode, ExperienceScope, ExperienceEvidence, ExperienceVerification, ExperienceProvenance, ExperienceFreshness, ExperienceConfidence, ExperienceConsolidation, SkillProposalStatus, SkillProposalProvenance, SkillProposalEvidence } from "./types.js";

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


export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  description: text("description"),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const projectMembers = pgTable("project_members", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull().default("editor"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.projectId, t.userId] }),
]);

export const insertProjectSchema = createInsertSchema(projects).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertProject = z.infer<typeof insertProjectSchema>;
export type Project = typeof projects.$inferSelect;

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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

// ─── Questions ──────────────────────────────────────

export const questions = pgTable("questions", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

export const providerKeys = pgTable(
  "provider_keys",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Per-project scoping: ADR-001 PR-0c
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    apiKeyEncrypted: text("api_key_encrypted").notNull(),
    createdAt: timestamp("created_at").defaultNow(),
    updatedAt: timestamp("updated_at").defaultNow(),
  },
  (table) => ({
    // Composite unique replaces the old global unique(provider): ADR-001 §5
    projectProviderUniq: unique("provider_keys_project_provider_unique").on(
      table.projectId,
      table.provider,
    ),
  }),
);

export type ProviderKey = typeof providerKeys.$inferSelect;

// ─── Anonymization Patterns ──────────────────────────────────────────────────

export const anonymizationPatterns = pgTable("anonymization_patterns", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

// ─── MCP Servers ─────────────────────────────────────────────────────────────

export const mcpServers = pgTable("mcp_servers", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

export const argoCdConfig = pgTable(
  'argocd_config',
  {
    // Changed from integer().default(1) singleton to serial (auto-inc) + per-project unique:
    // ADR-001 PR-0c converts the id=1 singleton to per-project rows.
    id: serial('id').primaryKey(),
    // Per-project scoping: one row per project — ADR-001 §3.1(e) [R3-SEC-5]
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
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
  },
  (table) => ({
    // One ArgoCD config per project (replaces the id=1 singleton): ADR-001 §5
    projectUniq: unique('argocd_config_project_unique').on(table.projectId),
  }),
);

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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

// ─── Specialization Profiles (Phase 5) ───────────────────────────────────────

export const specializationProfiles = pgTable("specialization_profiles", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  // Git skill source tracking (issue #161). The git_skill_sources table + its sync
  // service were removed when the skills ecosystem was pruned (Phase 3b); these two
  // columns are retained as inert data (no FK) so the skills table shape / rows are
  // preserved. gitSourceId is a plain varchar — no longer a foreign key.
  sourceType: text("source_type").notNull().default("manual").$type<"manual" | "git">(),
  gitSourceId: varchar("git_source_id"),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

// ─── Pipeline Triggers (Phase 6.3) ───────────────────────────────────────────

export const TRIGGER_TYPES = ["webhook", "schedule", "github_event", "gitlab_event", "file_change", "tracker_event"] as const;


export const triggers = pgTable(
  "triggers",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Denormalized from pipelines.projectId for direct query scoping: ADR-001 PR-0c §3.1(e)
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    type: text("type").notNull().$type<TriggerType>(),
    config: jsonb("config").notNull().default(sql`'{}'::jsonb`).$type<TriggerConfig>(),
    secretEncrypted: text("secret_encrypted"),
    enabled: boolean("enabled").notNull().default(true),
    lastTriggeredAt: timestamp("last_triggered_at"),
    // T1 policy rail: monotonically-incremented count of fires suppressed by a
    // policy (dedup today; budget/debounce later). Surfaced on the triggers page.
    suppressedCount: integer("suppressed_count").notNull().default(0),
    // WRITE-on-fire rail: `last_fired_at`/`fired_count` record when a trigger
    // ACTUALLY launches a loop (a loop row was created) — as opposed to
    // `last_triggered_at` (EVERY fire, incl. suppressed/no-op) and
    // `suppressed_count` (fires the dedup rail suppressed). Populated ONLY on the
    // successful-launch branch of `launchReviewWithDedup`, so the triggers page can
    // render "Fired N · Suppressed M". lastFiredAt equals the loop's provenance firedAt.
    lastFiredAt: timestamp("last_fired_at"),
    firedCount: integer("fired_count").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    enabledTypeIdx: index("triggers_enabled_type_idx").on(table.enabled, table.type),
    projectIdIdx: index("triggers_project_id_idx").on(table.projectId),
  }),
);

export const insertTriggerSchema = createInsertSchema(triggers).omit({
  id: true,
  projectId: true,
  createdAt: true,
  updatedAt: true,
  lastTriggeredAt: true,
  secretEncrypted: true,
  suppressedCount: true,
  lastFiredAt: true,
  firedCount: true,
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
    // The pipelines engine is retired (migration 0053): the FK to pipeline_runs
    // is detached (column kept, plain varchar). traces is write-less going
    // forward (see task #29) — getTraces()/getTraceByRunId() now return
    // empty/null unconditionally rather than reconstruct scoping through a
    // dropped table (server/storage-pg.ts).
    runId: varchar("run_id").notNull(),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

export const TASK_EXECUTION_MODES = ["direct_llm"] as const;
export type TaskExecutionMode = typeof TASK_EXECUTION_MODES[number];

export const tasks = pgTable(
  "tasks",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
    // Optional workspace this task's pipeline_run runs are recorded against
    // (consilium loop DEV handoff, design §14.3). Plain varchar (no FK) mirrors
    // pipeline_runs.workspace_id; null = today's behaviour (no workspace).
    workspaceId: varchar("workspace_id"),
    modelSlug: text("model_slug"),
    teamId: text("team_id"),
    // v2 (task-groups-v2 §3.3): organizational labels (array, not a join table —
    // mirrors library_items.tags).
    labels: jsonb("labels").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
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

// ─── Task Group Iterations (task-groups-v2 §3.1) ────────────────────────────
// One row per RUN of a group. status/timing/output projects onto the group row
// (latest-iteration mirror). UNIQUE(group_id, iteration_number) is the DB-level
// concurrency backstop for two concurrent `start` calls computing the same max+1.

export const taskGroupIterations = pgTable(
  "task_group_iterations",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    groupId: varchar("group_id")
      .notNull()
      .references(() => taskGroups.id, { onDelete: "cascade" }),
    iterationNumber: integer("iteration_number").notNull(),
    status: text("status").notNull().default("running").$type<TaskGroupStatus>(),
    // Immutable snapshot of group.input at run time — what actually ran.
    input: text("input").notNull(),
    output: jsonb("output").$type<Record<string, unknown>>(),
    // Human-in-the-loop note written AFTER this iteration completes. It is folded
    // into the NEXT iteration's input snapshot (see TaskOrchestrator.startGroupAsync)
    // so the debaters/judge of the following round argue WITH the user's thoughts
    // and decisions in scope. Nullable; only the latest iteration's note is carried.
    humanNote: text("human_note"),
    traceId: text("trace_id"),
    triggeredBy: text("triggered_by").references(() => users.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    groupIdIdx: index("iterations_group_id_idx").on(table.groupId),
    groupNumberUnique: unique("iterations_group_number_uq").on(
      table.groupId,
      table.iterationNumber,
    ),
  }),
);

export const insertTaskGroupIterationSchema = createInsertSchema(taskGroupIterations).omit({
  id: true,
  createdAt: true,
}).extend({
  status: z.enum(TASK_GROUP_STATUSES).optional(),
});

export type InsertTaskGroupIteration = z.infer<typeof insertTaskGroupIterationSchema>;
export type TaskGroupIterationRow = typeof taskGroupIterations.$inferSelect;

// ─── Task Executions (task-groups-v2 §3.2) ──────────────────────────────────
// One row per DEFINITION × ITERATION: the result of running a task definition in
// one iteration. group_id is denormalized for the owner-join + activity scope
// (MF-1: the group is a mandatory scope key on every execution read).
// model_slug records the RESOLVED model actually used (the #375 default result),
// not just the (possibly-null/later-changed) definition pin. UNIQUE(iteration_id,
// task_id) enforces one execution per definition per iteration.

export const taskExecutions = pgTable(
  "task_executions",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    iterationId: varchar("iteration_id")
      .notNull()
      .references(() => taskGroupIterations.id, { onDelete: "cascade" }),
    // SEC1 (history integrity): `set null` (not cascade) so removing a task
    // DEFINITION between runs never destroys that task's historical executions
    // across prior iterations (immutable iteration history, §6/R2). Nullable
    // column: a historical row whose definition was deleted keeps task_name.
    taskId: varchar("task_id")
      .references(() => tasks.id, { onDelete: "set null" }),
    // Denormalized definition name captured at execution-creation time. Survives
    // a later definition delete (task_id → null) so the FE timeline + history
    // stay readable, and pairs with the null-task_id rows above.
    taskName: text("task_name"),
    groupId: varchar("group_id")
      .notNull()
      .references(() => taskGroups.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending").$type<TaskStatus>(),
    output: jsonb("output"),
    summary: text("summary"),
    artifacts: jsonb("artifacts").$type<Record<string, unknown>[]>(),
    decisions: jsonb("decisions").$type<string[]>(),
    errorMessage: text("error_message"),
    modelSlug: text("model_slug"),
    pipelineRunId: varchar("pipeline_run_id"),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    iterationIdIdx: index("executions_iteration_id_idx").on(table.iterationId),
    taskIdIdx: index("executions_task_id_idx").on(table.taskId),
    // UNIQUE(iteration_id, task_id) still holds: live rows have a non-null
    // task_id (one execution per definition per iteration); historical rows whose
    // definition was deleted carry task_id NULL, and PG treats NULLs as DISTINCT,
    // so they never collide with each other or with live rows.
    iterTaskUnique: unique("executions_iter_task_uq").on(
      table.iterationId,
      table.taskId,
    ),
  }),
);

export const insertTaskExecutionSchema = createInsertSchema(taskExecutions).omit({
  id: true,
  createdAt: true,
}).extend({
  status: z.enum(TASK_STATUSES).optional(),
});

export type InsertTaskExecution = z.infer<typeof insertTaskExecutionSchema>;
export type TaskExecutionRow = typeof taskExecutions.$inferSelect;

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
    // v2 (task-groups-v2 §3.4): a trace now belongs to a specific iteration.
    // groupId retained for back-compat single-trace reads.
    iterationId: varchar("iteration_id").references(() => taskGroupIterations.id, { onDelete: "cascade" }),
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
    iterationIdIdx: index("task_traces_iteration_id_idx").on(table.iterationId),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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

// ── Federation: Shared Sessions (issue #224) ────────────────────────────────

export const sharedSessions = pgTable("shared_sessions", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
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
    // Per-project scoping: ADR-001 PR-0c — resolves the column-not-found gap
    // that would cause fail-closed withProject(mcpToolCalls) to throw. Backfilled
    // from pipeline_runs.project_id via JOIN on pipeline_run_id (column retained,
    // TS field renamed to runId — see #53 Phase 1).
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** Nullable — tool calls may occur outside a run context. */
    runId: varchar("pipeline_run_id"),
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
    pipelineRunIdIdx: index("mcp_tool_calls_pipeline_run_id_idx").on(table.runId),
    startedAtIdx: index("mcp_tool_calls_started_at_idx").on(table.startedAt),
    connectionStartedIdx: index("mcp_tool_calls_connection_started_idx").on(
      table.connectionId,
      table.startedAt,
    ),
    projectIdIdx: index("mcp_tool_calls_project_id_idx").on(table.projectId),
  }),
);

export const insertMcpToolCallSchema = createInsertSchema(mcpToolCalls).omit({
  id: true,
  projectId: true,
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
    runId: varchar("pipeline_run_id"),
    stageId: text("stage_id"),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    costUsd: real("cost_usd").notNull().default(0),
    ts: timestamp("ts").notNull().defaultNow(),
  },
  (table) => [
    index("cost_ledger_workspace_ts_idx").on(table.workspaceId, table.ts),
    index("cost_ledger_workspace_provider_idx").on(table.workspaceId, table.provider),
    index("cost_ledger_run_idx").on(table.runId),
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

export const CHUNK_SOURCE_TYPES = ["code", "document", "memory_entry", "practice_card", "news_item"] as const;
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

// ─── Practice Cards (Active Knowledge Base — issue: active-knowledge-base) ─────
// Atomic, cited, dated best-practice assertions. Cards own structured/relational
// state here and are PROJECTED into memory_chunks (source_type='practice_card')
// for ANN search. The model must not bless its own update: ingested_by / verified_by
// are recorded separately and the API enforces they differ.

export const PRACTICE_CARD_STATUSES = ["active", "superseded", "deprecated"] as const;
export type PracticeCardStatus = typeof PRACTICE_CARD_STATUSES[number];

export const PRACTICE_CARD_REVIEW_STATES = [
  "pending_verification",
  "pending_review",
  "accepted",
  "rejected",
] as const;
export type PracticeCardReviewState = typeof PRACTICE_CARD_REVIEW_STATES[number];

export const PRACTICE_CARD_REFRESH_STATUSES = ["running", "completed", "failed"] as const;
export type PracticeCardRefreshStatus = typeof PRACTICE_CARD_REFRESH_STATUSES[number];

/** A single cited source backing a practice card. */
export interface PracticeCardSource {
  url: string;
  sourceVersion?: string;
  fetchedAt: string;
}

/** Scope descriptor — which tools/resources/tags the card applies to. */
export interface PracticeCardAppliesTo {
  tool: string;
  resourceKinds?: string[];
  tags?: string[];
}

export const practiceCards = pgTable(
  "practice_cards",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    statement: text("statement").notNull(),
    rationale: text("rationale").notNull(),
    appliesTo: jsonb("applies_to").notNull().default(sql`'{}'::jsonb`).$type<PracticeCardAppliesTo>(),
    sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`).$type<PracticeCardSource[]>(),
    confidence: real("confidence").notNull().default(0),
    status: text("status").notNull().default("active").$type<PracticeCardStatus>(),
    supersedes: jsonb("supersedes").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    supersededBy: jsonb("superseded_by").notNull().default(sql`'[]'::jsonb`).$type<string[]>(),
    /** Actor/agent that PROPOSED the card (untrusted label). */
    ingestedBy: text("ingested_by").notNull(),
    /** Authenticated user id that performed the ingest (server-bound, trusted; NOT NULL — the adversarial gate depends on it). */
    ingestedByUserId: text("ingested_by_user_id").notNull(),
    /** Actor/agent that VERIFIED the card (untrusted label; NULL until verified). */
    verifiedBy: text("verified_by"),
    /** Authenticated user id that performed verification (server-bound, trusted). */
    verifiedByUserId: text("verified_by_user_id"),
    verification: jsonb("verification").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
    reviewState: text("review_state").notNull().default("pending_verification").$type<PracticeCardReviewState>(),
    /** sha256(canonicalized statement+rationale+appliesTo) — server-computed, never client-supplied. */
    contentHash: text("content_hash").notNull(),
    lastVerifiedAt: timestamp("last_verified_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("practice_cards_workspace_topic_idx").on(table.workspaceId, table.topic),
    index("practice_cards_status_idx").on(table.workspaceId, table.status),
    index("practice_cards_review_state_idx").on(table.workspaceId, table.reviewState),
    index("practice_cards_verified_idx").on(table.workspaceId, table.lastVerifiedAt),
    unique("practice_cards_content_hash_uq").on(table.workspaceId, table.contentHash),
  ],
);

export type PracticeCardRow = typeof practiceCards.$inferSelect;

export const insertPracticeCardSchema = createInsertSchema(practiceCards).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  status: z.enum(PRACTICE_CARD_STATUSES).optional(),
  reviewState: z.enum(PRACTICE_CARD_REVIEW_STATES).optional(),
});

export type InsertPracticeCard = z.infer<typeof insertPracticeCardSchema>;

export const practiceCardRefreshRuns = pgTable(
  "practice_card_refresh_runs",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    workspaceId: varchar("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    topic: text("topic").notNull(),
    trigger: text("trigger").notNull().default("manual"),
    status: text("status").notNull().default("running").$type<PracticeCardRefreshStatus>(),
    report: jsonb("report").notNull().default(sql`'{}'::jsonb`).$type<Record<string, unknown>>(),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => [
    index("practice_card_refresh_runs_workspace_idx").on(table.workspaceId),
  ],
);

export type PracticeCardRefreshRunRow = typeof practiceCardRefreshRuns.$inferSelect;

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

// ─── Config sync conflict tracking (issue #323) ──────────────────────────────

export const CONFIG_CONFLICT_STATUSES = [
  "detected",
  "pending_human",
  "auto_resolved",
  "human_resolved",
  "dismissed",
] as const;
export type ConfigConflictStatus = typeof CONFIG_CONFLICT_STATUSES[number];

export const CONFIG_CONFLICT_STRATEGIES = [
  "lww",
  "human",
  "auto_merge",
  "approval_voting",
] as const;
export type ConfigConflictStrategy = typeof CONFIG_CONFLICT_STRATEGIES[number];

/**
 * Active conflict records for config-sync events.
 * Detected when an incoming remote event targets an entity modified locally
 * after the last synced version.
 */
export const configConflicts = pgTable(
  "config_conflicts",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    peerId: text("peer_id").notNull(),
    remoteVersion: text("remote_version").notNull(),
    localVersion: text("local_version").notNull(),
    remotePayload: jsonb("remote_payload").notNull().default(sql`'{}'::jsonb`),
    localPayload: jsonb("local_payload").notNull().default(sql`'{}'::jsonb`),
    strategy: text("strategy").notNull().$type<ConfigConflictStrategy>(),
    status: text("status").notNull().default("detected").$type<ConfigConflictStatus>(),
    detectedAt: timestamp("detected_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    isContested: boolean("is_contested").notNull().default(false),
    mergedPayload: jsonb("merged_payload"),
  },
  (table) => [
    index("config_conflicts_open_idx").on(table.entityKind, table.entityId).where(
      sql`${table.status} IN ('detected', 'pending_human')`,
    ),
    index("config_conflicts_peer_idx").on(table.peerId, table.detectedAt),
    index("config_conflicts_stale_idx").on(table.detectedAt).where(
      sql`${table.status} IN ('detected', 'pending_human')`,
    ),
  ],
);

export type ConfigConflictRow = typeof configConflicts.$inferSelect;
export type InsertConfigConflict = typeof configConflicts.$inferInsert;

/**
 * Per-entity strategy configuration.
 * Seeded with defaults; can be overridden per installation.
 */
export const configConflictStrategies = pgTable("config_conflict_strategies", {
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  entityKind: text("entity_kind").primaryKey(),
  strategy: text("strategy").notNull().default("lww").$type<ConfigConflictStrategy>(),
  markContested: boolean("mark_contested").notNull().default(true),
  alertAfterH: integer("alert_after_h").notNull().default(24),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export type ConfigConflictStrategyRow = typeof configConflictStrategies.$inferSelect;

/**
 * Append-only audit log for every conflict + resolution action.
 */
export const configConflictAudit = pgTable(
  "config_conflict_audit",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    conflictId: varchar("conflict_id").notNull().references(() => configConflicts.id, { onDelete: "cascade" }),
    entityKind: text("entity_kind").notNull(),
    entityId: text("entity_id").notNull(),
    peerId: text("peer_id").notNull(),
    strategy: text("strategy").notNull(),
    action: text("action").notNull(), // 'detected' | 'auto_resolved' | 'human_resolved' | 'dismissed'
    resolvedBy: text("resolved_by"),
    resolutionNote: text("resolution_note"),
    payloadBefore: jsonb("payload_before"),
    payloadAfter: jsonb("payload_after"),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    index("config_conflict_audit_conflict_idx").on(table.conflictId),
    index("config_conflict_audit_entity_idx").on(table.entityKind, table.entityId),
    index("config_conflict_audit_recorded_at_idx").on(table.recordedAt),
  ],
);

export type ConfigConflictAuditRow = typeof configConflictAudit.$inferSelect;
export type InsertConfigConflictAudit = typeof configConflictAudit.$inferInsert;

// ─── Lessons (Agent-Experience Memory — Track B) ─────────────────────────────
//
// Native "lessons" layer per the merged memory-architecture ADR. Captures the
// OUTCOME of a run/stage (what worked / what failed) as a reusable lesson and
// lets the planning stage recall relevant prior lessons so the pipeline
// improves across runs. Source material lives in `stage_executions`
// (status/error/output/rejectionReason — `error` added in #342) and run
// outcomes. Nullable-friendly; no backfill.

export const lessonOutcomes = ["success", "failure"] as const;
export type LessonOutcome = (typeof lessonOutcomes)[number];

export const lessons = pgTable(
  "lessons",
  {
    id: varchar("id")
      .primaryKey()
      .default(sql`gen_random_uuid()`),
    // Workspace the run operated against; NULL for unbound / legacy runs.
    workspaceId: varchar("workspace_id"),
    runId: varchar("run_id"),
    // NULL when the lesson summarizes a whole run rather than a single stage.
    stageId: varchar("stage_id"),
    teamId: text("team_id"),
    modelSlug: text("model_slug"),
    outcome: text("outcome").notNull().$type<LessonOutcome>(),
    // Coarse classification of a failure (e.g. "sandbox", "rejection",
    // "exception"); NULL for successes or when unclassified.
    category: text("category"),
    // Normalized failure signature for grouping similar lessons; NULL otherwise.
    errorPattern: text("error_pattern"),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    // Structured evidence (truncated error, output keys, rejection reason …).
    detail: jsonb("detail").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    index("lessons_workspace_idx").on(table.workspaceId),
    index("lessons_team_idx").on(table.teamId),
    index("lessons_outcome_idx").on(table.outcome),
    index("lessons_created_at_idx").on(table.createdAt),
  ],
);

export const insertLessonSchema = createInsertSchema(lessons, {
  outcome: z.enum(lessonOutcomes),
  detail: z.record(z.unknown()).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
});

export type InsertLesson = z.infer<typeof insertLessonSchema>;
export type Lesson = typeof lessons.$inferSelect;

// ─── Consilium Loop (Phase B — auto-versioned closed loop FSM, design §4) ────
// An auto-versioned loop: design-idea → consilium debate → DEV → re-review,
// until convergence. Mirrors `orchestratorRuns` (state enum + jsonb + error +
// audit timestamps). State is PERSISTED so the loop survives restart; every
// transition is an atomic compare-and-swap on `state` (Security H-3).

export const CONSILIUM_LOOP_STATES = [
  "pending",
  "building_context",
  "reviewing",
  "deciding",
  "developing",
  "awaiting_merge",
  // CONSERVATIVE agent-limit throttling: NON-terminal, RESTING pause (see
  // rate-limit.ts / `throttledPhase`) entered from `reviewing`/`developing` on a
  // CLEAR usage/rate-limit signature. An operator resumes it (`POST /retry`,
  // `controller.retryThrottled`); the poller never advances it (a RESTING state,
  // like `deciding` under the review gate).
  "throttled",
  "converged",
  "stopped_cap",
  "escalated",
  "failed",
  "cancelled",
] as const;
export type ConsiliumLoopState = typeof CONSILIUM_LOOP_STATES[number];

/** The terminal states — a loop in one of these never ticks again. */
export const CONSILIUM_LOOP_TERMINAL_STATES = [
  "converged",
  "stopped_cap",
  "escalated",
  "failed",
  "cancelled",
] as const satisfies readonly ConsiliumLoopState[];

// ADR-0003 I1 (re-scoped, GH #445 P1): the loop's autonomy CLASS — additive
// metadata only, set once at launch, nothing reads it yet. R0 = review/judge-only
// loop (no worktree write, advisory). A = coder-enabled loop (worktree write /
// Draft-PR capable, i.e. `pipeline.consiliumLoop.implement.enabled`). B/C/E are
// reserved for future deploy/prod targets (none exist today; never assigned).
// NO escalation and NO gating logic reads this field yet — that is P2/P3.
export const CONSILIUM_CLASSES = ["R0", "A", "B", "C", "E"] as const;
export type ConsiliumClass = (typeof CONSILIUM_CLASSES)[number];

/**
 * Provenance of ONE operator-selected skill whose directives extended a consilium
 * loop's engineer instruction (Stage 2 — skills extend the loop's engineer
 * instruction). Recorded on `consilium_loops.applied_skills` at launch so the
 * launch passport can show exactly which skills shaped the dispute.
 *
 * `dropped: true` marks a skill that WAS resolved (a real, project-scoped row) but
 * was DROPPED WHOLE — lowest-priority-last — to keep the combined instruction under
 * the byte budget. It never means "truncated mid-skill" (that never happens): a
 * skill is either applied in full or dropped in full.
 */
export interface AppliedSkillRef {
  /** The skills-table row id that was selected. */
  id: string;
  /** The skill name captured at launch (for a stable label even if the row changes). */
  name: string;
  /** True when the skill was dropped WHOLE to fit the byte budget (not applied). */
  dropped?: boolean;
}

/**
 * Task #52.2: real per-skill applied/converged aggregate, derived from
 * `consilium_loops.applied_skills` over TERMINAL-state loops only. Replaces the
 * mock contour observability skill-success-rate demo. `dropped: true` entries in
 * `applied_skills` are excluded from both `appliedCount` and `convergedCount` — a
 * dropped skill was never actually applied to the loop's instruction. A skill
 * that was applied to zero terminal loops has NO entry in the returned array
 * (never a synthetic 100%/0% rate).
 */
export interface ConsiliumLoopSkillStat {
  /** The skills-table row id (matches `AppliedSkillRef.id`). */
  skillId: string;
  /** Count of TERMINAL loops where this skill was applied (not dropped). */
  appliedCount: number;
  /** Of those, count whose loop `state === "converged"`. */
  convergedCount: number;
  /** `convergedCount / appliedCount`, 0..1. */
  successRate: number;
}

/**
 * Task #52.2: real loop outcome distribution over TERMINAL loops only. Replaces
 * the mock contour "yield/escape" metrics.
 */
export interface ConsiliumLoopOutcomeStats {
  /** Count of loops in a TERMINAL state (converged/stopped_cap/escalated/failed/cancelled). */
  totalTerminalLoops: number;
  /** Share of terminal loops that landed in `converged`, 0..1 (0 when totalTerminalLoops is 0). */
  convergedRate: number;
  /** Share of terminal loops that landed in `escalated`, 0..1 (0 when totalTerminalLoops is 0). */
  escalatedRate: number;
}

export const consiliumLoops = pgTable(
  "consilium_loops",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // The consilium task group re-run each round (cascade with the group).
    groupId: varchar("group_id")
      .notNull()
      .references(() => taskGroups.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending").$type<ConsiliumLoopState>(),
    // ADR-0003 I1 (re-scoped, GH #445 P1): additive autonomy metadata, set once at
    // launch (review-only ⇒ R0, coder-enabled ⇒ A). Nothing reads either column
    // yet — no escalation, no gating (that is P2/P3). `autonomyTier` is reserved
    // for a future finer-grained tier and is left unset (null) by this PR.
    class: text("class").notNull().default("R0").$type<ConsiliumClass>(),
    autonomyTier: text("autonomy_tier"),
    round: integer("round").notNull().default(0),
    maxRounds: integer("max_rounds").notNull().default(6),
    // Allowlisted target repo (validated at create AND re-validated each round).
    repoPath: text("repo_path").notNull(),
    // Diff baseline; null on round 1 (objective-only, no diff).
    lastReviewedCommit: text("last_reviewed_commit"),
    // BRANCH-targeted review: an optional git ref (branch name / revision) whose
    // tip + tree this review targets (content read AT THAT REF, no checkout).
    // null ⇒ working-tree HEAD (existing behavior; full back-compat).
    reviewRef: text("review_ref"),
    // Per-loop commit-message/MR-title prefix (migration 0057): OPTIONAL operator
    // string prepended (single space) to every SDLC-coder git commit subject AND the
    // Merge-Request title for THIS loop — lets a loop targeting a repo whose
    // pre-receive hook requires an issue key (e.g. a Jira key) pass the push.
    // Sanitized (control-stripped/collapsed/trimmed/clamped ≤64) at write time in the
    // create route AND defensively re-sanitized at every git-commit/MR-title call
    // site (never a shell string — argv/body-file only). Null/absent ⇒ byte-identical
    // to today's subjects/titles (no prefix).
    commitPrefix: text("commit_prefix"),
    // "Large Research" preset gate (migration 0059, additive): TRUE ONLY for
    // loops launched under the `large-research` preset (`createConsiliumReview`).
    // When true, `consilium-loop-controller.ts` PAUSES the loop in `deciding`
    // after each review round instead of auto-developing — the operator either
    // requests another review round (`POST /rereview`, comment-steered) or
    // proceeds to development (`POST /develop`, extended to allow promotion
    // from `deciding` for gated loops). NOT derived from the group name (unlike
    // panel/objective) because the controller's hot tick path reads it directly.
    // Default false ⇒ every existing/non-gated loop's autonomous
    // deciding→developing path is BYTE-IDENTICAL to today.
    reviewGate: boolean("review_gate").notNull().default(false),
    // Single-verifier re-review (migration 0044): HOW rounds AFTER the first are
    // run — 'full-dispute' (the default) or 'single-verifier'. NULLABLE; null ⇒
    // resolve from the operator default (pipeline.consiliumLoop.verifyReview.enabled).
    // An explicit per-loop value always wins. Additive text column (mirrors reviewRef);
    // INERT audit/dispatch selector — never a shell/branch/PR sink.
    reviewMode: text("review_mode").$type<ReviewMode>(),
    // Stage 1 (0031): OPTIONAL human "engineer instruction" — free-text steering
    // the dispute objective (factory objectiveExtra) AND the planner. UNTRUSTED:
    // fenced-as-data in prompts, inert in storage; never a shell/branch/PR sink.
    engineerInstruction: text("engineer_instruction"),
    // Stage 2 (0041): provenance of the operator-selected SKILLS whose directives
    // extended `engineer_instruction` (see review-factory composeInstructionWithSkills).
    // Nullable jsonb; null ⇒ no skills applied (the objective is byte-identical to the
    // pre-skills behavior). Each entry carries the skill id + name at launch; a
    // `dropped: true` entry was resolved but dropped WHOLE to fit the byte budget
    // (never truncated mid-skill). INERT in storage — display/audit only.
    appliedSkills: jsonb("applied_skills").$type<AppliedSkillRef[]>(),
    // T1 (loop-triggers.md §6, migration 0042): provenance of the TRIGGER that
    // fired this loop — `{ triggerId, triggerType, eventDigest, firedAt }`. Null ⇒
    // a human/API-initiated loop (no trigger). DEDICATED column (not archetype_params,
    // which the planner's partial updates own — same reasoning as applied_skills).
    // INERT display/audit data for the launch passport; never a prompt/shell sink.
    triggerProvenance: jsonb("trigger_provenance").$type<TriggerProvenance>(),
    // Stage 1 (0032): intent→archetype planner output / human override. All
    // nullable; written by a PLAIN partial update (NOT casLoopState) so persisting
    // an archetype on a terminal loop never transitions it.
    archetype: text("archetype").$type<Archetype>(),
    archetypeSource: text("archetype_source").$type<ArchetypeSource>(),
    archetypeRationale: text("archetype_rationale"),
    archetypeParams: jsonb("archetype_params").$type<Record<string, string>>(),
    archetypeDecidedAt: timestamp("archetype_decided_at"),
    currentIterationNumber: integer("current_iteration_number"),
    // Bug #7 (stranded-review recovery): per-round auto re-launch bookkeeping. A
    // review round runs in the in-process consilium workers; if they die (crash /
    // restart) the iteration is orphaned `running` and the loop sits in `reviewing`
    // forever. The controller RE-LAUNCHES the round on a no-progress stall, bounded
    // by `reviewMaxRedrives`; this column records `{ round, count }` so the bound
    // survives a restart (a process-local counter would reset → redrive storm) and
    // the passport can surface "re-launched attempt k/N". `round`-scoped: a read
    // whose `round` != the loop's current round counts as 0 (auto-resets each round,
    // no explicit clear). INERT display/audit — never a prompt/shell/branch sink.
    reviewRedrive: jsonb("review_redrive").$type<{ round: number; count: number }>(),
    devGroupId: varchar("dev_group_id"),
    prRef: text("pr_ref"),
    // M-3 (TOCTOU): HEAD captured when entering AWAITING_MERGE; merge-approved
    // records the merged HEAD (server-read) as the next baseline + any delta.
    headCommitAtReview: text("head_commit_at_review"),
    // Latest convergence count (anti-stall mirror of the per-round history).
    openP0: integer("open_p0"),
    error: text("error"),
    // Agent-limit throttling (additive, migration 0060): which phase to resume when
    // `state === "throttled"` — set on the reviewing/developing→throttled transition,
    // cleared (null) on `retryThrottled`'s resume. Null whenever the loop is not
    // (and has never been) throttled.
    throttledPhase: text("throttled_phase").$type<"review" | "develop">(),
    // "throttled v2" Part A (additive, migration 0061): bounded AUTO-RESUME bookkeeping
    // for a loop resting in `throttled`. `throttledUntil` is the deadline stamped at the
    // throttling transition (now + parsed Retry-After, else the configured cooldown);
    // cleared (null) on ANY resume (auto or operator). `resumeAttempts` counts bounded
    // auto-resume attempts for the CURRENT pause (reset to 0 on every resume) — an
    // operator's manual Retry resets it exactly like an auto-resume would, since both
    // clear the pause. Null/0 for every loop that has never been throttled.
    throttledUntil: timestamp("throttled_until"),
    resumeAttempts: integer("resume_attempts").notNull().default(0),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
    completedAt: timestamp("completed_at"),
  },
  (table) => ({
    groupIdIdx: index("consilium_loops_group_id_idx").on(table.groupId),
    createdByIdx: index("consilium_loops_created_by_idx").on(table.createdBy),
    // H-3: at most ONE non-terminal loop per group. Partial unique index over
    // group_id where the state is non-terminal — the DB rejects a 2nd active
    // loop on the same group even under a create race.
    oneActivePerGroup: uniqueIndex("consilium_loops_one_active_per_group")
      .on(table.groupId)
      .where(sql`state NOT IN ('converged','stopped_cap','escalated','failed','cancelled')`),
  }),
);

export const insertConsiliumLoopSchema = createInsertSchema(consiliumLoops).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertConsiliumLoop = typeof consiliumLoops.$inferInsert;
export type ConsiliumLoopRow = typeof consiliumLoops.$inferSelect;

export const consiliumLoopRounds = pgTable(
  "consilium_loop_rounds",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    loopId: varchar("loop_id")
      .notNull()
      .references(() => consiliumLoops.id, { onDelete: "cascade" }),
    round: integer("round").notNull(),
    // FK-by-value to task_group_iterations (the iteration that ran this round).
    iterationNumber: integer("iteration_number").notNull(),
    converged: boolean("converged"),
    openP0: integer("open_p0"),
    // The still-open action points — bounded by readConvergence (Security L-2).
    // We persist the structured AP metadata for audit + the DEV handoff, but
    // NEVER the raw diff / assembled prompt input (Security H-4).
    openActionPoints: jsonb("open_action_points").$type<ActionPoint[]>(),
    // The FULL judge verdict for this round (design: RoundVerdict) — the judge's
    // prose summary, pros/cons, and the FULL RANKED action-point list (ALL
    // priorities, not just the still-open P0 subset the SUMMARY fields carry).
    // Bounded (readJudgeVerdict) before write — same Security L-2 discipline as
    // openActionPoints (H-4: NEVER the raw diff/prompt input). NULL on pre-column /
    // backfilled rounds and whenever the raw judge output is unreadable at record time.
    verdict: jsonb("verdict").$type<RoundVerdict>(),
    // Phase 2 (direct review-runner): the round's review participants — primary
    // reviewers + rebuttals, each carrying the seat name, the model that filled it,
    // the role, and the review prose (design: RoundParticipant). Bounded before write
    // (Security L-2, same as verdict; H-4: NEVER the raw diff/prompt input). NULL on
    // pre-column / backfilled rounds and on rounds run via the legacy task-group path.
    participants: jsonb("participants").$type<RoundParticipant[]>(),
    baselineCommit: text("baseline_commit"),
    headCommit: text("head_commit"),
    testSummary: text("test_summary"),
    // #18: operator steering note recorded AFTER this round completes — the
    // runner-mode (Phase 2) mirror of `task_group_iterations.human_note`.
    // Runner-mode rounds never mint an iteration row (see composeIterationInput
    // in task-orchestrator.ts, legacy-path only), so this is where the note has
    // to live for the review-runner to carry it into the NEXT round's context
    // (alongside the existing prior-findings carry-forward). Nullable; only the
    // latest round's note is read forward. Never wired into the legacy path.
    humanNote: text("human_note"),
    // Stage 3 (research archetype): the structured, web-evidence-verified report the
    // research-runner produces INSTEAD of code + a Draft PR. Nullable; written
    // out-of-band by `updateLoopRoundReport` after the research run settles (mirror of
    // testSummary). NULL for every non-research round. Size-clamped before write.
    report: jsonb("report").$type<ResearchReport>(),
    // Stage 4 (observability tree): the per-round execution trace (phase → controller
    // → worker → skill → criterion) both archetypes emit. Nullable; written out-of-band
    // by `updateLoopRoundExecutionTrace` after settle (mirror of report/testSummary).
    // NULL for pre-Stage-4 rounds / rounds with no skilled run. Clamped before write.
    executionTrace: jsonb("execution_trace").$type<ExecutionTrace>(),
    // Result comments: an operator's thread-like notes on this round's Result,
    // appended (never edited/removed) by POST .../rounds/:round/comments. Nullable
    // jsonb array — absent on pre-column rounds, additive over every other field
    // above (same out-of-band settle discipline as humanNote/report). UNTRUSTED
    // operator free text; rendered client-side as inert plain text only.
    comments: jsonb("comments").$type<RoundComment[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    loopRoundUnique: unique("consilium_loop_rounds_uq").on(table.loopId, table.round),
    loopIdIdx: index("consilium_loop_rounds_loop_id_idx").on(table.loopId),
  }),
);

export const insertConsiliumLoopRoundSchema = createInsertSchema(consiliumLoopRounds).omit({
  id: true,
  createdAt: true,
});
export type InsertConsiliumLoopRound = typeof consiliumLoopRounds.$inferInsert;
export type ConsiliumLoopRoundRow = typeof consiliumLoopRounds.$inferSelect;

// ─── Credential Broker — Phase 1 (ADR-001) ──────────────────────────────────
//
// credential_leases:    short-TTL scoped lease records (active | revoked | expired)
// credential_access_log: append-only audit trail for all broker operations
//
// Both tables carry projectId NOT NULL to enforce hard project isolation.
// The application-layer broker asserts projectId === getProjectId() on entry
// before any DB access.
//
// Deploy: psql "$DATABASE_URL" -f migrations/0028_phase1_credential_broker.sql

export const CREDENTIAL_LEASE_STATUSES = ["active", "revoked", "expired"] as const;
export type CredentialLeaseStatus = typeof CREDENTIAL_LEASE_STATUSES[number];

export const CREDENTIAL_ACCESS_ACTIONS = [
  "list_metadata",
  "get_metadata",
  "lease_issued",
  "lease_used",
  "lease_revoked",
  "lease_expired",
  // [Wave-2] Non-lease direct secret accesses through the broker (ADR-001 PR-1d).
  "secret_accessed",
  // [Secrets Vault Phase 1] Credential-store writes against the `secrets` table.
  "secret_created",
  "secret_rotated",
  "secret_deleted",
] as const;
export type CredentialAccessAction = typeof CREDENTIAL_ACCESS_ACTIONS[number];

export const credentialLeases = pgTable(
  "credential_leases",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    credentialId: text("credential_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    runId: text("run_id").notNull(),
    stageId: text("stage_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    issuedAt: timestamp("issued_at").notNull().defaultNow(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<CredentialLeaseStatus>(),
  },
  (table) => ({
    projectIdx: index("credential_leases_project_id_idx").on(table.projectId),
    runIdx: index("credential_leases_run_id_idx").on(table.runId),
    statusIdx: index("credential_leases_status_idx").on(table.status),
  }),
);

export type CredentialLease = typeof credentialLeases.$inferSelect;
export type InsertCredentialLease = typeof credentialLeases.$inferInsert;

export const credentialAccessLog = pgTable(
  "credential_access_log",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    /** Null for plan-time actions (list_metadata, get_metadata) that have no lease. */
    leaseId: text("lease_id"),
    credentialId: text("credential_id").notNull(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null for plan-time actions that have no run context. */
    runId: text("run_id"),
    /** Null for plan-time actions that have no stage context. */
    stageId: text("stage_id"),
    action: text("action")
      .notNull()
      .$type<CredentialAccessAction>(),
    requestedBy: text("requested_by").notNull(),
    justification: text("justification"),
    success: boolean("success").notNull().default(true),
    errorMessage: text("error_message"),
    /** TTL in seconds — only set for lease_issued actions. */
    ttlSeconds: integer("ttl_seconds"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    projectIdx: index("credential_access_log_project_id_idx").on(table.projectId),
    credentialIdx: index("credential_access_log_credential_id_idx").on(table.credentialId),
  }),
);

export type CredentialAccessLogRow = typeof credentialAccessLog.$inferSelect;
export type InsertCredentialAccessLog = typeof credentialAccessLog.$inferInsert;

// ─── Secrets Vault (Phase 1 — project-scoped credential store) ──────────────
//
// Named, versioned secrets owned directly by a project (distinct from the
// workspaceConnections-backed credentials).  `valueEncrypted` is written and
// read ONLY inside server/credentials/db-crypto-provider.ts (the sanctioned
// crypto.encrypt()/decrypt() call site) — never accepted as plaintext input
// from a Zod-validated insert, hence the insert schema below omits it.
//
// Deploy: psql "$DATABASE_URL" -f migrations/0058_secrets_vault.sql

export const secrets = pgTable(
  "secrets",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    scope: text("scope"),
    provider: text("provider"),
    /** AES-256-GCM ciphertext (crypto.ts `v2:` format). Null until first rotate. */
    valueEncrypted: text("value_encrypted"),
    version: integer("version").notNull().default(1),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    rotatedAt: timestamp("rotated_at"),
  },
  (table) => ({
    projectNameIdx: uniqueIndex("secrets_project_name_idx").on(
      table.projectId,
      table.name,
    ),
  }),
);

export const insertSecretSchema = createInsertSchema(secrets).omit({
  id: true,
  projectId: true,
  valueEncrypted: true,
  version: true,
  createdBy: true,
  createdAt: true,
  rotatedAt: true,
});

export type SecretRow = typeof secrets.$inferSelect;
export type InsertSecretRow = z.infer<typeof insertSecretSchema>;

// ─── Standing Roles (ROLE-1 — standing-role.md §3/§8) ────────────────────────
//
// A StandingRole is a named, persistent identity — a saved COMPOSITION of a persona
// (standing instruction) + skills + a loop template — that an operator can manually
// "wake" (POST /api/roles/:id/wake) to spawn ONE ephemeral consilium loop. ROLE-1 is
// JUST the record + manual wake: NO triggers/concerns (ROLE-2) and NO role-scoped
// experience (ROLE-3) yet. A role is a DEFINITION, not a running process (§6) — its
// only runtime footprint is the ephemeral loops a wake spawns (which keep every
// existing isolation + human-merge gate). Separate import (localized/append-only) so
// the shared `./types.js` import line stays a single merge point for other teams.
// eslint-disable-next-line @typescript-eslint/no-duplicate-imports -- localized append
import type { StandingRoleLoopTemplate, StandingRoleConcern, StandingRolePolicy } from "./types.js";

export const standingRoles = pgTable(
  "standing_roles",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Project-scoped (owner/member isolation via withProject); cascades with project.
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // The standing instruction / persona that grounds every wake. Human-authored on
    // create, but UNTRUSTED at wake time: it (with the wake `focus`) is fed through
    // the review factory's `untrustedExtraBlock` (control-strip + byte-clamp + a
    // strictly-longer backtick fence) before it enters the loop objective. Inert in
    // storage; never a shell/branch/PR sink.
    persona: text("persona").notNull(),
    // The role's capability: skill ids (shared `skills.id`). Validated against the
    // PROJECT-SCOPED skill registry at create/update (fail-closed — an unknown id is
    // a 400) AND re-resolved project-scoped by the review factory at wake. jsonb string[].
    skills: jsonb("skills").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // How the role's ephemeral loops run: { preset, maxRounds?, reviewMode? }. `preset`
    // + `reviewMode` are server enums; `maxRounds` is bounded 1..6 by the factory.
    loopTemplate: jsonb("loop_template").$type<StandingRoleLoopTemplate>().notNull(),
    // ROLE-2 (standing-role.md §3, migration 0048): the concerns this role WATCHES —
    // each `{ id, repoPath, trigger:{type,filter}, focus, enabled?, triggerId? }`. A
    // concern is a DECLARATION; its runtime footprint is a BACKING trigger row whose
    // `config.roleConcern` names `{ roleId, concernId }`. Additive default '[]' so
    // every ROLE-1 row reads back as "no concerns" (byte-identical). jsonb array.
    concerns: jsonb("concerns").$type<StandingRoleConcern[]>().notNull().default(sql`'[]'::jsonb`),
    // ROLE-2 (§6, loop-triggers.md §4): the per-ROLE rails { budgetPerDay?, cascadeDepth? }.
    // Nullable ⇒ the server default constants apply (role-wake.ts). `enabled` (below)
    // stays the primary kill-switch; this is the quantitative budget/cascade rails.
    policy: jsonb("policy").$type<StandingRolePolicy>(),
    // A DISABLED role is inert — the wake endpoint refuses it (safety §6): a role can
    // never spawn work while disabled. ROLE-2: a disabled role's backing triggers also
    // never wake it (the dispatch enabled-gate is the authoritative check).
    enabled: boolean("enabled").notNull().default(true),
    createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    projectIdIdx: index("standing_roles_project_id_idx").on(table.projectId),
    createdByIdx: index("standing_roles_created_by_idx").on(table.createdBy),
  }),
);

export const insertStandingRoleSchema = createInsertSchema(standingRoles).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertStandingRole = typeof standingRoles.$inferInsert;
export type StandingRoleRow = typeof standingRoles.$inferSelect;
// ─── Experience plane — the "Dream" distillation (DREAM-1) ───────────────────
//
// The WRITE side of the Experience plane (docs/design/experience-plane-dream.md).
// A background distiller reads a TERMINAL consilium loop's already-persisted trail
// and emits compact, verification-GROUNDED items here — separate from Omniscience
// (state) and the SKILL.md registry (capability). DREAM-1 is WRITE-ONLY: items
// accumulate for inspection; no read path (DREAM-2), no consolidation (DREAM-3).
//
// GROUNDING (the crux, §1/§3/§6): `confidence` is a function of HOW the underlying
// claim was verified by OUR INDEPENDENT verification (test-run pass / single-verifier
// `closed` / merged-converged), NEVER of an agent's self-report. A coder-believed but
// verifier-refuted pattern lands as `refuted` (a negative lesson), equally stored.
//
// SCOPING: `projectId` mirrors `consilium_loops` (nullable) so items inherit the
// source loop's project isolation. The distiller writes with the loop's OWN projectId
// (not the ambient context — it runs cross-project under runAsSystem). `sourceLoopId`
// is the single loop the item was distilled from — its index makes the idempotency
// dedup ("has THIS loop already produced items?") an O(1) lookup, so a re-observe of a
// distilled loop writes NO duplicate. All model-derived text (`claim`, evidence titles)
// is clamped at distill time and INERT here — never a shell/branch/PR sink.
export const experienceItems = pgTable(
  "experience_items",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Nullable, mirrors consilium_loops.project_id — the source loop's project.
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // WHERE the pattern applies (§3): { repo, archetype, criterionClass } — plus an
    // OPTIONAL ROLE-3 (role, concern) when the source loop was role-fired (additive, no
    // migration: jsonb). A role-scoped item is fail-closed on read (same role only).
    scope: jsonb("scope").$type<ExperienceScope>().notNull(),
    // ONE distilled fact/pattern (clamped, inert).
    claim: text("claim").notNull(),
    // Auditable links back to the raw sessions this was distilled from.
    evidence: jsonb("evidence").$type<ExperienceEvidence[]>().notNull(),
    // HOW it was confirmed — the grounding (method, independent outcome, ratio).
    verification: jsonb("verification").$type<ExperienceVerification>().notNull(),
    // verified ⇐ independent confirmation ONLY | observed | refuted.
    confidence: text("confidence").$type<ExperienceConfidence>().notNull(),
    // Measured effect if this pattern was reused (DREAM-3 fills it; null at write).
    successDelta: real("success_delta"),
    // Auditable origin: { createdAt, dreamRunId, sourceLoops[] }.
    provenance: jsonb("provenance").$type<ExperienceProvenance>().notNull(),
    // Freshness/decay descriptor stamped at write (§6); decay machinery is DREAM-3.
    freshness: jsonb("freshness").$type<ExperienceFreshness>().notNull(),
    // DREAM-3 (§4/§6): the SCHEDULED consolidation pass's durable audit trail (merge
    // count, contradiction cross-link, decay origin). NULL on a DREAM-1 item; set the
    // first time the consolidator touches a surviving item. The consolidator writes ONLY
    // to this table — never state, never SKILL.md. Nullable ⇒ byte-identical for existing
    // rows and for a consolidate.enabled=false runtime (no pass ⇒ never populated).
    consolidation: jsonb("consolidation").$type<ExperienceConsolidation>(),
    // Links into Omniscience state (state ≠ experience, §5) — NEVER mutated here.
    relatedComponents: jsonb("related_components").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    // The single loop this item was distilled from — the idempotency dedup key.
    sourceLoopId: varchar("source_loop_id").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => ({
    // O(1) idempotency dedup: "has this loop already produced items?"
    sourceLoopIdx: index("experience_items_source_loop_id_idx").on(table.sourceLoopId),
    // DREAM-2 read path scopes by project; index it now (additive, cheap).
    projectIdx: index("experience_items_project_id_idx").on(table.projectId),
  }),
);

export const insertExperienceItemSchema = createInsertSchema(experienceItems).omit({
  id: true,
  createdAt: true,
});
export type InsertExperienceItem = typeof experienceItems.$inferInsert;
export type ExperienceItemRow = typeof experienceItems.$inferSelect;

// ─── DREAM-4: Experience → SKILL.md feedback proposals (experience-plane-dream §5/§9) ──
//
// The FEEDBACK side of the Experience plane, and the STRICT §5 boundary in table form:
// Experience ≠ Skill. A background proposer reads REPEATEDLY-`verified` experience_items
// and writes ONLY here — a PROPOSED SKILL.md patch entered into the ADR-0002 trust envelope
// as `unverified`. It NEVER mutates a SKILL.md, the `skills` table, `experience_items`, or
// the state graph. EVERY forward status move (`unverified`→`verified`/`rejected`/`deprecated`)
// is a HUMAN/CODEOWNERS decision via the review endpoint (requireRole maintainer/admin) —
// the Dream PROPOSES, a human DECIDES.
//
// `dedupKey` = `${project}::${skillName}::${patternHash}` — a UNIQUE guard so a proven
// pattern yields ONE proposal, never a spam of duplicates (the proposer skips a candidate
// whose key already exists; the DB unique index is the backstop against a race). `patchText`
// is INERT, clamped, fence-delimited model-derived text — the distilled claim is fenced-as-
// data, never a shell/branch/PR sink. `skillId` links the `skills`-table row when a READ of
// the registry knows the name, else null (the SKILL.md is referenced by name). Nullable/new
// table ⇒ byte-identical when `skillFeedback.enabled=false` (no proposer ⇒ no rows).
export const skillProposals = pgTable(
  "skill_proposals",
  {
    id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
    // Nullable, mirrors experience_items.project_id — the proven pattern's project.
    projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
    // The target skill name (the SKILL.md / skills-table `name`) the pattern maps to.
    skillName: text("skill_name").notNull(),
    // The skills-table row id, when a registry READ knows the name; else null. NEVER an FK
    // write target — DREAM-4 reads the registry, it never mutates it.
    skillId: varchar("skill_id"),
    // Idempotency/dedup guard: ONE proposal per (project, skill, pattern). UNIQUE.
    dedupKey: text("dedup_key").notNull(),
    // The normalized claim/pattern (audit; the human-readable side of dedupKey).
    patternKey: text("pattern_key").notNull(),
    // WHERE the pattern applies (the source items' scope).
    scope: jsonb("scope").$type<ExperienceScope>().notNull(),
    // The PROPOSED SKILL.md addition — INERT, clamped, fence-delimited. NEVER applied here.
    patchText: text("patch_text").notNull(),
    // The ADR-0002 trust-envelope status. DREAM-4 writes ONLY 'unverified'; forward moves are
    // human/CODEOWNERS decisions (the review endpoint).
    status: text("status").$type<SkillProposalStatus>().notNull().default("unverified"),
    // Auditable evidence links back to the proven loops.
    evidence: jsonb("evidence").$type<SkillProposalEvidence[]>().notNull(),
    // Auditable origin (which items/loops + the success-delta basis).
    provenance: jsonb("provenance").$type<SkillProposalProvenance>().notNull(),
    // A human review note stamped when a reviewer moves the status (audit). Null until reviewed.
    reviewNote: text("review_note"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => ({
    // The dedup backstop — one proposal per (project, skill, pattern).
    dedupIdx: uniqueIndex("skill_proposals_dedup_key_idx").on(table.dedupKey),
    projectIdx: index("skill_proposals_project_id_idx").on(table.projectId),
    statusIdx: index("skill_proposals_status_idx").on(table.status),
  }),
);

export const insertSkillProposalSchema = createInsertSchema(skillProposals).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertSkillProposal = typeof skillProposals.$inferInsert;
export type SkillProposalRow = typeof skillProposals.$inferSelect;

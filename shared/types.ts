import { z } from "zod";

// ─── Complexity Types ─────────────────────────────────────────────────────────

export type TaskComplexity = "trivial" | "standard" | "complex";

// ─── Auth Types ───────────────────────────────────────────────────────────────

export type UserRole = "user" | "maintainer" | "admin";

export interface User {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: UserRole;
  lastLoginAt: Date | null;
  createdAt: Date;
}

export interface AuthSession {
  token: string;
  user: User;
  expiresAt: Date;
}

// ─── Pipeline Types ───────────────────────────────────────────────────────────

export type TeamId =
  | "planning"
  | "architecture"
  | "development"
  | "testing"
  | "code_review"
  | "deployment"
  | "monitoring"
  | "fact_check"
  | string; // custom stage IDs (Phase 5)

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled"
  | "rejected";

export type StageStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped"
  | "awaiting_approval";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export type QuestionStatus = "pending" | "answered" | "dismissed";

export type ModelProvider = "vllm" | "ollama" | "mock" | "anthropic" | "google" | "xai";

export interface TeamConfig {
  id: TeamId;
  name: string;
  description: string;
  defaultModelSlug: string;
  systemPromptTemplate: string;
  inputSchema: Record<string, string>;
  outputSchema: Record<string, string>;
  tools: string[];
  color: string;
  icon: string;
}

// ─── Execution Strategy Types ────────────────────────────────────────────────

export type ExecutionStrategyType = "single" | "moa" | "debate" | "voting";

export interface SingleStrategy {
  type: "single";
}

export interface ProposerConfig {
  modelSlug: string;
  role?: string;
  temperature?: number;
}

export interface AggregatorConfig {
  modelSlug: string;
  systemPrompt?: string;
}

export interface MoaStrategy {
  type: "moa";
  proposers: ProposerConfig[];
  aggregator: AggregatorConfig;
  proposerPromptOverride?: string;
}

export interface DebateParticipant {
  modelSlug: string;
  role: "proposer" | "critic" | "devil_advocate";
  persona?: string;
}

export interface JudgeConfig {
  modelSlug: string;
  criteria?: string[];
}


export interface ArbitratorConfig {
  modelSlug: string;
  criteria?: Array<'correctness' | 'completeness' | 'security' | 'performance'>;
}

export interface DebateStrategy {
  type: "debate";
  participants: DebateParticipant[];
  judge: JudgeConfig;
  rounds: number;
  stopEarly?: boolean;
  arbitrator?: ArbitratorConfig;
}

export interface CandidateConfig {
  modelSlug: string;
  temperature?: number;
}

export interface VotingStrategy {
  type: "voting";
  candidates: CandidateConfig[];
  threshold: number;
  validationMode: "text_similarity" | "test_execution";
}

export type ExecutionStrategy =
  | SingleStrategy
  | MoaStrategy
  | DebateStrategy
  | VotingStrategy;

// ─── Strategy Result Detail Types ────────────────────────────────────────────

// ─── Arbitrator Verdict Types ─────────────────────────────────────────────────

export type ArbitratorCriterion = 'correctness' | 'completeness' | 'security' | 'performance';

export interface ArbitratorCriterionScore {
  criterion: ArbitratorCriterion;
  scores: Record<string, number>; // participant modelSlug → 1–10
  reasoning: string;
}

export interface ArbitratorVerdict {
  arbitratorModelSlug: string;
  criterionScores: ArbitratorCriterionScore[];
  winner: string;        // modelSlug of winning participant
  confidence: number;    // 0–1
  reasoning: string;
  participantSlugs: string[]; // enforced at runtime: arbitratorModelSlug NOT in this list
}

export interface MoaDetails {
  proposerResponses: Array<{ modelSlug: string; content: string; role?: string }>;
  aggregatorModelSlug: string;
}

export interface DebateDetails {
  rounds: Array<{
    round: number;
    participant: string;
    role: string;
    content: string;
    provider?: string;
  }>;
  judgeModelSlug: string;
  verdict: string;
  providerDiversityScore?: number;    // 0–1; 1 = all participants on different providers
  arbitratorVerdict?: ArbitratorVerdict;
}

export interface VotingDetails {
  candidates: Array<{ modelSlug: string; content: string; passed: boolean }>;
  winnerIndex: number;
  agreement: number;
}

export interface StrategyResult {
  finalContent: string;
  strategy: ExecutionStrategyType;
  details: MoaDetails | DebateDetails | VotingDetails | null;
  totalTokensUsed: number;
  durationMs: number;
}

// ─── Sandbox Types ────────────────────────────────────────────────────────────

export interface SandboxConfig {
  enabled: boolean;
  image: string;
  command: string;
  installCommand?: string;
  workdir?: string;
  timeout?: number;
  memoryLimit?: string;
  cpuLimit?: number;
  networkEnabled?: boolean;
  env?: Record<string, string>;
  failOnNonZero?: boolean;
}

export interface SandboxFile {
  path: string;
  content: string;
}

export interface SandboxArtifact {
  path: string;
  content: string;
  sizeBytes: number;
  isBinary: boolean;
}

export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  artifacts: SandboxArtifact[];
  image: string;
  command: string;
}

// ─── WS Event Types ──────────────────────────────────────────────────────────

export type WsEventType =
  | "pipeline:started"
  | "pipeline:completed"
  | "pipeline:failed"
  | "pipeline:cancelled"
  | "stage:started"
  | "stage:progress"
  | "stage:completed"
  | "stage:failed"
  | "stage:awaiting_approval"
  | "stage:approved"
  | "stage:rejected"
  | "question:asked"
  | "question:answered"
  | "chat:message"
  | "chat:stream_chunk"
  | "chat:stream_end"
  | "model:status"
  | "strategy:started"
  | "strategy:proposer"
  | "strategy:debate:round"
  | "strategy:debate:judge"
  | "strategy:debate:arbitrator"
  | "strategy:voting:candidate"
  | "strategy:completed"
  | "sandbox:starting"
  | "sandbox:output"
  | "sandbox:completed"
  | "stage:thought_tree"
  | "stage:model_downgraded"
  | "parallel:split"
  | "parallel:subtask:started"
  | "parallel:subtask:completed"
  | "parallel:merged"
  | "guardrail:checking"
  | "guardrail:passed"
  | "guardrail:failed"
  | "guardrail:retrying"
  | "delegation:requested"
  | "delegation:completed"
  | "delegation:failed"
  | "dag:stage:ready"
  | "dag:stage:skipped"
  | "dag:edge:evaluated"
  | "dag:completed"
  | "trigger:fired"
  | "trigger:error"
  | "swarm:started"
  | "swarm:clone:started"
  | "swarm:clone:completed"
  | "swarm:clone:failed"
  | "swarm:merging"
  | "swarm:completed"
  | "manager:decision"
  | "manager:complete"
  | "manager:error"
  | "workspace:index_start"
  | "workspace:index_progress"
  | "workspace:index_complete"
  | "workspace:index_error";

export interface WsEvent {
  type: WsEventType;
  runId?: string;
  stageExecutionId?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}

export interface GatewayRequest {
  modelSlug: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  /** Per-request timeout override in milliseconds */
  timeoutMs?: number;
}

export interface GatewayResponse {
  content: string;
  tokensUsed: number;
  modelSlug: string;
  finishReason: string;
}

// ─── Privacy Proxy Types ─────────────────────────────────────────────────────

export type EntityType =
  | 'domain'
  | 'ip_address'
  | 'ip_cidr'
  | 'k8s_namespace'
  | 'k8s_resource'
  | 'argocd_app'
  | 'git_url'
  | 'docker_image'
  | 'cloud_account'
  | 'cloud_resource_id'
  | 'env_variable'
  | 'api_key'
  | 'email'
  | 'hostname'
  | 'service_name'
  | 'custom_pattern';

export type EntitySeverity = 'critical' | 'high' | 'medium' | 'low';

export interface DetectedEntity {
  type: EntityType;
  value: string;
  start: number;
  end: number;
  confidence: number;
  severity: EntitySeverity;
}

export interface AnonymizationResult {
  anonymizedText: string;
  sessionId: string;
  entitiesFound: DetectedEntity[];
}

export type AnonymizationLevel = 'off' | 'standard' | 'strict';

export interface PrivacySettings {
  enabled: boolean;
  level: AnonymizationLevel;
  vaultTtlMs: number;   // default: 3_600_000 (1 hour)
  auditLog: boolean;    // default: true
}

// ─── Tool Types ───────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
  source: 'builtin' | 'mcp';
  mcpServer?: string;
  tags?: string[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface ToolCallLogEntry {
  iteration: number;
  call: ToolCall;
  result: ToolResult;
  durationMs: number;
}

export interface StageToolConfig {
  enabled: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  maxToolCalls?: number;       // default 10
  toolChoice?: 'auto' | 'none' | 'required';
}

// ─── MCP Server Config ────────────────────────────────────────────────────────

export interface McpServerConfig {
  id: number;
  name: string;
  transport: 'stdio' | 'sse' | 'streamable-http';
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  env?: Record<string, string> | null;
  enabled: boolean;
  autoConnect: boolean;
  toolCount: number;
  lastConnectedAt?: Date | null;
  createdAt?: Date | null;
}

// ─── Pipeline Stage Config ────────────────────────────────────────────────────

export interface PipelineStageConfig {
  teamId: TeamId;
  modelSlug: string;
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
  approvalRequired?: boolean;
  executionStrategy?: ExecutionStrategy;
  privacySettings?: PrivacySettings;
  sandbox?: SandboxConfig;
  tools?: StageToolConfig;
  parallel?: ParallelConfig;
  swarm?: SwarmConfig;
  guardrails?: StageGuardrail[];
  autoModelRouting?: {
    enabled: boolean;
  };
  skillId?: string;
  delegationEnabled?: boolean; // default false; stage must opt-in to receive delegate fn
}

export interface StageOutput {
  teamId: string;
  output: Record<string, unknown>;
  stageIndex: number;
}

export interface StageContext {
  runId: string;
  stageIndex: number;
  stageExecutionId?: string;
  modelSlug?: string;
  temperature?: number;
  maxTokens?: number;
  previousOutputs: Record<string, unknown>[];
  fullContext?: StageOutput[];
  userAnswers?: Record<string, string>;
  privacySettings?: PrivacySettings;
  sessionId?: string;
  memoryContext?: string;
  stageConfig?: PipelineStageConfig;
  variables?: Record<string, string>;
  delegate?: DelegateFn; // present when DelegationService is active and stage has delegationEnabled
}

export interface TeamResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  raw: string;
  questions?: string[];
  strategyResult?: StrategyResult;
  toolCallLog?: ToolCallLogEntry[];
}

// ─── Provider Message ─────────────────────────────────────────────────────────

export type ProviderMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface ILLMProviderOptions {
  maxTokens?: number;
  temperature?: number;
  /** Per-request timeout override in milliseconds. Defaults to provider default (30s). */
  timeoutMs?: number;
  /** Associate this request with a pipeline run for logging. */
  runId?: string;
  /** Associate this request with a stage execution for logging. */
  stageExecutionId?: string;
  /** Team identifier for cost/usage grouping. */
  teamId?: string;
  /** Tools to make available for this completion. */
  tools?: ToolDefinition[];
  /** How the model chooses tools. */
  toolChoice?: 'auto' | 'none' | 'required';
}

export interface ILLMProvider {
  /**
   * Non-streaming completion. Returns full content, token count, and optional tool calls.
   */
  complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number; toolCalls?: ToolCall[]; finishReason?: 'stop' | 'tool_use' }>;

  /**
   * Streaming completion. Yields text delta chunks as they arrive.
   * The generator MUST be exhaustible — callers do not cancel mid-stream.
   */
  stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string>;
}

// ─── Strategy Preset (existing usage in constants.ts) ────────────────────────

export interface StrategyPreset {
  id: string;
  label: string;
  description: string;
  temperature: number;
  maxTokens: number;
  stageOverrides?: Partial<Record<TeamId, { modelSlug?: string; temperature?: number }>>;
}

// ─── Execution Strategy Preset ───────────────────────────────────────────────

export interface ExecutionStrategyPreset {
  /** Estimated cost multiplier relative to single-model baseline (1.0 = 1x cost). */
  costMultiplier: number;
  id: string;
  label: string;
  description: string;
  stageStrategies: Partial<Record<TeamId, ExecutionStrategy>>;
}

// ─── Fact Check Output ────────────────────────────────────────────────────────

export interface FactCheckOutput {
  verdict: "pass" | "warn" | "fail";
  issues: string[];
  enrichedOutput: string;
  summary: string;
}

// ─── Thought Tree Types ───────────────────────────────────────────────────────

export interface ThoughtNode {
  id: string;
  parentId: string | null;
  type: 'reasoning' | 'tool_call' | 'tool_result' | 'decision' | 'guardrail' | 'memory_recall' | 'branch' | 'conclusion';
  label: string;
  content: string;
  timestamp: number;
  durationMs?: number;
  metadata?: {
    model?: string;
    provider?: string;
    tokensUsed?: number;
    toolName?: string;
    decision?: string;
    confidence?: number;
    isConsensus?: boolean;
  };
}

export type ThoughtTree = ThoughtNode[];

// ─── Memory Types ─────────────────────────────────────────────────────────────

export type MemoryScope = 'global' | 'workspace' | 'pipeline' | 'run';
export type MemoryType = 'decision' | 'pattern' | 'fact' | 'preference' | 'issue' | 'dependency';

export interface Memory {
  id: number;
  scope: MemoryScope;
  scopeId: string | null;
  type: MemoryType;
  key: string;
  content: string;
  source: string | null;
  confidence: number;
  tags: string[] | null;
  createdAt: Date | null;
  updatedAt: Date | null;
  expiresAt: Date | null;
  createdByRunId: number | null;
}

export interface InsertMemory {
  scope: MemoryScope;
  scopeId?: string | null;
  type: MemoryType;
  key: string;
  content: string;
  source?: string | null;
  confidence?: number;
  tags?: string[];
  expiresAt?: Date | null;
  createdByRunId?: number | null;
}

export interface TeamMemoryHint {
  key: string;
  content: string;
  type: MemoryType;
}

// ─── Workspace Types ──────────────────────────────────────────────────────────

export interface Workspace {
  id: string;
  name: string;
  type: "local" | "remote";
  path: string;
  branch: string;
  status: "active" | "syncing" | "error";
  lastSyncAt: Date | null;
  createdAt: Date;
}

export interface FileEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  size?: number;
}

export interface GitStatus {
  branch: string;
  modified: string[];
  staged: string[];
  untracked: string[];
}

export interface CodeSelection {
  startLine: number;
  endLine: number;
  content: string;
}

export interface CodeChange {
  type: "replace" | "insert" | "delete";
  startLine: number;
  endLine?: number;
  content?: string;
}

export interface ReviewIssue {
  severity: "error" | "warning" | "info";
  file: string;
  line?: number;
  message: string;
  suggestion?: string;
}

export interface ReviewResult {
  model: string;
  issues: ReviewIssue[];
  summary: string;
}

// ─── Config Diff Types (0.5b.2) ───────────────────────────────────────────────

export interface ConfigDiffEntry {
  path: string;                   // e.g. "defaults.tokenBudget"
  platformValue: unknown;
  projectValue: unknown;
  changeType: "override" | "new" | "removed";
}

export interface ProjectConfigResponse {
  detected: boolean;              // true if multiqlti.yaml found in workspace
  projectConfig: Record<string, unknown> | null;
  diff: ConfigDiffEntry[];
}

// ─── Ephemeral Run Variable Types (0.5b.2) ────────────────────────────────────

export interface RunVariableState {
  runId: string;
  variables: Record<string, string>;
  status: "active" | "cleared" | "preserved";
  preserveReason?: string;        // e.g. "run failed at stage: deployment"
  createdAt: Date;
  clearedAt: Date | null;
}

// ─── Maintenance Autopilot Types (Phase 4.5) ─────────────────────────────────

export type MaintenanceCategory =
  | "dependency_update"
  | "breaking_change"
  | "security_advisory"
  | "license_compliance"
  | "api_deprecation"
  | "config_drift"
  | "best_practices"
  | "documentation"
  | "access_control"
  | "data_retention"
  | "cert_expiry"
  | "infra_drift"
  | "vendor_status"
  | "system_hardening";

export type MaintenanceSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface MaintenanceCategoryConfig {
  category: MaintenanceCategory;
  enabled: boolean;
  severity: MaintenanceSeverity;
  customRules?: Record<string, unknown>;
}

export interface MaintenancePolicy {
  id: string;
  workspaceId: string | null;
  enabled: boolean;
  schedule: string;
  categories: MaintenanceCategoryConfig[];
  severityThreshold: MaintenanceSeverity;
  autoMerge: boolean;
  notifyChannels: string[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ScoutFinding {
  id: string;
  scanId: string;
  category: MaintenanceCategory;
  severity: MaintenanceSeverity;
  title: string;
  description: string;
  currentValue: string;
  recommendedValue: string;
  effort: "trivial" | "small" | "medium" | "large";
  references: string[];
  autoFixable: boolean;
  complianceRefs: string[];
  status: "open" | "actioned" | "dismissed";
}

export interface MaintenanceScan {
  id: string;
  policyId: string;
  workspaceId: string;
  status: "running" | "completed" | "failed";
  findings: ScoutFinding[];
  importantCount: number;
  triggeredPipelineId: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

export interface HealthScore {
  score: number;
  breakdown: {
    openFindings: number;
    complianceCoverage: number;
    meanTimeToFix: number;
    scanFrequency: number;
  };
  trend: "improving" | "stable" | "declining";
}

export interface Recommendation {
  type:
    | "increase_frequency"
    | "enable_category"
    | "review_stale"
    | "upgrade_threshold";
  message: string;
  priority: "high" | "medium" | "low";
  actionable: boolean;
  suggestedChange?: Partial<MaintenancePolicy>;
}

// ─── Parallel Split Execution Types (Phase 3.8) ───────────────────────────────

export type MergeStrategy = "concatenate" | "review" | "auto";

export interface ParallelConfig {
  enabled: boolean;
  mode: "auto" | "manual";
  maxAgents: number;
  splitterModelSlug?: string;
  mergerModelSlug?: string;
  mergeStrategy: MergeStrategy;
}

export interface ModelParallelCapabilities {
  maxConcurrentAgents: number;
  supportedMergeStrategies: MergeStrategy[];
  recommendedForSplitting: boolean;
}

export interface SubTask {
  id: string;
  title: string;
  description: string;
  context: string[];
  suggestedModel?: string;
  estimatedComplexity: "low" | "medium" | "high";
}

export interface SplitPlan {
  shouldSplit: boolean;
  reason: string;
  subtasks: SubTask[];
}

export interface SubTaskResult {
  subtask: SubTask;
  output: string;
  tokensUsed: number;
  modelSlug: string;
  durationMs: number;
}

export interface ParallelExecutionMeta {
  parallelExecution: true;
  subtaskCount: number;
  succeededCount: number;
  failedCount: number;
  totalTokens: number;
}

// ─── Parallel Split Execution Types (Phase 3.8) ───────────────────────────────


export interface ParallelConfig {
  enabled: boolean;
  mode: "auto" | "manual";
  maxAgents: number;
  splitterModelSlug?: string;
  mergerModelSlug?: string;
  mergeStrategy: MergeStrategy;
}

export interface ModelParallelCapabilities {
  maxConcurrentAgents: number;
  supportedMergeStrategies: MergeStrategy[];
  recommendedForSplitting: boolean;
}

export interface SubTask {
  id: string;
  title: string;
  description: string;
  context: string[];
  suggestedModel?: string;
  estimatedComplexity: "low" | "medium" | "high";
}

export interface SplitPlan {
  shouldSplit: boolean;
  reason: string;
  subtasks: SubTask[];
}

export interface SubTaskResult {
  subtask: SubTask;
  output: string;
  tokensUsed: number;
  modelSlug: string;
  durationMs: number;
}

export interface ParallelExecutionMeta {
  parallelExecution: true;
  subtaskCount: number;
  succeededCount: number;
  failedCount: number;
  totalTokens: number;
}

// ─── Custom Stage Types (Phase 5) ────────────────────────────────────────────

export interface CustomStageConfig {
  id: string;         // e.g. "custom_summarize_abc123"
  name: string;
  description: string;
  systemPrompt: string;
  icon: string;       // emoji, e.g. "🗒️"
}

// ─── Specialization Profile Types (Phase 5) ──────────────────────────────────

export interface SpecializationProfile {
  id: string;
  name: string;
  isBuiltIn: boolean;
  assignments: Record<string, string>; // teamId → modelSlug
  createdAt?: Date;
}

// ─── Guardrail Types (Phase 6.1) ─────────────────────────────────────────────

export type GuardrailType = "json_schema" | "regex" | "custom" | "llm_check";
export type GuardrailOnFail = "retry" | "skip" | "fail" | "fallback";

export interface GuardrailConfig {
  /** JSON Schema object — for "json_schema" type */
  schema?: Record<string, unknown>;
  /** Regex string — for "regex" type */
  pattern?: string;
  /** JS expression returning boolean — for "custom" type (sandboxed) */
  validatorCode?: string;
  /** Validation prompt — for "llm_check" type */
  llmPrompt?: string;
  /** Model to use for llm_check (defaults to cheapest/mock) */
  llmModelSlug?: string;
}

export interface StageGuardrail {
  id: string;
  type: GuardrailType;
  config: GuardrailConfig;
  onFail: GuardrailOnFail;
  /** Applies to "retry" action only; default 1 */
  maxRetries: number;
  /** Applies to "fallback" action */
  fallbackValue?: string;
  enabled: boolean;
}

export interface GuardrailResult {
  guardrailId: string;
  passed: boolean;
  reason?: string;
  attempts: number;
}

// ─── Agent Delegation Types (Phase 6.4) ──────────────────────────────────────

export const MAX_DELEGATION_DEPTH = 2;

export type DelegationPriority = "blocking" | "async";

export type DelegationStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "rejected";

export interface DelegationRequest {
  fromStage: TeamId;
  toStage: TeamId;
  task: string;
  context: Record<string, unknown>;
  priority: DelegationPriority;
  timeout: number; // ms — only enforced for blocking calls
}

export interface DelegationResult {
  output: Record<string, unknown>;
  raw: string;
  tokensUsed: number;
  durationMs: number;
}

export interface DelegationRecord {
  id: string;
  runId: string;
  fromStage: TeamId;
  toStage: TeamId;
  task: string;
  context: Record<string, unknown>;
  priority: DelegationPriority;
  timeout: number;
  depth: number;
  status: DelegationStatus;
  result: DelegationResult | null;
  errorMessage: string | null;
  startedAt: Date;
  completedAt: Date | null;
  createdAt: Date;
}

// Passed into StageContext so a team can invoke delegation
export type DelegateFn = (request: DelegationRequest) => Promise<DelegationResult>;
// ─── DAG Types (Phase 6.2) ────────────────────────────────────────────────────

export type DAGConditionOperator = "eq" | "neq" | "gt" | "lt" | "contains" | "exists";

export interface DAGCondition {
  field: string;
  operator: DAGConditionOperator;
  value?: string | number | boolean | null;
}

export interface DAGEdge {
  id: string;
  from: string;
  to: string;
  condition?: DAGCondition;
  label?: string;
}

export interface DAGStage {
  id: string;
  teamId: TeamId;
  modelSlug: string;
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
  approvalRequired?: boolean;
  executionStrategy?: ExecutionStrategy;
  privacySettings?: PrivacySettings;
  sandbox?: SandboxConfig;
  tools?: StageToolConfig;
  parallel?: ParallelConfig;
  swarm?: SwarmConfig;
  guardrails?: StageGuardrail[];
  autoModelRouting?: { enabled: boolean };
  skillId?: string;
  position: { x: number; y: number };
  label?: string;
}

export interface PipelineDAG {
  stages: DAGStage[];
  edges: DAGEdge[];
}

// ─── Trigger Types (Phase 6.3) ────────────────────────────────────────────────

export type TriggerType = "webhook" | "schedule" | "github_event" | "file_change";

// Per-type discriminated union for the config JSONB column
export interface WebhookTriggerConfig {
  // endpoint is auto-derived as /api/webhooks/:triggerId — not stored
  // secret is stored encrypted in secretEncrypted column — not in this object
}

export interface ScheduleTriggerConfig {
  cron: string;      // standard 5-field cron expression, e.g. "0 9 * * 1"
  timezone?: string; // IANA timezone string, defaults to "UTC"
  input?: string;    // optional pipeline input override for this scheduled run
}

export interface GitHubEventTriggerConfig {
  repository: string;   // "owner/repo"
  events: string[];     // ["push", "pull_request", "issues", "release"]
  refFilter?: string;   // optional, e.g. "refs/heads/main"
  // secret stored encrypted in secretEncrypted column — not in this object
}

export interface FileChangeTriggerConfig {
  watchPath: string;     // absolute or workspace-relative path
  patterns: string[];    // micromatch glob patterns, e.g. ["**/*.ts", "!node_modules/**"]
  debounceMs?: number;   // default 500
  input?: string;        // optional pipeline input template; may reference {{filePath}}
}

export type TriggerConfig =
  | WebhookTriggerConfig
  | ScheduleTriggerConfig
  | GitHubEventTriggerConfig
  | FileChangeTriggerConfig;

// Public-facing Trigger shape returned from API (no secretEncrypted)
export interface PipelineTrigger {
  id: string;
  pipelineId: string;
  type: TriggerType;
  config: TriggerConfig;
  // webhookUrl is synthesized by the server for webhook and github_event triggers
  webhookUrl?: string;
  // hasSecret tells client whether a secret is configured without exposing it
  hasSecret: boolean;
  enabled: boolean;
  lastTriggeredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertTrigger {
  pipelineId: string;
  type: TriggerType;
  config: TriggerConfig;
  // plaintext secret supplied at creation/update — immediately encrypted, never stored raw
  secret?: string;
  enabled?: boolean;
}

export interface UpdateTrigger {
  type?: TriggerType;
  config?: TriggerConfig;
  secret?: string | null;  // null = remove secret; undefined = leave unchanged
  enabled?: boolean;
}

// WS event payload shapes
export interface TriggerFiredPayload {
  triggerId: string;
  triggerType: TriggerType;
  pipelineId: string;
  runId: string;
}

export interface TriggerErrorPayload {
  triggerId: string;
  triggerType: TriggerType;
  pipelineId: string;
  error: string;
}

// ─── Manager Mode Types (Phase 6.6) ──────────────────────────────────────────

/**
 * Configuration for manager-mode pipelines.
 * Stored in pipelines.managerConfig JSONB column.
 */
export interface ManagerConfig {
  /** Model slug for the manager LLM (e.g., "claude-sonnet-4" or "gpt-4") */
  managerModel: string;
  /** Teams the manager is allowed to dispatch. Manager cannot call unlisted teams. */
  availableTeams: TeamId[];
  /** Maximum iterations before forced failure (hard cap: 20, enforced server-side) */
  maxIterations: number;
  /** High-level objective the manager is working toward */
  goal: string;
}

/**
 * A single decision made by the manager LLM during orchestration.
 */
export interface ManagerDecision {
  /** Action to take: dispatch a team, declare success, or declare failure */
  action: "dispatch" | "complete" | "fail";
  /** Team to dispatch (required if action === "dispatch") */
  teamId?: TeamId;
  /** Task description for the dispatched team (required if action === "dispatch") */
  task?: string;
  /** Manager's reasoning (shown in UI for transparency) */
  reasoning: string;
  /** Which iteration this decision was made in (1-indexed) */
  iterationNumber: number;
  /** Summary of outcome (required if action === "complete" or "fail") */
  outcome?: string;
}

/**
 * Record of a single manager iteration, persisted to DB.
 */
export interface ManagerIteration {
  id: string;
  runId: string;
  iterationNumber: number;
  decision: ManagerDecision;
  /** Output from the dispatched team (null if action was complete/fail) */
  teamResult?: string;
  /** Tokens used by manager LLM for this iteration's decision */
  tokensUsed: number;
  /** Duration of the manager LLM call in ms */
  decisionDurationMs: number;
  /** Duration of team execution in ms (null if no dispatch) */
  teamDurationMs?: number;
  createdAt: Date;
}

/**
 * Structured output schema for the manager LLM's response.
 * This is what the LLM returns (parsed from JSON).
 */
export interface ManagerLLMResponse {
  action: "dispatch" | "complete" | "fail";
  teamId?: string;
  task?: string;
  reasoning: string;
  outcome?: string;
}

// ─── Manager WS Payload Types ────────────────────────────────────────────────

export interface ManagerDecisionPayload {
  iterationNumber: number;
  action: "dispatch" | "complete" | "fail";
  teamId?: string;
  task?: string;
  reasoning: string;
  tokensUsed: number;
}

export interface ManagerCompletePayload {
  totalIterations: number;
  outcome: string;
  status: "completed" | "failed";
  totalTokensUsed: number;
  totalDurationMs: number;
}

export interface ManagerErrorPayload {
  iteration: number;
  error: string;
  recoverable: boolean;
}

// ─── Tracing Types (Phase 6.5) ────────────────────────────────────────────────

export interface TraceSpan {
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;       // Unix epoch milliseconds
  endTime: number;         // Unix epoch milliseconds
  attributes: Record<string, string | number>;
  events: Array<{
    name: string;
    timestamp: number;     // Unix epoch milliseconds
    attributes?: Record<string, string>;
  }>;
  status: "ok" | "error";
}

export interface PipelineTrace {
  traceId: string;
  runId: string;
  spans: TraceSpan[];
}

/** Propagation context passed between instrumentation points */
export interface SpanContext {
  traceId: string;
  spanId: string;
}

/** Shape used when persisting a trace to DB (mirrors InsertTrace in schema.ts) */
export interface InsertTrace {
  traceId: string;
  runId: string;
  spans: TraceSpan[];
}

// ─── Agent Swarm Types (Phase 6.7) ────────────────────────────────────────────

export type SwarmSplitter = "chunks" | "perspectives" | "custom";
export type SwarmMerger = "concatenate" | "llm_merge" | "vote";

export interface SwarmPerspective {
  label: string;               // e.g. "Security Review"
  systemPromptSuffix: string;  // appended to the stage's base system prompt
}

export interface SwarmConfig {
  enabled: boolean;
  cloneCount: number;          // 2–20, enforced in Zod
  splitter: SwarmSplitter;
  merger: SwarmMerger;
  mergerModelSlug?: string;    // for llm_merge strategy; defaults to stage modelSlug
  perspectives?: SwarmPerspective[];
  customClonePrompts?: string[];
}

export interface SwarmCloneResult {
  cloneIndex: number;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
  tokensUsed: number;
  durationMs: number;
  systemPromptPreview: string;  // first 120 chars of the prompt used
}

export interface SwarmResult {
  mergedOutput: string;
  cloneResults: SwarmCloneResult[];
  succeededCount: number;
  failedCount: number;
  totalTokensUsed: number;
  mergerUsed: SwarmMerger;
  splitterUsed: SwarmSplitter;
  durationMs: number;
}

// ─── Swarm Zod Schemas ────────────────────────────────────────────────────────

export const SwarmPerspectiveSchema = z.object({
  label: z.string().min(1).max(100),
  systemPromptSuffix: z.string().min(1).max(4000),
});

export const SwarmConfigSchema = z.object({
  enabled: z.boolean(),
  cloneCount: z.number().int().min(2).max(20),
  splitter: z.enum(["chunks", "perspectives", "custom"]),
  merger: z.enum(["concatenate", "llm_merge", "vote"]),
  mergerModelSlug: z.string().min(1).max(200).optional(),
  perspectives: z.array(SwarmPerspectiveSchema).max(20).optional(),
  customClonePrompts: z.array(z.string().min(1).max(8000)).max(20).optional(),
}).refine(
  (val) => {
    if (val.splitter === "custom") {
      return Array.isArray(val.customClonePrompts) &&
             val.customClonePrompts.length === val.cloneCount;
    }
    return true;
  },
  { message: "customClonePrompts length must equal cloneCount when splitter is 'custom'" }
);

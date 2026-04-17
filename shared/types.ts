import { z } from "zod";

// ─── Complexity Types ─────────────────────────────────────────────────────────

export type TaskComplexity = "trivial" | "standard" | "complex";

// ─── Auth Types ───────────────────────────────────────────────────────────────

export type UserRole = "user" | "maintainer" | "admin";
export type OAuthProvider = "github" | "gitlab";

export interface User {
  id: string;
  email: string;
  name: string;
  isActive: boolean;
  role: UserRole;
  oauthProvider?: OAuthProvider | null;
  oauthId?: string | null;
  avatarUrl?: string | null;
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
  | "rejected"
  | "handed_off";

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

export type ModelProvider = "vllm" | "ollama" | "mock" | "anthropic" | "google" | "xai" | "lmstudio";

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

// ─── Dynamic Consensus Threshold Types (#285) ────────────────────────────────

/** A task signal emitted by a pipeline stage or present in pipeline input. */
export interface TaskSignal {
  /** Signal key (e.g. "signal:high_risk", "signal:low_stakes", or a tag). */
  key: string;
  /** Where this signal came from. */
  source: "tag" | "risk_level" | "upstream_stage";
  /** Optional scalar payload (e.g. the risk_level string). */
  value?: string;
}

/** Container for all signals accumulated during a pipeline run. */
export interface TaskSignalBag {
  signals: TaskSignal[];
}

/** Maps a signal key to a threshold value. */
export interface SignalThresholdRule {
  signal: string;
  threshold: number;
}

/** Fixed (legacy) threshold — always uses `value`. */
export interface StaticThresholdConfig {
  mode: "static";
  /** Threshold value in [0, 1]. */
  value: number;
}

/**
 * Task-signal-based threshold — finds the first matching rule;
 * falls back to `default` when no rule matches.
 */
export interface TaskSignalThresholdConfig {
  mode: "task_signal";
  rules: SignalThresholdRule[];
  /** Threshold used when no rule matches. */
  default: number;
}

/**
 * Confidence-based threshold — adjusts the base threshold up/down
 * based on aggregated candidate confidence within [floor, ceiling].
 *
 * Formula: effective = clamp(base - (conf - 0.5) * sensitivity, floor, ceiling)
 *   conf=1 → threshold decreases (easier to pass)
 *   conf=0 → threshold increases (harder to pass)
 */
export interface ConfidenceThresholdConfig {
  mode: "confidence";
  /** Starting point before confidence adjustment. */
  base: number;
  /** Minimum allowed effective threshold. */
  floor: number;
  /** Maximum allowed effective threshold. */
  ceiling: number;
  /**
   * How strongly confidence shifts the threshold.
   * Default: 0.2.  At sensitivity=0.2 and conf=1.0, threshold drops by 0.1.
   */
  sensitivity?: number;
}

export type VotingThresholdConfig =
  | StaticThresholdConfig
  | TaskSignalThresholdConfig
  | ConfidenceThresholdConfig;

// ─── Fallback Configuration (#285) ───────────────────────────────────────────

export type VotingFallbackStrategy = "escalate" | "abort" | "partial";
export type VotingFallbackOutcome = "escalated" | "partial";

export interface VotingFallbackConfig {
  strategy: VotingFallbackStrategy;
  /**
   * Model slug used when strategy="escalate".
   * Defaults to "claude-opus-4".
   */
  escalationModelSlug?: string;
}

// ─── Candidate Confidence Score (#285) ───────────────────────────────────────

export type ConfidenceSource = "provider" | "self_eval" | "heuristic";

export interface CandidateConfidenceScore {
  modelSlug: string;
  /** Confidence score in [0, 1]. */
  score: number;
  source: ConfidenceSource;
}

// ─── Updated VotingStrategy ───────────────────────────────────────────────────

export interface VotingStrategy {
  type: "voting";
  candidates: CandidateConfig[];
  /** Legacy fixed threshold.  Used when `thresholdConfig` is absent. */
  threshold: number;
  validationMode: "text_similarity" | "test_execution";
  /**
   * Dynamic threshold configuration (#285).
   * When present, overrides the legacy `threshold` field.
   */
  thresholdConfig?: VotingThresholdConfig;
  /**
   * Fallback behaviour when the threshold is not met (#285).
   * Default: { strategy: "partial" }.
   */
  fallback?: VotingFallbackConfig;
  /**
   * Task-signal bag propagated from pipeline input and upstream stages (#285).
   * Populated at runtime by the executor; not set by users in config.
   */
  signals?: TaskSignalBag;
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
  // ─── Observability fields added by issue #285 ─────────────────────────────
  /** The resolved threshold actually used for this run. */
  thresholdUsed?: number;
  /** Threshold resolution mode that was active. */
  thresholdMode?: "static" | "task_signal" | "confidence";
  /** Per-candidate confidence scores. */
  confidenceScores?: CandidateConfidenceScore[];
  /** Aggregated confidence across all candidates (0–1). */
  aggregatedConfidence?: number;
  /** What happened when threshold was not met (absent when threshold was met). */
  fallbackOutcome?: VotingFallbackOutcome;
  /** Model slug used during escalation (present only when fallbackOutcome="escalated"). */
  escalationModelSlug?: string;
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

// ─── Sandbox Hardening Types (#281) ─────────────────────────────────────────

/** Which OCI runtime to use for a sandbox container. */
export type SandboxRuntime = "runsc" | "runc";

/** A host:port egress allow-list entry. */
export interface EgressAllowEntry {
  /** Hostname or IP address. */
  host: string;
  /** Port number (1–65535). */
  port: number;
  /** Transport protocol. Default: tcp. */
  protocol?: "tcp" | "udp";
}

/** Resource quota applied to a sandbox namespace (Docker + K8s). */
export interface SandboxResourceQuota {
  /** CPU limit in Kubernetes notation (e.g. "500m", "2"). */
  limitCpu?: string;
  /** Memory limit in Kubernetes notation (e.g. "256Mi", "1Gi"). */
  limitMemory?: string;
  /** Maximum number of pods (K8s namespace only). */
  maxPods?: number;
}

/**
 * Extended sandbox hardening configuration.
 * Merged into SandboxConfig when present; defaults applied for omitted fields.
 */
export interface SandboxHardeningConfig {
  /**
   * Preferred OCI runtime.
   * "runsc" = gVisor (use when available); "runc" = standard runc.
   * Default: "runsc" with automatic fallback to "runc" + warning.
   */
  runtime?: SandboxRuntime;
  /** Egress allow-list. Default: empty (deny all egress). */
  egressAllowList?: EgressAllowEntry[];
  /** Resource quota overrides. */
  resourceQuota?: SandboxResourceQuota;
  /**
   * When true, apply AppArmor profile that restricts writes to /tmp/sandbox.
   * Ignored when runtime is "runsc" (gVisor enforces at kernel level).
   */
  applyAppArmor?: boolean;
  /**
   * When true, apply a scoped seccomp profile (denies clone3/ptrace/reboot).
   * Default: true.
   */
  applySeccomp?: boolean;
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
  | "parallel:cost:warning"
  | "parallel:cost:exceeded"
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
  | "workspace:index_error"
  | "workspace:incremental_flush"
  | "workspace:full_rebuild_complete"
  // ─── Task Orchestrator Events ───────────────────────────────────────────────
  | "task:created"
  | "task:ready"
  | "task:started"
  | "task:progress"
  | "task:completed"
  | "task:failed"
  | "taskgroup:started"
  | "taskgroup:progress"
  | "taskgroup:completed"
  | "taskgroup:failed"
  // ─── Task Trace Events ──────────────────────────────────────────────────────
  | "trace:span:started"
  | "trace:span:completed"
  | "trace:span:failed"
  // ─── Federation Handoff & Approval Events ────────────────────────────────
  | "federation:handoff:sent"
  | "federation:handoff:received"
  | "federation:handoff:accepted"
  | "federation:user_joined"
  | "federation:user_left"
  | "approval:requested"
  | "approval:vote_received"
  | "approval:resolved"
  // ─── A2A Inter-stage Messaging Events (issue #269) ──────────────────────────
  | "stage:a2a:clarify"
  | "stage:a2a:answer"
  | "stage:a2a:timeout"
  | "stage:connection:blocked";

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
  | 'k8s_pod'
  | 'k8s_service'
  | 'k8s_configmap'
  | 'k8s_secret_ref'
  | 'k8s_ingress'
  | 'k8s_cluster'
  | 'argocd_app'
  | 'argocd_project'
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
  /** Workspace connection ID — set when this MCP server represents a workspace connection. */
  connectionId?: string;
  /** Connection type string (e.g. "github", "kubernetes"). */
  connectionType?: string;
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
  remoteAgent?: RemoteAgentStageConfig;
  /**
   * Explicit allow-list of workspace connection IDs this stage may invoke.
   * Default: empty array (deny-all). Must opt-in per connection.
   */
  allowedConnections?: string[];
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
  published: boolean;
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
  published?: boolean;
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
  | "system_hardening"
  | "cve_scan"
  | "log_analysis"
  | "container_scan";

// ─── Log Source Config (Phase 6.11) ──────────────────────────────────────────

export interface LogSourceConfig {
  type: "file" | "http";
  path?: string;
  url?: string;
  headers?: Record<string, string>;
}

// ─── Auto-Trigger Audit (Phase 6.11) ─────────────────────────────────────────

export interface AutoTriggerAuditRow {
  id: string;
  scanId: string;
  findingId: string;
  pipelineRunId: string;
  triggeredAt: Date;
  triggeredBy: string | null;
}

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
  autoTriggerPipelineId: string | null;
  autoTriggerEnabled: boolean;
  logSourceConfig: LogSourceConfig | null;
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

export type MergeStrategy = "concatenate" | "llm_merge" | "vote" | "review" | "auto";

// ─── Sharding Types (Phase 6.12) ────────────────────────────────────────────

export type ShardingMode = "equal" | "weighted" | "natural";

export interface ShardComplexity {
  /** Estimated token count for the full input */
  inputTokens: number;
  /** Number of files referenced */
  fileCount: number;
  /** Number of test cases/suites detected */
  testCount: number;
  /** Composite complexity score */
  score: number;
}

export interface CostThresholdConfig {
  /** Warn (but proceed) above this USD amount */
  warnUsd?: number;
  /** Block execution above this USD amount */
  blockUsd?: number;
}

export interface ParallelConfig {
  enabled: boolean;
  mode: "auto" | "manual";
  maxAgents: number;
  splitterModelSlug?: string;
  mergerModelSlug?: string;
  mergeStrategy: MergeStrategy;
  // ── Phase 6.12 additions ──────────────────────────────────────────────────
  /** Sharding strategy for dynamic shard sizing */
  shardingStrategy?: ShardingMode;
  /** Target complexity score per shard; splitter computes shard count automatically */
  shardTargetSize?: number;
  /** Maximum tokens allowed per subtask input; input is truncated + summarised if exceeded */
  maxTokensPerSubtask?: number;
  /** Cost-gate configuration; warn or block before expensive splits */
  costThreshold?: CostThresholdConfig;
  /** How subtasks are split (used by Splitter). */
  splitStrategy?: string;
  /** Capability-based model routing for subtasks. */
  capabilityRouting?: {
    enabled: boolean;
    availableModels: string[];
  };
}

/** Cost tier classification for a model (used in parallel capability routing). */
export type CostTier = "low" | "medium" | "high";

export interface ModelParallelCapabilities {
  maxConcurrentAgents: number;
  supportedMergeStrategies: MergeStrategy[];
  recommendedForSplitting: boolean;
  /** Rate limit in requests per minute. */
  rateLimit?: number;
  /** Cost classification for subtask model selection. */
  costTier?: CostTier;
  /** Strengths for capability-based routing (e.g. "reasoning", "code"). */
  strengths?: string[];
  /** Whether the model supports agentic multi-step execution. */
  agenticCapability?: boolean;
  /** Maximum context window in tokens. */
  contextWindow?: number;
}

// ─── Rate Limiter Types ─────────────────────────────────────────────────────

/** Action to take when parallel execution hits a rate or cost limit. */
export type RateLimitFallback = "abort" | "warn" | "queue";

/** Global guardrails applied to all parallel pipeline splits. */
export interface ParallelGuardrails {
  /** Maximum concurrent subtask agents per model slug. */
  maxConcurrentPerModel: number;
  /** Minimum cooldown in ms between successive requests to the same model. */
  cooldownBetweenRequests: number;
  /** Maximum USD cost allowed for a single split execution. */
  maxTotalCostPerSplit: number;
  /** What to do when a limit is hit. */
  onLimitHit: RateLimitFallback;
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
  /** Populated when a cost threshold was hit */
  costExceeded?: {
    estimatedUsd: number;
    limitUsd: number;
    action: "warned" | "blocked";
  };
  /** Dynamic sharding metadata */
  sharding?: {
    mode: ShardingMode;
    shardCount: number;
    complexityScore: number;
  };
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
  | "rejected"
  | "handed_off";

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
  remoteAgent?: RemoteAgentStageConfig;
  /** See PipelineStageConfig.allowedConnections */
  allowedConnections?: string[];
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

// ─── Skill Marketplace Types (Phase 6.16) ─────────────────────────────────────

export type SharingLevel = "private" | "team" | "public";

export interface SkillVersionConfig {
  name: string;
  description: string;
  teamId: string;
  systemPromptOverride: string;
  tools: string[];
  modelPreference: string | null;
  outputSchema: Record<string, unknown> | null;
  tags: string[];
}

export interface SkillVersionRecord {
  id: string;
  skillId: string;
  version: string;
  config: SkillVersionConfig;
  changelog: string;
  createdBy: string;
  createdAt: Date;
}

export interface SkillYaml {
  apiVersion: "multiqlti/v1";
  kind: "Skill";
  metadata: {
    name: string;
    version: string;
    author: string;
    tags: string[];
    description: string;
  };
  spec: {
    teamId: string;
    systemPrompt: string;
    tools: string[];
    modelPreference: string | null;
    outputSchema: Record<string, unknown> | null;
    sharing: SharingLevel;
  };
}

export interface MarketplaceSkill {
  id: string;
  name: string;
  description: string;
  teamId: string;
  tags: string[];
  version: string;
  author: string;
  usageCount: number;
  sharing: SharingLevel;
  modelPreference: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type MarketplaceSortField = "usageCount" | "newest" | "name";

export interface MarketplaceFilters {
  search?: string;
  tags?: string[];
  teamId?: string;
  author?: string;
  sort: MarketplaceSortField;
  limit: number;
  offset: number;
}

export interface InsertSkillVersion {
  skillId: string;
  version: string;
  config: SkillVersionConfig;
  changelog: string;
  createdBy: string;
}

// ─── Platform Version Types ────────────────────────────────────────────────────

// ─── Task Orchestrator Types ───────────────────────────────────────────────

export type TaskGroupStatus = "pending" | "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = "pending" | "blocked" | "ready" | "running" | "completed" | "failed" | "cancelled";
export type TaskExecutionMode = "pipeline_run" | "direct_llm";

export interface TaskResult {
  summary: string;
  artifacts?: Record<string, unknown>[];
  decisions?: string[];
  output?: Record<string, unknown>;
}

// ─── Platform Version Types ────────────────────────────────────────────────────

export interface VersionsResponse {
  platform: {
    frontend: string;
    backend: string;
    node: string;
    buildDate: string;
    gitCommit: string;
  };
  runtimes: {
    docker: string | null;
    vllm: string | null;
    ollama: string | null;
  };
  database: {
    postgres: string | null;
  };
}

// ─── Task Trace Types (End-to-End Request Observability) ─────────────────────

export type TaskTraceSpanType = "task_group" | "task" | "pipeline_run" | "stage" | "llm_call";
export type TaskTraceSpanStatus = "running" | "completed" | "failed";

export interface TaskTraceSpanMetadata {
  taskId?: string;
  pipelineRunId?: string;
  stageIndex?: number;
  modelSlug?: string;
  provider?: string;
  tokensUsed?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
  inputSizeBytes?: number;
  outputSizeBytes?: number;
  error?: string;
}

// ─── Issue Tracker Integration Types ─────────────────────────────────────────

export type TrackerProvider = "jira" | "clickup" | "linear" | "github";

export interface TrackerConnection {
  id: string;
  taskGroupId: string;
  provider: TrackerProvider;
  issueUrl: string;
  issueKey: string;
  projectKey: string | null;
  syncComments: boolean;
  syncSubtasks: boolean;
  apiToken: string | null;
  baseUrl: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
}

export interface SplitTask {
  name: string;
  description: string;
  conditionsOfDone: string[];
  tests: string[];
  dependsOn?: string[];
}

export interface TaskTraceSpan {
  spanId: string;
  parentSpanId: string | null;
  name: string;
  type: TaskTraceSpanType;
  status: TaskTraceSpanStatus;
  startTime: number;       // epoch ms
  endTime?: number;        // epoch ms
  durationMs?: number;
  metadata: TaskTraceSpanMetadata;
}

// ─── Model Skill Binding Types (Phase 6.17) ───────────────────────────────────

export interface ModelSkillBinding {
  id: string;
  modelId: string;
  skillId: string;
  createdBy: string | null;
  createdAt: Date;
}

export interface ModelWithSkills {
  modelId: string;
  skills: import("./schema.js").Skill[];
}

// ─── Git Skill Sources (issue #161) ──────────────────────────────────────────

export interface GitSkillSource {
  id: string;
  name: string;
  repoUrl: string;
  branch: string;
  path: string;
  syncOnStart: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface GitSkillSourceWithStats extends GitSkillSource {
  skillCount: number;
}

// ── Phase 8: Remote Agents (ABOX) ─────────────────────────────────────────

export type RemoteAgentEnvironment = "kubernetes" | "linux" | "docker" | "cloud";
export type RemoteAgentTransport = "mcp-sse" | "mcp-streamable-http" | "a2a-http" | "a2a-grpc";
export type RemoteAgentStatus = "online" | "offline" | "degraded" | "connecting";
export type A2ATaskStatus = "submitted" | "working" | "completed" | "failed" | "cancelled";

export interface AgentSkill {
  id: string;
  name: string;
  description?: string;
  inputModes?: string[];
  outputModes?: string[];
}

export interface AgentCapability {
  streaming?: boolean;
  pushNotifications?: boolean;
  stateTransitionHistory?: boolean;
}

export interface AgentCard {
  name: string;
  description?: string;
  version: string;
  url: string;
  capabilities?: AgentCapability;
  skills: AgentSkill[];
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
}

export interface RemoteAgentConfig {
  id: string;
  name: string;
  environment: RemoteAgentEnvironment;
  transport: RemoteAgentTransport;
  endpoint: string;
  cluster?: string | null;
  namespace?: string | null;
  labels?: Record<string, string> | null;
  authTokenEnc?: string | null;
  enabled: boolean;
  autoConnect: boolean;
  status: RemoteAgentStatus;
  lastHeartbeatAt?: Date | null;
  healthError?: string | null;
  agentCard?: AgentCard | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface A2AMessage {
  role: "user" | "agent";
  parts: A2APart[];
}

export interface A2APart {
  type: "text" | "data" | "file";
  text?: string;
  data?: Record<string, unknown>;
  mimeType?: string;
  uri?: string;
}

export interface A2ATask {
  id: string;
  agentId: string;
  runId?: string | null;
  stageExecutionId?: string | null;
  skill?: string | null;
  input: A2AMessage;
  status: A2ATaskStatus;
  output?: A2AMessage | null;
  error?: string | null;
  durationMs?: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface RemoteAgentStageConfig {
  agentId?: string;
  agentSelector?: Record<string, string>;
  skill?: string;
  timeoutMs?: number;
}

// ── Phase 9: Skill Market ─────────────────────────────────────────────────

export interface SkillRegistrySource {
  id: number;
  adapterId: string;
  name: string;
  enabled: boolean;
  config?: Record<string, unknown> | null;
  lastSyncAt?: Date | null;
  lastHealthCheckAt?: Date | null;
  healthStatus: string;
  healthError?: string | null;
  catalogCount: number;
  createdAt: Date;
}

export interface ExternalSkillSummary {
  externalId: string;
  name: string;
  description: string;
  source: string;
  tags: string[];
  author?: string;
  version?: string;
  popularity?: number;
  iconUrl?: string;
  installable: boolean;
}

export interface ExternalSkillDetails extends ExternalSkillSummary {
  tools: Array<{ name: string; description: string; inputSchema?: Record<string, unknown> }>;
  readme?: string;
  repositoryUrl?: string;
  license?: string;
  lastUpdated?: Date;
  installInstructions?: string;
  requiredConfig?: Array<{ key: string; description: string; secret: boolean }>;
}

export interface InstalledSkillResult {
  skillId: string;
  mcpServerId?: number;
  toolsRegistered: number;
  source: string;
  externalId: string;
}

export interface SkillUpdateInfo {
  skillId: string;
  externalId: string;
  source: string;
  currentVersion: string;
  latestVersion: string;
  changelog?: string;
}

export interface SkillInstallLogEntry {
  id: number;
  skillId?: string | null;
  externalSource?: string | null;
  externalId?: string | null;
  action: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  userId?: string | null;
  createdAt: Date;
}

// ── Federation: Share Permissions (issue #232) ───────────────────────────────

export type ShareRole = "owner" | "collaborator" | "viewer";

export interface SharePermissions {
  role: ShareRole;
  allowedStages: string[] | null;
  canChat: boolean;
  canVote: boolean;
  canViewMemories: boolean;
}

// ── Federation: Shared Sessions (issue #224) ────────────────────────────────

export interface SharedSession {
  id: string;
  runId: string;
  shareToken: string;
  ownerInstanceId: string;
  createdBy: string;
  expiresAt?: Date | null;
  isActive: boolean;
  createdAt: Date;
  permissions?: SharePermissions;
}

export interface CreateSharedSessionInput {
  runId: string;
  shareToken: string;
  ownerInstanceId: string;
  createdBy: string;
  expiresAt?: Date | null;
  role?: ShareRole;
  allowedStages?: string[] | null;
  canChat?: boolean;
  canVote?: boolean;
  canViewMemories?: boolean;
}

// ── Federation: Async Handoff (issue #226) ───────────────────────────────────

export interface HandoffBundle {
  run: Record<string, unknown>;
  pipeline: Record<string, unknown>;
  stages: Record<string, unknown>[];
  chatHistory: Record<string, unknown>[];
  memories: Record<string, unknown>[];
  llmRequests: Record<string, unknown>[];
  notes: string;
}

export interface ApprovalVote {
  userId: string;
  instanceId: string;
  vote: "approve" | "reject";
  reason?: string;
  timestamp: number;
}

export type ConflictResolutionMethod = "unanimous" | "arbitration" | "escalation";

export interface ConflictResolution {
  method: ConflictResolutionMethod;
  votes: ApprovalVote[];
  verdict?: "approve" | "reject";
  reasoning?: string;
}

// ── Federation: Presence (issue #226) ────────────────────────────────────────

export interface PresenceEntry {
  userId: string;
  instanceId: string;
  lastHeartbeat: number;
}

// ── Federation: Cross-Instance Delegation (issue #233) ───────────────────────

/** Policy controlling which peers/stages can be delegated and at what concurrency. */
export interface CrossDelegationPolicy {
  enabled: boolean;
  /** Max concurrent outstanding delegations from this instance. */
  maxConcurrent: number;
  /** Timeout in seconds for a single delegation. */
  timeoutSeconds: number;
  /** Allowed peer instance IDs; null = allow all. */
  allowedPeers: string[] | null;
  /** Allowed stage team IDs; null = allow all. */
  allowedStages: string[] | null;
}

/** Payload sent to a peer when delegating a stage. */
export interface CrossDelegationRequest {
  id: string;
  runId: string;
  stageIndex: number;
  stage: PipelineStageConfig;
  input: string;
  variables: Record<string, string>;
  fromInstanceId: string;
}

/** Result returned by a peer after executing a delegated stage. */
export interface CrossDelegationResult {
  delegationId: string;
  status: "completed" | "failed" | "timeout";
  output: string;
  tokensUsed: number;
  executionMs: number;
  error?: string;
}

// ── External Connections (issue #266) ─────────────────────────────────────────

export const CONNECTION_TYPES = [
  "gitlab",
  "github",
  "kubernetes",
  "aws",
  "jira",
  "grafana",
  "generic_mcp",
] as const;

export type ConnectionType = typeof CONNECTION_TYPES[number];

export const CONNECTION_STATUSES = ["active", "inactive", "error"] as const;
export type ConnectionStatus = typeof CONNECTION_STATUSES[number];

/** Public shape of a workspace connection — secrets are NEVER included. */
export interface WorkspaceConnection {
  id: string;
  workspaceId: string;
  type: ConnectionType;
  name: string;
  /** Non-secret configuration (URLs, usernames, project keys, etc.) */
  config: Record<string, unknown>;
  /** Whether the connection has encrypted secrets stored (boolean flag only — no plaintext). */
  hasSecrets: boolean;
  status: ConnectionStatus;
  lastTestedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string | null;
}

/** Input for creating a workspace connection. */
export interface CreateWorkspaceConnectionInput {
  workspaceId: string;
  type: ConnectionType;
  name: string;
  /** Non-secret configuration JSON — validated by per-type Zod schema. */
  config: Record<string, unknown>;
  /** Plaintext secrets — immediately encrypted, never stored raw. */
  secrets?: Record<string, string>;
  createdBy?: string | null;
}

/** Input for updating a workspace connection. */
export interface UpdateWorkspaceConnectionInput {
  name?: string;
  config?: Record<string, unknown>;
  /** Plaintext secrets — immediately encrypted, never stored raw. null = remove secrets. */
  secrets?: Record<string, string> | null;
  status?: ConnectionStatus;
  lastTestedAt?: Date | null;
}

// ─── A2A Inter-stage Messaging Types (issue #269) ────────────────────────────

/** Sent by a stage to ask another stage a question during a pipeline run. */
export interface StageA2AClarifyMessage {
  id: string;
  runId: string;
  fromStageId: string;
  targetStageId: string;
  question: string;
  /** References to context items (e.g. output keys) the question relates to. */
  contextRefs: string[];
  sentAt: number;    // epoch ms
  timeoutMs: number;
}

/** Response from a target stage to a clarify message. */
export interface StageA2AAnswerMessage {
  clarifyId: string;
  runId: string;
  fromStageId: string;
  targetStageId: string;
  answer: string;
  answeredAt: number;  // epoch ms
}

/** A2A conversation thread entry for trace UI display. */
export interface A2AThreadEntry {
  id: string;
  type: "clarify" | "answer" | "timeout";
  fromStageId: string;
  targetStageId: string;
  content: string;
  timestamp: number;  // epoch ms
}

/** Structured error emitted when a stage tries to use a disallowed connection. */
export interface ConnectionBlockedError {
  code: "CONNECTION_BLOCKED";
  connectionId: string;
  stageId: string;
  runId: string;
  message: string;
}

// ── MCP Tool Call Audit + Usage Metrics (issue #271) ─────────────────────────

/** Public shape of a recorded MCP tool call — args/result are already redacted. */
export interface McpToolCall {
  id: string;
  pipelineRunId: string | null;
  stageId: string | null;
  connectionId: string;
  toolName: string;
  /** Redacted copy of call arguments. */
  argsJson: Record<string, unknown>;
  /** Redacted copy of the result. Null on error. */
  resultJson: unknown | null;
  /** Generic error description. Null on success. */
  error: string | null;
  durationMs: number;
  startedAt: Date;
}

/** One data-point in the calls-per-day time series. */
export interface McpToolCallsPerDay {
  date: string;   // ISO date "YYYY-MM-DD"
  count: number;
}

/** Aggregate usage stats for a single workspace connection. */
export interface ConnectionUsageMetrics {
  connectionId: string;
  /** Calls per calendar day for the last 30 days. */
  callsPerDay: McpToolCallsPerDay[];
  /** Top N tools ranked by invocation count. */
  topTools: Array<{ toolName: string; count: number }>;
  /** Error rate (0–1) over the last 7 days. */
  errorRate7d: number;
  /** P95 latency in milliseconds across all calls in the last 30 days. */
  p95LatencyMs: number;
  /** True when the connection had zero calls in the last 30 days. */
  isOrphan: boolean;
}

/** Input for recording a tool call. */
export interface RecordMcpToolCallInput {
  pipelineRunId?: string | null;
  stageId?: string | null;
  connectionId: string;
  toolName: string;
  argsJson: Record<string, unknown>;
  resultJson?: unknown | null;
  error?: string | null;
  durationMs: number;
  startedAt?: Date;
}

// ── E2E Kubernetes Stage Types (issue #272) ───────────────────────────────────

/**
 * Resource quota limits for an ephemeral namespace.
 * All values follow Kubernetes resource notation (e.g. "2", "500m" for CPU;
 * "2Gi", "512Mi" for memory).
 */
export interface EphemeralNamespaceQuota {
  /** CPU limit for the entire namespace (default "2"). */
  limitCpu?: string;
  /** Memory limit for the entire namespace (default "2Gi"). */
  limitMemory?: string;
  /** Maximum pod count for the entire namespace (default 10). */
  maxPods?: number;
}

/**
 * Readiness check configuration.
 * Checks are performed in order: deployment rollout → endpoints → custom command.
 * Any single check failure aborts the stage.
 */
export interface ReadinessConfig {
  /** Kubernetes Deployment name to wait for (kubectl rollout status). */
  deploymentName?: string;
  /** Service name whose Endpoints must have at least one ready address. */
  serviceName?: string;
  /** Arbitrary command to run in a short-lived pod; exit 0 = ready. */
  command?: string[];
  /** Image to use when running `command`. Defaults to `testImage`. */
  commandImage?: string;
  /** Maximum milliseconds to wait for any single check (default 120_000). */
  timeoutMs?: number;
  /** Polling interval for endpoint checks (default 3_000). */
  pollIntervalMs?: number;
}

/**
 * Minimal pod spec subset used for security guardrail validation.
 * Mirrors the subset of the Kubernetes PodSpec we inspect; additional fields
 * are passed through untouched.
 */
export interface EphemeralPodSpec {
  hostNetwork?: boolean;
  volumes?: Array<{
    name?: string;
    hostPath?: unknown;
    [key: string]: unknown;
  }>;
  containers?: Array<{
    name?: string;
    securityContext?: { privileged?: boolean; [key: string]: unknown };
    [key: string]: unknown;
  }>;
  initContainers?: Array<{
    name?: string;
    securityContext?: { privileged?: boolean; [key: string]: unknown };
    [key: string]: unknown;
  }>;
}

/**
 * Configuration for the `e2e_kubernetes` pipeline stage type.
 */
export interface E2eKubernetesStageConfig {
  /** Docker image reference to deploy (e.g. "registry/app:sha256-..."). */
  imageRef: string;
  /**
   * Helm chart reference. Can be:
   *   - A repo/chart reference (e.g. "stable/nginx")
   *   - A local chart path (e.g. "./helm/my-chart")
   * Default: "stable/nginx" (generic bundled chart).
   */
  helmChart?: string;
  /** Helm release name. Defaults to "mq-<runId-prefix>". */
  releaseName?: string;
  /** Optional Helm values as a YAML string. */
  helmValues?: string;
  /**
   * TTL in hours for failed-run namespaces. The janitor uses this value.
   * Default: 4 hours.
   */
  ttlHours?: number;
  /**
   * When true (default), the namespace is deleted immediately after a
   * successful test run. When false, the namespace is preserved until the
   * TTL expires.
   */
  deleteOnSuccess?: boolean;
  /**
   * Image used to run the test command in the test pod.
   * Must be a valid, pullable Docker image reference.
   */
  testImage: string;
  /**
   * Command and arguments to execute in the test pod.
   * Exit code 0 = test passed; any other exit code = test failed.
   */
  testCommand: string[];
  /** Readiness checks to perform before running the test command. */
  readiness?: ReadinessConfig;
  /** Namespace resource quota overrides. */
  resourceQuota?: EphemeralNamespaceQuota;
  /**
   * CIDR blocks that should be allowed in the egress NetworkPolicy.
   * Default: empty (deny all egress).
   */
  allowedEgressHosts?: string[];
  /**
   * Optional pod spec for the test pod — used for guardrail validation.
   * Privileged containers, hostNetwork, and hostPath volumes are denied.
   */
  testPodSpec?: EphemeralPodSpec;
  /** Timeout in ms for the Helm deploy (default 120_000). */
  helmTimeoutMs?: number;
  /** Timeout in ms for the test pod execution (default 60_000). */
  testTimeoutMs?: number;
}

/**
 * Artifacts collected during the e2e_kubernetes stage run.
 */
export interface E2eKubernetesArtifacts {
  /** Combined test stdout + stderr from the test pod. */
  testLogs: string;
  /** Rendered Helm manifest (from `helm get manifest`). */
  helmManifest: string;
  /** Pod events for the namespace — populated on failure for diagnostics. */
  podEvents?: string;
}

/**
 * Result returned by the e2e_kubernetes stage after completion.
 */
export interface E2eKubernetesResult {
  /** Fully qualified namespace that was created (e.g. "mq-run-abc123"). */
  namespace: string;
  /** True when the test command exited with code 0. */
  success: boolean;
  /** Raw exit code from the test command (-1 if not reached). */
  testExitCode: number;
  /** Standard output from the test pod. */
  testStdout: string;
  /** Standard error from the test pod. */
  testStderr: string;
  /** Collected artifacts for storage/display. */
  artifacts: E2eKubernetesArtifacts;
  /** TTL used for the namespace (hours). */
  ttlHours: number;
}

// ── MCP Client Token Types (issue #274) ──────────────────────────────────────

/**
 * Token type for external MCP clients — distinct from user session tokens.
 * Stored in its own table; validated by McpTokenValidator.
 */
export const MCP_CLIENT_TOKEN_TYPE = "mcp_client" as const;

/** Allowed tools a token may call. "*" means all tools. */
export type McpToolAllowList = string[] | ["*"];

/** Scopes that limit which workspaces a token can access. */
export interface McpTokenScope {
  /** Workspace IDs this token may access. Empty array = no access. */
  workspaceIds: string[];
  /**
   * Tool names this token may call. Use ["*"] to allow all.
   * Specific names must match the tool names exposed by the MCP server.
   */
  allowedTools: McpToolAllowList;
  /** Maximum number of concurrent pipeline runs triggered via this token. */
  maxRunConcurrency: number;
}

/** Public shape of an MCP client token (tokenHash never exposed). */
export interface McpClientToken {
  id: string;
  workspaceId: string;
  name: string;
  /** The last 8 characters of the raw token (for identification only). */
  tokenSuffix: string;
  scope: McpTokenScope;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  isRevoked: boolean;
}

/** Input for creating an MCP client token. */
export interface CreateMcpClientTokenInput {
  workspaceId: string;
  name: string;
  scope: McpTokenScope;
  expiresAt?: Date | null;
}

/** Result returned when creating a token — plaintext shown once, then gone. */
export interface CreateMcpClientTokenResult {
  token: McpClientToken;
  /** The full raw token. Show once to user; not persisted. */
  rawToken: string;
}

/**
 * Audit log entry for an inbound MCP tool call from an external client.
 * This extends the existing McpToolCall with MCP-client-specific fields.
 */
export interface McpInboundToolCall {
  id: string;
  /** The MCP client token ID that authenticated this call. */
  mcpClientTokenId: string;
  workspaceId: string;
  toolName: string;
  /** Redacted copy of call arguments (no secrets). */
  argsJson: Record<string, unknown>;
  /** Redacted copy of the result. Null on error. */
  resultJson: unknown | null;
  error: string | null;
  durationMs: number;
  startedAt: Date;
}

/** Summary metadata for a workspace as returned by list_workspaces MCP tool. */
export interface McpWorkspaceSummary {
  id: string;
  name: string;
  type: "local" | "remote";
  status: "active" | "syncing" | "error";
  createdAt: Date;
}

/** Summary metadata for a pipeline as returned by list_pipelines MCP tool. */
export interface McpPipelineSummary {
  id: string;
  name: string;
  description: string | null;
  stageCount: number;
  isTemplate: boolean;
  createdAt: Date | null;
}

/** Result from run_pipeline MCP tool. */
export interface McpRunPipelineResult {
  runId: string;
  status: RunStatus;
  startedAt: Date | null;
}

/** Result from get_run MCP tool. */
export interface McpRunDetails {
  id: string;
  pipelineId: string;
  status: RunStatus;
  input: string;
  output: unknown | null;
  currentStageIndex: number;
  startedAt: Date | null;
  completedAt: Date | null;
  /** Stage execution summaries for trace events. */
  stages: Array<{
    id: string;
    teamId: string;
    status: StageStatus;
    startedAt: Date | null;
    completedAt: Date | null;
  }>;
}

/** Result from cancel_run MCP tool. */
export interface McpCancelRunResult {
  runId: string;
  cancelled: boolean;
}

/** Connection metadata (no secrets) as returned by list_connections MCP tool. */
export interface McpConnectionSummary {
  id: string;
  workspaceId: string;
  type: ConnectionType;
  name: string;
  /** True if the connection has stored secrets — but secrets are NEVER returned. */
  hasSecrets: boolean;
  status: ConnectionStatus;
  lastTestedAt: Date | null;
  createdAt: Date;
}

/** Result from query_connection_usage MCP tool. */
export type McpConnectionUsage = ConnectionUsageMetrics;

// ── Inventory & Dependency Graph (issue #275) ─────────────────────────────────

/** Node types present in the workspace dependency graph. */
export type InventoryNodeType = "connection" | "pipeline" | "stage" | "skill" | "model";

/** A node in the workspace dependency graph. */
export interface InventoryNode {
  id: string;
  type: InventoryNodeType;
  label: string;
  /** Node-type-specific metadata. */
  metadata: Record<string, unknown>;
  /** True when the node has had no activity in the last 30 days. */
  isOrphan?: boolean;
}

/** An edge in the workspace dependency graph. */
export interface InventoryEdge {
  /** ID of the source node. */
  source: string;
  /** ID of the target node. */
  target: string;
  /**
   * Relationship label:
   * - "contains"  — pipeline → stage
   * - "uses"      — stage → connection | skill | model
   */
  relation: "contains" | "uses";
}

/** Full inventory graph returned by GET /api/workspaces/:id/inventory. */
export interface InventoryGraph {
  nodes: InventoryNode[];
  edges: InventoryEdge[];
}

/** A pipeline or stage that depends on a given connection. */
export interface ConnectionDependent {
  kind: "pipeline" | "stage";
  /** Pipeline ID. */
  pipelineId: string;
  /** Pipeline name. */
  pipelineName: string;
  /** Stage index within the pipeline (undefined for pipeline-level entries). */
  stageIndex?: number;
  /** Stage teamId (undefined for pipeline-level entries). */
  stageTeamId?: string;
}

/** Response from GET /api/workspaces/:id/connections/:cid/dependents */
export interface ConnectionDependentsResponse {
  connectionId: string;
  dependents: ConnectionDependent[];
}

/** Response from GET /api/workspaces/:id/inventory/orphans */
export interface InventoryOrphansResponse {
  nodes: InventoryNode[];
}

/** Body for DELETE /api/workspaces/:id/connections/:cid with dependents override. */
export interface DeleteConnectionWithOverrideBody {
  /** Must be true to force-delete a connection that has dependents. */
  force?: boolean;
}

// ─── Connections YAML Sync Types (issue #276) ─────────────────────────────────

/** Action type in a connections reconciliation plan. */
export type ReconcileActionType = "create" | "update" | "delete" | "unchanged";

/** A single planned change in the reconciliation plan. */
export interface ReconcileAction {
  type: ReconcileActionType;
  connectionName: string;
  reason: string;
}

/** Full reconciliation plan from diffing YAML against DB state. */
export interface ConnectionsReconcilePlan {
  actions: ReconcileAction[];
  hasChanges: boolean;
}

/** Result of applying a reconciliation plan. */
export interface ConnectionsApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ connectionName: string; message: string }>;
}

/** A connection that has drifted from its YAML definition. */
export interface ConnectionDriftItem {
  connectionId: string;
  connectionName: string;
  connectionType: ConnectionType;
  driftedConfigKeys: string[];
}

/** Full result of a connections YAML sync operation. */
export interface ConnectionsSyncResult {
  /** Whether the .multiqlti/connections.yaml file was absent. */
  yamlMissing: boolean;
  plan: ConnectionsReconcilePlan;
  applied: boolean;
  applyResult?: ConnectionsApplyResult;
  drift: ConnectionDriftItem[];
}

/** Request body for POST /api/workspaces/:id/connections/sync. */
export interface ConnectionsSyncRequest {
  /** Auto-apply the plan without requiring a second call. Default: false. */
  autoApply?: boolean;
  /** Include deletions for DB connections absent from YAML. Default: false. */
  includeDeletes?: boolean;
}

// ─── LLM Tracing Types (issue #278) ───────────────────────────────────────────

/** Exporter backend type for workspace-level LLM tracing. */
export type LlmTracingExporter = "langfuse" | "phoenix" | "otlp" | "none";

/** Per-workspace LLM tracing configuration stored in workspace settings. */
export interface WorkspaceLlmTracingConfig {
  /** Which exporter to use for this workspace.  Default: "none". */
  exporter: LlmTracingExporter;
  /** Whether to store prompt/response text in spans. Default: false (redacted). */
  storePrompts: boolean;
  /** Whether to store tool call arguments/results. Default: false (redacted). */
  storeToolData: boolean;
  /** Langfuse base URL — required when exporter is "langfuse". */
  langfuseBaseUrl?: string;
  /** Phoenix base URL — required when exporter is "phoenix". */
  phoenixBaseUrl?: string;
  /** Generic OTLP endpoint — used when exporter is "otlp". */
  otlpEndpoint?: string;
}

/** Summary row returned in the workspace trace list. */
export interface WorkspaceTraceSummary {
  traceId: string;
  runId: string;
  spanCount: number;
  startTime: number;     // epoch ms of the earliest span
  endTime: number;       // epoch ms of the latest span
  totalTokens: number;   // sum of llm.token_count.total across all LLM spans
  costUsd: number;       // sum of llm.cost_usd across all LLM spans
  provider: string;      // predominant provider (most common llm.provider value)
  model: string;         // predominant model (most common llm.model value)
}

/** Full trace returned at GET /workspaces/:id/traces/:run_id. */
export interface WorkspaceTraceDetail extends WorkspaceTraceSummary {
  spans: TraceSpan[];
}

/** Query params for GET /workspaces/:id/traces. */
export interface WorkspaceTracesQuery {
  limit?: number;
  offset?: number;
  /** Filter to a specific pipeline run ID. */
  runId?: string;
}

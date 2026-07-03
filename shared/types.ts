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
  /**
   * Abort signal forwarded to provider.complete options (Security C1). When it
   * fires, the provider MUST terminate the in-flight request/child. The gateway
   * forwards BOTH this and timeoutMs into provider.complete.
   */
  signal?: AbortSignal;
  /**
   * Explicit provider key (e.g. "antigravity", "anthropic"). When set, it wins
   * over the DB model lookup — used by live-discovered models that are not
   * persisted in the `models` table.
   */
  provider?: string;
  /** Explicit provider-native model id/label. Wins over the DB lookup. */
  modelId?: string;
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
  // Optional workspace binding for the run (issue #343). Tools that need a
  // workspace (file-read, code-search, knowledge-search, ...) default to this
  // workspace when their input doesn't supply one. Both fields are populated
  // together — workspaceId is the row id, workspacePath is the resolved
  // filesystem path for tool convenience.
  workspaceId?: string;
  workspacePath?: string;
  /**
   * Stage streaming controls (streaming-stage-execution). Populated by the
   * pipeline-controller: the run AbortSignal, a coalesced WS-progress onDelta,
   * and the resolved idle/overall/byte limits. Absent → blocking fallback.
   */
  streaming?: StreamingStageOptions;
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
  /**
   * Abort signal for mid-stream cancellation. Providers MUST terminate the
   * underlying child/request and stop yielding when this fires.
   */
  signal?: AbortSignal;
  /**
   * Idle (inactivity) timeout in ms for streaming calls: reset on every
   * received chunk. Fires only when NO output has arrived for this window.
   * Independent of timeoutMs (which is the overall cap on the stream path).
   */
  idleTimeoutMs?: number;
  /**
   * Cumulative output byte cap for streaming calls. When exceeded the child is
   * killed and the call fails. Bounds in-memory accumulation (DoS guard).
   */
  maxOutputBytes?: number;
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
   *
   * Cancellation contract (changed for streaming-stage-execution): callers MAY
   * abort mid-stream via options.signal. Providers MUST terminate the
   * underlying child/request and stop yielding when the signal fires. The
   * generator is otherwise exhaustible.
   */
  stream(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<string>;
}

// ─── Streaming Provider Events (streaming-stage-execution) ───────────────────

/**
 * Discriminated event emitted by a provider's optional streamEvents() channel.
 * Lets the gateway run a tool loop while streaming: text deltas arrive
 * incrementally, tool-use blocks surface as discrete calls, and a terminal
 * 'done' carries usage + the model's stop reason.
 */
export type ProviderStreamEvent =
  | { kind: 'text-delta'; text: string }
  | { kind: 'tool-call'; call: ToolCall }
  | { kind: 'done'; tokensUsed: number; finishReason: 'stop' | 'tool_use' };

/**
 * Optional provider capability (duck-typed). A provider that emits
 * ProviderStreamEvent supports the streamed tool loop. Providers without it
 * (e.g. emulated one-shot streams) fall back to the blocking tool path.
 */
export interface IStreamingToolProvider {
  streamEvents(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): AsyncGenerator<ProviderStreamEvent>;
}

/**
 * Stage-streaming options threaded controller → BaseTeam → gateway → provider.
 * onDelta receives the coalesced/raw delta plus cumulative char count so the
 * controller can emit bounded WS progress without shipping the whole buffer.
 */
export interface StreamingStageOptions {
  signal?: AbortSignal;
  onDelta?: (deltaText: string, cumulativeChars: number) => void;
  idleTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxOutputBytes?: number;
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
  input?: string;    // legacy free-text input (unused by the loop-template retarget)
  /**
   * T1 RETARGET (loop-triggers.md §2): a schedule trigger's firing creates a
   * CONSILIUM LOOP via the same factory the UI/API use — NOT a (deleted) pipeline
   * run. The loop template is REQUIRED for a schedule trigger to do anything on
   * fire; `repoPath` is REQUIRED here (there is no watchPath to derive it from) and
   * is RE-VALIDATED against the fail-closed allowlist inside the factory.
   */
  action?: ConsiliumReviewTriggerAction;
}

export interface GitHubEventTriggerConfig {
  repository: string;   // "owner/repo"
  events: string[];     // ["push", "pull_request", "issues", "release"]
  refFilter?: string;   // optional, e.g. "refs/heads/main"
  // secret stored encrypted in secretEncrypted column — not in this object
  /**
   * T1-full (loop-triggers.md §3.1): the loop template a matching GitHub event
   * fires. `repoPath` (REQUIRED for a github trigger to launch — there is no
   * watchPath to derive it from) is re-validated against the fail-closed allowlist
   * INSIDE the factory. `engineerInstruction` (may embed `${event}`) is UNTRUSTED —
   * the factory control-strips + byte-clamps + fences it. The action's `preset` is a
   * DEFAULT only: the per-event mapping OVERRIDES it (pull_request → `diff-pr-review`
   * on the PR head; push to the default branch → post-merge review), so the operator
   * only needs to pick a target repo + optional instruction. Absent ⇒ the trigger
   * still receives + records events but launches nothing (record-only, back-compat).
   */
  action?: ConsiliumReviewTriggerAction;
}

export interface FileChangeTriggerConfig {
  watchPath: string;     // absolute or workspace-relative path
  patterns: string[];    // micromatch glob patterns, e.g. ["**/*.ts", "!node_modules/**"]
  debounceMs?: number;   // default 500
  input?: string;        // optional pipeline input template; may reference {{filePath}}
  /**
   * Optional ACTION to launch when the trigger fires (embedded in the existing
   * `config` JSONB — NO schema migration). When ABSENT, the trigger keeps its
   * historical record-only no-op behaviour (back-compat). When present and
   * `kind === "consilium_review"`, `fireTrigger` launches a consilium review via
   * `createConsiliumReview` under `runAsProject(trigger.projectId)`.
   */
  action?: ConsiliumReviewTriggerAction;
}

/**
 * The canonical consilium-review preset set. Shared between the HTTP body enum
 * (POST /api/consilium-reviews), the file-change trigger action, and the
 * server-side factory (`review-factory.ts`). The preset NAMES + the per-preset
 * task/model structure are SERVER CONSTANTS — never derived from caller text.
 */
export const CONSILIUM_REVIEW_PRESETS = [
  "sdlc-cross-review",
  "diff-pr-review",
  "full-viability",
] as const;
export type ConsiliumReviewPreset = (typeof CONSILIUM_REVIEW_PRESETS)[number];

/**
 * Consilium re-review MODE — HOW rounds AFTER the first (round > 1) are run.
 *
 *   - `full-dispute`    — the DEFAULT + historical behavior: EVERY round re-runs the
 *                         full cross-review debate panel (N debaters + rebuttals +
 *                         judge). A loop with this mode (or an UNSET/`null` mode when
 *                         the operator default is off) is BYTE-IDENTICAL to the
 *                         pre-feature loop.
 *   - `single-verifier` — re-review rounds (nextRound > 1) run ONE fresh, independent
 *                         verifier (1 model, 1 level) that only CONFIRMS whether the
 *                         written code closed the prior findings. Round 1 ALWAYS runs
 *                         the full preset DAG regardless of this mode.
 *
 * Persisted (nullable) on `consilium_loops.review_mode`; `null` ⇒ resolve from the
 * operator default (`pipeline.consiliumLoop.verifyReview.enabled`). An EXPLICIT
 * per-loop value always wins over the operator default.
 */
export const REVIEW_MODES = ["full-dispute", "single-verifier"] as const;
export type ReviewMode = (typeof REVIEW_MODES)[number];

/**
 * A file-change trigger ACTION that launches a consilium review. Embedded in the
 * trigger's `config` JSONB. `repoPath`, when present, MUST resolve inside the
 * consilium-loop allowlist (re-validated INSIDE the factory — never trusted from
 * the stored config). `preset` is a server enum; `maxRounds` is bounded 1..6.
 */
export interface ConsiliumReviewTriggerAction {
  kind: "consilium_review";
  preset: ConsiliumReviewPreset;
  maxRounds?: number;
  /**
   * Target repo (MUST resolve inside the project's allowlisted workspaces).
   * Defaults to the watchPath's repo root for file_change when omitted; REQUIRED
   * for schedule (no watchPath to derive from). Re-validated INSIDE the factory.
   */
  repoPath?: string;
  /**
   * T1 (loop-triggers.md §2): OPTIONAL operator "engineer instruction" free-text
   * steering the review objective. May contain the literal token `${event}`, which
   * the runtime interpolates with a short, human description of the firing event
   * (e.g. "file change at <path>" / "scheduled run at <iso>"). UNTRUSTED — the
   * factory control-strips + byte-clamps + fences it (same seam as the human UI
   * endpoint's engineerInstruction) before it enters any prompt. Never a shell/
   * branch/PR sink.
   */
  engineerInstruction?: string;
}

/**
 * T1 (loop-triggers.md §2, hard-rail §6): provenance recorded on EVERY
 * trigger-fired consilium loop so the launch passport (#457) can show which
 * trigger + which event started it. Persisted INERT as jsonb on the loop
 * (`consilium_loops.trigger_provenance`); display/audit only, never a prompt or
 * shell sink. `eventDigest` is a short hex hash of the firing payload — enough to
 * correlate a loop to the event without storing the (untrusted) payload verbatim.
 */
export interface TriggerProvenance {
  triggerId: string;
  triggerType: TriggerType;
  eventDigest: string;
  firedAt: string; // ISO-8601
  /**
   * OPTIONAL short, human-readable description of the firing event for the launch
   * passport (#457) — e.g. `PR #123: <title>` or `post-merge push to main (abc1234)`.
   * UNTRUSTED (embeds a github PR title / branch): single-line control-stripped +
   * clamped at the mapping boundary and rendered as INERT text only. Absent for
   * file_change/schedule fires (the digest already correlates those). Never a
   * prompt/shell sink.
   */
  eventSummary?: string;
}

export type TriggerConfig =
  | WebhookTriggerConfig
  | ScheduleTriggerConfig
  | GitHubEventTriggerConfig
  | FileChangeTriggerConfig;

// Public-facing Trigger shape returned from API (no secretEncrypted)
export interface PipelineTrigger {
  id: string;
  // T1 RETARGET: a trigger now targets a CONSILIUM LOOP (loop template in config),
  // not a pipeline. `pipelineId` is legacy/nullable — new project-scoped triggers
  // carry no pipeline. Kept on the shape for back-compat with pre-existing rows.
  pipelineId: string | null;
  type: TriggerType;
  config: TriggerConfig;
  // webhookUrl is synthesized by the server for webhook and github_event triggers
  webhookUrl?: string;
  // hasSecret tells client whether a secret is configured without exposing it
  hasSecret: boolean;
  enabled: boolean;
  lastTriggeredAt: Date | null;
  // T1 policy rail: count of fires suppressed by a policy (dedup/budget). Surfaced
  // on the triggers page so silence is diagnosable (loop-triggers.md §6).
  suppressedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface InsertTrigger {
  // Legacy/nullable — new loop-template triggers are project-scoped, no pipeline.
  pipelineId?: string | null;
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

// ─── Skill Version + YAML Types (Phase 6.16) ──────────────────────────────────

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

// ─── Consilium Verdict / Convergence Types (Consilium Loop A1) ───────────────

/**
 * A single action point emitted by a consilium judge task in its structured
 * `output.action_points[]`. Shared by the client verdict panel and the
 * server-side convergence reader so both agree on the shape (lifted from the
 * former local interface in `verdict-panel.tsx`).
 */
export interface ActionPoint {
  title: string;
  priority?: string;
  effort?: string;
  rationale?: string;
  tradeoff?: string;
  /**
   * OPTIONAL verifiable definition-of-done for THIS action point — a concrete
   * "When … Then …" condition the change can be checked against. Emitted per-AP by
   * the judge (Stage 1, design §3.B); absent on pre-existing verdicts and on judges
   * that don't follow the prompt, so it is fully back-compat. UNTRUSTED model text
   * (bounded by `boundActionPoint`'s `MAX_CRITERION_LEN` clamp); treated as data,
   * never a shell/branch/PR sink.
   *
   * NOTE: distinct from `SpecRequirement.acceptanceCriteria` (Dark-Factory graph) —
   * same "When…Then…" FORMAT convention, different feature/type; not coupled.
   */
  acceptanceCriterion?: string;
  /**
   * Stage B (design §5 + §9 "Stage 6"): the OPTIONAL per-criterion VERIFICATION METHOD.
   * The judge PROPOSES it (one of {@link JUDGE_PROPOSABLE_METHODS}) and the planner
   * ASSIGNS/normalizes it — enum-clamped, with an absent/invalid value filled from the
   * archetype default (`repo-assessment → test-run`, `research → web-evidence`). The
   * "verification method is a per-criterion property, not an archetype property" (§5): a
   * single verdict routinely mixes `test-run` code criteria with `manual-ops` operational
   * ones (e.g. "rotate the leaked secrets") no code change can verify.
   *
   * Absent on pre-Stage-B verdicts, on judges that don't follow the prompt, and whenever
   * `implement.perCriterionMethod` is off ⇒ fully back-compat. UNTRUSTED model text but
   * ENUM-CLAMPED on parse (an invalid value is dropped → the planner default), so it is
   * bounded to the fixed union; NEVER a shell/branch/PR sink.
   */
  verificationMethod?: VerificationMethod;
  /**
   * Stage C (design §9 "Stage 7") — SERVER-COMPUTED criterion-QA flag: `true` when this
   * AP's {@link acceptanceCriterion} failed the mechanical generation-time LINT
   * (`applyCriteriaQa`): absent/empty, missing the "When … Then …" shape, or — for a
   * `test-run` criterion — too thin to name a concrete observable signal. A flagged AP is
   * DEMOTED to `judge` (never counts as test-run green; §5) and surfaces a small amber
   * "weak DoD" marker in the loop UI. NOT model text — derived deterministically from the
   * criterion + method, never a shell/branch/PR sink. Absent (⇒ `undefined`/back-compat)
   * whenever `pipeline.consiliumLoop.planner.criteriaQa.enabled` is off (byte-identical) or
   * the criterion passed the lint.
   */
  weakCriterion?: boolean;
  /**
   * Parallel-develop (design §4 "development = controller + N coders for N features"):
   * the OTHER action points that MUST complete before this one — the dependency edges the
   * JUDGE declares from the dispute. Each entry references another action point by its
   * 1-based ORDINAL in this list (a number, or a numeric string) OR by an exact `title`
   * match (a string). The planner's {@link buildWaveSchedule} validates these (drops refs
   * to nonexistent APs, BREAKS cycles) and topologically sorts the round into WAVES that
   * run concurrently. DEFAULT = NO dependency (absent/empty ⇒ independent ⇒ wave 0,
   * parallelizable) — a judge only declares one when a later fix genuinely requires an
   * earlier one's result (e.g. "confirm CI green" depends on the fixes it verifies).
   *
   * Absent on every pre-parallel verdict and on judges that don't follow the prompt, and
   * IGNORED entirely unless `implement.parallel.enabled` ⇒ fully back-compat. UNTRUSTED
   * model input: treated as DATA only (index/title lookup), never a shell/branch/PR sink;
   * bounded + validated by the planner before it can influence scheduling.
   */
  dependsOn?: Array<number | string>;
}

/**
 * The verification methods a criterion can carry (design §5 — the ground-truth check).
 * Single source of truth for the enum-clamp shared by the judge prompt, the convergence
 * reader, the planner normalizer, the SDLC executor's routing, and the FE. `none` is a
 * trace-only sentinel (a criterion with no method) and is intentionally NOT part of this
 * assignable set.
 */
export const VERIFICATION_METHODS = ["test-run", "web-evidence", "judge", "manual-ops"] as const;
export type VerificationMethod = (typeof VERIFICATION_METHODS)[number];

/**
 * The subset a JUDGE may PROPOSE per action point. `web-evidence` is deliberately
 * EXCLUDED — it is the research archetype's ground truth (cited sources), assigned by the
 * planner's archetype default, never proposed on a code action point. `manual-ops` marks
 * an operational action outside the repo (rotate a secret, revoke a key, file a ticket)
 * that NO code change can verify — the loop can only surface it, never close it (§5).
 */
export const JUDGE_PROPOSABLE_METHODS = ["test-run", "judge", "manual-ops"] as const;
export type JudgeProposableMethod = (typeof JUDGE_PROPOSABLE_METHODS)[number];

/**
 * The convergence-blocking priority tier. An action point at `P0` keeps the
 * consilium loop from converging; the judge prompt, `readConvergence`, and the
 * UI all key off this single constant so the taxonomy never drifts.
 */
export const P0_PRIORITY = "P0" as const;
export type P0Priority = typeof P0_PRIORITY;

/**
 * Machine-readable convergence verdict the loop FSM decides on. Either trusted
 * from the judge's `output.convergence` object or derived from `action_points`
 * (trust-then-derive). `converged` is true iff no `P0` action points remain.
 */
export interface ConvergenceVerdict {
  converged: boolean;
  openP0: number;
  openActionPoints: ActionPoint[];
}

/**
 * Finding #5 — the READ-TIME (never-persisted) summary of the STILL-OPEN action
 * points carried by a TERMINAL loop's LAST recorded round. Convergence is keyed
 * on `P0` BY DESIGN (a loop converges the moment no P0 remains), but the judge
 * may leave actionable non-P0 items (P1/P2/…) standing; without surfacing them
 * that remainder silently drops out of the lifecycle. The loop detail response
 * attaches this (only when non-empty) so a "converged with remainder" outcome is
 * VISIBLE and executable via develop-from-terminal. Computed from
 * `consilium_loop_rounds.openActionPoints` (LAST round ONLY — each round persists
 * the set still open AT THAT round's decide, so summing across rounds would
 * double-count items later closed). No schema/FSM change; see
 * `computeOpenRemainder` in `shared/consilium-remainder.ts`.
 */
export interface OpenRemainder {
  /** Total still-open action points on the last recorded round (always > 0 when present). */
  total: number;
  /**
   * Count per priority tier, keyed by the UPPERCASED priority label
   * (e.g. `{ P1: 1, P2: 1 }`); an action point with no priority is counted under
   * `"P?"`. Only tiers with a non-zero count appear.
   */
  byPriority: Record<string, number>;
}

// ─── Loop ARCHETYPE (Stage 1 — intent→archetype planner, design §5/§6) ──────
// The intent class a lightweight planner proposes (and a human may override) for a
// verdict-terminal loop. Stage 1 STORES it; it does NOT yet branch implement on it
// (that is Stage 2). Mirrors CONSILIUM_LOOP_STATES: one `as const` tuple is the
// single source of truth shared by TS, the zod enum (route + planner parser), the
// DB column ($type<Archetype>), and the FE. Lives here (the client-safe types
// module) so the FE can import it without pulling in drizzle/schema.
export const ARCHETYPES = ["repo-assessment", "research", "infra"] as const;
export type Archetype = typeof ARCHETYPES[number];

/** How a loop's archetype was decided. `override` outranks a planner `proposed`. */
export type ArchetypeSource = "proposed" | "override";

// ─── Research archetype REPORT (Stage 3, design §6 — the `research` artifact) ─
// The structured artifact the research-runner produces INSTEAD of code + a Draft
// PR. It rides the SAME out-of-band wire as `testSummary` into a new nullable
// `consilium_loop_rounds.report` jsonb column, and reaches the client via the
// existing loop GET `rounds`. Every string here is UNTRUSTED model/web text — it
// is DATA, never a shell/branch/PR sink, and the whole object is size-clamped
// (`clampReport`) before it is persisted. Lives in the client-safe types module so
// a future ReportPanel can import it without pulling in drizzle/schema.

/** One web citation backing a research claim (title + URL + a short snippet). */
export interface ResearchCitation {
  title: string;
  url: string;
  snippet: string;
}

/** A single research claim + the sources that back it + whether web-evidence
 *  verification confirmed a cited source supports it (3b). */
export interface ResearchClaim {
  claim: string;
  citations: ResearchCitation[];
  /** Set by the web-evidence verifier: true ⇒ a cited source supports the claim. */
  verified: boolean;
}

/** A source consulted during research (de-duplicated title + URL). */
export interface ResearchSource {
  title: string;
  url: string;
}

/**
 * The structured research report. `verdict` is `green` when every P0-criterion
 * claim is backed by a cited source (web-evidence, 3b), else `flagged`.
 */
export interface ResearchReport {
  /** The research question (derived from the loop objective + action points). */
  question: string;
  /** The synthesized recommendation / answer. */
  recommendation: string;
  claims: ResearchClaim[];
  sources: ResearchSource[];
  /** web-evidence outcome: all P0-criterion claims cited ⇒ `green`, else `flagged`. */
  verdict: "green" | "flagged";
  /** ISO-8601 timestamp the report was generated. */
  generatedAt: string;
}

// ─── Execution trace (Stage 4 — the observability tree, design §8) ──────────────
//
// A phase → controller → worker → skill → criterion tree BOTH archetypes emit (the
// coder path builds it from the executor's ApOutcome[]; the research path from its
// steps + P0 CriterionEvidence[]) so the FE has ONE renderer. It rides the loop GET
// `rounds[]` out-of-band (like `report`/`testSummary`) — never on the dev_completed
// event, so the FSM is unchanged. Display-only, inert, URL-free; `permissionsUsed`
// are tool NAMES only (never secrets/values/env).

/** One skilled step an agent carried (its skill, capability scope, and green). */
export interface ExecutionSkill {
  /** e.g. "test-author" | "coder" | "research" | "synthesize" | "verify". */
  skillName: string;
  capability: "read-only" | "worktree-write" | "web-read";
  /** Tool NAMES the step was allowed (Edit/Write/Read | web_search). Never values. */
  permissionsUsed: string[];
  /** Skill-green: the step ran clean. */
  green: boolean;
}

/** A per-acceptance-criterion verification leaf. */
export interface ExecutionCriterion {
  /** The Definition-of-Done text (clamped, inert). */
  criterion: string;
  /**
   * How the criterion was checked (design §5). Stage B adds `manual-ops` — an
   * operational action outside the repo that the loop only SURFACES (`ran:false`,
   * `passed:false` ALWAYS — a manual op is NEVER green, only surfaced).
   */
  method: "test-run" | "web-evidence" | "judge" | "manual-ops" | "none";
  /** Whether the verification method actually ran. */
  ran: boolean;
  /** Acceptance-criterion green. */
  passed: boolean;
  /** test-run fix re-invocations | re-research iterations. */
  fixIterations?: number;
  /** Scrubbed, clamped verification summary. */
  summary?: string;
  /**
   * Stage A (final-state re-verification): whether this criterion still held when the
   * WHOLE test suite was re-run against the FINAL worktree (after every action point).
   * OPTIONAL/ADDITIVE — absent unless final verification ran; set only for `test-run`
   * criteria. A `false` here alongside `passed:true` reveals a late-AP REGRESSION.
   */
  passedAtFinal?: boolean;
  /**
   * Additive: whether the verification run was KILLED by the wall-clock timeout
   * (SIGKILL) rather than adjudicated. true ⇒ NOT-ADJUDICATED — the test-run was
   * AMBIGUOUS (the suite may exceed `testRunTimeoutMs`, or the change introduced a
   * hang) and the fix loop was SKIPPED (a coder cannot fix a config-level cap, and the
   * next run pays the same wall-clock). Distinct from `passed:false` (a real, adjudicated
   * red) and from `ran:false` (a launch failure). OPTIONAL/ADDITIVE — absent on
   * adjudicated runs and on pre-timeout-policy snapshots (no schemaVersion bump).
   */
  timedOut?: boolean;
}

/** A worker agent: one action point (coder) or one research step. */
export interface ExecutionWorker {
  /** 1-based position in the round. */
  index: number;
  /** e.g. "P0" (coder); "" for research steps. */
  priority: string;
  /** The AP title, or the step role. */
  title: string;
  status: "completed" | "partial" | "failed";
  /** Ordered skilled steps (test-author→coder | research→synthesize→verify). */
  skills: ExecutionSkill[];
  /** Acceptance-criterion leaves. */
  criteria: ExecutionCriterion[];
  /** Scrubbed worker-level note. */
  note?: string;
}

/** The implement-phase orchestrator (the coder executor or the research runner). */
export interface ExecutionController {
  kind: "sdlc-executor" | "research-runner";
  label: string;
  /** All workers green + the aggregation criterion (§4). */
  green: boolean;
  /** Scrubbed controller-level error/degradation. */
  note?: string;
  workers: ExecutionWorker[];
}

/** The full per-round execution trace persisted on `consilium_loop_rounds`. */
export interface ExecutionTrace {
  schemaVersion: 1;
  archetype: Archetype | null;
  controller: ExecutionController;
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

// ── Federation: Subjective Conflict Resolution (issue #229) ──────────────────

/** Strategy used to resolve a subjective dispute in a shared session. */
export type SubjectiveResolutionStrategy =
  | "structured_debate"
  | "quorum_vote"
  | "parallel_experiment"
  | "defer_to_owner";

/** Current lifecycle state of a conflict. */
export type ConflictStatus =
  | "open"
  | "debate_in_progress"
  | "voting_in_progress"
  | "experiment_in_progress"
  | "resolved"
  | "expired";

/** A single option submitted to a quorum vote or debate. */
export interface ConflictProposal {
  id: string;
  authorId: string;
  instanceId: string;
  title: string;
  description: string;
  arguments?: string;
  submittedAt: number;
}

/** A participant's vote on a specific proposal. */
export interface ConflictVote {
  participantId: string;
  instanceId: string;
  proposalId: string;
  anonymous: boolean;
  submittedAt: number;
}

/** Result of a debate round: the LLM judge's evaluation. */
export interface DebateJudgement {
  judgeModelSlug: string;
  winner?: string;
  reasoning: string;
  confidence: number;
  evaluatedAt: number;
}

/** Outcome of a parallel experiment branch. */
export interface ExperimentBranchResult {
  proposalId: string;
  runId: string;
  status: "pending" | "completed" | "failed";
  outcome?: string;
  completedAt?: number;
}

/** Final outcome of a conflict resolution process. */
export interface ResolutionOutcome {
  strategy: SubjectiveResolutionStrategy;
  winningProposalId?: string;
  reasoning: string;
  decidedBy: "quorum" | "judge" | "owner" | "timeout";
  decidedAt: number;
}

/** A subjective conflict in a shared session. */
export interface SessionConflict {
  id: string;
  sessionId: string;
  raisedBy: string;
  raisedByInstance: string;
  question: string;
  context?: string;
  strategy: SubjectiveResolutionStrategy;
  status: ConflictStatus;
  proposals: ConflictProposal[];
  votes: ConflictVote[];
  quorumThreshold: number;
  timeoutMs: number;
  judgement?: DebateJudgement;
  experimentResults?: ExperimentBranchResult[];
  outcome?: ResolutionOutcome;
  createdAt: number;
  updatedAt: number;
}

/** Input for raising a new conflict. */
export interface RaiseConflictInput {
  sessionId: string;
  raisedBy: string;
  raisedByInstance: string;
  question: string;
  context?: string;
  strategy: SubjectiveResolutionStrategy;
  quorumThreshold?: number;
  timeoutMs?: number;
}

/** Input for casting a vote on a conflict. */
export interface CastConflictVoteInput {
  participantId: string;
  instanceId: string;
  proposalId: string;
  anonymous?: boolean;
}

/** A decision log entry (append-only). */
export interface DecisionLogEntry {
  id: string;
  sessionId: string;
  conflictId: string;
  question: string;
  strategy: SubjectiveResolutionStrategy;
  outcome: ResolutionOutcome;
  participantCount: number;
  proposalCount: number;
  durationMs: number;
  recordedAt: number;
}

// ─── CRDT Types (issue #230) ──────────────────────────────────────────────────

/** Sync mode for a shared session's collaborative state. */
export type CollabSyncMode = "single_writer" | "crdt_p2p";

/** Vector clock snapshot — maps nodeId to its logical counter. */
export interface VectorClockSnapshot {
  clocks: Record<string, number>;
}

/** Serialized G-Counter state. */
export interface GCounterSnapshot {
  type: "g-counter";
  counters: Record<string, number>;
}

/** Serialized PN-Counter state. */
export interface PNCounterSnapshot {
  type: "pn-counter";
  positive: GCounterSnapshot;
  negative: GCounterSnapshot;
}

/** Serialized LWW-Register state. */
export interface LWWRegisterSnapshot<T> {
  type: "lww-register";
  value: T | null;
  timestamp: number;
  nodeId: string;
}

/** Serialized OR-Set state. */
export interface ORSetSnapshot<T> {
  type: "or-set";
  /** Serialized element → list of live add-tags. */
  entries: Record<string, string[]>;
  tombstones: string[];
}

/** Serialized LWW-Map state. */
export interface LWWMapSnapshot<V> {
  type: "lww-map";
  entries: Record<string, LWWRegisterSnapshot<V>>;
}

/** Full serialized CRDT document for a shared session. */
export interface CRDTDocumentSnapshot {
  sessionId: string;
  nodeId: string;
  participants: ORSetSnapshot<string>;
  stageOutputs: LWWMapSnapshot<string>;
  stageStatuses: LWWMapSnapshot<string>;
  votes: GCounterSnapshot;
  tags: ORSetSnapshot<string>;
  metadata: LWWRegisterSnapshot<Record<string, unknown>>;
  vectorClock: VectorClockSnapshot;
}

/** Human-readable snapshot of resolved CRDT document values. */
export interface CRDTDocumentValue {
  participants: string[];
  stageOutputs: Record<string, string | null>;
  stageStatuses: Record<string, string | null>;
  votes: number;
  tags: string[];
  metadata: Record<string, unknown> | null;
  vectorClock: VectorClockSnapshot;
}

/** A CRDT delta sent from one peer to another. */
export interface CRDTDeltaMessage {
  sessionId: string;
  fromNodeId: string;
  senderClock: VectorClockSnapshot;
  sinceRecipientClock: VectorClockSnapshot | null;
  state: CRDTDocumentSnapshot;
}

/** Response from GET /api/sessions/:id/crdt-state */
export interface CRDTStateResponse {
  sessionId: string;
  syncMode: CollabSyncMode;
  state: CRDTDocumentSnapshot;
  value: CRDTDocumentValue;
}

/** Request body for POST /api/sessions/:id/crdt-merge */
export interface CRDTMergeRequest {
  state: CRDTDocumentSnapshot;
}

/** Response from POST /api/sessions/:id/crdt-merge */
export interface CRDTMergeResponse {
  merged: boolean;
  state: CRDTDocumentSnapshot;
  value: CRDTDocumentValue;
}

/** Entry in GET /api/sessions/:id/crdt-peers response */
export interface CRDTPeerEntry {
  peerId: string;
  clock: VectorClockSnapshot | undefined;
}

/** Response from GET /api/sessions/:id/crdt-peers */
export type CRDTPeersResponse = CRDTPeerEntry[];

// ─── Adaptive-Stability Deliberation ────────────────────────────────────────

/** Why a deliberation stopped. */
export type StopReason = "stable" | "hard-cap" | "budget" | "timeout" | "aborted";

/** Confidence in a stable stop, derived only from convergence speed. */
export type Confidence = "high" | "medium" | "low";


// ─── Live Run Activity (read-only observability lens) ───────────────
//
// The /api/activity snapshot + the WS events that keep it live. STRICTLY
// METADATA-ONLY: these shapes intentionally carry no transcript, prompt, task
// text, decision text, step output, or reasoning. Every string is either an
// id, an enum-derived label, or a model slug.

/** Which run mode an active run belongs to. */
export type ActivityMode = "pipeline" | "manager" | "task_group";

/** The current unit of work inside a run (stage / iteration / step / round). */
export interface ActivityUnit {
  /** Human label of the current unit, e.g. "Stage 3", "Step 2", "Round 1 · review". */
  label: string;
  /** Agent/team/role/phase identifier — ENUM-derived, never untrusted text. */
  agent: string;
  /** Model slug for this unit (best-effort / null for manager mode when unknown). */
  modelSlug: string | null;
  /** Status of this unit (StageStatus | phase-derived). */
  status: string;
}

/** One active run as seen through the Activity lens. Metadata only. */
export interface ActivityRun {
  runId: string;
  mode: ActivityMode;
  /** Run-level label (mode name / pipeline name). NEVER the raw task text. */
  title: string;
  status: RunStatus | string;
  workspaceId: string | null;
  currentUnit: ActivityUnit | null;
  startedAt: string | null;
  /** Owner id — present for admins only (so admins can attribute runs). */
  ownerId?: string | null;
}

/** The /api/activity response payload. */
export interface ActivitySnapshot {
  runs: ActivityRun[];
  /** Whether the caller is admin (FE shows the owner column). */
  isAdmin: boolean;
  /** True iff the row count was capped (the FE can surface a "showing N of more"). */
  truncated: boolean;
}

// ─── Activity History (terminal runs, DB-backed, metadata-only) ──────────────
// METADATA-ONLY: built by an explicit allowlist, NEVER by spreading a DB row.
// NO output / input / summary / errorMessage / decisionText / transcript.

/** One past (terminal) run as seen through the Activity History tab. */
export interface ActivityHistoryRow {
  /** runId for pipeline-family modes; groupId for task_group mode. */
  runId: string;
  mode: ActivityMode;
  /** FIXED mode label — NEVER the user's group/run name (no free-text leak). */
  title: string;
  status: RunStatus | string;
  startedAt: string | null;
  completedAt: string | null;
  /** Enum-derived last/current unit summary, or null. Metadata only. */
  currentUnit: ActivityUnit | null;
  workspaceId: string | null;
  /** Owner id — present for admins only (attribution). */
  ownerId?: string | null;
}

/** The /api/activity/history response payload (keyset-paginated). */
export interface ActivityHistoryPage {
  items: ActivityHistoryRow[];
  /** Opaque base64 keyset cursor for the next page, or null at the end. */
  nextCursor: string | null;
  /** Whether the caller is admin (FE shows the owner column). */
  isAdmin: boolean;
}

// ─── Dark Factory Types (Phase 6+) ──────────────────────────────────────────

export interface SpecRequirement {
  id: string;
  description: string;
  acceptanceCriteria: string; // "When ... Then ..."
}

export interface OpenSpec {
  id: string;
  title: string;
  description: string;
  requirements: SpecRequirement[];
  version: string;
}

export type EvaluatorVerdict = "pass" | "fail" | "error";

export interface VerificationProof {
  specId: string;
  requirementId: string;
  verdict: EvaluatorVerdict;
  proofType: "log" | "screenshot" | "test_result" | "sandbox_trace";
  proofContent: string; // The raw log, or trace output
  evaluatorModel: string;
  timestamp: string;
  reasoning?: string;
}

export interface EvaluatorResult {
  specId: string;
  overallVerdict: EvaluatorVerdict;
  proofs: VerificationProof[];
  summary: string;
}

export type TeamId =
  | "planning"
  | "architecture"
  | "development"
  | "testing"
  | "code_review"
  | "deployment"
  | "monitoring"
  | "fact_check";

export type RunStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type StageStatus =
  | "pending"
  | "running"
  | "paused"
  | "completed"
  | "failed"
  | "skipped";

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

export interface DebateStrategy {
  type: "debate";
  participants: DebateParticipant[];
  judge: JudgeConfig;
  rounds: number;
  stopEarly?: boolean;
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

export interface MoaDetails {
  proposerResponses: Array<{ modelSlug: string; content: string; role?: string }>;
  aggregatorModelSlug: string;
}

export interface DebateDetails {
  rounds: Array<{ round: number; participant: string; role: string; content: string }>;
  judgeModelSlug: string;
  verdict: string;
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
  | "strategy:voting:candidate"
  | "strategy:completed"
  | "sandbox:starting"
  | "sandbox:output"
  | "sandbox:completed"
  | "stage:thought_tree";

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
  executionStrategy?: ExecutionStrategy;
  privacySettings?: PrivacySettings;
  sandbox?: SandboxConfig;
  tools?: StageToolConfig;
}

export interface StageOutput {
  teamId: string;
  output: Record<string, unknown>;
  stageIndex: number;
}

export interface StageContext {
  runId: string;
  stageIndex: number;
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
  type: 'reasoning' | 'tool_call' | 'tool_result' | 'decision' | 'guardrail' | 'memory_recall';
  label: string;
  content: string;
  timestamp: number;
  durationMs?: number;
  metadata?: {
    model?: string;
    tokensUsed?: number;
    toolName?: string;
    decision?: string;
    confidence?: number;
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

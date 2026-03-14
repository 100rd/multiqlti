export type TeamId =
  | "planning"
  | "architecture"
  | "development"
  | "testing"
  | "code_review"
  | "deployment"
  | "monitoring";

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
  | "strategy:completed";

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
}

export interface StageContext {
  runId: string;
  stageIndex: number;
  modelSlug?: string;
  temperature?: number;
  maxTokens?: number;
  previousOutputs: Record<string, unknown>[];
  userAnswers?: Record<string, string>;
  privacySettings?: PrivacySettings;
  sessionId?: string;
}

export interface TeamResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  raw: string;
  questions?: string[];
  strategyResult?: StrategyResult;
}

export type ProviderMessage = { role: string; content: string };

export interface ILLMProviderOptions {
  maxTokens?: number;
  temperature?: number;
  /** Per-request timeout override in milliseconds. Defaults to provider default (30s). */
  timeoutMs?: number;
}

export interface ILLMProvider {
  /**
   * Non-streaming completion. Returns full content and token count.
   */
  complete(
    modelId: string,
    messages: ProviderMessage[],
    options?: ILLMProviderOptions,
  ): Promise<{ content: string; tokensUsed: number }>;

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

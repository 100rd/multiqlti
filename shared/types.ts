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

export type ModelProvider = "vllm" | "ollama" | "mock";

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
  | "model:status";

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

export interface PipelineStageConfig {
  teamId: TeamId;
  modelSlug: string;
  systemPromptOverride?: string;
  temperature?: number;
  maxTokens?: number;
  enabled: boolean;
}

export interface StageContext {
  runId: string;
  stageIndex: number;
  modelSlug?: string;
  temperature?: number;
  maxTokens?: number;
  previousOutputs: Record<string, unknown>[];
  userAnswers?: Record<string, string>;
}

export interface TeamResult {
  output: Record<string, unknown>;
  tokensUsed: number;
  raw: string;
  questions?: string[];
}

export type StrategyPresetId =
  | "fast"
  | "balanced"
  | "deep_think"
  | "cost_efficient"
  | "anti_hallucination";

export interface StrategyPreset {
  id: StrategyPresetId;
  label: string;
  description: string;
  temperature: number;
  maxTokens: number;
  stageOverrides?: Partial<Record<TeamId, { modelSlug?: string; temperature?: number; maxTokens?: number }>>;
}

/**
 * Wiring factory: construct the OrchestratorAgent with its real services
 * (ResearchService / DebateRunner / GroundingStep) and step-handler executors.
 * Kept out of routes.ts so the construction graph stays readable and testable.
 *
 * Model slugs are read from env with safe defaults (Opus architect/judge,
 * gemini-flash critic via the antigravity provider). The Omniscience board tool
 * caller is wired lazily and degrades gracefully when the flag is off.
 */
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import { OrchestratorAgent } from "./orchestrator-agent.js";
import { ResearchService } from "./research-service.js";
import { DebateRunner } from "./debate-runner.js";
import { GroundingStep } from "./grounding-step.js";
import { buildStepExecutors } from "./steps/index.js";
import { configLoader } from "../config/loader.js";

const DEFAULT_PLAN_MODEL = process.env.ORCHESTRATOR_PLAN_MODEL ?? "claude-opus";
const DEFAULT_CRITIC_MODEL = process.env.ORCHESTRATOR_CRITIC_MODEL ?? "gemini-flash";

export function buildOrchestratorAgent(
  storage: IStorage,
  gateway: Gateway,
  wsManager: WsManager,
): OrchestratorAgent {
  const models = {
    planModelSlug: DEFAULT_PLAN_MODEL,
    synthesizeModelSlug: DEFAULT_PLAN_MODEL,
    proposerModelSlug: DEFAULT_PLAN_MODEL,
    criticModelSlug: DEFAULT_CRITIC_MODEL,
    judgeModelSlug: DEFAULT_PLAN_MODEL,
  };

  const researchService = new ResearchService(gateway, {
    synthesizeModelSlug: models.synthesizeModelSlug,
  });
  const debateRunner = new DebateRunner(gateway, wsManager, {
    proposerModelSlug: models.proposerModelSlug,
    criticModelSlug: models.criticModelSlug,
    judgeModelSlug: models.judgeModelSlug,
  });

  // Grounding is flag-gated; the caller factory returns null until a real
  // workspace-scoped Omniscience tool caller is wired (graceful degrade).
  const boardEnabled = configLoader.get().memory.retrieval.omniscience.board.enabled;
  const groundingStep = new GroundingStep({
    enabled: boardEnabled,
    callerFactory: () => null,
  });

  const stepExecutors = buildStepExecutors({
    storage,
    gateway,
    researchService,
    debateRunner,
    groundingStep,
    models,
    streamingConfig: configLoader.get().pipeline.streaming,
  });

  return new OrchestratorAgent({ storage, wsManager, gateway, stepExecutors, models });
}

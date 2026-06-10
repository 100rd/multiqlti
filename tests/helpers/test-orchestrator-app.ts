/**
 * Test app factory for the debate-research orchestrator routes + a real
 * PipelineController orchestrator branch, over MemStorage with deterministic
 * doubles (mock gateway, injected step executors). No CLI / network / real DB.
 *
 * Mirrors the test-knowledge-app idiom: an injected authenticated user (by role
 * / id), a kill-switch toggle, and helpers to seed runs owned by other users so
 * the owner-or-admin + deny-when-ownerId-null authz paths are exercised.
 */
import express from "express";
import type { Router } from "express";
import { vi } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { PipelineController } from "../../server/controller/pipeline-controller.js";
import { OrchestratorAgent } from "../../server/orchestrator/orchestrator-agent.js";
import type {
  StepExecutors,
  OrchestratorModels,
} from "../../server/orchestrator/orchestrator-agent.js";
import { registerOrchestratorRoutes } from "../../server/routes/orchestrator.js";
import { configLoader } from "../../server/config/loader.js";
import type { User, UserRole } from "../../shared/types.js";

const MODELS: OrchestratorModels = {
  planModelSlug: "claude-opus",
  synthesizeModelSlug: "claude-opus",
  proposerModelSlug: "claude-opus",
  criticModelSlug: "gemini-flash",
  judgeModelSlug: "claude-opus",
};

export interface OrchestratorTestAppOptions {
  role?: UserRole;
  userId?: string;
  enabled?: boolean;
  /** Plan the mock Opus plan turn emits. */
  planSteps?: Array<Record<string, unknown>>;
  /** Record each executed step type. */
  onStep?: (type: string) => void;
  /** When true, the user session carries no id (deny-when-no-user). */
  noUserId?: boolean;
}

export interface OrchestratorTestApp {
  app: express.Express;
  storage: MemStorage;
  controller: PipelineController;
  userId: string;
}

export function createOrchestratorTestApp(
  opts: OrchestratorTestAppOptions = {},
): OrchestratorTestApp {
  const role: UserRole = opts.role ?? "user";
  const userId = opts.userId ?? "test-user-id";
  const enabled = opts.enabled ?? true;
  const planSteps = opts.planSteps ?? [{ type: "ground", query: "g" }, { type: "synthesize" }];

  const base = configLoader.get();
  vi.spyOn(configLoader, "get").mockReturnValue({
    ...base,
    pipeline: { ...base.pipeline, orchestrator: { ...base.pipeline.orchestrator, enabled } },
  } as never);

  const storage = new MemStorage();

  const gateway = {
    complete: vi.fn(async () => ({
      content: JSON.stringify({ steps: planSteps }),
      tokensUsed: 1,
      modelSlug: "claude-opus",
      finishReason: "stop",
    })),
    resolveProvider: vi.fn(async () => "anthropic"),
  } as never;

  const mkStep = (t: string) =>
    vi.fn(async () => {
      opts.onStep?.(t);
      return { output: { ok: true }, tokensUsed: 0 };
    });
  const stepExecutors = {
    research: mkStep("research"),
    analyzeCode: mkStep("analyze-code"),
    debate: mkStep("debate"),
    ground: mkStep("ground"),
    synthesize: mkStep("synthesize"),
  } as unknown as StepExecutors;

  const agent = new OrchestratorAgent({
    storage,
    wsManager: { broadcastToRun: vi.fn() } as never,
    gateway,
    stepExecutors,
    models: MODELS,
  });

  const controller = new PipelineController(
    storage,
    {} as never,
    { broadcastToRun: vi.fn() } as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    agent,
  );

  const user: User = {
    id: opts.noUserId ? (undefined as unknown as string) : userId,
    email: "orch@example.com",
    name: "Orch User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    // Simulate requireAuth: unauthenticated when the test header is set.
    if (req.headers["x-test-unauth"] === "1") {
      req.user = undefined as never;
    } else {
      req.user = user;
    }
    next();
  });

  registerOrchestratorRoutes(app as unknown as Router, storage, controller);

  return { app, storage, controller, userId };
}

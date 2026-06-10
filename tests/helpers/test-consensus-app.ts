/**
 * Test app factory for the /consensus routes + a real ConsensusController over
 * MemStorage with a deterministic gateway double (no CLI/network/real DB).
 *
 * Mirrors test-orchestrator-app: an injected authenticated user (role/id), a
 * kill-switch toggle, and helpers to seed runs owned by other users so the
 * owner-or-admin + deny-when-ownerId-null authz paths are exercised.
 */
import express from "express";
import type { Router } from "express";
import { vi } from "vitest";
import { MemStorage } from "../../server/storage.js";
import { ConsensusController } from "../../server/consensus/consensus-controller.js";
import { registerConsensusRoutes } from "../../server/routes/consensus.js";
import { configLoader } from "../../server/config/loader.js";
import type { GatewayRequest, GatewayResponse } from "../../shared/types.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { User, UserRole } from "../../shared/types.js";

export interface ConsensusTestAppOptions {
  role?: UserRole;
  userId?: string;
  enabled?: boolean;
  /** Verdict every voter + Claude turn returns (default APPROVE → resolves). */
  verdict?: "APPROVE" | "REQUEST_CHANGES" | "REJECT";
  /** When true, the user session carries no id. */
  noUserId?: boolean;
}

export interface ConsensusTestApp {
  app: express.Express;
  storage: MemStorage;
  controller: ConsensusController;
  userId: string;
}

/** A gateway double: voters + Claude all return the configured verdict. */
function makeGateway(verdict: string): Gateway {
  return {
    async complete(req: GatewayRequest): Promise<GatewayResponse> {
      const isVoter = req.provider === "antigravity";
      const content = isVoter
        ? JSON.stringify({ verdict, critical_issues: [] })
        : JSON.stringify({ verdict });
      return { content, tokensUsed: 1, modelSlug: req.modelSlug, finishReason: "stop" };
    },
    async discoverModels() {
      return {
        antigravity: {
          available: true,
          models: [
            { slug: "gemini-3-1-pro-high" },
            { slug: "gemini-3-1-pro-low" },
            { slug: "gemini-3-5-flash-high" },
            { slug: "gemini-3-5-flash-medium" },
            { slug: "gemini-3-5-flash-low" },
          ],
        },
      };
    },
  } as unknown as Gateway;
}

export function createConsensusTestApp(opts: ConsensusTestAppOptions = {}): ConsensusTestApp {
  const role: UserRole = opts.role ?? "user";
  const userId = opts.userId ?? "test-user-id";
  const enabled = opts.enabled ?? true;
  const verdict = opts.verdict ?? "APPROVE";

  const base = configLoader.get();
  vi.spyOn(configLoader, "get").mockReturnValue({
    ...base,
    pipeline: { ...base.pipeline, consensus: { ...base.pipeline.consensus, enabled } },
  } as never);

  const storage = new MemStorage();
  const gateway = makeGateway(verdict);
  const controller = new ConsensusController(storage, gateway, { claudeModelSlug: "claude-opus" });

  const user: User = {
    id: opts.noUserId ? (undefined as unknown as string) : userId,
    email: "consensus@example.com",
    name: "Consensus User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-unauth"] === "1") {
      req.user = undefined as never;
    } else {
      req.user = user;
    }
    next();
  });

  registerConsensusRoutes(app as unknown as Router, storage, controller);

  return { app, storage, controller, userId };
}

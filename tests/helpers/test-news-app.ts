/**
 * Test app factory for the Morning News Board routes.
 *
 * Builds an express app over MemStorage wired to a real BriefScheduler + a real
 * brief-generator whose collaborators are deterministic mocks (board provider,
 * internal search, external fetch, gateway summarizer). Exercises the real
 * routes (auth gates, lazy-gen lock+cache+rate-limit, validation, feedback state
 * machine) with no network. The authenticated user is injected by role and may
 * own the workspace so requireOwnerOrRole paths are covered.
 */
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../server/storage.js";
import { registerNewsRoutes } from "../../server/routes/news.js";
import { BriefScheduler } from "../../server/news/brief-scheduler.js";
import { generateBrief, type GenerateBriefDeps } from "../../server/news/brief-generator.js";
import type { BlastRadius } from "../../server/memory/omniscience-board-provider.js";
import type { User, UserRole } from "../../shared/types.js";

export interface NewsTestAppOptions {
  role?: UserRole;
  userId?: string;
  /** When true, the injected user owns the seeded workspace. */
  ownsWorkspace?: boolean;
  /** Simulate backend=local: no board provider → internal feed degrades. */
  boardDisabled?: boolean;
  /** Simulate Omniscience unreachable: board calls throw. */
  boardProviderFails?: boolean;
  /** Force the gateway summarizer to throw → brief 'failed'. */
  gatewayFails?: boolean;
  /** Force the embed/internal-search to throw (internal feed degrades). */
  embedFails?: boolean;
  /** Simulate a malformed token: session user has no id. */
  noUserId?: boolean;
  /** Fixed server clock (defaults to a stable UTC instant). */
  now?: () => Date;
}

export interface NewsTestApp {
  app: express.Express;
  storage: MemStorage;
  workspaceId: string;
  userId: string;
  scheduler: BriefScheduler;
  /** Count of generator invocations (for cache/regen assertions). */
  generationCount: () => number;
}

const FIXED_NOW = new Date("2026-06-09T05:30:00.000Z");

export async function createNewsTestApp(opts: NewsTestAppOptions = {}): Promise<NewsTestApp> {
  const role: UserRole = opts.role ?? "admin";
  const userId = opts.userId ?? "test-user-id";
  const now = opts.now ?? (() => FIXED_NOW);

  const storage = new MemStorage();
  const workspace = await storage.createWorkspace({
    name: "News Test Workspace",
    type: "local",
    path: "/tmp/news-test",
    branch: "main",
    status: "active",
    ownerId: opts.ownsWorkspace ? userId : "someone-else",
  });

  const user: User = {
    id: opts.noUserId ? (undefined as unknown as string) : userId,
    email: "news@example.com",
    name: "News User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  let generations = 0;

  const boardProvider = opts.boardDisabled
    ? null
    : {
        blastRadius: async (p: { entityId: string; asOf?: string }): Promise<BlastRadius> => {
          if (opts.boardProviderFails) throw new Error("forbidden:no workspace token");
          return {
            seedEntityId: p.entityId,
            actionType: "restart" as const,
            maxDepth: 3,
            impacted: [{ entityId: "svc-a", entityType: "service", impactScore: 0.7, confidence: 1, path: [] }],
          };
        },
        toAffects: (b: BlastRadius) =>
          b.impacted.map((i) => ({
            entityId: i.entityId,
            entityType: i.entityType,
            impactScore: i.impactScore,
            confidence: i.confidence,
            path: i.path,
          })),
      };

  const genDeps: GenerateBriefDeps = {
    storage,
    boardProvider,
    searchInternal: async (asOf) => {
      if (opts.embedFails) throw new Error("internal search down");
      return [
        { title: "deploy svc-a", summary: `internal text @${asOf}`, seedEntityId: "svc-a", sourceUri: "https://internal/x", sourceName: "omniscience" },
      ];
    },
    fetchExternal: async () => [
      { title: "AWS EKS X", summary: "EKS adds X support", sourceUri: "https://aws.amazon.com/x", sourceName: "AWS What's New", provider: "aws-whatsnew", contentHash: "ext-1" },
      { title: "K8s 1.33", summary: "kubernetes release", sourceUri: "https://kubernetes.io/blog/k8s-133", sourceName: "Kubernetes Blog", provider: "k8s-blog", contentHash: "ext-2" },
    ],
    summarize: async () => {
      if (opts.gatewayFails) throw new Error("gateway down");
      return { summary: "clean summary", whyRelevant: "matters to your stack" };
    },
    now,
  };

  const scheduler = new BriefScheduler(
    storage,
    async (params) => {
      generations += 1;
      return generateBrief(genDeps, params);
    },
    { pollIntervalMs: 1, pollTimeoutMs: 2000, sleep: () => Promise.resolve() },
  );

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });
  registerNewsRoutes(app as unknown as Router, storage, { scheduler, now });

  return {
    app,
    storage,
    workspaceId: workspace.id,
    userId,
    scheduler,
    generationCount: () => generations,
  };
}

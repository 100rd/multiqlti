/**
 * Consult routes — standalone multi-model Q&A (workspace-independent).
 *
 * Three MANUAL steps, one endpoint each, all project-scoped and mounted behind
 * `requireAuth + requireProject` in routes.ts (so `req.user` + `req.projectId`
 * are set and the ALS project context createConsiliumReview relies on is live):
 *
 *   1. POST /api/consult                 — create a session (question + models)
 *   2. POST /api/consult/:id/answer      — each model answers independently (round 0)
 *      POST /api/consult/:id/debate      — models see each other, refine (round N+1)
 *   3. POST /api/consult/:id/handoff     — connect repo → workspace → start a loop
 *
 *   GET  /api/consult      — history (newest first)
 *   GET  /api/consult/:id  — session + all answer rounds
 *
 * The heavy lifting lives in ../services/consult/consult-service (pure, fail-soft
 * over a narrow gateway). This file owns validation, persistence, and access.
 */
import type { Express, Request, Response } from "express";
import { z } from "zod";
import { CONSILIUM_REVIEW_PRESETS } from "@shared/types";
import type { ConsultSession, ConsultAnswer } from "@shared/schema";
import type { IStorage } from "../storage.js";
import { validateBody } from "../middleware/validate.js";
import {
  answerIndependently,
  debate,
  type ConsultGateway,
  type ConsultModelAnswer,
} from "../services/consult/consult-service.js";
import {
  createConsiliumReview,
  type CreateConsiliumReviewDeps,
} from "../services/consilium/review-factory.js";

/** Everything the consult routes need, injected from routes.ts (testable). */
export interface ConsultRouteDeps {
  storage: IStorage;
  /** Model gateway for the answer/debate steps (the real Gateway satisfies it). */
  gateway: ConsultGateway;
  /** Reused verbatim by the handoff step to start a standard consilium loop. */
  reviewDeps: CreateConsiliumReviewDeps;
  /** Connect a local repo path as a workspace (wsManager.connectLocal). */
  connectWorkspace: (repoPath: string) => Promise<{ id: string; path: string }>;
}

const MAX_QUESTION = 8_000;
const MAX_MODELS = 6;
const MAX_INSTRUCTION = 60_000;

const CreateConsultSchema = z.object({
  question: z.string().trim().min(1).max(MAX_QUESTION),
  modelSlugs: z.array(z.string().trim().min(1)).min(1).max(MAX_MODELS),
});

const HandoffSchema = z.object({
  repoPath: z.string().trim().min(1),
  instruction: z.string().trim().min(1).max(MAX_INSTRUCTION),
  preset: z.enum(CONSILIUM_REVIEW_PRESETS).optional(),
  maxRounds: z.number().int().min(1).max(6).optional(),
});

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Persist a batch of service answers for one round; returns the insert rows. */
function toInsertRows(
  sessionId: string,
  round: number,
  answers: ConsultModelAnswer[],
) {
  return answers.map((a) => ({
    sessionId,
    modelSlug: a.modelSlug,
    round,
    content: a.content,
    errorMessage: a.errorMessage,
  }));
}

/** The newest stored answer per model (rows arrive createdAt-ascending). */
function latestPerModel(answers: ConsultAnswer[]): ConsultAnswer[] {
  const byModel = new Map<string, ConsultAnswer>();
  for (const a of answers) byModel.set(a.modelSlug, a);
  return [...byModel.values()];
}

export function registerConsultRoutes(app: Express, deps: ConsultRouteDeps): void {
  const { storage, gateway, reviewDeps, connectWorkspace } = deps;

  /** Load a session, enforcing project scope + owner-or-admin. Sends the error. */
  async function loadSession(
    req: Request,
    res: Response,
  ): Promise<ConsultSession | null> {
    const session = await storage.getConsultSession(String(req.params.id));
    // 404 (not 403) on a project mismatch so we never leak cross-project existence.
    if (!session || session.projectId !== req.projectId) {
      res.status(404).json({ error: "consult session not found" });
      return null;
    }
    const isAdmin = req.user?.role === "admin";
    if (!isAdmin && session.createdBy !== req.user?.id) {
      res.status(403).json({ error: "not your consult session" });
      return null;
    }
    return session;
  }

  // 1 — create a session (validate models against the ACTIVE catalog).
  app.post(
    "/api/consult",
    validateBody(CreateConsultSchema),
    async (req: Request, res: Response) => {
      const userId = req.user?.id;
      if (!userId) return res.status(401).json({ error: "Authentication required" });
      if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });

      const body = req.body as z.infer<typeof CreateConsultSchema>;
      const modelSlugs = [...new Set(body.modelSlugs.map((s) => s.trim()))];
      const active = new Set((await storage.getActiveModels()).map((m) => m.slug));
      const unknown = modelSlugs.filter((s) => !active.has(s));
      if (unknown.length > 0) {
        return res
          .status(400)
          .json({ error: `unknown or inactive model(s): ${unknown.join(", ")}` });
      }

      const session = await storage.createConsultSession({
        projectId: req.projectId,
        question: body.question,
        modelSlugs,
        createdBy: userId,
      });
      return res.status(201).json(session);
    },
  );

  // 2a — independent answers (round 0). Manual; re-running regenerates round 0.
  app.post("/api/consult/:id/answer", async (req: Request, res: Response) => {
    const session = await loadSession(req, res);
    if (!session) return;
    const answers = await answerIndependently(
      gateway,
      session.question,
      session.modelSlugs,
    );
    const saved = await storage.addConsultAnswers(
      toInsertRows(session.id, 0, answers),
    );
    await storage.updateConsultStatus(session.id, "answered");
    return res.json({ round: 0, answers: saved });
  });

  // 2b — one debate round: models see each other's latest answers, refine. Manual.
  app.post("/api/consult/:id/debate", async (req: Request, res: Response) => {
    const session = await loadSession(req, res);
    if (!session) return;
    const existing = await storage.getConsultAnswers(session.id);
    if (existing.length === 0) {
      return res
        .status(400)
        .json({ error: "run the independent answers first (POST /answer)" });
    }
    const maxRound = existing.reduce((m, a) => Math.max(m, a.round), 0);
    const prior: ConsultModelAnswer[] = latestPerModel(existing).map((a) => ({
      modelSlug: a.modelSlug,
      content: a.content,
      errorMessage: a.errorMessage,
    }));
    const refined = await debate(
      gateway,
      session.question,
      prior,
      session.modelSlugs,
    );
    const round = maxRound + 1;
    const saved = await storage.addConsultAnswers(
      toInsertRows(session.id, round, refined),
    );
    await storage.updateConsultStatus(session.id, "debated");
    return res.json({ round, answers: saved });
  });

  // 3 — handoff: connect the repo as a workspace, then start a standard loop.
  app.post(
    "/api/consult/:id/handoff",
    validateBody(HandoffSchema),
    async (req: Request, res: Response) => {
      const session = await loadSession(req, res);
      if (!session) return;
      const userId = req.user!.id;
      const body = req.body as z.infer<typeof HandoffSchema>;

      let workspace: { id: string; path: string };
      try {
        workspace = await connectWorkspace(body.repoPath);
      } catch (err) {
        // The path is the caller's own input — safe to echo (not an fs leak).
        return res
          .status(400)
          .json({ error: `could not connect workspace: ${errMsg(err)}` });
      }

      let loop;
      try {
        loop = await createConsiliumReview(reviewDeps, {
          projectId: session.projectId,
          repoPath: workspace.path,
          createdBy: userId,
          engineerInstruction: body.instruction,
          preset: body.preset ?? "sdlc-cross-review",
          maxRounds: body.maxRounds,
        });
      } catch (err) {
        // The factory re-validates repoPath against the allowlist ∩ workspaces and
        // names the rejected path (caller's own input) — surface it verbatim.
        return res.status(400).json({ error: errMsg(err) });
      }

      await storage.setConsultHandoff(session.id, {
        loopId: loop.id,
        workspaceId: workspace.id,
      });
      return res.status(201).json({ loopId: loop.id, workspaceId: workspace.id });
    },
  );

  // History — list (newest first).
  app.get("/api/consult", async (req: Request, res: Response) => {
    if (!req.projectId) return res.status(400).json({ error: "x-project-id header is required" });
    const sessions = await storage.listConsultSessions(req.projectId);
    return res.json({ sessions });
  });

  // History — one session + all answer rounds.
  app.get("/api/consult/:id", async (req: Request, res: Response) => {
    const session = await loadSession(req, res);
    if (!session) return;
    const answers = await storage.getConsultAnswers(session.id);
    return res.json({ session, answers });
  });
}

/**
 * Practice-card API — Active Knowledge Base MVP (Wave 1).
 *
 * Base: /api/workspaces/:id/knowledge/practice-cards
 *
 * Every route is WORKSPACE-SCOPED: it resolves the workspace and gates mutations
 * with requireOwnerOrRole(() => ws.ownerId, ...). No route trusts a caller-supplied
 * identity for the adversarial gate — verifier identity is bound to req.user.id and
 * verifiedBy must differ from the ingester. The content hash is server-computed.
 *
 * Embedding + vector-store access is injected (PracticeCardDeps) so tests can
 * supply deterministic mocks instead of hitting Ollama / pgvector.
 */
import type { Router, Request, Response } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import { requireOwnerOrRole } from "../auth/middleware";
import { isAllowedSource } from "../knowledge/source-allowlist";
import {
  computeContentHash,
  transitionReviewState,
  applySupersession,
  projectToChunk,
  dropProjection,
  cardProjectionText,
  InvalidTransitionError,
} from "../knowledge/practice-card-service";
import type { PracticeCardRow, InsertPracticeCard } from "@shared/schema";
import { mapCard, type ComplianceGraph } from "../knowledge/compliance-mapper";
import {
  PRACTICE_CARD_STATUSES,
  PRACTICE_CARD_REVIEW_STATES,
} from "@shared/schema";

// ─── Injected dependencies ───────────────────────────────────────────────────

export interface EmbeddingClient {
  embed: (text: string) => Promise<number[]>;
  dimensions: number;
  model: string;
  provider: string;
}

export interface VectorClient {
  insertChunks: (rows: Array<Record<string, unknown>>) => Promise<unknown[]>;
  deleteBySource: (workspaceId: string, sourceType: "practice_card", sourceId: string) => Promise<number>;
  search: (
    workspaceId: string,
    queryEmbedding: number[],
    options: { topK?: number; sourceTypes?: string[]; minScore?: number },
  ) => Promise<Array<{ sourceId: string; score: number }>>;
}

/** Refresh scheduler capability needed by the route layer. */
export interface RefreshClient {
  triggerNow: (workspaceId: string, trigger?: string) => Promise<string>;
}

export interface PracticeCardDeps {
  /** Resolve an embedding client for the workspace (may throw → 503). */
  getEmbeddingClient: (workspaceId: string) => Promise<EmbeddingClient>;
  vector: VectorClient;
  /** Manual refresh trigger (Wave 2). Optional so Wave 1 callers still compile. */
  refresh?: RefreshClient;
  /** Loads the cached infra compliance graph (Wave 2); null = feature disabled. */
  loadComplianceGraph?: () => Promise<ComplianceGraph | null>;
}

// ─── Validation schemas (strict; no passthrough) ─────────────────────────────

const appliesToSchema = z
  .object({
    tool: z.literal("terraform"),
    resourceKinds: z.array(z.string().min(1).max(120)).max(50).optional(),
    tags: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict();

const sourceSchema = z
  .object({
    url: z.string().url().max(2048),
    sourceVersion: z.string().max(200).optional(),
    fetchedAt: z.string().datetime(),
  })
  .strict();

const ingestCardSchema = z
  .object({
    statement: z.string().min(1).max(2000),
    rationale: z.string().min(1).max(8000),
    appliesTo: appliesToSchema,
    sources: z.array(sourceSchema).min(1).max(50),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const ingestBodySchema = z
  .object({
    topic: z.string().min(1).max(200),
    ingestedBy: z.string().min(1).max(200),
    cards: z.array(ingestCardSchema).min(1).max(50),
  })
  .strict();

const verifyBodySchema = z
  .object({
    verifiedBy: z.string().min(1).max(200),
    verdict: z.enum(["pass", "fail", "needs_changes"]),
    notes: z.string().max(8000).optional(),
    checkedSources: z.array(z.string().url().max(2048)).max(50).optional(),
  })
  .strict();

const reviewBodySchema = z
  .object({
    decision: z.enum(["accept", "reject"]),
    supersedes: z.array(z.string().min(1).max(120)).max(50).optional(),
  })
  .strict();

const listQuerySchema = z.object({
  topic: z.string().max(200).optional(),
  status: z.enum(PRACTICE_CARD_STATUSES).optional(),
  reviewState: z.enum(PRACTICE_CARD_REVIEW_STATES).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

const searchQuerySchema = z.object({
  q: z.string().min(1).max(1000),
  topK: z.coerce.number().int().min(1).max(50).optional().default(10),
});

const BASE = "/api/workspaces/:id/knowledge/practice-cards";

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Resolve a workspace or send 404. Returns null when not found (response sent). */
async function resolveWorkspace(
  storage: IStorage,
  req: Request,
  res: Response,
): Promise<{ id: string; ownerId: string | null } | null> {
  const ws = await storage.getWorkspace(String(req.params.id));
  if (!ws) {
    res.status(404).json({ error: "Workspace not found" });
    return null;
  }
  return { id: ws.id, ownerId: ws.ownerId };
}

function logServerError(context: string, err: unknown): void {
  const detail = err instanceof Error ? err.message : String(err);
  // Detail stays server-side only; clients get a generic message.
  console.warn(`[practice-cards] ${context}: ${detail}`);
}

// ─── Route registration ──────────────────────────────────────────────────────

export function registerPracticeCardRoutes(
  router: Router,
  storage: IStorage,
  deps: PracticeCardDeps,
): void {
  // POST /ingest — maintainer/admin/owner
  router.post(`${BASE}/ingest`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;

    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const parsed = ingestBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      const { topic, ingestedBy, cards } = parsed.data;

      // Require a bound, trusted ingester identity. Without it the adversarial
      // verify gate's identity check is toothless, so refuse before persisting.
      const ingestedByUserId = req.user?.id;
      if (!ingestedByUserId) {
        return res.status(403).json({ error: "Forbidden — authenticated identity required" });
      }

      // Atomic batch: reject the WHOLE request if any URL fails the allowlist.
      const rejectedUrls = cards
        .flatMap((c) => c.sources.map((s) => s.url))
        .filter((url) => !isAllowedSource(url));
      if (rejectedUrls.length > 0) {
        return res.status(400).json({ error: "One or more source URLs are not allowed", rejectedUrls });
      }

      try {
        const embedder = await getEmbedderOr503(deps, ws.id, res);
        if (!embedder) return;

        const cardIds: string[] = [];
        for (const card of cards) {
          const contentHash = computeContentHash({
            statement: card.statement,
            rationale: card.rationale,
            appliesTo: card.appliesTo,
          });
          const insert: InsertPracticeCard = {
            workspaceId: ws.id,
            topic,
            statement: card.statement,
            rationale: card.rationale,
            appliesTo: card.appliesTo,
            sources: card.sources,
            confidence: card.confidence,
            status: "active",
            ingestedBy, // untrusted declared label
            ingestedByUserId, // server-bound, trusted (guaranteed non-null above)
            reviewState: "pending_verification",
            contentHash,
          };
          const row = await storage.createPracticeCard(insert);
          cardIds.push(row.id);
          await projectCard(row, deps, embedder);
        }

        return res.status(201).json({
          data: { accepted: cardIds.length, cardIds, rejectedUrls: [] },
        });
      } catch (err) {
        logServerError("ingest failed", err);
        return res.status(500).json({ error: "Failed to ingest practice cards" });
      }
    });
  });

  // POST /:cardId/verify — maintainer/admin/owner; enforces actor-differs gate
  router.post(`${BASE}/:cardId/verify`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;

    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      const parsed = verifyBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      const card = await loadCardInWorkspace(storage, String(req.params.cardId), ws.id, res);
      if (!card) return;

      // Adversarial gate: verifier MUST differ from the ingester (id + label).
      // Fail closed if the card has no bound ingester id — the identity check
      // cannot run, so we must not allow a differing label to slip through.
      if (!card.ingestedByUserId) {
        return res.status(409).json({ error: "Verifier must differ from the ingesting actor" });
      }
      const sameUser = req.user?.id != null && req.user.id === card.ingestedByUserId;
      const sameLabel = parsed.data.verifiedBy === card.ingestedBy;
      if (sameUser || sameLabel) {
        return res.status(409).json({ error: "Verifier must differ from the ingesting actor" });
      }

      try {
        const { reviewState } = transitionReviewState(card.reviewState, {
          kind: "verify",
          verdict: parsed.data.verdict,
        });
        const passed = parsed.data.verdict === "pass";
        const updated = await storage.updatePracticeCardState(card.id, {
          reviewState,
          verifiedBy: parsed.data.verifiedBy,
          verifiedByUserId: req.user?.id ?? null,
          verification: {
            verdict: parsed.data.verdict,
            notes: parsed.data.notes ?? null,
            checkedSources: parsed.data.checkedSources ?? [],
            at: new Date().toISOString(),
          },
          lastVerifiedAt: passed ? new Date() : card.lastVerifiedAt,
        });
        return res.status(200).json({ data: updated });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return res.status(409).json({ error: "Illegal review-state transition" });
        }
        logServerError("verify failed", err);
        return res.status(500).json({ error: "Failed to verify practice card" });
      }
    });
  });

  // POST /:cardId/review — admin/owner only (human gate)
  router.post(`${BASE}/:cardId/review`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;

    const gate = requireOwnerOrRole(() => ws.ownerId, "admin");
    gate(req, res, async () => {
      const parsed = reviewBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
      }
      const card = await loadCardInWorkspace(storage, String(req.params.cardId), ws.id, res);
      if (!card) return;

      try {
        const { reviewState, setActive } = transitionReviewState(card.reviewState, {
          kind: "review",
          decision: parsed.data.decision,
        });

        if (parsed.data.decision === "reject") {
          await dropProjection(card, deps.vector);
          const updated = await storage.updatePracticeCardState(card.id, { reviewState });
          return res.status(200).json({ data: updated });
        }

        // accept — the ONLY path that sets status='active'.
        const plan = applySupersession(card.id, parsed.data.supersedes ?? []);
        const updated = await storage.updatePracticeCardState(card.id, {
          reviewState,
          status: setActive ? "active" : card.status,
          supersedes: plan.acceptedSupersedes,
        });
        for (const sup of plan.supersededUpdates) {
          const target = await storage.getPracticeCard(sup.id);
          if (target && target.workspaceId === ws.id) {
            await storage.updatePracticeCardState(sup.id, {
              status: sup.status,
              supersededBy: sup.supersededBy,
            });
          }
        }
        return res.status(200).json({ data: updated });
      } catch (err) {
        if (err instanceof InvalidTransitionError) {
          return res.status(409).json({ error: "Card is not pending review" });
        }
        logServerError("review failed", err);
        return res.status(500).json({ error: "Failed to review practice card" });
      }
    });
  });

  // GET /practice-cards — auth (workspace-scoped read)
  router.get(BASE, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    }
    try {
      const { cards, total } = await storage.listPracticeCards(ws.id, parsed.data);
      return res.status(200).json({ data: cards, meta: { total } });
    } catch (err) {
      logServerError("list failed", err);
      return res.status(500).json({ error: "Failed to list practice cards" });
    }
  });

  // GET /practice-cards/search — auth (semantic search, workspace-scoped)
  router.get(`${BASE}/search`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    const parsed = searchQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Validation failed", issues: parsed.error.issues });
    }

    let queryEmbedding: number[];
    try {
      const embedder = await deps.getEmbeddingClient(ws.id);
      queryEmbedding = await embedder.embed(parsed.data.q);
    } catch (err) {
      logServerError("search embed failed", err);
      return res.status(503).json({ error: "Search is temporarily unavailable" });
    }

    try {
      const hits = await deps.vector.search(ws.id, queryEmbedding, {
        topK: parsed.data.topK,
        sourceTypes: ["practice_card"],
        minScore: 0.2,
      });
      const results: Array<{ card: PracticeCardRow; score: number }> = [];
      for (const hit of hits) {
        const card = await storage.getPracticeCard(hit.sourceId);
        if (card && card.workspaceId === ws.id) {
          results.push({ card, score: hit.score });
        }
      }
      return res.status(200).json({ data: results });
    } catch (err) {
      logServerError("search failed", err);
      return res.status(500).json({ error: "Failed to search practice cards" });
    }
  });

  // POST /refresh — maintainer/admin/owner; kicks off a refresh run (async).
  router.post(`${BASE}/refresh`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;

    const gate = requireOwnerOrRole(() => ws.ownerId, "maintainer", "admin");
    gate(req, res, async () => {
      if (!deps.refresh) {
        return res.status(503).json({ error: "Refresh is not available" });
      }
      try {
        const refreshRunId = await deps.refresh.triggerNow(ws.id, "manual");
        return res.status(202).json({ data: { refreshRunId } });
      } catch (err) {
        logServerError("refresh trigger failed", err);
        return res.status(500).json({ error: "Failed to start refresh run" });
      }
    });
  });

  // GET /refresh-runs/:runId — auth, workspace-scoped (404 cross-workspace).
  router.get(`${BASE}/refresh-runs/:runId`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    try {
      const run = await storage.getRefreshRun(String(req.params.runId));
      if (!run || run.workspaceId !== ws.id) {
        return res.status(404).json({ error: "Refresh run not found" });
      }
      return res.status(200).json({ data: run });
    } catch (err) {
      logServerError("get refresh run failed", err);
      return res.status(500).json({ error: "Failed to load refresh run" });
    }
  });

  // GET /compliance — auth, workspace-scoped; active cards only; one entry per card.
  router.get(`${BASE}/compliance`, async (req, res) => {
    const ws = await resolveWorkspace(storage, req, res);
    if (!ws) return;
    try {
      // Graph load degrades gracefully to null (feature disabled / all-empty).
      const graph = deps.loadComplianceGraph ? await deps.loadComplianceGraph() : null;
      const { cards } = await storage.listPracticeCards(ws.id, { status: "active", limit: 200 });
      const data = cards.map((card) => mapCard(card, graph));
      return res.status(200).json({ data });
    } catch (err) {
      logServerError("compliance failed", err);
      // Compliance is best-effort; never surface a 500 for a missing graph.
      return res.status(200).json({ data: [] });
    }
  });
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function loadCardInWorkspace(
  storage: IStorage,
  cardId: string,
  workspaceId: string,
  res: Response,
): Promise<PracticeCardRow | null> {
  const card = await storage.getPracticeCard(cardId);
  if (!card || card.workspaceId !== workspaceId) {
    res.status(404).json({ error: "Practice card not found" });
    return null;
  }
  return card;
}

async function getEmbedderOr503(
  deps: PracticeCardDeps,
  workspaceId: string,
  res: Response,
): Promise<EmbeddingClient | null> {
  try {
    return await deps.getEmbeddingClient(workspaceId);
  } catch (err) {
    logServerError("embedding provider unavailable", err);
    res.status(503).json({ error: "Knowledge indexing is temporarily unavailable" });
    return null;
  }
}

async function projectCard(
  card: PracticeCardRow,
  deps: PracticeCardDeps,
  embedder: EmbeddingClient,
): Promise<void> {
  await projectToChunk(card, {
    embed: embedder.embed,
    insertChunks: deps.vector.insertChunks,
    dimensions: embedder.dimensions,
    model: embedder.model,
    provider: embedder.provider,
  });
}

// Re-export for callers that need the projection text shape.
export { cardProjectionText };

/**
 * telemetry.ts — GET /api/telemetry/trust (Stage 8 / "Stage D", design §7+§9).
 *
 * READ-ONLY trust telemetry: aggregates what the consilium loop rounds ALREADY
 * persist (`execution_trace` jsonb per criterion + loop archetype/archetypeSource)
 * into the grounding ratio, planner track record, and criteria-quality metrics on
 * which "trust the planner under observation" is periodically re-decided.
 *
 * SCOPING: mounted behind `requireAuth` + `requireProject` in routes.ts under the
 * NEW `/api/telemetry` prefix. `requireProject` sets the async-local project
 * context, so `storage.getLoops()` / `getLoopRounds()` return ONLY this project's
 * rows (they scope through task_groups → withProjectList). Missing that mount would
 * both 401 (no req.user path) and 500 (getLoops throws "no request context") — the
 * same class of bug that hit /api/pr-queue.
 *
 * BOUNDED SCAN: never reads all history. `limit` (default 50, max 200) caps how
 * many recent loops are scanned; an optional `windowDays` further restricts to a
 * time window. The expensive jsonb round-read runs ONLY for the capped loop set.
 */
import type { Express } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import {
  computeTrustTelemetry,
  type TelemetryLoopInput,
} from "../services/consilium/trust-telemetry";

const querySchema = z.object({
  /** Max recent loops to scan (bounds the jsonb round-read). */
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  /** Optional time window (days); loops older than this are excluded. */
  windowDays: z.coerce.number().int().min(1).max(365).optional(),
});

export function registerTelemetryRoutes(app: Express, storage: IStorage): void {
  // GET /api/telemetry/trust — project-scoped, read-only trust telemetry.
  app.get("/api/telemetry/trust", async (req, res) => {
    try {
      // Belt-and-suspenders: the mount already enforces auth, but never trust the
      // route to be mounted correctly — a populated req.user is required to be here.
      if (!req.user?.id) {
        res.status(401).json({ error: "Authentication required" });
        return;
      }

      const parsed = querySchema.safeParse(req.query);
      if (!parsed.success) {
        res.status(400).json({ error: parsed.error.flatten() });
        return;
      }
      const { limit, windowDays } = parsed.data;

      // Project-scoped via the async-local context set by requireProject.
      const allLoops = await storage.getLoops();

      // Newest first (getLoops already orders desc, but re-sort defensively), then
      // apply the optional time window, then CAP — this is the scan bound.
      const cutoff = windowDays ? Date.now() - windowDays * 86_400_000 : null;
      const scanned = [...allLoops]
        .sort((a, b) => msOf(b.createdAt) - msOf(a.createdAt))
        .filter((l) => (cutoff === null ? true : msOf(l.createdAt) >= cutoff))
        .slice(0, limit);

      // Fetch rounds ONLY for the capped set (bounded fan-out ≤ limit).
      const loopInputs: TelemetryLoopInput[] = await Promise.all(
        scanned.map(async (loop): Promise<TelemetryLoopInput> => {
          const rounds = await storage.getLoopRounds(loop.id);
          return {
            archetype: loop.archetype,
            archetypeSource: loop.archetypeSource,
            createdAt: loop.createdAt,
            rounds: rounds.map((r) => ({
              createdAt: r.createdAt,
              executionTrace: r.executionTrace,
              openActionPoints: r.openActionPoints,
            })),
          };
        }),
      );

      const telemetry = computeTrustTelemetry(loopInputs);
      res.json({ ...telemetry, scan: { limit, windowDays: windowDays ?? null } });
    } catch (err) {
      console.error("/api/telemetry/trust error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  });
}

function msOf(d: Date | string | null | undefined): number {
  if (!d) return 0;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

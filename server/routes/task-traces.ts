import type { Express } from "express";
import type { IStorage } from "../storage";
import { authorizeTaskGroup } from "./authorize-task-group.js";

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerTaskTraceRoutes(app: Express, storage: IStorage): void {
  // GET /api/task-groups/:id/trace — get trace for a task group
  app.get("/api/task-groups/:id/trace", async (req, res) => {
    try {
      const groupId = req.params.id;
      if (!groupId) {
        return res.status(400).json({ error: "Missing group id" });
      }

      // Owner-or-admin gate (same IDOR class closed on the other task-group
      // routes): the trace exposes the span tree, durations, token/cost, and
      // error strings — must not be readable cross-tenant. authorizeTaskGroup
      // writes 401/404/403 + returns null on failure.
      const auth = await authorizeTaskGroup(req, res, storage, groupId);
      if (!auth) return;

      // v2: this legacy endpoint ALIASES the LATEST iteration's trace. Resolve
      // the latest iteration and read its iteration-scoped trace (MF-3); fall
      // back to the legacy group-level trace for pre-v2 groups with none.
      const latest = await storage.getLatestIteration(groupId);
      const trace = latest
        ? (await storage.getTaskTraceByIteration(groupId, latest.id)) ?? (await storage.getTaskTrace(groupId))
        : await storage.getTaskTrace(groupId);
      if (!trace) {
        return res.status(404).json({ error: `No trace found for task group ${groupId}` });
      }

      res.json(trace);
    } catch {
      // SEC1-LOW: never leak err.message (matches the generic envelope used on
      // every other task-group route). The detailed error is logged server-side
      // by the upstream error middleware; the client sees a generic 500.
      res.status(500).json({ error: "Failed to load task group trace" });
    }
  });
}

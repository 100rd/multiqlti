import type { Express } from "express";
import type { IStorage } from "../storage";

export function registerDelegationRoutes(app: Express, storage: IStorage): void {
  // GET /api/runs/:id/delegations — list all delegations for a run
  // Auth is applied via `app.use("/api/runs", requireAuth)` in routes.ts
  app.get("/api/runs/:id/delegations", async (req, res) => {
    const runId = req.params.id as string;
    const delegations = await storage.getDelegationRequests(runId);
    res.json(delegations);
  });
}

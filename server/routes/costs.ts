// server/routes/costs.ts
// Cost reporting and budget management endpoints for workspaces.
//
// Endpoints:
//   GET  /api/workspaces/:id/costs/summary?period=month
//   GET  /api/workspaces/:id/costs/export?period=month   → CSV download
//   GET  /api/workspaces/:id/budgets
//   POST /api/workspaces/:id/budgets
//   GET  /api/workspaces/:id/budgets/:budgetId
//   PATCH /api/workspaces/:id/budgets/:budgetId
//   DELETE /api/workspaces/:id/budgets/:budgetId

import { z } from "zod";
import type { Express } from "express";
import type { IStorage } from "../storage";
import { CostService } from "../services/cost-service";
import { BUDGET_PERIODS, insertBudgetSchema, updateBudgetSchema } from "@shared/schema";

// ─── Zod Schemas ──────────────────────────────────────────────────────────────

const WorkspaceIdSchema = z.object({
  id: z.string().min(1).max(64),
});

const BudgetIdParamSchema = z.object({
  id: z.string().min(1).max(64),
  budgetId: z.string().min(1).max(64),
});

const PeriodQuerySchema = z.object({
  period: z.enum(BUDGET_PERIODS).default("month"),
});

// ─── Route Registration ───────────────────────────────────────────────────────

export function registerCostRoutes(app: Express, storage: IStorage): void {
  const costService = new CostService(storage);

  // ── GET /api/workspaces/:id/costs/summary ─────────────────────────────────
  app.get("/api/workspaces/:id/costs/summary", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const queryResult = PeriodQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: queryResult.error.message });
    }

    const workspaceId = wsResult.data.id;
    const period = queryResult.data.period;

    // Workspace must exist
    const workspace = await storage.getWorkspace(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: `Workspace ${workspaceId} not found` });
    }

    try {
      const summary = await costService.getSummary(workspaceId, period);
      return res.json(summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── GET /api/workspaces/:id/costs/export ──────────────────────────────────
  // Returns CSV file for download.
  app.get("/api/workspaces/:id/costs/export", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const queryResult = PeriodQuerySchema.safeParse(req.query);
    if (!queryResult.success) {
      return res.status(400).json({ error: queryResult.error.message });
    }

    const workspaceId = wsResult.data.id;
    const period = queryResult.data.period;

    const workspace = await storage.getWorkspace(workspaceId);
    if (!workspace) {
      return res.status(404).json({ error: `Workspace ${workspaceId} not found` });
    }

    try {
      const csv = await costService.exportCsv(workspaceId, period);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="costs-${workspaceId}-${period}-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      return res.send(csv);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── GET /api/workspaces/:id/budgets ───────────────────────────────────────
  app.get("/api/workspaces/:id/budgets", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const workspace = await storage.getWorkspace(wsResult.data.id);
    if (!workspace) {
      return res.status(404).json({ error: `Workspace ${wsResult.data.id} not found` });
    }

    try {
      const budgetRows = await storage.getBudgetsByWorkspace(wsResult.data.id);
      return res.json({ budgets: budgetRows });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── POST /api/workspaces/:id/budgets ──────────────────────────────────────
  app.post("/api/workspaces/:id/budgets", async (req, res) => {
    const wsResult = WorkspaceIdSchema.safeParse(req.params);
    if (!wsResult.success) {
      return res.status(400).json({ error: wsResult.error.message });
    }

    const workspace = await storage.getWorkspace(wsResult.data.id);
    if (!workspace) {
      return res.status(404).json({ error: `Workspace ${wsResult.data.id} not found` });
    }

    // Merge workspaceId from path into body for validation
    const bodyResult = insertBudgetSchema.safeParse({
      ...req.body,
      workspaceId: wsResult.data.id,
    });
    if (!bodyResult.success) {
      return res.status(400).json({ error: bodyResult.error.message });
    }

    try {
      const budget = await storage.createBudget(bodyResult.data);
      return res.status(201).json(budget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── GET /api/workspaces/:id/budgets/:budgetId ─────────────────────────────
  app.get("/api/workspaces/:id/budgets/:budgetId", async (req, res) => {
    const paramResult = BudgetIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: paramResult.error.message });
    }

    try {
      const budget = await storage.getBudget(paramResult.data.budgetId);
      if (!budget) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }
      // Ownership check: budget must belong to this workspace
      if (budget.workspaceId !== paramResult.data.id) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }
      return res.json(budget);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── PATCH /api/workspaces/:id/budgets/:budgetId ───────────────────────────
  app.patch("/api/workspaces/:id/budgets/:budgetId", async (req, res) => {
    const paramResult = BudgetIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: paramResult.error.message });
    }

    const bodyResult = updateBudgetSchema.safeParse(req.body);
    if (!bodyResult.success) {
      return res.status(400).json({ error: bodyResult.error.message });
    }

    try {
      const existing = await storage.getBudget(paramResult.data.budgetId);
      if (!existing) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }
      if (existing.workspaceId !== paramResult.data.id) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }

      const updated = await storage.updateBudget(paramResult.data.budgetId, bodyResult.data);
      return res.json(updated);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });

  // ── DELETE /api/workspaces/:id/budgets/:budgetId ──────────────────────────
  app.delete("/api/workspaces/:id/budgets/:budgetId", async (req, res) => {
    const paramResult = BudgetIdParamSchema.safeParse(req.params);
    if (!paramResult.success) {
      return res.status(400).json({ error: paramResult.error.message });
    }

    try {
      const existing = await storage.getBudget(paramResult.data.budgetId);
      if (!existing) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }
      if (existing.workspaceId !== paramResult.data.id) {
        return res.status(404).json({ error: `Budget ${paramResult.data.budgetId} not found` });
      }

      await storage.deleteBudget(paramResult.data.budgetId);
      return res.status(204).send();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Internal server error";
      return res.status(500).json({ error: msg });
    }
  });
}

import type { Express, Request, Response } from "express";
import { contourObservability } from "../pipeline/observability/contour-observability";

export function registerContourObservabilityRoutes(app: Express) {
  app.get("/api/observability/contour", (req: Request, res: Response) => {
    try {
      const metrics = contourObservability.getYieldMetrics();
      
      // We will mock some skills since the actual observability store is fresh.
      // In a real system, these would be retrieved dynamically.
      const skillSuccessRates = [
        { skillId: "auth-migration", successRate: contourObservability.getSkillSuccessRate("auth-migration"), name: "Auth Migration" },
        { skillId: "db-provisioning", successRate: contourObservability.getSkillSuccessRate("db-provisioning"), name: "DB Provisioning" },
        { skillId: "ui-baseline-check", successRate: contourObservability.getSkillSuccessRate("ui-baseline-check"), name: "UI Baseline Check" }
      ];

      res.json({
        metrics,
        threshold: 2.0, // Should match config
        skillSuccessRates
      });
    } catch (err) {
      console.error("[Contour Observability] Failed to fetch metrics", err);
      res.status(500).json({ error: "Failed to fetch contour observability metrics" });
    }
  });

  // Seed mock data endpoint for UI demonstration purposes
  app.post("/api/observability/contour/seed-mock", (req: Request, res: Response) => {
    try {
      const now = Date.now();
      const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
      
      // Clear old
      // Wait, we can't easily clear the singleton's internal store without exposing it, 
      // but we can just add records.
      
      for (let i = 0; i < 97; i++) {
        contourObservability.recordTaskVerdict(`mock-success-${i}`, "success", "auth-migration", tenDaysAgo);
      }
      
      // Add a couple of failures
      for (let i = 0; i < 2; i++) {
        contourObservability.recordTaskVerdict(`mock-fail-${i}`, "failure", "db-provisioning", tenDaysAgo);
      }
      
      // Add one escaped task
      contourObservability.recordTaskVerdict(`mock-escape-1`, "success", "ui-baseline-check", tenDaysAgo);
      contourObservability.reportEscapedIncident(`mock-escape-1`, now);

      res.json({ success: true, message: "Mock data seeded successfully" });
    } catch (err) {
      res.status(500).json({ error: "Failed to seed mock data" });
    }
  });
}

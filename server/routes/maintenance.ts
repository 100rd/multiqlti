import type { Router } from "express";
import { z } from "zod";
import { db } from "../db";
import { maintenancePolicies, maintenanceScans } from "@shared/schema";
import { eq, desc, and } from "drizzle-orm";
import type {
  MaintenanceCategoryConfig,
  ScoutFinding,
  HealthScore,
} from "@shared/types";

// ─── Validation Schemas ───────────────────────────────────────────────────────

const MAINTENANCE_CATEGORIES = [
  "dependency_update",
  "breaking_change",
  "security_advisory",
  "license_compliance",
  "api_deprecation",
  "config_drift",
  "best_practices",
  "documentation",
  "access_control",
  "data_retention",
  "cert_expiry",
  "infra_drift",
  "vendor_status",
  "system_hardening",
] as const;

const SEVERITY_VALUES = ["critical", "high", "medium", "low", "info"] as const;

const CategoryConfigSchema = z.object({
  category: z.enum(MAINTENANCE_CATEGORIES),
  enabled: z.boolean(),
  severity: z.enum(SEVERITY_VALUES),
  customRules: z.record(z.unknown()).optional(),
});

const CreatePolicySchema = z.object({
  workspaceId: z.string().min(1).optional().nullable(),
  enabled: z.boolean().default(true),
  schedule: z
    .string()
    .min(1)
    .max(100)
    .regex(
      /^(@(annually|yearly|monthly|weekly|daily|hourly|reboot))|(((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*) ){4}((\d+,)+\d+|(\d+(\/|-)\d+)|\d+|\*)$/,
      "Invalid cron expression",
    )
    .default("0 9 * * 1"),
  categories: z.array(CategoryConfigSchema).default([]),
  severityThreshold: z.enum(SEVERITY_VALUES).default("high"),
  autoMerge: z.boolean().default(false),
  notifyChannels: z.array(z.string().min(1).max(255)).default([]),
});

const UpdatePolicySchema = CreatePolicySchema.partial();

const TriggerScanSchema = z.object({
  policyId: z.string().min(1).max(255),
});

const FindingActionSchema = z.object({
  action: z.enum(["sdlc", "backlog", "dismiss"]),
  scanId: z.string().min(1).max(255),
});

// ─── Route registration ───────────────────────────────────────────────────────

export function registerMaintenanceRoutes(router: Router): void {
  // ── Policies CRUD ────────────────────────────────────────────────────────────

  router.get("/api/maintenance/policies", async (_req, res) => {
    try {
      const rows = await db
        .select()
        .from(maintenancePolicies)
        .orderBy(desc(maintenancePolicies.createdAt));
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/maintenance/policies", async (req, res) => {
    const parsed = CreatePolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    try {
      const [row] = await db
        .insert(maintenancePolicies)
        .values({
          workspaceId: parsed.data.workspaceId ?? null,
          enabled: parsed.data.enabled,
          schedule: parsed.data.schedule,
          categories: parsed.data.categories as MaintenanceCategoryConfig[],
          severityThreshold: parsed.data.severityThreshold,
          autoMerge: parsed.data.autoMerge,
          notifyChannels: parsed.data.notifyChannels,
        })
        .returning();

      return res.status(201).json(row);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  router.put("/api/maintenance/policies/:id", async (req, res) => {
    const parsed = UpdatePolicySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    try {
      const [existing] = await db
        .select()
        .from(maintenancePolicies)
        .where(eq(maintenancePolicies.id, req.params.id));

      if (!existing) {
        return res.status(404).json({ error: "Policy not found" });
      }

      const updateData: Record<string, unknown> = { updatedAt: new Date() };
      if (parsed.data.workspaceId !== undefined) updateData.workspaceId = parsed.data.workspaceId;
      if (parsed.data.enabled !== undefined) updateData.enabled = parsed.data.enabled;
      if (parsed.data.schedule !== undefined) updateData.schedule = parsed.data.schedule;
      if (parsed.data.categories !== undefined) updateData.categories = parsed.data.categories;
      if (parsed.data.severityThreshold !== undefined)
        updateData.severityThreshold = parsed.data.severityThreshold;
      if (parsed.data.autoMerge !== undefined) updateData.autoMerge = parsed.data.autoMerge;
      if (parsed.data.notifyChannels !== undefined)
        updateData.notifyChannels = parsed.data.notifyChannels;

      const [updated] = await db
        .update(maintenancePolicies)
        .set(updateData)
        .where(eq(maintenancePolicies.id, req.params.id))
        .returning();

      return res.json(updated);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  router.delete("/api/maintenance/policies/:id", async (req, res) => {
    try {
      const [existing] = await db
        .select()
        .from(maintenancePolicies)
        .where(eq(maintenancePolicies.id, req.params.id));

      if (!existing) {
        return res.status(404).json({ error: "Policy not found" });
      }

      await db
        .delete(maintenancePolicies)
        .where(eq(maintenancePolicies.id, req.params.id));

      return res.json({ message: "Policy deleted" });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Scans ────────────────────────────────────────────────────────────────────

  router.get("/api/maintenance/scans", async (req, res) => {
    try {
      const workspaceId = typeof req.query.workspaceId === "string" ? req.query.workspaceId : null;

      const rows = workspaceId
        ? await db
            .select()
            .from(maintenanceScans)
            .where(eq(maintenanceScans.workspaceId, workspaceId))
            .orderBy(desc(maintenanceScans.createdAt))
        : await db.select().from(maintenanceScans).orderBy(desc(maintenanceScans.createdAt));

      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  router.get("/api/maintenance/scans/:id", async (req, res) => {
    try {
      const [row] = await db
        .select()
        .from(maintenanceScans)
        .where(eq(maintenanceScans.id, req.params.id));

      if (!row) {
        return res.status(404).json({ error: "Scan not found" });
      }

      return res.json(row);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  router.post("/api/maintenance/scans/trigger", async (req, res) => {
    const parsed = TriggerScanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    try {
      const [policy] = await db
        .select()
        .from(maintenancePolicies)
        .where(eq(maintenancePolicies.id, parsed.data.policyId));

      if (!policy) {
        return res.status(404).json({ error: "Policy not found" });
      }

      if (!policy.workspaceId) {
        return res.status(400).json({ error: "Policy has no workspace associated" });
      }

      // Create a stub scan record — the scheduler will fill it in
      const [scan] = await db
        .insert(maintenanceScans)
        .values({
          policyId: policy.id,
          workspaceId: policy.workspaceId,
          status: "running",
          findings: [],
          importantCount: 0,
        })
        .returning();

      return res.status(202).json(scan);
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Finding Actions ──────────────────────────────────────────────────────────

  router.post("/api/maintenance/findings/:findingId/action", async (req, res) => {
    const parsed = FindingActionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    const findingId = req.params.findingId;
    if (!findingId || findingId.length > 255) {
      return res.status(400).json({ error: "Invalid finding id" });
    }

    try {
      const [scan] = await db
        .select()
        .from(maintenanceScans)
        .where(eq(maintenanceScans.id, parsed.data.scanId));

      if (!scan) {
        return res.status(404).json({ error: "Scan not found" });
      }

      const findings = (scan.findings as ScoutFinding[]) ?? [];
      const findingIndex = findings.findIndex((f) => f.id === findingId);

      if (findingIndex === -1) {
        return res.status(404).json({ error: "Finding not found in scan" });
      }

      const newStatus: ScoutFinding["status"] =
        parsed.data.action === "dismiss" ? "dismissed" : "actioned";

      const updatedFindings = findings.map((f, idx) =>
        idx === findingIndex ? { ...f, status: newStatus } : f,
      );

      const [updated] = await db
        .update(maintenanceScans)
        .set({ findings: updatedFindings })
        .where(eq(maintenanceScans.id, parsed.data.scanId))
        .returning();

      return res.json({ finding: updatedFindings[findingIndex], scan: updated });
    } catch (err) {
      return res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Dashboard ────────────────────────────────────────────────────────────────

  router.get("/api/maintenance/dashboard", async (_req, res) => {
    try {
      const [policies, scans] = await Promise.all([
        db.select().from(maintenancePolicies),
        db
          .select()
          .from(maintenanceScans)
          .orderBy(desc(maintenanceScans.createdAt)),
      ]);

      const allFindings = scans.flatMap((s) => (s.findings as ScoutFinding[]) ?? []);
      const openFindings = allFindings.filter((f) => f.status === "open");

      const severityCounts = {
        critical: openFindings.filter((f) => f.severity === "critical").length,
        high: openFindings.filter((f) => f.severity === "high").length,
        medium: openFindings.filter((f) => f.severity === "medium").length,
        low: openFindings.filter((f) => f.severity === "low").length,
      };

      const lastScan = scans[0] ?? null;

      res.json({
        totalPolicies: policies.length,
        enabledPolicies: policies.filter((p) => p.enabled).length,
        totalScans: scans.length,
        openFindings: openFindings.length,
        severityCounts,
        lastScanAt: lastScan?.completedAt ?? lastScan?.startedAt ?? null,
        recentScans: scans.slice(0, 10),
      });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ── Health Score ─────────────────────────────────────────────────────────────

  router.get("/api/maintenance/health/:workspaceId", async (req, res) => {
    try {
      const workspaceId = req.params.workspaceId;

      const scans = await db
        .select()
        .from(maintenanceScans)
        .where(
          and(
            eq(maintenanceScans.workspaceId, workspaceId),
            eq(maintenanceScans.status, "completed"),
          ),
        )
        .orderBy(desc(maintenanceScans.completedAt));

      const allFindings = scans.flatMap((s) => (s.findings as ScoutFinding[]) ?? []);
      const openFindings = allFindings.filter((f) => f.status === "open");

      // Score formula: start at 100, subtract by severity
      let score = 100;
      const deductions = Math.min(
        60,
        openFindings.filter((f) => f.severity === "critical").length * 20 +
          openFindings.filter((f) => f.severity === "high").length * 10 +
          openFindings.filter((f) => f.severity === "medium").length * 3 +
          openFindings.filter((f) => f.severity === "low").length * 1,
      );
      score -= deductions;

      // Bonus for recent scans
      const now = Date.now();
      const latestScan = scans[0];
      if (latestScan?.completedAt) {
        const ageMs = now - new Date(latestScan.completedAt).getTime();
        const dayMs = 86_400_000;
        if (ageMs < dayMs) {
          score += 10;
        } else if (ageMs < 7 * dayMs) {
          score += 5;
        }
      }

      score = Math.max(0, Math.min(100, score));

      // Trend: compare last 3 scan scores
      const scoredScans = scans.slice(0, 3).map((s) => {
        const findings = (s.findings as ScoutFinding[]) ?? [];
        const open = findings.filter((f) => f.status === "open");
        const d = Math.min(
          60,
          open.filter((f) => f.severity === "critical").length * 20 +
            open.filter((f) => f.severity === "high").length * 10 +
            open.filter((f) => f.severity === "medium").length * 3 +
            open.filter((f) => f.severity === "low").length,
        );
        return 100 - d;
      });

      let trend: HealthScore["trend"] = "stable";
      if (scoredScans.length >= 2) {
        const latest = scoredScans[0];
        const previous = scoredScans[scoredScans.length - 1];
        if (latest > previous + 5) trend = "improving";
        else if (latest < previous - 5) trend = "declining";
      }

      const health: HealthScore = {
        score,
        breakdown: {
          openFindings: openFindings.length,
          complianceCoverage: openFindings.length === 0 ? 100 : Math.max(0, 100 - deductions),
          meanTimeToFix: 0, // calculated in analytics module
          scanFrequency: scans.length,
        },
        trend,
      };

      res.json(health);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });
}

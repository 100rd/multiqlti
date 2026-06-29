/**
 * Credentials API — read-only broker UI endpoints (ADR-001 §3.2 plan-time surface).
 *
 * All three endpoints:
 *   - require authentication + project context (enforced in routes.ts via
 *     requireAuth + requireProject on /api/credentials)
 *   - scope every query to the current project (via withProject or credentialProvider)
 *   - NEVER return secret material
 *
 * Endpoints:
 *   GET /api/credentials              → CredentialMetadata[]
 *   GET /api/credentials/access-log   → CredentialAccessLogRow[] (newest createdAt first)
 *   GET /api/credentials/leases       → CredentialLeaseRow[] (newest issuedAt first)
 */

import type { Express } from "express";
import { db, withProject } from "../db.js";
import {
  credentialLeases,
  credentialAccessLog,
  CREDENTIAL_LEASE_STATUSES,
} from "../../shared/schema.js";
import { credentialProvider } from "../credentials/db-crypto-provider.js";
import { getProjectId } from "../context.js";
import { desc, eq, and } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export function registerCredentialRoutes(app: Express): void {
  // ── GET /api/credentials ──────────────────────────────────────────────────────
  // List all credentials for the current project — metadata only, no secrets.
  // Delegates entirely to credentialProvider which enforces assertProject() and
  // writes a list_metadata audit row on every call.
  app.get("/api/credentials", async (_req, res) => {
    try {
      const projectId = getProjectId();
      const credentials = await credentialProvider.listCredentials(projectId);
      res.json(credentials);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── GET /api/credentials/access-log ──────────────────────────────────────────
  // Returns credential_access_log rows for the current project, newest first.
  //
  // Query params:
  //   limit        — row cap (default 100, max 500)
  //   credentialId — narrow to a single credential ID
  //   runId        — narrow to a single pipeline run ID
  app.get("/api/credentials/access-log", async (req, res) => {
    try {
      const rawLimit = parseInt(String(req.query.limit ?? "100"), 10);
      const limit =
        isNaN(rawLimit) || rawLimit < 1 ? 100 : Math.min(rawLimit, 500);

      const credentialId = req.query.credentialId
        ? String(req.query.credentialId)
        : undefined;
      const runId = req.query.runId ? String(req.query.runId) : undefined;

      // Build WHERE: start with the project scope, then layer optional filters.
      const conditions: SQL[] = [withProject(credentialAccessLog)];
      if (credentialId) {
        conditions.push(eq(credentialAccessLog.credentialId, credentialId));
      }
      if (runId) {
        conditions.push(eq(credentialAccessLog.runId, runId));
      }
      const where =
        conditions.length === 1 ? conditions[0] : and(...conditions)!;

      const rows = await db
        .select()
        .from(credentialAccessLog)
        .where(where)
        .orderBy(desc(credentialAccessLog.createdAt))
        .limit(limit);

      res.json(rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── GET /api/credentials/leases ───────────────────────────────────────────────
  // Returns credential_leases rows for the current project, newest issuedAt first.
  //
  // Query params:
  //   status — filter by lease status: active | revoked | expired
  app.get("/api/credentials/leases", async (req, res) => {
    try {
      const status = req.query.status ? String(req.query.status) : undefined;

      if (
        status !== undefined &&
        !(CREDENTIAL_LEASE_STATUSES as readonly string[]).includes(status)
      ) {
        res.status(400).json({
          error: `Invalid status: must be one of ${CREDENTIAL_LEASE_STATUSES.join(", ")}`,
        });
        return;
      }

      const conditions: SQL[] = [withProject(credentialLeases)];
      if (status) {
        conditions.push(
          eq(
            credentialLeases.status,
            status as (typeof CREDENTIAL_LEASE_STATUSES)[number],
          ),
        );
      }
      const where =
        conditions.length === 1 ? conditions[0] : and(...conditions)!;

      const rows = await db
        .select()
        .from(credentialLeases)
        .where(where)
        .orderBy(desc(credentialLeases.issuedAt));

      res.json(rows);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}

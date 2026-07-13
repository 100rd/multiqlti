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
import { z } from "zod";
import { db, withProject } from "../db.js";
import {
  credentialLeases,
  credentialAccessLog,
  CREDENTIAL_LEASE_STATUSES,
  secrets,
} from "../../shared/schema.js";
import { credentialProvider } from "../credentials/db-crypto-provider.js";
import { SECRET_TYPES, shapeTypedSecret } from "../credentials/typed-secret.js";
import { getProjectId } from "../context.js";
import { requireRole } from "../auth/middleware.js";
import { desc, eq, and } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

// ─── Write-endpoint schemas (Secrets Vault, Phase 1) ───────────────────────────

const CONTROL_CHARS_RE = new RegExp("[\\u0000-\\u001F\\u007F-\\u009F]", "g");

/** Vault secret name: leading letter/underscore, then word chars/./-, <=129 chars. */
const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]{0,128}$/;
const MAX_META_LEN = 256;

const CreateSecretBodySchema = z.object({
  name: z.string().regex(SECRET_NAME_RE, "invalid secret name"),
  value: z.string().min(1).max(8192),
  // ADR-003 §D3: typed delivery — "static" (default), "aws" (JSON creds), or
  // "kubernetes" (kubeconfig). The value shape is validated in the handler.
  type: z.enum(SECRET_TYPES).default("static"),
  description: z.string().max(MAX_META_LEN).optional(),
  scope: z.string().max(MAX_META_LEN).optional(),
  provider: z.string().max(MAX_META_LEN).optional(),
});

const UpdateSecretBodySchema = z.object({
  value: z.string().min(1).max(8192).optional(),
  description: z.string().max(MAX_META_LEN).optional(),
  scope: z.string().max(MAX_META_LEN).optional(),
  provider: z.string().max(MAX_META_LEN).optional(),
});

const SecretIdParamsSchema = z.object({
  id: z.string().min(1),
});

/**
 * Control-strip (C0/DEL/C1) + collapse whitespace + trim + clamp an untrusted
 * metadata field (description/scope/provider). Mirrors the pattern used by
 * consilium-loops.ts's sanitizeReason/sanitizeCommitPrefix. Returns undefined
 * for a non-string or empty-after-strip input.
 */
function sanitizeMeta(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw
    .replace(CONTROL_CHARS_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_META_LEN);
  return cleaned.length ? cleaned : undefined;
}

/** The metadata shape returned by every write endpoint. VALUE is never included. */
interface SecretMetadataResponse {
  id: string;
  projectId: string;
  name: string;
  provider: string;
  scope: string;
  description: string;
  hasSecret: boolean;
  version: number;
  createdAt: Date;
  rotatedAt: Date | null;
}

function toSecretResponse(
  row: typeof secrets.$inferSelect,
): SecretMetadataResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    name: row.name,
    provider: row.provider ?? "vault",
    scope: row.scope ?? "",
    description: row.description ?? "",
    hasSecret: row.valueEncrypted !== null,
    version: row.version,
    createdAt: row.createdAt,
    rotatedAt: row.rotatedAt,
  };
}

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

  // ── POST /api/credentials ─────────────────────────────────────────────────────
  // Create a new vault secret. Admin only. VALUE is never returned.
  app.post("/api/credentials", requireRole("admin"), async (req, res) => {
    const body = CreateSecretBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    try {
      const projectId = getProjectId();

      const [existing] = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(
          and(eq(secrets.projectId, projectId), eq(secrets.name, body.data.name)),
        );
      if (existing) {
        res.status(409).json({
          error: `Secret with name "${body.data.name}" already exists`,
        });
        return;
      }

      // §3b: shape-validate the typed value (aws JSON / kubeconfig) before storing —
      // reuse the exact delivery shaper so a malformed payload is a 400, not a
      // runtime delivery failure. Never echoes the value (shaper errors carry name/type).
      try {
        shapeTypedSecret({
          name: body.data.name,
          type: body.data.type,
          value: body.data.value,
        });
      } catch (shapeErr: unknown) {
        res.status(400).json({
          error:
            shapeErr instanceof Error
              ? shapeErr.message
              : "invalid typed secret value",
        });
        return;
      }

      const metadata = await credentialProvider.putCredential({
        projectId,
        name: body.data.name,
        secret: body.data.value,
        description: sanitizeMeta(body.data.description) ?? "",
        scope: sanitizeMeta(body.data.scope) ?? "",
        provider: sanitizeMeta(body.data.provider) ?? "",
        type: body.data.type,
      });

      const [row] = await db
        .select()
        .from(secrets)
        .where(and(eq(secrets.id, metadata.id), eq(secrets.projectId, projectId)));
      res.status(201).json(toSecretResponse(row));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── PATCH /api/credentials/:id ─────────────────────────────────────────────────
  // Update metadata and/or rotate a vault secret (value present = rotate).
  // Admin only. VALUE is never returned.
  app.patch("/api/credentials/:id", requireRole("admin"), async (req, res) => {
    const params = SecretIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const body = UpdateSecretBodySchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }

    try {
      const projectId = getProjectId();

      const [existing] = await db
        .select()
        .from(secrets)
        .where(and(eq(secrets.id, params.data.id), eq(secrets.projectId, projectId)));
      if (!existing) {
        res.status(404).json({ error: "Secret not found" });
        return;
      }

      if (body.data.value !== undefined) {
        // Rotate (+ optionally update metadata) through the broker — bumps
        // version and rotatedAt, and writes a 'secret_rotated' audit row.
        const metadata = await credentialProvider.putCredential({
          projectId,
          name: existing.name,
          secret: body.data.value,
          description: sanitizeMeta(body.data.description) ?? existing.description ?? "",
          scope: sanitizeMeta(body.data.scope) ?? existing.scope ?? "",
          provider: sanitizeMeta(body.data.provider) ?? existing.provider ?? "",
        });
        const [row] = await db
          .select()
          .from(secrets)
          .where(and(eq(secrets.id, metadata.id), eq(secrets.projectId, projectId)));
        res.json(toSecretResponse(row));
        return;
      }

      // Metadata-only update — no rotation, no crypto touch, no version bump.
      const [updated] = await db
        .update(secrets)
        .set({
          description:
            body.data.description !== undefined
              ? sanitizeMeta(body.data.description) ?? null
              : existing.description,
          scope:
            body.data.scope !== undefined
              ? sanitizeMeta(body.data.scope) ?? null
              : existing.scope,
          provider:
            body.data.provider !== undefined
              ? sanitizeMeta(body.data.provider) ?? null
              : existing.provider,
        })
        .where(and(eq(secrets.id, params.data.id), eq(secrets.projectId, projectId)))
        .returning();

      res.json(toSecretResponse(updated));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });

  // ── DELETE /api/credentials/:id ────────────────────────────────────────────────
  // Delete a vault secret. Admin only.
  app.delete("/api/credentials/:id", requireRole("admin"), async (req, res) => {
    const params = SecretIdParamsSchema.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }

    try {
      const projectId = getProjectId();

      const [existing] = await db
        .select({ id: secrets.id })
        .from(secrets)
        .where(and(eq(secrets.id, params.data.id), eq(secrets.projectId, projectId)));
      if (!existing) {
        res.status(404).json({ error: "Secret not found" });
        return;
      }

      await credentialProvider.deleteCredential(projectId, params.data.id);
      res.status(204).end();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: message });
    }
  });
}

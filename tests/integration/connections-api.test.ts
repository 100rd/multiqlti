/**
 * Integration tests for the Workspace Connections REST API (issue #267).
 *
 * Covers:
 *  - All 6 endpoints (list, create, read, update, delete, test)
 *  - RBAC: admin has full CRUD, maintainer is read-only, user has no access
 *  - Zod validation: invalid type, missing required fields, malformed body
 *  - Secret redaction: verifies secrets never appear in any response
 *  - Connectivity test endpoint: returns { ok, latencyMs, details }
 *  - Error cases: 404 for missing connection, 403 for wrong role, 400 validation
 *
 * Uses an in-memory mock storage to avoid needing PostgreSQL.
 * Auth is injected per-test by setting req.user on a per-role Express app.
 */

import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import type { User } from "../../shared/types.js";
import type { WorkspaceConnection } from "../../shared/types.js";
import { registerConnectionRoutes } from "../../server/routes/connections.js";
import { MemStorage } from "../../server/storage.js";

// ─── Users ────────────────────────────────────────────────────────────────────

const ADMIN_USER: User = {
  id: "admin-id",
  email: "admin@example.com",
  name: "Admin",
  isActive: true,
  role: "admin",
  lastLoginAt: null,
  createdAt: new Date(0),
};

/** Workspace member — read metadata only */
const MAINTAINER_USER: User = {
  id: "maintainer-id",
  email: "maintainer@example.com",
  name: "Maintainer",
  isActive: true,
  role: "maintainer",
  lastLoginAt: null,
  createdAt: new Date(0),
};

/** Workspace viewer — no access */
const VIEWER_USER: User = {
  id: "viewer-id",
  email: "viewer@example.com",
  name: "Viewer",
  isActive: true,
  role: "user",
  lastLoginAt: null,
  createdAt: new Date(0),
};

// ─── App factories ────────────────────────────────────────────────────────────

function createApp(user: User, storage: MemStorage): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.user = user;
    next();
  });
  registerConnectionRoutes(app, storage);
  return app;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE_ID = "ws-test-001";

const VALID_GITHUB_BODY = {
  type: "github",
  name: "My GitHub",
  config: { host: "https://api.github.com", owner: "acme" },
};

const VALID_GITLAB_BODY = {
  type: "gitlab",
  name: "My GitLab",
  config: { host: "https://gitlab.com" },
};

/** Assert that a response body (or any nested object) has no secret keys. */
function assertNoSecrets(body: unknown): void {
  const json = JSON.stringify(body);
  expect(json).not.toContain("secretsEncrypted");
  expect(json).not.toContain("secrets");
  // Patterns that look like raw secret values should not appear
  expect(json).not.toMatch(/"token"\s*:/);
  expect(json).not.toMatch(/"password"\s*:/);
  expect(json).not.toMatch(/"privateKey"\s*:/);
}

// ─── Test state ───────────────────────────────────────────────────────────────

let storage: MemStorage;

beforeEach(() => {
  storage = new MemStorage();
});

// ─── LIST — GET /api/workspaces/:id/connections ───────────────────────────────

describe("GET /api/workspaces/:id/connections", () => {
  it("admin: returns empty array when no connections exist", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(0);
  });

  it("admin: returns all connections for the workspace", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "My GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].id).toBe(conn.id);
  });

  it("admin: secrets are never included in list response", async () => {
    await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "Sensitive GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
      secrets: { token: "ghp_supersecrettoken" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(200);
    assertNoSecrets(res.body);

    // hasSecrets flag should indicate secrets exist without revealing them
    const conn = res.body[0] as WorkspaceConnection;
    expect(conn.hasSecrets).toBe(true);
  });

  it("maintainer (member): can list connections (read-only role)", async () => {
    await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "gitlab",
      name: "My GitLab",
      config: { host: "https://gitlab.com" },
    });

    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("viewer (user role): gets 403 — no access", async () => {
    const app = createApp(VIEWER_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(403);
  });

  it("only returns connections belonging to the requested workspace", async () => {
    await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "WS1 Connection",
      config: { host: "https://api.github.com", owner: "acme" },
    });
    await storage.createWorkspaceConnection({
      workspaceId: "other-workspace",
      type: "gitlab",
      name: "Other WS Connection",
      config: { host: "https://gitlab.com" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].name).toBe("WS1 Connection");
  });
});

// ─── CREATE — POST /api/workspaces/:id/connections ────────────────────────────

describe("POST /api/workspaces/:id/connections", () => {
  it("admin: creates a GitHub connection and returns 201", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send(VALID_GITHUB_BODY);

    expect(res.status).toBe(201);
    expect(res.body.id).toBeDefined();
    expect(res.body.type).toBe("github");
    expect(res.body.name).toBe("My GitHub");
    expect(res.body.workspaceId).toBe(WORKSPACE_ID);
  });

  it("admin: created connection has no secret fields in response", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        ...VALID_GITHUB_BODY,
        secrets: { token: "ghp_verysecrettoken" },
      });

    expect(res.status).toBe(201);
    assertNoSecrets(res.body);
    expect(res.body.hasSecrets).toBe(true);
  });

  it("admin: creates a GitLab connection with valid config", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send(VALID_GITLAB_BODY);

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("gitlab");
  });

  it("admin: creates a Kubernetes connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "kubernetes",
        name: "My K8s",
        config: { server: "https://kubernetes.example.com", namespace: "production" },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("kubernetes");
  });

  it("admin: creates an AWS connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "aws",
        name: "AWS Prod",
        config: { region: "us-east-1" },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("aws");
  });

  it("admin: creates a Jira connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "jira",
        name: "Jira Board",
        config: { host: "https://myorg.atlassian.net" },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("jira");
  });

  it("admin: creates a Grafana connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "grafana",
        name: "Grafana Dashboards",
        config: { host: "https://grafana.example.com" },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("grafana");
  });

  it("admin: creates a generic_mcp connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "generic_mcp",
        name: "My MCP Server",
        config: { endpoint: "https://mcp.example.com", transport: "sse" },
      });

    expect(res.status).toBe(201);
    expect(res.body.type).toBe("generic_mcp");
  });

  it("returns 400 for missing type field", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({ name: "Missing Type", config: {} });

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid connection type", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({ type: "ftp_server", name: "Bad Type", config: {} });

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing required name field", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({ type: "github", config: { host: "https://api.github.com", owner: "acme" } });

    expect(res.status).toBe(400);
  });

  it("returns 400 when GitHub config is missing required owner field", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "github",
        name: "Bad GitHub",
        config: { host: "https://api.github.com" },
        // owner is required for GitHub
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("config");
  });

  it("returns 400 when Kubernetes config has invalid server URL", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "kubernetes",
        name: "Bad K8s",
        config: { server: "not-a-url" },
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 for completely empty body", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({});

    expect(res.status).toBe(400);
  });

  it("maintainer (member): gets 403 — cannot create connections", async () => {
    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send(VALID_GITHUB_BODY);

    expect(res.status).toBe(403);
  });

  it("viewer (user role): gets 403 — no access", async () => {
    const app = createApp(VIEWER_USER, storage);
    const res = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send(VALID_GITHUB_BODY);

    expect(res.status).toBe(403);
  });
});

// ─── READ — GET /api/workspaces/:id/connections/:cid ─────────────────────────

describe("GET /api/workspaces/:id/connections/:cid", () => {
  it("admin: reads an existing connection", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub Read",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(conn.id);
    expect(res.body.type).toBe("github");
  });

  it("admin: secrets never appear in single connection response", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "gitlab",
      name: "Secret GitLab",
      config: { host: "https://gitlab.com" },
      secrets: { privateToken: "glpat-supersecret" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(200);
    assertNoSecrets(res.body);
    expect(res.body.hasSecrets).toBe(true);
  });

  it("returns 404 for non-existent connection id", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/does-not-exist`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when connection belongs to a different workspace", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "other-workspace-id",
      type: "github",
      name: "Other WS Conn",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(404);
  });

  it("maintainer: can read connection metadata", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "jira",
      name: "Jira",
      config: { host: "https://company.atlassian.net" },
    });

    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(conn.id);
    assertNoSecrets(res.body);
  });

  it("viewer (user role): gets 403", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(VIEWER_USER, storage);
    const res = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(403);
  });
});

// ─── UPDATE — PATCH /api/workspaces/:id/connections/:cid ─────────────────────

describe("PATCH /api/workspaces/:id/connections/:cid", () => {
  it("admin: updates name only", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "Original Name",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ name: "Updated Name" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Updated Name");
    expect(res.body.type).toBe("github");
  });

  it("admin: updates status to inactive", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "Active Connection",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ status: "inactive" });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("inactive");
  });

  it("admin: rotating secrets sets hasSecrets=true (secrets field never returned)", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
      secrets: { token: "old_token" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ secrets: { token: "new_rotated_token" } });

    expect(res.status).toBe(200);
    assertNoSecrets(res.body);
    expect(res.body.hasSecrets).toBe(true);
  });

  it("admin: setting secrets=null removes them (hasSecrets=false)", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
      secrets: { token: "some_token" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ secrets: null });

    expect(res.status).toBe(200);
    expect(res.body.hasSecrets).toBe(false);
    assertNoSecrets(res.body);
  });

  it("admin: partial update preserves omitted fields", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "gitlab",
      name: "GitLab Original",
      config: { host: "https://gitlab.com" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ name: "GitLab Renamed" });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe("GitLab Renamed");
    expect(res.body.type).toBe("gitlab");
    expect(res.body.config).toBeDefined();
  });

  it("returns 400 when updated config violates the type-specific schema", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "kubernetes",
      name: "K8s",
      config: { server: "https://k8s.example.com" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ config: { server: "not-a-valid-url" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("config");
  });

  it("returns 400 for invalid status value", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ status: "broken" });

    expect(res.status).toBe(400);
  });

  it("returns 404 for non-existent connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/nonexistent-id`)
      .send({ name: "New Name" });

    expect(res.status).toBe(404);
  });

  it("returns 404 when patching connection from different workspace", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "other-workspace",
      type: "github",
      name: "Other Conn",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ name: "Hijack Attempt" });

    expect(res.status).toBe(404);
  });

  it("maintainer (member): gets 403 — cannot update connections", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ name: "Attempt Update" });

    expect(res.status).toBe(403);
  });

  it("viewer: gets 403 — no access to update", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(VIEWER_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ name: "Attempt" });

    expect(res.status).toBe(403);
  });

  it("updated response never contains secret values", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({
        name: "Updated GitHub",
        secrets: { token: "ghp_abcdefg12345" },
      });

    expect(res.status).toBe(200);
    assertNoSecrets(res.body);
  });
});

// ─── DELETE — DELETE /api/workspaces/:id/connections/:cid ────────────────────

describe("DELETE /api/workspaces/:id/connections/:cid", () => {
  it("admin: deletes a connection and returns 204", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "To Delete",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(204);
  });

  it("admin: connection is no longer accessible after deletion", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "Gone",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);

    const getRes = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(getRes.status).toBe(404);
  });

  it("returns 404 for non-existent connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/no-such-id`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting connection from different workspace", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "other-workspace",
      type: "github",
      name: "Other Conn",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(404);
  });

  it("maintainer (member): gets 403 — cannot delete connections", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(403);
  });

  it("viewer: gets 403 — no access to delete", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(VIEWER_USER, storage);
    const res = await request(app).delete(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(res.status).toBe(403);
  });
});

// ─── TEST — POST /api/workspaces/:id/connections/:cid/test ───────────────────

describe("POST /api/workspaces/:id/connections/:cid/test", () => {
  it("admin: returns { ok, latencyMs, details } for existing connection", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub Test",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);

    expect(res.status).toBe(200);
    expect(typeof res.body.ok).toBe("boolean");
    expect(typeof res.body.latencyMs).toBe("number");
    expect(res.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof res.body.details).toBe("string");
  });

  it("test endpoint never returns secret data", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub Secret Test",
      config: { host: "https://api.github.com", owner: "acme" },
      secrets: { token: "ghp_absolutelysecret" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);

    expect(res.status).toBe(200);
    assertNoSecrets(res.body);
  });

  it("test updates lastTestedAt (only metadata side-effect allowed)", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "gitlab",
      name: "GitLab Test",
      config: { host: "https://gitlab.com" },
    });

    expect(conn.lastTestedAt).toBeNull();

    const app = createApp(ADMIN_USER, storage);
    await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);

    // Verify lastTestedAt was set
    const updated = await storage.getWorkspaceConnection(conn.id);
    expect(updated?.lastTestedAt).not.toBeNull();
  });

  it("returns 200 with ok=false for AWS (no public probe URL)", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "aws",
      name: "AWS Test",
      config: { region: "us-east-1" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);

    // AWS has no probe URL — returns ok=false with a descriptive details message
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.details).toContain("aws");
  });

  it("returns 404 for non-existent connection", async () => {
    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/no-such-id/test`);
    expect(res.status).toBe(404);
  });

  it("returns 404 when testing connection from different workspace", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "other-workspace",
      type: "github",
      name: "Other Conn",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(ADMIN_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);
    expect(res.status).toBe(404);
  });

  it("maintainer (member): gets 403 — cannot run connectivity test", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(MAINTAINER_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);
    expect(res.status).toBe(403);
  });

  it("viewer: gets 403 — no access to test endpoint", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "GitHub",
      config: { host: "https://api.github.com", owner: "acme" },
    });

    const app = createApp(VIEWER_USER, storage);
    const res = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);
    expect(res.status).toBe(403);
  });
});

// ─── Secret redaction: comprehensive cross-endpoint check ────────────────────

describe("Secret redaction invariants", () => {
  it("secrets never appear across any endpoint for a connection with secrets", async () => {
    const SECRET_VALUE = "ghp_topsecretvalue_shouldneverappear";

    const conn = await storage.createWorkspaceConnection({
      workspaceId: WORKSPACE_ID,
      type: "github",
      name: "Full Secret Check",
      config: { host: "https://api.github.com", owner: "acme" },
      secrets: { token: SECRET_VALUE },
    });

    const app = createApp(ADMIN_USER, storage);

    // List
    const listRes = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections`);
    expect(JSON.stringify(listRes.body)).not.toContain(SECRET_VALUE);

    // Read single
    const getRes = await request(app).get(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`);
    expect(JSON.stringify(getRes.body)).not.toContain(SECRET_VALUE);

    // Update (with secret rotation)
    const patchRes = await request(app)
      .patch(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}`)
      .send({ secrets: { token: "new_token_value" } });
    expect(JSON.stringify(patchRes.body)).not.toContain(SECRET_VALUE);
    expect(JSON.stringify(patchRes.body)).not.toContain("new_token_value");

    // Test endpoint
    const testRes = await request(app).post(`/api/workspaces/${WORKSPACE_ID}/connections/${conn.id}/test`);
    expect(JSON.stringify(testRes.body)).not.toContain(SECRET_VALUE);
  });

  it("hasSecrets flag correctly reflects secret presence", async () => {
    const app = createApp(ADMIN_USER, storage);

    // Create without secrets
    const noSecretsRes = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({ type: "github", name: "No Secrets", config: { host: "https://api.github.com", owner: "acme" } });

    expect(noSecretsRes.status).toBe(201);
    expect(noSecretsRes.body.hasSecrets).toBe(false);

    // Create with secrets
    const withSecretsRes = await request(app)
      .post(`/api/workspaces/${WORKSPACE_ID}/connections`)
      .send({
        type: "github",
        name: "With Secrets",
        config: { host: "https://api.github.com", owner: "acme" },
        secrets: { token: "ghp_test" },
      });

    expect(withSecretsRes.status).toBe(201);
    expect(withSecretsRes.body.hasSecrets).toBe(true);
  });
});

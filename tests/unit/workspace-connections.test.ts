import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import {
  GitLabConnectionConfigSchema,
  GitHubConnectionConfigSchema,
  KubernetesConnectionConfigSchema,
  AwsConnectionConfigSchema,
  JiraConnectionConfigSchema,
  GrafanaConnectionConfigSchema,
  GenericMcpConnectionConfigSchema,
  validateConnectionConfig,
  CONNECTION_TYPES,
} from "../../shared/schema";
import type { ConnectionType, WorkspaceConnection, CreateWorkspaceConnectionInput } from "../../shared/types";
import { MemStorage } from "../../server/storage";

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeFakeStorage(): InstanceType<typeof MemStorage> {
  return new MemStorage();
}

function makeCreateInput(
  overrides: Partial<CreateWorkspaceConnectionInput> = {},
): CreateWorkspaceConnectionInput {
  return {
    workspaceId: "ws-test-1",
    type: "github",
    name: "My GitHub Connection",
    config: { host: "https://api.github.com", owner: "acme" },
    ...overrides,
  };
}

// ── Zod Schema Validation ─────────────────────────────────────────────────────

describe("GitLabConnectionConfigSchema", () => {
  it("accepts valid config with defaults", () => {
    const result = GitLabConnectionConfigSchema.parse({ host: "https://gitlab.com", owner: "acme" });
    expect(result.host).toBe("https://gitlab.com");
    expect(result.apiVersion).toBe("v4");
  });

  it("accepts custom host", () => {
    const result = GitLabConnectionConfigSchema.parse({
      host: "https://gitlab.mycompany.com",
    });
    expect(result.host).toBe("https://gitlab.mycompany.com");
  });

  it("rejects invalid URL for host", () => {
    expect(() =>
      GitLabConnectionConfigSchema.parse({ host: "not-a-url" }),
    ).toThrow(z.ZodError);
  });

  it("defaults host to https://gitlab.com when omitted", () => {
    const result = GitLabConnectionConfigSchema.parse({});
    expect(result.host).toBe("https://gitlab.com");
  });
});

describe("GitHubConnectionConfigSchema", () => {
  it("accepts valid config", () => {
    const result = GitHubConnectionConfigSchema.parse({ owner: "acme", repo: "platform" });
    expect(result.owner).toBe("acme");
    expect(result.repo).toBe("platform");
  });

  it("rejects empty owner", () => {
    expect(() =>
      GitHubConnectionConfigSchema.parse({ owner: "" }),
    ).toThrow(z.ZodError);
  });

  it("accepts config without optional repo", () => {
    const result = GitHubConnectionConfigSchema.parse({ owner: "acme" });
    expect(result.owner).toBe("acme");
    expect(result.repo).toBeUndefined();
  });

  it("rejects invalid host URL", () => {
    expect(() =>
      GitHubConnectionConfigSchema.parse({ owner: "acme", host: "not-a-url-at-all" }),
    ).toThrow(z.ZodError);
  });
});

describe("KubernetesConnectionConfigSchema", () => {
  it("accepts valid config", () => {
    const result = KubernetesConnectionConfigSchema.parse({
      server: "https://k8s.example.com:6443",
    });
    expect(result.server).toBe("https://k8s.example.com:6443");
    expect(result.namespace).toBe("default");
    expect(result.insecureSkipTlsVerify).toBe(false);
  });

  it("rejects non-URL server", () => {
    expect(() =>
      KubernetesConnectionConfigSchema.parse({ server: "k8s-cluster" }),
    ).toThrow(z.ZodError);
  });

  it("accepts custom namespace", () => {
    const result = KubernetesConnectionConfigSchema.parse({
      server: "https://k8s.example.com",
      namespace: "production",
    });
    expect(result.namespace).toBe("production");
  });

  it("rejects missing server", () => {
    expect(() => KubernetesConnectionConfigSchema.parse({})).toThrow(z.ZodError);
  });
});

describe("AwsConnectionConfigSchema", () => {
  it("accepts valid config", () => {
    const result = AwsConnectionConfigSchema.parse({ region: "us-east-1" });
    expect(result.region).toBe("us-east-1");
  });

  it("rejects empty region", () => {
    expect(() => AwsConnectionConfigSchema.parse({ region: "" })).toThrow(z.ZodError);
  });

  it("accepts optional roleArn", () => {
    const result = AwsConnectionConfigSchema.parse({
      region: "eu-west-1",
      roleArn: "arn:aws:iam::123456789012:role/MyRole",
    });
    expect(result.roleArn).toBe("arn:aws:iam::123456789012:role/MyRole");
  });

  it("rejects missing region", () => {
    expect(() => AwsConnectionConfigSchema.parse({})).toThrow(z.ZodError);
  });
});

describe("JiraConnectionConfigSchema", () => {
  it("accepts valid config", () => {
    const result = JiraConnectionConfigSchema.parse({
      host: "https://mycompany.atlassian.net",
    });
    expect(result.host).toBe("https://mycompany.atlassian.net");
  });

  it("rejects non-URL host", () => {
    expect(() =>
      JiraConnectionConfigSchema.parse({ host: "mycompany.atlassian.net" }),
    ).toThrow(z.ZodError);
  });

  it("rejects invalid email", () => {
    expect(() =>
      JiraConnectionConfigSchema.parse({
        host: "https://mycompany.atlassian.net",
        email: "not-an-email",
      }),
    ).toThrow(z.ZodError);
  });

  it("accepts valid email", () => {
    const result = JiraConnectionConfigSchema.parse({
      host: "https://mycompany.atlassian.net",
      email: "user@company.com",
    });
    expect(result.email).toBe("user@company.com");
  });
});

describe("GrafanaConnectionConfigSchema", () => {
  it("accepts valid config with default orgId", () => {
    const result = GrafanaConnectionConfigSchema.parse({
      host: "https://grafana.example.com",
    });
    expect(result.orgId).toBe(1);
  });

  it("accepts custom orgId", () => {
    const result = GrafanaConnectionConfigSchema.parse({
      host: "https://grafana.example.com",
      orgId: 42,
    });
    expect(result.orgId).toBe(42);
  });

  it("rejects non-URL host", () => {
    expect(() =>
      GrafanaConnectionConfigSchema.parse({ host: "grafana.example.com" }),
    ).toThrow(z.ZodError);
  });
});

describe("GenericMcpConnectionConfigSchema", () => {
  it("accepts valid config with defaults", () => {
    const result = GenericMcpConnectionConfigSchema.parse({
      endpoint: "https://mcp.example.com/api",
    });
    expect(result.transport).toBe("sse");
  });

  it("accepts custom transport", () => {
    const result = GenericMcpConnectionConfigSchema.parse({
      endpoint: "https://mcp.example.com/api",
      transport: "streamable-http",
    });
    expect(result.transport).toBe("streamable-http");
  });

  it("rejects invalid transport", () => {
    expect(() =>
      GenericMcpConnectionConfigSchema.parse({
        endpoint: "https://mcp.example.com",
        transport: "ws",
      }),
    ).toThrow(z.ZodError);
  });

  it("rejects non-URL endpoint", () => {
    expect(() =>
      GenericMcpConnectionConfigSchema.parse({ endpoint: "not-a-url" }),
    ).toThrow(z.ZodError);
  });
});

// ── validateConnectionConfig dispatcher ─────────────────────────────────────

describe("validateConnectionConfig", () => {
  it("routes to GitLab schema", () => {
    const result = validateConnectionConfig("gitlab", {});
    expect(result).toHaveProperty("host");
  });

  it("routes to GitHub schema", () => {
    const result = validateConnectionConfig("github", { owner: "acme" });
    expect(result).toHaveProperty("owner", "acme");
  });

  it("routes to kubernetes schema", () => {
    const result = validateConnectionConfig("kubernetes", {
      server: "https://k8s.example.com",
    });
    expect(result).toHaveProperty("server");
  });

  it("routes to aws schema", () => {
    const result = validateConnectionConfig("aws", { region: "us-east-1" });
    expect(result).toHaveProperty("region", "us-east-1");
  });

  it("routes to jira schema", () => {
    const result = validateConnectionConfig("jira", {
      host: "https://company.atlassian.net",
    });
    expect(result).toHaveProperty("host");
  });

  it("routes to grafana schema", () => {
    const result = validateConnectionConfig("grafana", {
      host: "https://grafana.company.com",
    });
    expect(result).toHaveProperty("host");
  });

  it("routes to generic_mcp schema", () => {
    const result = validateConnectionConfig("generic_mcp", {
      endpoint: "https://mcp.company.com",
    });
    expect(result).toHaveProperty("endpoint");
  });

  it("throws ZodError for invalid config", () => {
    expect(() =>
      validateConnectionConfig("aws", { region: "" }),
    ).toThrow(z.ZodError);
  });

  it("covers all CONNECTION_TYPES", () => {
    // Every type in the const must map to a schema without throwing
    for (const t of CONNECTION_TYPES) {
      const config: Record<string, unknown> = {};
      if (t === "github") config.owner = "acme";
      if (t === "kubernetes") config.server = "https://k8s.example.com";
      if (t === "aws") config.region = "us-east-1";
      if (t === "jira") config.host = "https://jira.example.com";
      if (t === "grafana") config.host = "https://grafana.example.com";
      if (t === "generic_mcp") config.endpoint = "https://mcp.example.com";
      expect(() => validateConnectionConfig(t, config)).not.toThrow();
    }
  });
});

// ── MemStorage CRUD ───────────────────────────────────────────────────────────

describe("MemStorage: workspace connections CRUD", () => {
  let storage: InstanceType<typeof MemStorage>;

  beforeEach(() => {
    storage = makeFakeStorage();
  });

  it("creates a connection without secrets", async () => {
    const conn = await storage.createWorkspaceConnection(makeCreateInput());
    expect(conn.id).toBeTruthy();
    expect(conn.workspaceId).toBe("ws-test-1");
    expect(conn.type).toBe("github");
    expect(conn.name).toBe("My GitHub Connection");
    expect(conn.hasSecrets).toBe(false);
    expect(conn.status).toBe("active");
    expect(conn.createdAt).toBeInstanceOf(Date);
    expect(conn.updatedAt).toBeInstanceOf(Date);
  });

  it("creates a connection with secrets and hasSecrets=true", async () => {
    const conn = await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: { token: "ghp_supersecret" } }),
    );
    expect(conn.hasSecrets).toBe(true);
  });

  it("creates a connection with empty secrets object — hasSecrets=false", async () => {
    const conn = await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: {} }),
    );
    expect(conn.hasSecrets).toBe(false);
  });

  it("returns null for non-existent connection", async () => {
    const result = await storage.getWorkspaceConnection("non-existent-id");
    expect(result).toBeNull();
  });

  it("retrieves a connection by id", async () => {
    const created = await storage.createWorkspaceConnection(makeCreateInput());
    const found = await storage.getWorkspaceConnection(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
  });

  it("lists connections for a workspace", async () => {
    await storage.createWorkspaceConnection(makeCreateInput({ name: "Conn 1" }));
    await storage.createWorkspaceConnection(makeCreateInput({ name: "Conn 2" }));
    await storage.createWorkspaceConnection(
      makeCreateInput({ workspaceId: "ws-other", name: "Other workspace" }),
    );

    const list = await storage.getWorkspaceConnections("ws-test-1");
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.name)).toContain("Conn 1");
    expect(list.map((c) => c.name)).toContain("Conn 2");
  });

  it("returns empty array for unknown workspace", async () => {
    const list = await storage.getWorkspaceConnections("ws-unknown");
    expect(list).toHaveLength(0);
  });

  it("updates connection name and config", async () => {
    const created = await storage.createWorkspaceConnection(makeCreateInput());
    const updated = await storage.updateWorkspaceConnection(created.id, {
      name: "Updated Name",
      config: { host: "https://api.github.com", owner: "neworg" },
    });
    expect(updated.name).toBe("Updated Name");
    expect((updated.config as { owner: string }).owner).toBe("neworg");
    expect(updated.updatedAt.getTime()).toBeGreaterThanOrEqual(created.updatedAt.getTime());
  });

  it("updates secrets sets hasSecrets=true", async () => {
    const created = await storage.createWorkspaceConnection(makeCreateInput());
    expect(created.hasSecrets).toBe(false);
    const updated = await storage.updateWorkspaceConnection(created.id, {
      secrets: { token: "new-token" },
    });
    expect(updated.hasSecrets).toBe(true);
  });

  it("removing secrets (null) sets hasSecrets=false", async () => {
    const created = await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: { token: "old-token" } }),
    );
    expect(created.hasSecrets).toBe(true);
    const updated = await storage.updateWorkspaceConnection(created.id, {
      secrets: null,
    });
    expect(updated.hasSecrets).toBe(false);
  });

  it("throws when updating non-existent connection", async () => {
    await expect(
      storage.updateWorkspaceConnection("bad-id", { name: "X" }),
    ).rejects.toThrow("WorkspaceConnection not found: bad-id");
  });

  it("deletes a connection", async () => {
    const created = await storage.createWorkspaceConnection(makeCreateInput());
    await storage.deleteWorkspaceConnection(created.id);
    const found = await storage.getWorkspaceConnection(created.id);
    expect(found).toBeNull();
  });

  it("deletes silently for non-existent id (no throw)", async () => {
    await expect(storage.deleteWorkspaceConnection("non-existent")).resolves.toBeUndefined();
  });

  it("testWorkspaceConnection updates lastTestedAt", async () => {
    const created = await storage.createWorkspaceConnection(makeCreateInput());
    expect(created.lastTestedAt).toBeNull();
    const tested = await storage.testWorkspaceConnection(created.id);
    expect(tested.lastTestedAt).toBeInstanceOf(Date);
  });

  it("throws when testing non-existent connection", async () => {
    await expect(storage.testWorkspaceConnection("bad-id")).rejects.toThrow(
      "WorkspaceConnection not found: bad-id",
    );
  });
});

// ── Secret redaction invariants ────────────────────────────────────────────

describe("MemStorage: secrets are never in public connection shape", () => {
  let storage: InstanceType<typeof MemStorage>;

  beforeEach(() => {
    storage = makeFakeStorage();
  });

  it("WorkspaceConnection type has no secrets field", async () => {
    const conn = await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: { token: "top-secret", password: "hunter2" } }),
    );
    // The returned object must not contain any secret values
    const serialized = JSON.stringify(conn);
    expect(serialized).not.toContain("top-secret");
    expect(serialized).not.toContain("hunter2");
    expect(serialized).not.toContain("token");
  });

  it("hasSecrets flag is true without exposing the value", async () => {
    const conn = await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: { apiKey: "sk-secret-key" } }),
    );
    expect(conn.hasSecrets).toBe(true);
    expect(JSON.stringify(conn)).not.toContain("sk-secret-key");
    expect(JSON.stringify(conn)).not.toContain("apiKey");
  });

  it("listed connections do not expose secrets", async () => {
    await storage.createWorkspaceConnection(
      makeCreateInput({ secrets: { accessToken: "sensitive-value" } }),
    );
    const list = await storage.getWorkspaceConnections("ws-test-1");
    const listStr = JSON.stringify(list);
    expect(listStr).not.toContain("sensitive-value");
    expect(listStr).not.toContain("accessToken");
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("WorkspaceConnection edge cases", () => {
  let storage: InstanceType<typeof MemStorage>;

  beforeEach(() => {
    storage = makeFakeStorage();
  });

  it("null secrets input stores no secrets", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "ws-1",
      type: "aws",
      name: "AWS Production",
      config: { region: "us-east-1" },
      secrets: undefined,
    });
    expect(conn.hasSecrets).toBe(false);
  });

  it("empty config object is accepted", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "ws-1",
      type: "gitlab",
      name: "GitLab (no config)",
      config: {},
    });
    expect(conn.config).toEqual({});
  });

  it("all supported connection types are creatable", async () => {
    const types: ConnectionType[] = [
      "gitlab", "github", "kubernetes", "aws", "jira", "grafana", "generic_mcp",
    ];
    for (const type of types) {
      const conn = await storage.createWorkspaceConnection({
        workspaceId: "ws-1",
        type,
        name: `Test ${type}`,
        config: { placeholder: true },
      });
      expect(conn.type).toBe(type);
    }
  });

  it("createdBy is preserved", async () => {
    const conn = await storage.createWorkspaceConnection({
      workspaceId: "ws-1",
      type: "github",
      name: "Test",
      config: { owner: "acme" },
      createdBy: "user-abc",
    });
    expect(conn.createdBy).toBe("user-abc");
  });

  it("createdBy defaults to null when not provided", async () => {
    const conn = await storage.createWorkspaceConnection(makeCreateInput());
    expect(conn.createdBy).toBeNull();
  });

  it("status defaults to active", async () => {
    const conn = await storage.createWorkspaceConnection(makeCreateInput());
    expect(conn.status).toBe("active");
  });

  it("updates status to error", async () => {
    const conn = await storage.createWorkspaceConnection(makeCreateInput());
    const updated = await storage.updateWorkspaceConnection(conn.id, { status: "error" });
    expect(updated.status).toBe("error");
  });
});

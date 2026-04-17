/**
 * Tests for declarative YAML connections config (issue #276)
 *
 * Coverage:
 *   - YAML parsing: valid, invalid, missing file
 *   - Schema: version enforcement, unknown types, empty connections
 *   - Secret reference resolution: ${env:…}, ${file:…}, ${vault:…} stub
 *   - Plaintext secret rejection (hard error)
 *   - Reconciliation diff: create, update, delete, unchanged
 *   - Drift detection: UI-modified connections flagged
 *   - Plan application: creates/updates/deletes in storage
 *   - High-level sync: autoApply flag, missing YAML
 *   - CLI validation helper: valid YAML, schema errors, plaintext secrets
 *   - Edge cases: empty YAML, missing env var, path traversal in file ref
 */

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { MemStorage } from "../../server/storage";
import {
  loadConnectionsYaml,
  resolveSecretRef,
  resolveConnectionSecrets,
  detectPlaintextSecret,
  buildReconcilePlan,
  buildReconcilePlanWithDeletes,
  detectDrift,
  applyReconcilePlan,
  syncConnectionsFromYaml,
  validateConnectionsYaml,
  CONNECTIONS_YAML_PATH,
} from "../../server/workspace/connections-yaml";
import type {
  YamlConnection,
  ReconcilePlan,
} from "../../server/workspace/connections-yaml";
import type { CreateWorkspaceConnectionInput } from "../../shared/types";
import { ConnectionsYamlFileSchema, YamlConnectionEntrySchema, ConnectionSecretRefSchema } from "../../shared/schema";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStorage(): InstanceType<typeof MemStorage> {
  return new MemStorage();
}

function makeConnInput(
  overrides: Partial<CreateWorkspaceConnectionInput> = {},
): CreateWorkspaceConnectionInput {
  return {
    workspaceId: "ws-1",
    type: "gitlab",
    name: "main-gitlab",
    config: { host: "https://gitlab.example.com", apiVersion: "v4" },
    ...overrides,
  };
}

function makeYamlConn(overrides: Partial<YamlConnection> = {}): YamlConnection {
  return {
    name: "main-gitlab",
    type: "gitlab",
    config: { host: "https://gitlab.example.com" },
    ...overrides,
  };
}

/** Write a temporary YAML file. Returns the temp dir path. */
async function writeTempYaml(content: string, subPath = CONNECTIONS_YAML_PATH): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multiqlti-test-"));
  const fullPath = path.join(dir, subPath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, "utf-8");
  return dir;
}

// ─── shared/schema Zod export tests ──────────────────────────────────────────

describe("ConnectionSecretRefSchema", () => {
  it("accepts ${env:VAR_NAME}", () => {
    expect(() => ConnectionSecretRefSchema.parse("${env:GITLAB_TOKEN}")).not.toThrow();
  });

  it("accepts ${file:./path}", () => {
    expect(() => ConnectionSecretRefSchema.parse("${file:./kubeconfig.yaml}")).not.toThrow();
  });

  it("accepts ${vault:secret/path}", () => {
    expect(() => ConnectionSecretRefSchema.parse("${vault:secret/data/token}")).not.toThrow();
  });

  it("rejects a plain string", () => {
    expect(() => ConnectionSecretRefSchema.parse("glpat-abc123")).toThrow();
  });

  it("rejects empty string", () => {
    expect(() => ConnectionSecretRefSchema.parse("")).toThrow();
  });

  it("rejects a token-looking value", () => {
    expect(() => ConnectionSecretRefSchema.parse("ghp_AAAAAAAAAAAAAAAA")).toThrow();
  });
});

describe("YamlConnectionEntrySchema", () => {
  it("accepts valid connection entry", () => {
    const result = YamlConnectionEntrySchema.safeParse({
      name: "my-gitlab",
      type: "gitlab",
      config: { host: "https://gitlab.com" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects unknown connection type", () => {
    const result = YamlConnectionEntrySchema.safeParse({
      name: "test",
      type: "unknown_type",
      config: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects plaintext secret in secrets block", () => {
    const result = YamlConnectionEntrySchema.safeParse({
      name: "test",
      type: "gitlab",
      config: {},
      secrets: { token: "glpat-supersecrettoken" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts secret reference in secrets block", () => {
    const result = YamlConnectionEntrySchema.safeParse({
      name: "test",
      type: "gitlab",
      config: {},
      secrets: { token: "${env:GITLAB_TOKEN}" },
    });
    expect(result.success).toBe(true);
  });
});

describe("ConnectionsYamlFileSchema", () => {
  it("requires version: 1", () => {
    const result = ConnectionsYamlFileSchema.safeParse({
      version: 2,
      connections: [],
    });
    expect(result.success).toBe(false);
  });

  it("defaults connections to empty array", () => {
    const result = ConnectionsYamlFileSchema.safeParse({ version: 1 });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.connections).toEqual([]);
    }
  });
});

// ─── loadConnectionsYaml ─────────────────────────────────────────────────────

describe("loadConnectionsYaml", () => {
  it("returns null when file does not exist", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "multiqlti-test-"));
    const result = await loadConnectionsYaml(dir);
    await fs.rm(dir, { recursive: true });
    expect(result).toBeNull();
  });

  it("parses a valid YAML file", async () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config:
      host: https://gitlab.example.com
    secrets:
      token: \${env:GITLAB_TOKEN}
`;
    const dir = await writeTempYaml(yaml);
    const result = await loadConnectionsYaml(dir);
    await fs.rm(dir, { recursive: true });

    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.connections).toHaveLength(1);
    expect(result!.connections[0].name).toBe("main-gitlab");
    expect(result!.connections[0].secrets?.token).toBe("${env:GITLAB_TOKEN}");
  });

  it("throws on invalid YAML syntax", async () => {
    const dir = await writeTempYaml("version: 1\nconnections:\n  - name: [invalid");
    await expect(loadConnectionsYaml(dir)).rejects.toThrow();
    await fs.rm(dir, { recursive: true });
  });

  it("throws on wrong schema version", async () => {
    const dir = await writeTempYaml("version: 2\nconnections: []");
    await expect(loadConnectionsYaml(dir)).rejects.toThrow(/validation failed/);
    await fs.rm(dir, { recursive: true });
  });

  it("throws when a connection has a plaintext secret", async () => {
    const yaml = `
version: 1
connections:
  - name: bad-conn
    type: gitlab
    config: {}
    secrets:
      token: glpat-supersecrettoken123456
`;
    const dir = await writeTempYaml(yaml);
    await expect(loadConnectionsYaml(dir)).rejects.toThrow(/Plaintext secrets are not allowed/);
    await fs.rm(dir, { recursive: true });
  });

  it("parses empty connections list", async () => {
    const dir = await writeTempYaml("version: 1\nconnections: []");
    const result = await loadConnectionsYaml(dir);
    await fs.rm(dir, { recursive: true });
    expect(result!.connections).toHaveLength(0);
  });

  it("throws on unknown connection type", async () => {
    const yaml = `
version: 1
connections:
  - name: bad
    type: ftp
    config: {}
`;
    const dir = await writeTempYaml(yaml);
    await expect(loadConnectionsYaml(dir)).rejects.toThrow(/validation failed/);
    await fs.rm(dir, { recursive: true });
  });
});

// ─── resolveSecretRef ─────────────────────────────────────────────────────────

describe("resolveSecretRef", () => {
  it("resolves ${env:VAR} from process.env", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    vi.stubEnv("TEST_SECRET_VAR_276", "my-secret-value");
    const result = await resolveSecretRef("${env:TEST_SECRET_VAR_276}", tmpDir);
    vi.unstubAllEnvs();
    await fs.rm(tmpDir, { recursive: true });
    expect(result).toBe("my-secret-value");
  });

  it("throws when env var is not set", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    vi.stubEnv("UNSET_VAR_276", undefined as unknown as string);
    // delete from env to ensure it's unset
    delete process.env["UNSET_VAR_276"];
    await expect(resolveSecretRef("${env:UNSET_VAR_276}", tmpDir)).rejects.toThrow(
      /Environment variable "UNSET_VAR_276" is not set/,
    );
    await fs.rm(tmpDir, { recursive: true });
  });

  it("resolves ${file:./path} from workspace file", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await fs.writeFile(path.join(tmpDir, "kubeconfig.yaml"), "apiVersion: v1\n", "utf-8");
    const result = await resolveSecretRef("${file:./kubeconfig.yaml}", tmpDir);
    await fs.rm(tmpDir, { recursive: true });
    expect(result).toBe("apiVersion: v1");
  });

  it("throws when file does not exist", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await expect(
      resolveSecretRef("${file:./missing-file.yaml}", tmpDir),
    ).rejects.toThrow(/Secret file not found/);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws on path traversal in file ref", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await expect(
      resolveSecretRef("${file:../../etc/passwd}", tmpDir),
    ).rejects.toThrow(/escape the workspace root/);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws a stub error for ${vault:…}", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await expect(
      resolveSecretRef("${vault:secret/data/token}", tmpDir),
    ).rejects.toThrow(/not yet implemented/);
    await fs.rm(tmpDir, { recursive: true });
  });

  it("throws on an invalid reference format", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await expect(
      resolveSecretRef("plain-string", tmpDir),
    ).rejects.toThrow(/Invalid secret reference format/);
    await fs.rm(tmpDir, { recursive: true });
  });
});

// ─── resolveConnectionSecrets ─────────────────────────────────────────────────

describe("resolveConnectionSecrets", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("resolves all valid refs successfully", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    vi.stubEnv("MY_TOKEN_276", "token-value");
    const result = await resolveConnectionSecrets(
      "test-conn",
      { token: "${env:MY_TOKEN_276}" },
      tmpDir,
    );
    await fs.rm(tmpDir, { recursive: true });
    expect(result.errors).toHaveLength(0);
    expect(result.secrets.token).toBe("token-value");
  });

  it("collects errors for missing env vars without throwing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    delete process.env["MISSING_VAR_276"];
    const result = await resolveConnectionSecrets(
      "test-conn",
      { token: "${env:MISSING_VAR_276}", apiKey: "${env:MISSING_VAR_276}" },
      tmpDir,
    );
    await fs.rm(tmpDir, { recursive: true });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].secretKey).toBe("token");
  });

  it("returns empty secrets and no errors for empty refs", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await resolveConnectionSecrets("conn", {}, tmpDir);
    await fs.rm(tmpDir, { recursive: true });
    expect(result.secrets).toEqual({});
    expect(result.errors).toHaveLength(0);
  });
});

// ─── detectPlaintextSecret ────────────────────────────────────────────────────

describe("detectPlaintextSecret", () => {
  it("returns null for YAML with no secrets block", () => {
    const yaml = `version: 1\nconnections:\n  - name: a\n    type: gitlab\n    config: {}`;
    expect(detectPlaintextSecret(yaml)).toBeNull();
  });

  it("returns null for YAML with reference secrets", () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config: {}
    secrets:
      token: \${env:GITLAB_TOKEN}
`;
    expect(detectPlaintextSecret(yaml)).toBeNull();
  });

  it("detects a GitLab PAT-looking plaintext secret", () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config: {}
    secrets:
      token: glpat-supersecretaccesstoken
`;
    const result = detectPlaintextSecret(yaml);
    expect(result).not.toBeNull();
    expect(result).toContain("glpat-");
  });

  it("detects a GitHub PAT-looking plaintext secret", () => {
    const yaml = `
version: 1
connections:
  - name: github-conn
    type: github
    config: {}
    secrets:
      token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAA
`;
    const result = detectPlaintextSecret(yaml);
    expect(result).not.toBeNull();
  });
});

// ─── buildReconcilePlan ───────────────────────────────────────────────────────

describe("buildReconcilePlan", () => {
  it("plans create for connection in YAML but not in DB", async () => {
    const storage = makeStorage();
    const yamlConns: YamlConnection[] = [makeYamlConn()];
    const plan = buildReconcilePlan(yamlConns, []);

    expect(plan.hasChanges).toBe(true);
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0].type).toBe("create");
    expect(plan.actions[0].connectionName).toBe("main-gitlab");
  });

  it("plans update when config differs", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://old.example.com", apiVersion: "v4" } }),
    );

    const yamlConns: YamlConnection[] = [
      makeYamlConn({ config: { host: "https://new.example.com" } }),
    ];

    const plan = buildReconcilePlan(yamlConns, [conn]);
    expect(plan.actions[0].type).toBe("update");
    expect(plan.hasChanges).toBe(true);
  });

  it("plans unchanged when config is identical", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    );

    const yamlConns: YamlConnection[] = [
      makeYamlConn({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    ];

    const plan = buildReconcilePlan(yamlConns, [conn]);
    expect(plan.actions[0].type).toBe("unchanged");
    expect(plan.hasChanges).toBe(false);
  });

  it("does not add delete actions by default", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput({ name: "old-conn" }));

    const plan = buildReconcilePlan([], [conn]);
    // Default plan does not delete — caller must use buildReconcilePlanWithDeletes
    expect(plan.actions.filter((a) => a.type === "delete")).toHaveLength(0);
  });

  it("handles empty YAML and empty DB", () => {
    const plan = buildReconcilePlan([], []);
    expect(plan.hasChanges).toBe(false);
    expect(plan.actions).toHaveLength(0);
  });

  it("handles multiple connections mixed create/update/unchanged", async () => {
    const storage = makeStorage();
    // existing: gitlab (unchanged) + github (needs update)
    const existing1 = await storage.createWorkspaceConnection(
      makeConnInput({ name: "gitlab-conn", config: { host: "https://gitlab.com", apiVersion: "v4" } }),
    );
    const existing2 = await storage.createWorkspaceConnection(
      makeConnInput({ name: "github-conn", type: "github", config: { host: "https://api.github.com", owner: "old-org" } }),
    );

    const yamlConns: YamlConnection[] = [
      { name: "gitlab-conn", type: "gitlab", config: { host: "https://gitlab.com", apiVersion: "v4" } },
      { name: "github-conn", type: "github", config: { host: "https://api.github.com", owner: "new-org" } },
      { name: "k8s-conn", type: "kubernetes", config: { server: "https://k8s.example.com" } },
    ];

    const plan = buildReconcilePlan(yamlConns, [existing1, existing2]);
    expect(plan.actions).toHaveLength(3);

    const types = new Map(plan.actions.map((a) => [a.connectionName, a.type]));
    expect(types.get("gitlab-conn")).toBe("unchanged");
    expect(types.get("github-conn")).toBe("update");
    expect(types.get("k8s-conn")).toBe("create");
  });
});

// ─── buildReconcilePlanWithDeletes ────────────────────────────────────────────

describe("buildReconcilePlanWithDeletes", () => {
  it("plans delete for connection in DB but not in YAML", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput({ name: "old-conn" }));

    const plan = buildReconcilePlanWithDeletes([], [conn]);
    expect(plan.hasChanges).toBe(true);
    const deleteAction = plan.actions.find((a) => a.type === "delete");
    expect(deleteAction).toBeDefined();
    expect(deleteAction!.connectionName).toBe("old-conn");
  });
});

// ─── detectDrift ─────────────────────────────────────────────────────────────

describe("detectDrift", () => {
  it("returns empty array when no connections", () => {
    expect(detectDrift([], [])).toHaveLength(0);
  });

  it("returns empty array when YAML and DB match", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    );

    const yamlConns: YamlConnection[] = [
      makeYamlConn({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    ];

    const drift = detectDrift(yamlConns, [conn]);
    expect(drift).toHaveLength(0);
  });

  it("detects config key drift", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://gitlab.example.com", apiVersion: "v4", modified: "ui-value" } }),
    );

    const yamlConns: YamlConnection[] = [
      makeYamlConn({ config: { host: "https://gitlab.example.com" } }),
    ];

    const drift = detectDrift(yamlConns, [conn]);
    expect(drift).toHaveLength(1);
    expect(drift[0].connectionName).toBe("main-gitlab");
    expect(drift[0].driftedConfigKeys).toContain("modified");
  });

  it("detects type change as drift", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput({ type: "github" }));

    const yamlConns: YamlConnection[] = [
      makeYamlConn({ type: "gitlab" }),
    ];

    const drift = detectDrift(yamlConns, [conn]);
    expect(drift).toHaveLength(1);
    expect(drift[0].driftedConfigKeys).toContain("type");
  });

  it("does not flag connections absent from YAML as drift", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(makeConnInput({ name: "other-conn" }));

    const drift = detectDrift([], [conn]);
    expect(drift).toHaveLength(0);
  });
});

// ─── applyReconcilePlan ───────────────────────────────────────────────────────

describe("applyReconcilePlan", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("creates new connections from plan", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));

    const plan: ReconcilePlan = {
      hasChanges: true,
      actions: [
        {
          type: "create",
          connectionName: "new-conn",
          yamlEntry: {
            name: "new-conn",
            type: "gitlab",
            config: { host: "https://gitlab.com", apiVersion: "v4" },
          },
          reason: "New connection",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.created).toContain("new-conn");
    expect(result.errors).toHaveLength(0);

    const connections = await storage.getWorkspaceConnections("ws-1");
    expect(connections.some((c) => c.name === "new-conn")).toBe(true);
  });

  it("creates connection with resolved env secret", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    vi.stubEnv("GITLAB_TOKEN_TEST_276", "my-actual-token");

    const plan: ReconcilePlan = {
      hasChanges: true,
      actions: [
        {
          type: "create",
          connectionName: "gitlab-conn",
          yamlEntry: {
            name: "gitlab-conn",
            type: "gitlab",
            config: { host: "https://gitlab.com", apiVersion: "v4" },
            secrets: { token: "${env:GITLAB_TOKEN_TEST_276}" },
          },
          reason: "Create",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.created).toContain("gitlab-conn");
    expect(result.errors).toHaveLength(0);
  });

  it("collects errors when secret resolution fails", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    delete process.env["MISSING_SECRET_276"];

    const plan: ReconcilePlan = {
      hasChanges: true,
      actions: [
        {
          type: "create",
          connectionName: "failing-conn",
          yamlEntry: {
            name: "failing-conn",
            type: "gitlab",
            config: { host: "https://gitlab.com", apiVersion: "v4" },
            secrets: { token: "${env:MISSING_SECRET_276}" },
          },
          reason: "Create",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].connectionName).toBe("failing-conn");
    expect(result.created).not.toContain("failing-conn");
  });

  it("updates existing connections from plan", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://old.gitlab.com", apiVersion: "v4" } }),
    );

    const plan: ReconcilePlan = {
      hasChanges: true,
      actions: [
        {
          type: "update",
          connectionName: "main-gitlab",
          yamlEntry: makeYamlConn({ config: { host: "https://new.gitlab.com", apiVersion: "v4" } }),
          existing: conn,
          reason: "Config changed",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.updated).toContain("main-gitlab");
    const updated = await storage.getWorkspaceConnection(conn.id);
    expect((updated!.config as Record<string, unknown>).host).toBe("https://new.gitlab.com");
  });

  it("deletes connections from plan", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const conn = await storage.createWorkspaceConnection(makeConnInput());

    const plan: ReconcilePlan = {
      hasChanges: true,
      actions: [
        {
          type: "delete",
          connectionName: "main-gitlab",
          existing: conn,
          reason: "Removed from YAML",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.deleted).toContain("main-gitlab");
    const remaining = await storage.getWorkspaceConnections("ws-1");
    expect(remaining.find((c) => c.id === conn.id)).toBeUndefined();
  });

  it("skips unchanged actions", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const conn = await storage.createWorkspaceConnection(makeConnInput());

    const plan: ReconcilePlan = {
      hasChanges: false,
      actions: [
        {
          type: "unchanged",
          connectionName: "main-gitlab",
          yamlEntry: makeYamlConn(),
          existing: conn,
          reason: "No changes",
        },
      ],
    };

    const result = await applyReconcilePlan(plan, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

// ─── syncConnectionsFromYaml ─────────────────────────────────────────────────

describe("syncConnectionsFromYaml", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns yamlMissing=true when file is absent", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.yamlMissing).toBe(true);
    expect(result.applied).toBe(false);
  });

  it("returns plan without applying when autoApply=false", async () => {
    const storage = makeStorage();
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config:
      host: https://gitlab.example.com
      apiVersion: v4
`;
    const tmpDir = await writeTempYaml(yaml);

    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage, { autoApply: false });
    await fs.rm(tmpDir, { recursive: true });

    expect(result.yamlMissing).toBe(false);
    expect(result.applied).toBe(false);
    expect(result.plan.hasChanges).toBe(true);
    expect(result.plan.actions[0].type).toBe("create");
  });

  it("applies plan when autoApply=true", async () => {
    const storage = makeStorage();
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config:
      host: https://gitlab.example.com
      apiVersion: v4
`;
    const tmpDir = await writeTempYaml(yaml);

    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage, { autoApply: true });
    await fs.rm(tmpDir, { recursive: true });

    expect(result.applied).toBe(true);
    expect(result.applyResult?.created).toContain("main-gitlab");
    const connections = await storage.getWorkspaceConnections("ws-1");
    expect(connections.some((c) => c.name === "main-gitlab")).toBe(true);
  });

  it("reports drift for UI-modified connections", async () => {
    const storage = makeStorage();
    // Create connection via storage (simulating a past YAML apply)
    await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://gitlab.example.com", apiVersion: "v4", uiExtra: "ui-added" } }),
    );

    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config:
      host: https://gitlab.example.com
      apiVersion: v4
`;
    const tmpDir = await writeTempYaml(yaml);

    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });

    expect(result.drift).toHaveLength(1);
    expect(result.drift[0].connectionName).toBe("main-gitlab");
    expect(result.drift[0].driftedConfigKeys).toContain("uiExtra");
  });

  it("does not include deletes by default", async () => {
    const storage = makeStorage();
    await storage.createWorkspaceConnection(makeConnInput({ name: "legacy-conn" }));

    const yaml = `version: 1\nconnections: []`;
    const tmpDir = await writeTempYaml(yaml);

    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage, { autoApply: true });
    await fs.rm(tmpDir, { recursive: true });

    // No plan changes means autoApply skips apply — applyResult is absent
    expect(result.applyResult).toBeUndefined();
    const remaining = await storage.getWorkspaceConnections("ws-1");
    expect(remaining.some((c) => c.name === "legacy-conn")).toBe(true);
  });

  it("includes deletes when includeDeletes=true", async () => {
    const storage = makeStorage();
    await storage.createWorkspaceConnection(makeConnInput({ name: "legacy-conn" }));

    const yaml = `version: 1\nconnections: []`;
    const tmpDir = await writeTempYaml(yaml);

    const result = await syncConnectionsFromYaml("ws-1", tmpDir, storage, {
      autoApply: true,
      includeDeletes: true,
    });
    await fs.rm(tmpDir, { recursive: true });

    expect(result.applyResult?.deleted).toContain("legacy-conn");
    const remaining = await storage.getWorkspaceConnections("ws-1");
    expect(remaining.find((c) => c.name === "legacy-conn")).toBeUndefined();
  });
});

// ─── validateConnectionsYaml (CLI linter) ────────────────────────────────────

describe("validateConnectionsYaml", () => {
  it("returns valid=true for correct YAML", () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config:
      host: https://gitlab.example.com
    secrets:
      token: \${env:GITLAB_TOKEN}
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
    expect(result.connectionCount).toBe(1);
  });

  it("returns valid=true for empty connections", () => {
    const result = validateConnectionsYaml("version: 1\nconnections: []");
    expect(result.valid).toBe(true);
    expect(result.connectionCount).toBe(0);
  });

  it("returns valid=false for invalid YAML syntax", () => {
    const result = validateConnectionsYaml("version: 1\nconnections:\n  - name: [unterminated");
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("YAML parse error"))).toBe(true);
  });

  it("returns valid=false for wrong version", () => {
    const result = validateConnectionsYaml("version: 2\nconnections: []");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("returns valid=false for unknown connection type", () => {
    const yaml = `
version: 1
connections:
  - name: ftp-conn
    type: ftp
    config: {}
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(false);
  });

  it("returns valid=false for plaintext secret", () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config: {}
    secrets:
      token: glpat-supersecrettoken
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Potential plaintext secret"))).toBe(true);
  });

  it("returns warning for vault refs (not yet implemented)", () => {
    const yaml = `
version: 1
connections:
  - name: main-gitlab
    type: gitlab
    config: {}
    secrets:
      token: \${vault:secret/data/gitlab-token}
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(true);
    expect(result.warnings.some((w) => w.includes("vault references are not yet implemented"))).toBe(true);
  });

  it("handles multiple connections", () => {
    const yaml = `
version: 1
connections:
  - name: gitlab-conn
    type: gitlab
    config:
      host: https://gitlab.com
  - name: k8s-conn
    type: kubernetes
    config:
      server: https://k8s.example.com
  - name: github-conn
    type: github
    config:
      host: https://api.github.com
      owner: myorg
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(true);
    expect(result.connectionCount).toBe(3);
  });

  it("reports multiple errors at once", () => {
    const yaml = `
version: 1
connections:
  - name: ""
    type: ftp
    config: {}
`;
    const result = validateConnectionsYaml(yaml);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("handles YAML with no top-level keys gracefully", async () => {
    const dir = await writeTempYaml("{}");
    await expect(loadConnectionsYaml(dir)).rejects.toThrow(/validation failed/);
    await fs.rm(dir, { recursive: true });
  });

  it("handles YAML null document", async () => {
    const dir = await writeTempYaml("~\n");
    await expect(loadConnectionsYaml(dir)).rejects.toThrow(/validation failed/);
    await fs.rm(dir, { recursive: true });
  });

  it("resolveSecretRef trims file content", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    await fs.writeFile(path.join(tmpDir, "token.txt"), "  my-token-value  \n", "utf-8");
    const result = await resolveSecretRef("${file:./token.txt}", tmpDir);
    await fs.rm(tmpDir, { recursive: true });
    expect(result).toBe("my-token-value");
  });

  it("plan with all unchanged actions has hasChanges=false", async () => {
    const storage = makeStorage();
    const conn = await storage.createWorkspaceConnection(
      makeConnInput({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    );
    const yamlConns: YamlConnection[] = [
      makeYamlConn({ config: { host: "https://gitlab.example.com", apiVersion: "v4" } }),
    ];
    const plan = buildReconcilePlan(yamlConns, [conn]);
    expect(plan.hasChanges).toBe(false);
  });

  it("applyReconcilePlan handles empty plan gracefully", async () => {
    const storage = makeStorage();
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "test-"));
    const result = await applyReconcilePlan({ actions: [], hasChanges: false }, "ws-1", tmpDir, storage);
    await fs.rm(tmpDir, { recursive: true });
    expect(result.created).toHaveLength(0);
    expect(result.updated).toHaveLength(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});

/**
 * Tests for shared/config-sync/schemas.ts (issue #313)
 *
 * Coverage:
 *   - Round-trip serialisation: valid entity → JSON → re-parse → deep-equal
 *   - Unknown field rejection (strict mode)
 *   - Missing required field rejection
 *   - apiVersion format validation (must be semver)
 *   - Discriminated union: correct kind dispatching, wrong kind rejection
 *   - Per-entity: all required fields, optional defaults, nested validation
 *   - ProviderKeyConfigEntity: secretRef accepts valid refs, rejects plaintext
 *   - TriggerConfigEntity: all four trigger sub-types validated correctly
 */

import { describe, it, expect } from "vitest";
import yaml from "js-yaml";
import {
  PipelineConfigEntitySchema,
  TriggerConfigEntitySchema,
  PromptConfigEntitySchema,
  SkillStateConfigEntitySchema,
  ConnectionConfigEntitySchema,
  ProviderKeyConfigEntitySchema,
  PreferencesConfigEntitySchema,
  ConfigEntitySchema,
  isPipelineEntity,
  isTriggerEntity,
  isPromptEntity,
  isSkillStateEntity,
  isConnectionEntity,
  isProviderKeyEntity,
  isPreferencesEntity,
} from "../../../shared/config-sync/schemas.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Round-trip: parse `input` through `schema`, serialise to JSON, re-parse.
 * Asserts the final value deep-equals what the schema returned on first parse.
 */
function roundTrip<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
  const first = schema.parse(input);
  const json = JSON.stringify(first);
  const second = schema.parse(JSON.parse(json));
  expect(second).toEqual(first);
  return second;
}

/**
 * Round-trip via YAML serialisation (simulates what the config-sync CLI does).
 */
function yamlRoundTrip<T>(schema: { parse: (v: unknown) => T }, input: unknown): T {
  const first = schema.parse(input);
  const yamlStr = yaml.dump(first);
  const second = schema.parse(yaml.load(yamlStr));
  expect(second).toEqual(first);
  return second;
}

// ─── Shared: apiVersion format ────────────────────────────────────────────────

describe("apiVersion validation", () => {
  it("accepts valid semver strings", () => {
    const valid = ["1.0.0", "0.1.2", "2.3.1-beta.1", "10.0.0+build.42"];
    for (const v of valid) {
      expect(() =>
        PipelineConfigEntitySchema.parse({
          kind: "pipeline",
          apiVersion: v,
          name: "test",
          stages: [],
        }),
      ).not.toThrow();
    }
  });

  it("rejects non-semver apiVersion", () => {
    const invalid = ["v1", "1.0", "latest", "1.0.0.0"];
    for (const v of invalid) {
      expect(() =>
        PipelineConfigEntitySchema.parse({
          kind: "pipeline",
          apiVersion: v,
          name: "test",
          stages: [],
        }),
      ).toThrow();
    }
  });
});

// ─── Unknown field rejection ───────────────────────────────────────────────────

describe("unknown field rejection (strict mode)", () => {
  it("rejects extra fields on pipeline", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        kind: "pipeline",
        apiVersion: "1.0.0",
        name: "test",
        stages: [],
        unexpectedField: "should cause error",
      }),
    ).toThrow();
  });

  it("rejects extra fields on preferences", () => {
    expect(() =>
      PreferencesConfigEntitySchema.parse({
        kind: "preferences",
        apiVersion: "1.0.0",
        scope: "global",
        ui: { theme: "dark", layout: "default", featureFlags: {} },
        extra: {},
        hackerField: true,
      }),
    ).toThrow();
  });

  it("rejects extra fields on pipeline stage", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        kind: "pipeline",
        apiVersion: "1.0.0",
        name: "test",
        stages: [
          {
            teamId: "code_review",
            modelSlug: "claude-sonnet-4-6",
            enabled: true,
            unknownProp: "bad",
          },
        ],
      }),
    ).toThrow();
  });
});

// ─── pipeline ─────────────────────────────────────────────────────────────────

describe("PipelineConfigEntitySchema", () => {
  const minimal = {
    kind: "pipeline" as const,
    apiVersion: "1.0.0",
    name: "my-pipeline",
    stages: [],
  };

  it("parses minimal valid pipeline", () => {
    const result = PipelineConfigEntitySchema.parse(minimal);
    expect(result.kind).toBe("pipeline");
    expect(result.name).toBe("my-pipeline");
    expect(result.stages).toHaveLength(0);
    expect(result.isTemplate).toBe(false); // default
  });

  it("round-trips via JSON", () => {
    roundTrip(PipelineConfigEntitySchema, minimal);
  });

  it("round-trips via YAML", () => {
    const full = {
      ...minimal,
      description: "A test pipeline",
      isTemplate: true,
      stages: [
        {
          teamId: "architecture",
          modelSlug: "claude-sonnet-4-6",
          enabled: true,
          temperature: 0.3,
          maxTokens: 4096,
          approvalRequired: false,
        },
      ],
    };
    yamlRoundTrip(PipelineConfigEntitySchema, full);
  });

  it("rejects missing name", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({ ...minimal, name: undefined }),
    ).toThrow();
  });

  it("rejects empty name", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({ ...minimal, name: "" }),
    ).toThrow();
  });

  it("rejects invalid executionStrategy in stage", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        ...minimal,
        stages: [
          {
            teamId: "code_review",
            modelSlug: "claude-sonnet-4-6",
            enabled: true,
            executionStrategy: "magic_mode",
          },
        ],
      }),
    ).toThrow();
  });

  it("parses stage with all optional fields", () => {
    const result = PipelineConfigEntitySchema.parse({
      ...minimal,
      stages: [
        {
          teamId: "code_review",
          modelSlug: "claude-sonnet-4-6",
          enabled: true,
          temperature: 0.7,
          maxTokens: 2048,
          approvalRequired: true,
          systemPromptOverride: "Custom prompt",
          executionStrategy: "single",
          skillId: "skill-123",
          delegationEnabled: false,
          allowedConnections: ["github-main"],
        },
      ],
    });
    expect(result.stages[0].allowedConnections).toEqual(["github-main"]);
  });

  it("defaults stage enabled to true", () => {
    const result = PipelineConfigEntitySchema.parse({
      ...minimal,
      stages: [
        { teamId: "architecture", modelSlug: "claude-sonnet-4-6" },
      ],
    });
    expect(result.stages[0].enabled).toBe(true);
  });

  it("parses pipeline with DAG", () => {
    const result = PipelineConfigEntitySchema.parse({
      ...minimal,
      dag: {
        stages: [
          {
            id: "stage-1",
            teamId: "architecture",
            modelSlug: "claude-sonnet-4-6",
            enabled: true,
            position: { x: 0, y: 0 },
          },
        ],
        edges: [
          {
            id: "edge-1",
            from: "stage-1",
            to: "stage-2",
            condition: {
              field: "output.status",
              operator: "eq",
              value: "ok",
            },
          },
        ],
      },
    });
    expect(result.dag?.stages).toHaveLength(1);
    expect(result.dag?.edges[0].condition?.operator).toBe("eq");
  });
});

// ─── trigger ──────────────────────────────────────────────────────────────────

describe("TriggerConfigEntitySchema", () => {
  it("parses schedule trigger", () => {
    const result = TriggerConfigEntitySchema.parse({
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      enabled: true,
      config: {
        type: "schedule",
        cron: "0 9 * * 1-5",
        timezone: "UTC",
      },
    });
    expect(result.config.type).toBe("schedule");
    if (result.config.type === "schedule") {
      expect(result.config.cron).toBe("0 9 * * 1-5");
    }
  });

  it("parses webhook trigger", () => {
    const result = TriggerConfigEntitySchema.parse({
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      config: { type: "webhook" },
    });
    expect(result.config.type).toBe("webhook");
  });

  it("parses github_event trigger", () => {
    const result = TriggerConfigEntitySchema.parse({
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      config: {
        type: "github_event",
        repository: "my-org/my-repo",
        events: ["push", "pull_request"],
      },
    });
    if (result.config.type === "github_event") {
      expect(result.config.repository).toBe("my-org/my-repo");
      expect(result.config.events).toContain("push");
    }
  });

  it("parses file_change trigger", () => {
    const result = TriggerConfigEntitySchema.parse({
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      config: {
        type: "file_change",
        watchPath: "/workspace/src",
        patterns: ["**/*.ts"],
        debounceMs: 500,
      },
    });
    if (result.config.type === "file_change") {
      expect(result.config.patterns).toHaveLength(1);
    }
  });

  it("rejects invalid github repository format", () => {
    expect(() =>
      TriggerConfigEntitySchema.parse({
        kind: "trigger",
        apiVersion: "1.0.0",
        pipelineRef: "my-pipeline",
        config: {
          type: "github_event",
          repository: "not-slash-format",
          events: ["push"],
        },
      }),
    ).toThrow();
  });

  it("rejects github_event with empty events array", () => {
    expect(() =>
      TriggerConfigEntitySchema.parse({
        kind: "trigger",
        apiVersion: "1.0.0",
        pipelineRef: "my-pipeline",
        config: {
          type: "github_event",
          repository: "org/repo",
          events: [],
        },
      }),
    ).toThrow();
  });

  it("round-trips schedule trigger via JSON", () => {
    roundTrip(TriggerConfigEntitySchema, {
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      config: { type: "schedule", cron: "0 0 * * *" },
    });
  });

  it("round-trips all trigger types via YAML", () => {
    const types = [
      { type: "schedule" as const, cron: "0 0 * * *" },
      { type: "webhook" as const },
      { type: "github_event" as const, repository: "a/b", events: ["push"] },
      { type: "file_change" as const, watchPath: "/x", patterns: ["**"] },
    ];
    for (const config of types) {
      yamlRoundTrip(TriggerConfigEntitySchema, {
        kind: "trigger",
        apiVersion: "1.0.0",
        pipelineRef: "my-pipeline",
        config,
      });
    }
  });
});

// ─── prompt ───────────────────────────────────────────────────────────────────

describe("PromptConfigEntitySchema", () => {
  const minimal = {
    kind: "prompt" as const,
    apiVersion: "1.0.0",
    name: "security-review",
  };

  it("parses minimal prompt", () => {
    const result = PromptConfigEntitySchema.parse(minimal);
    expect(result.stageOverrides).toHaveLength(0);
    expect(result.tags).toHaveLength(0);
  });

  it("parses prompt with all fields", () => {
    const result = PromptConfigEntitySchema.parse({
      ...minimal,
      description: "For security reviews",
      defaultPrompt: "You are a security expert.",
      stageOverrides: [
        { teamId: "code_review", systemPrompt: "Focus on OWASP Top 10." },
      ],
      tags: ["security", "owasp"],
    });
    expect(result.stageOverrides).toHaveLength(1);
    expect(result.tags).toContain("security");
  });

  it("round-trips via YAML", () => {
    yamlRoundTrip(PromptConfigEntitySchema, {
      ...minimal,
      stageOverrides: [{ teamId: "architecture", systemPrompt: "You are an architect." }],
      tags: ["architecture"],
    });
  });

  it("rejects missing name", () => {
    expect(() =>
      PromptConfigEntitySchema.parse({ ...minimal, name: "" }),
    ).toThrow();
  });
});

// ─── skill-state ──────────────────────────────────────────────────────────────

describe("SkillStateConfigEntitySchema", () => {
  const minimal = {
    kind: "skill-state" as const,
    apiVersion: "1.0.0",
    generatedAt: "2025-01-01T00:00:00.000Z",
    skills: [],
  };

  it("parses empty skill list", () => {
    const result = SkillStateConfigEntitySchema.parse(minimal);
    expect(result.skills).toHaveLength(0);
  });

  it("parses skill with all fields", () => {
    const result = SkillStateConfigEntitySchema.parse({
      ...minimal,
      skills: [
        {
          id: "skill-1",
          name: "TypeScript Reviewer",
          version: "2.0.0",
          source: "builtin",
          autoUpdate: false,
          installedAt: "2025-01-01T00:00:00.000Z",
        },
      ],
    });
    expect(result.skills[0].version).toBe("2.0.0");
  });

  it("rejects invalid skill source", () => {
    expect(() =>
      SkillStateConfigEntitySchema.parse({
        ...minimal,
        skills: [
          { id: "skill-1", name: "X", version: "1.0.0", source: "unknown_source" },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid skill version (non-semver)", () => {
    expect(() =>
      SkillStateConfigEntitySchema.parse({
        ...minimal,
        skills: [
          { id: "skill-1", name: "X", version: "v1.2", source: "builtin" },
        ],
      }),
    ).toThrow();
  });

  it("rejects invalid generatedAt (not ISO-8601)", () => {
    expect(() =>
      SkillStateConfigEntitySchema.parse({
        ...minimal,
        generatedAt: "not-a-date",
      }),
    ).toThrow();
  });

  it("round-trips via JSON", () => {
    roundTrip(SkillStateConfigEntitySchema, {
      ...minimal,
      skills: [
        { id: "skill-1", name: "X", version: "1.0.0", source: "market", autoUpdate: true },
      ],
    });
  });
});

// ─── connection ───────────────────────────────────────────────────────────────

describe("ConnectionConfigEntitySchema", () => {
  const minimal = {
    kind: "connection" as const,
    apiVersion: "1.0.0",
    name: "github-main",
    type: "github" as const,
    workspaceRef: "my-workspace",
    config: {},
  };

  it("parses minimal connection", () => {
    const result = ConnectionConfigEntitySchema.parse(minimal);
    expect(result.status).toBe("active"); // default
  });

  it("parses connection with config", () => {
    const result = ConnectionConfigEntitySchema.parse({
      ...minimal,
      config: { host: "https://api.github.com", owner: "my-org" },
    });
    expect(result.config).toHaveProperty("owner");
  });

  it("rejects unknown connection type", () => {
    expect(() =>
      ConnectionConfigEntitySchema.parse({ ...minimal, type: "slack" }),
    ).toThrow();
  });

  it("rejects missing workspaceRef", () => {
    expect(() =>
      ConnectionConfigEntitySchema.parse({ ...minimal, workspaceRef: "" }),
    ).toThrow();
  });

  it("round-trips via YAML", () => {
    yamlRoundTrip(ConnectionConfigEntitySchema, {
      ...minimal,
      type: "kubernetes",
      config: { server: "https://k8s.example.com", namespace: "prod" },
      status: "inactive",
    });
  });

  it("accepts all valid connection types", () => {
    const types = ["gitlab", "github", "kubernetes", "aws", "jira", "grafana", "generic_mcp"] as const;
    for (const type of types) {
      expect(() =>
        ConnectionConfigEntitySchema.parse({ ...minimal, type }),
      ).not.toThrow();
    }
  });
});

// ─── provider-key ─────────────────────────────────────────────────────────────

describe("ProviderKeyConfigEntitySchema", () => {
  const minimal = {
    kind: "provider-key" as const,
    apiVersion: "1.0.0",
    provider: "anthropic" as const,
    secretRef: "${env:ANTHROPIC_API_KEY}",
  };

  it("parses valid provider-key", () => {
    const result = ProviderKeyConfigEntitySchema.parse(minimal);
    expect(result.enabled).toBe(true); // default
  });

  it("accepts all valid secretRef forms", () => {
    const refs = [
      "${env:ANTHROPIC_API_KEY}",
      "${file:./secrets/key.txt}",
      "${vault:secret/myapp/api-key}",
    ];
    for (const secretRef of refs) {
      expect(() =>
        ProviderKeyConfigEntitySchema.parse({ ...minimal, secretRef }),
      ).not.toThrow();
    }
  });

  it("rejects plaintext API key", () => {
    expect(() =>
      ProviderKeyConfigEntitySchema.parse({
        ...minimal,
        secretRef: "sk-ant-abc123plaintext",
      }),
    ).toThrow();
  });

  it("rejects missing dollar-brace prefix", () => {
    expect(() =>
      ProviderKeyConfigEntitySchema.parse({
        ...minimal,
        secretRef: "env:MY_KEY",
      }),
    ).toThrow();
  });

  it("rejects unknown provider", () => {
    expect(() =>
      ProviderKeyConfigEntitySchema.parse({
        ...minimal,
        provider: "cohere",
      }),
    ).toThrow();
  });

  it("accepts all valid providers", () => {
    const providers = [
      "anthropic", "google", "openai", "xai", "mistral", "groq", "vllm", "ollama", "lmstudio",
    ] as const;
    for (const provider of providers) {
      expect(() =>
        ProviderKeyConfigEntitySchema.parse({ ...minimal, provider }),
      ).not.toThrow();
    }
  });

  it("round-trips via JSON", () => {
    roundTrip(ProviderKeyConfigEntitySchema, {
      ...minimal,
      description: "Production key",
      enabled: false,
    });
  });
});

// ─── preferences ──────────────────────────────────────────────────────────────

describe("PreferencesConfigEntitySchema", () => {
  const minimal = {
    kind: "preferences" as const,
    apiVersion: "1.0.0",
  };

  it("parses minimal preferences with all defaults", () => {
    const result = PreferencesConfigEntitySchema.parse(minimal);
    expect(result.scope).toBe("global");
    expect(result.ui.theme).toBe("system");
    expect(result.ui.layout).toBe("default");
    expect(result.ui.featureFlags).toEqual({});
    expect(result.extra).toEqual({});
  });

  it("parses user-scoped preferences", () => {
    const result = PreferencesConfigEntitySchema.parse({
      ...minimal,
      scope: "user",
      userId: "usr_abc123",
      ui: { theme: "dark", layout: "compact", featureFlags: { betaFeature: true } },
    });
    expect(result.scope).toBe("user");
    expect(result.userId).toBe("usr_abc123");
    expect(result.ui.featureFlags).toHaveProperty("betaFeature", true);
  });

  it("rejects invalid theme", () => {
    expect(() =>
      PreferencesConfigEntitySchema.parse({
        ...minimal,
        ui: { theme: "purple", layout: "default", featureFlags: {} },
      }),
    ).toThrow();
  });

  it("rejects invalid layout", () => {
    expect(() =>
      PreferencesConfigEntitySchema.parse({
        ...minimal,
        ui: { theme: "dark", layout: "fullscreen", featureFlags: {} },
      }),
    ).toThrow();
  });

  it("round-trips via YAML", () => {
    yamlRoundTrip(PreferencesConfigEntitySchema, {
      ...minimal,
      scope: "global",
      ui: { theme: "dark", layout: "wide", featureFlags: { featureA: true, featureB: false } },
      extra: { retentionDays: 30 },
    });
  });
});

// ─── ConfigEntity discriminated union ─────────────────────────────────────────

describe("ConfigEntitySchema (discriminated union)", () => {
  it("dispatches pipeline kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "test",
      stages: [],
    });
    expect(entity.kind).toBe("pipeline");
    expect(isPipelineEntity(entity)).toBe(true);
    expect(isTriggerEntity(entity)).toBe(false);
  });

  it("dispatches trigger kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "trigger",
      apiVersion: "1.0.0",
      pipelineRef: "my-pipeline",
      config: { type: "webhook" },
    });
    expect(isTriggerEntity(entity)).toBe(true);
    expect(isPipelineEntity(entity)).toBe(false);
  });

  it("dispatches prompt kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "prompt",
      apiVersion: "1.0.0",
      name: "test",
    });
    expect(isPromptEntity(entity)).toBe(true);
  });

  it("dispatches skill-state kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "skill-state",
      apiVersion: "1.0.0",
      generatedAt: "2025-01-01T00:00:00.000Z",
      skills: [],
    });
    expect(isSkillStateEntity(entity)).toBe(true);
  });

  it("dispatches connection kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "connection",
      apiVersion: "1.0.0",
      name: "my-conn",
      type: "github",
      workspaceRef: "ws-1",
      config: {},
    });
    expect(isConnectionEntity(entity)).toBe(true);
  });

  it("dispatches provider-key kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "provider-key",
      apiVersion: "1.0.0",
      provider: "anthropic",
      secretRef: "${env:ANTHROPIC_API_KEY}",
    });
    expect(isProviderKeyEntity(entity)).toBe(true);
  });

  it("dispatches preferences kind correctly", () => {
    const entity = ConfigEntitySchema.parse({
      kind: "preferences",
      apiVersion: "1.0.0",
    });
    expect(isPreferencesEntity(entity)).toBe(true);
  });

  it("rejects unknown kind", () => {
    expect(() =>
      ConfigEntitySchema.parse({
        kind: "unknown-entity",
        apiVersion: "1.0.0",
      }),
    ).toThrow();
  });

  it("rejects missing kind", () => {
    expect(() =>
      ConfigEntitySchema.parse({
        apiVersion: "1.0.0",
        name: "test",
      }),
    ).toThrow();
  });

  it("rejects wrong kind with correct schema shape", () => {
    // Provide a valid pipeline body but claim it's a trigger
    expect(() =>
      ConfigEntitySchema.parse({
        kind: "trigger",
        apiVersion: "1.0.0",
        name: "test",    // pipeline field, not valid for trigger
        stages: [],
      }),
    ).toThrow();
  });

  it("round-trips all entity kinds via JSON", () => {
    const entities = [
      { kind: "pipeline", apiVersion: "1.0.0", name: "p", stages: [] },
      { kind: "trigger", apiVersion: "1.0.0", pipelineRef: "p", config: { type: "webhook" } },
      { kind: "prompt", apiVersion: "1.0.0", name: "pr" },
      { kind: "skill-state", apiVersion: "1.0.0", generatedAt: "2025-01-01T00:00:00.000Z", skills: [] },
      { kind: "connection", apiVersion: "1.0.0", name: "c", type: "github", workspaceRef: "ws", config: {} },
      { kind: "provider-key", apiVersion: "1.0.0", provider: "anthropic", secretRef: "${env:KEY}" },
      { kind: "preferences", apiVersion: "1.0.0" },
    ];
    for (const entity of entities) {
      roundTrip(ConfigEntitySchema, entity);
    }
  });
});

// ─── Boundary / edge cases ────────────────────────────────────────────────────

describe("Edge cases", () => {
  it("rejects null input", () => {
    expect(() => ConfigEntitySchema.parse(null)).toThrow();
  });

  it("rejects empty object", () => {
    expect(() => ConfigEntitySchema.parse({})).toThrow();
  });

  it("rejects string input", () => {
    expect(() => ConfigEntitySchema.parse("pipeline")).toThrow();
  });

  it("rejects array input", () => {
    expect(() => ConfigEntitySchema.parse([])).toThrow();
  });

  it("pipeline: rejects stage temperature < 0", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        kind: "pipeline",
        apiVersion: "1.0.0",
        name: "test",
        stages: [
          { teamId: "architecture", modelSlug: "claude-sonnet-4-6", temperature: -0.1, enabled: true },
        ],
      }),
    ).toThrow();
  });

  it("pipeline: rejects stage temperature > 2", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        kind: "pipeline",
        apiVersion: "1.0.0",
        name: "test",
        stages: [
          { teamId: "architecture", modelSlug: "claude-sonnet-4-6", temperature: 2.1, enabled: true },
        ],
      }),
    ).toThrow();
  });

  it("pipeline: rejects negative maxTokens in stage", () => {
    expect(() =>
      PipelineConfigEntitySchema.parse({
        kind: "pipeline",
        apiVersion: "1.0.0",
        name: "test",
        stages: [
          { teamId: "architecture", modelSlug: "claude-sonnet-4-6", maxTokens: -1, enabled: true },
        ],
      }),
    ).toThrow();
  });

  it("skill-state: rejects skill installedAt with invalid datetime", () => {
    expect(() =>
      SkillStateConfigEntitySchema.parse({
        kind: "skill-state",
        apiVersion: "1.0.0",
        generatedAt: "2025-01-01T00:00:00.000Z",
        skills: [
          { id: "s1", name: "X", version: "1.0.0", source: "builtin", installedAt: "not-a-date" },
        ],
      }),
    ).toThrow();
  });
});

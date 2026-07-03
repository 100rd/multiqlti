/**
 * composition.test.ts — the read-only, computed "who does what" of a consilium
 * loop (Observability GAP 2). Covers the PURE helpers
 * (`parseConsiliumPreset` + `buildLoopComposition`) and the GET route SHAPE.
 *
 * The load-bearing property is SECURITY: the composition is a strict NAME/BOOLEAN
 * allowlist and must NEVER carry a secret (apiKey / encryption key / token), even
 * when those are populated in the config it reads. That is asserted directly by
 * planting secrets into the config and proving they do not surface.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import {
  buildLoopComposition,
  parseConsiliumPreset,
} from "../../../server/services/consilium/composition.js";
import { ConfigSchema, type AppConfig } from "../../../server/config/schema.js";
import type { IStorage } from "../../../server/storage.js";
import type { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import { registerConsiliumLoopRoutes } from "../../../server/routes/consilium-loops.js";

const baseConfig = (): AppConfig => ConfigSchema.parse({});

// ─── parseConsiliumPreset — recover the preset from the group NAME ────────────

describe("parseConsiliumPreset", () => {
  it("recovers each known preset from the factory group-name prefix", () => {
    expect(parseConsiliumPreset("[consilium-review:sdlc-cross-review] widget")).toBe(
      "sdlc-cross-review",
    );
    expect(parseConsiliumPreset("[consilium-review:diff-pr-review] some/repo")).toBe(
      "diff-pr-review",
    );
    expect(parseConsiliumPreset("[consilium-review:full-viability]")).toBe(
      "full-viability",
    );
  });

  it("returns null for an unknown preset, a non-matching name, or an absent name", () => {
    expect(parseConsiliumPreset("[consilium-review:not-a-preset] x")).toBeNull();
    expect(parseConsiliumPreset("just a plain group name")).toBeNull();
    expect(parseConsiliumPreset("")).toBeNull();
    expect(parseConsiliumPreset(null)).toBeNull();
    expect(parseConsiliumPreset(undefined)).toBeNull();
  });
});

// ─── buildLoopComposition — preset → roles/panel ─────────────────────────────

describe("buildLoopComposition — preset → panel roles", () => {
  it("maps the cross-review panel to debaters (Opus + Gemini) and an Opus judge", () => {
    const c = buildLoopComposition("sdlc-cross-review", baseConfig());
    expect(c.preset).toBe("sdlc-cross-review");
    expect(c.debaters).toHaveLength(2);
    expect(c.debaters.map((d) => d.label)).toEqual(["Opus", "Gemini"]);
    expect(c.debaters.map((d) => d.model)).toEqual(["claude-opus", "gemini-3-1-pro-high"]);
    expect(c.debaters.every((d) => d.role === "debater")).toBe(true);
    expect(c.judge.role).toBe("judge");
    expect(c.judge.model).toBe("claude-opus");
  });

  it("falls back to the canonical panel (and a null preset) for an unknown/absent preset", () => {
    const c = buildLoopComposition(null, baseConfig());
    // Every preset shares the 2-model panel today, so a null preset still yields
    // the correct debaters/judge — only the preset LABEL is omitted.
    expect(c.preset).toBeNull();
    expect(c.debaters.map((d) => d.model)).toEqual(["claude-opus", "gemini-3-1-pro-high"]);
    expect(c.judge.model).toBe("claude-opus");
  });

  it("exposes the downstream roles: planner, coder, verifier", () => {
    const c = buildLoopComposition("diff-pr-review", baseConfig());
    expect(c.planner.role).toBe("planner");
    expect(c.coder.role).toBe("coder");
    expect(c.verifier.role).toBe("verifier");
  });
});

// ─── buildLoopComposition — config → flags/models ────────────────────────────

describe("buildLoopComposition — config → flags & models", () => {
  it("reflects the SDLC coder mode: cli → local CLI (claude-opus), api → Anthropic API (no slug)", () => {
    const cli = buildLoopComposition(null, baseConfig()); // mode defaults to "cli"
    expect(cli.coder.tool).toBe("claude CLI (local)");
    expect(cli.coder.model).toBe("claude-opus");

    const api = buildLoopComposition(
      null,
      ConfigSchema.parse({ providers: { anthropic: { mode: "api" } } }),
    );
    expect(api.coder.tool).toBe("Anthropic API");
    expect(api.coder.model).toBeNull();
  });

  it("threads verification flags, commands, timeouts, planner + judge-retry from config", () => {
    const config = ConfigSchema.parse({
      pipeline: {
        consiliumLoop: {
          sdlcTimeoutMs: 900_000,
          planner: { enabled: true, model: "claude-sonnet" },
          judgeRetry: { enabled: true, fallbackModel: "gemini-3-1-pro-high" },
          implement: {
            enabled: true,
            testCommand: "npm test",
            lintCommand: "npm run lint",
            maxFixIterations: 5,
            testRunTimeoutMs: 600_000,
            verification: { enabled: true },
            trustedRepoAck: true,
            finalVerification: { enabled: true },
            perCriterionMethod: { enabled: true, judgeModel: "claude-opus" },
          },
        },
      },
    });
    const c = buildLoopComposition("full-viability", config);
    expect(c.verification.implementEnabled).toBe(true);
    expect(c.verification.perCriterionMethodEnabled).toBe(true);
    expect(c.verification.verificationEnabled).toBe(true);
    // verification.enabled AND trustedRepoAck ⇒ gate satisfied.
    expect(c.verification.effectiveVerificationEnabled).toBe(true);
    expect(c.verification.finalVerificationEnabled).toBe(true);
    expect(c.verification.testCommand).toBe("npm test");
    expect(c.verification.lintCommand).toBe("npm run lint");
    expect(c.verification.testRunTimeoutMs).toBe(600_000);
    expect(c.verification.sdlcTimeoutMs).toBe(900_000);
    expect(c.verification.maxFixIterations).toBe(5);
    expect(c.judgeRetry).toEqual({ enabled: true, fallbackModel: "gemini-3-1-pro-high" });
    expect(c.planner.model).toBe("claude-sonnet");
    expect(c.verifier.model).toBe("claude-opus");
    expect(c.verifier.enabled).toBe(true);
  });

  it("reports verification requested-but-gated-off (no sandbox / no trusted-repo ack)", () => {
    const config = ConfigSchema.parse({
      pipeline: {
        consiliumLoop: { implement: { verification: { enabled: true } } },
      },
    });
    const c = buildLoopComposition(null, config);
    expect(c.verification.verificationEnabled).toBe(true);
    // Requested but the sandbox/trusted-repo gate withholds it → degrades to 2a.
    expect(c.verification.effectiveVerificationEnabled).toBe(false);
  });
});

// ─── SECURITY: strict NAME/BOOLEAN allowlist — a secret can NEVER surface ─────

describe("buildLoopComposition — secret allowlist (never leaks a secret)", () => {
  const SECRETS = {
    anthropic: "sk-ant-SECRET-DO-NOT-LEAK",
    google: "GOOGLE-SECRET-DO-NOT-LEAK",
    xai: "XAI-SECRET-DO-NOT-LEAK",
    tavily: "TAVILY-SECRET-DO-NOT-LEAK",
  };

  const config = ConfigSchema.parse({
    providers: {
      anthropic: { mode: "api", apiKey: SECRETS.anthropic },
      google: { apiKey: SECRETS.google },
      xai: { apiKey: SECRETS.xai },
      tavily: { apiKey: SECRETS.tavily },
    },
  });

  it("carries none of the planted secret VALUES anywhere in the composition", () => {
    const serialized = JSON.stringify(buildLoopComposition("sdlc-cross-review", config));
    for (const secret of Object.values(SECRETS)) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("exposes no secret-NAMED key (apiKey / secret / token / password / key) at any depth", () => {
    const c = buildLoopComposition("sdlc-cross-review", config);
    const secretKey = /api[-_]?key|secret|token|password|(^|[^a-z])key([^a-z]|$)/i;
    const walk = (node: unknown, path: string): void => {
      if (node == null || typeof node !== "object") return;
      for (const [k, v] of Object.entries(node)) {
        expect(
          secretKey.test(k),
          `secret-named key "${k}" found at ${path}`,
        ).toBe(false);
        walk(v, `${path}.${k}`);
      }
    };
    walk(c, "composition");
  });
});

// ─── Route shape — GET /api/consilium-loops/:id merges `composition` ──────────

const LOOP_ID = "loop-1";
const OWNER = "user-1";
const LOOP = {
  id: LOOP_ID,
  groupId: "grp-1",
  state: "reviewing",
  round: 1,
  createdBy: OWNER,
  repoPath: "/repos/widget",
};

function makeApp(opts: { groupName?: string; hasGetTaskGroup?: boolean } = {}) {
  const { groupName = "[consilium-review:diff-pr-review] widget", hasGetTaskGroup = true } = opts;
  const controller = {
    getDevProgress: vi.fn(() => undefined),
  } as unknown as ConsiliumLoopController;

  const storage = {
    getLoop: vi.fn(async () => ({ ...LOOP })),
    getLoopRounds: vi.fn(async () => []),
    ...(hasGetTaskGroup
      ? { getTaskGroup: vi.fn(async () => ({ id: "grp-1", name: groupName })) }
      : {}),
  } as unknown as IStorage;

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { id: string } }).user = { id: OWNER };
    next();
  });
  registerConsiliumLoopRoutes(app, storage, controller, () => baseConfig());
  return app;
}

describe("GET /api/consilium-loops/:id — composition merge (route shape)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("merges a composition block with the preset recovered from the group name", async () => {
    const res = await request(makeApp()).get(`/api/consilium-loops/${LOOP_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.composition).toBeDefined();
    expect(res.body.composition.preset).toBe("diff-pr-review");
    expect(res.body.composition.debaters).toHaveLength(2);
    expect(res.body.composition.judge.model).toBe("claude-opus");
    expect(res.body.composition.verification).toBeDefined();
  });

  it("still returns a (null-preset) composition when storage lacks getTaskGroup", async () => {
    const res = await request(makeApp({ hasGetTaskGroup: false })).get(
      `/api/consilium-loops/${LOOP_ID}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.composition).toBeDefined();
    expect(res.body.composition.preset).toBeNull();
    expect(res.body.composition.debaters).toHaveLength(2);
  });

  it("never serializes a secret-named key in the route response composition", async () => {
    const res = await request(makeApp()).get(`/api/consilium-loops/${LOOP_ID}`);
    const serialized = JSON.stringify(res.body.composition);
    expect(serialized).not.toMatch(/apiKey|"key"|password|token/i);
  });
});

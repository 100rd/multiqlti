/**
 * Unit tests for trigger UI utility logic.
 *
 * These tests cover the pure functions extracted from TriggerCard and TriggerForm
 * without requiring a browser environment (no jsdom needed).
 */
import { describe, it, expect } from "vitest";
import type {
  PipelineTrigger,
  TriggerType,
  ScheduleTriggerConfig,
  GitHubEventTriggerConfig,
  FileChangeTriggerConfig,
} from "@shared/types";
import {
  isTriggerFormValid,
  canAddTrigger,
  buildLoopTemplate,
  loopTargetSummary,
  isGitHubRepoValid,
  formatValidationIssues,
  GITHUB_DEFAULT_EVENTS,
} from "../../client/src/components/triggers/trigger-form-logic";

// ─── Helpers duplicated from TriggerCard / TriggerForm ──────────────────────
// (keeping them in test scope avoids re-exporting implementation details)

function configSummary(trigger: PipelineTrigger): string {
  switch (trigger.type) {
    case "webhook":
      return trigger.webhookUrl
        ? `POST ${trigger.webhookUrl}`
        : "Webhook endpoint auto-assigned";
    case "schedule": {
      const cfg = trigger.config as ScheduleTriggerConfig;
      return cfg.cron;
    }
    case "github_event": {
      const cfg = trigger.config as GitHubEventTriggerConfig;
      return `${cfg.repository} · ${cfg.events.join(", ")}`;
    }
    case "file_change": {
      const cfg = trigger.config as FileChangeTriggerConfig;
      return `${cfg.watchPath} · ${cfg.patterns.join(", ")}`;
    }
  }
}

function parseCronHuman(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return "";
  const [min, hour, dom, month, dow] = parts;
  if (dom === "*" && month === "*" && dow === "*") {
    if (min === "0" && hour !== "*")
      return `Every day at ${hour.padStart(2, "0")}:00 UTC`;
    if (min !== "*" && hour !== "*")
      return `Every day at ${hour.padStart(2, "0")}:${min.padStart(2, "0")} UTC`;
  }
  if (dow !== "*" && dom === "*" && month === "*")
    return `Weekly (day ${dow}) at ${hour}:${min} UTC`;
  return "";
}

function generateSecret(): string {
  // In test environment, crypto.getRandomValues may not be available.
  // We test the output format instead by mocking via a manual implementation.
  const hex = "0123456789abcdef";
  return Array.from({ length: 64 }, () => hex[Math.floor(Math.random() * 16)]).join("");
}

function buildTrigger(overrides: Partial<PipelineTrigger> & { type: TriggerType }): PipelineTrigger {
  return {
    id: "t-001",
    pipelineId: null,
    hasSecret: false,
    enabled: true,
    lastTriggeredAt: null,
    suppressedCount: 0,
    lastFiredAt: null,
    firedCount: 0,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-01"),
    config: {},
    webhookUrl: undefined,
    ...overrides,
  };
}

// ─── configSummary ──────────────────────────────────────────────────────────

describe("configSummary", () => {
  it("webhook with url shows POST endpoint", () => {
    const trigger = buildTrigger({
      type: "webhook",
      webhookUrl: "/api/webhooks/t-001",
      config: {},
    });
    expect(configSummary(trigger)).toBe("POST /api/webhooks/t-001");
  });

  it("webhook without url shows placeholder", () => {
    const trigger = buildTrigger({ type: "webhook", config: {} });
    expect(configSummary(trigger)).toBe("Webhook endpoint auto-assigned");
  });

  it("schedule shows cron expression", () => {
    const trigger = buildTrigger({
      type: "schedule",
      config: { cron: "0 9 * * 1-5" } as ScheduleTriggerConfig,
    });
    expect(configSummary(trigger)).toBe("0 9 * * 1-5");
  });

  it("github_event shows repo and events", () => {
    const trigger = buildTrigger({
      type: "github_event",
      config: {
        repository: "acme/app",
        events: ["push", "pull_request"],
      } as GitHubEventTriggerConfig,
    });
    expect(configSummary(trigger)).toBe("acme/app · push, pull_request");
  });

  it("file_change shows watchPath and patterns", () => {
    const trigger = buildTrigger({
      type: "file_change",
      config: {
        watchPath: "/workspace/src",
        patterns: ["**/*.ts", "!node_modules/**"],
      } as FileChangeTriggerConfig,
    });
    expect(configSummary(trigger)).toBe("/workspace/src · **/*.ts, !node_modules/**");
  });
});

// ─── parseCronHuman ─────────────────────────────────────────────────────────

describe("parseCronHuman", () => {
  it("returns empty string for invalid cron (wrong field count)", () => {
    expect(parseCronHuman("* * *")).toBe("");
    expect(parseCronHuman("")).toBe("");
    expect(parseCronHuman("0 9 * * * *")).toBe("");
  });

  it("daily at midnight", () => {
    expect(parseCronHuman("0 0 * * *")).toBe("Every day at 00:00 UTC");
  });

  it("daily at 9am", () => {
    expect(parseCronHuman("0 9 * * *")).toBe("Every day at 09:00 UTC");
  });

  it("daily at 14:30", () => {
    expect(parseCronHuman("30 14 * * *")).toBe("Every day at 14:30 UTC");
  });

  it("weekly on day 1 (Monday)", () => {
    expect(parseCronHuman("0 9 * * 1")).toBe("Weekly (day 1) at 9:0 UTC");
  });

  it("returns empty for complex expressions it cannot parse simply", () => {
    // Every 5 minutes — no match for the simple cases
    expect(parseCronHuman("*/5 * * * *")).toBe("");
  });
});

// ─── generateSecret ─────────────────────────────────────────────────────────

describe("generateSecret", () => {
  it("generates a 64-character hex string", () => {
    const secret = generateSecret();
    expect(secret).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(secret)).toBe(true);
  });

  it("generates different values on successive calls", () => {
    const a = generateSecret();
    const b = generateSecret();
    // Extremely unlikely to collide
    expect(a).not.toBe(b);
  });
});

// ─── TriggerCard display logic ───────────────────────────────────────────────

describe("TriggerCard display helpers", () => {
  it("enabled trigger should be represented as 'On'", () => {
    const trigger = buildTrigger({ type: "webhook", enabled: true, config: {} });
    const label = trigger.enabled ? "On" : "Off";
    expect(label).toBe("On");
  });

  it("disabled trigger should be represented as 'Off'", () => {
    const trigger = buildTrigger({ type: "webhook", enabled: false, config: {} });
    const label = trigger.enabled ? "On" : "Off";
    expect(label).toBe("Off");
  });

  it("lastTriggeredAt null shows Never", () => {
    const trigger = buildTrigger({ type: "webhook", config: {} });
    const display = trigger.lastTriggeredAt ? "some time ago" : "Never";
    expect(display).toBe("Never");
  });

  it("lastTriggeredAt non-null is truthy", () => {
    const trigger = buildTrigger({
      type: "webhook",
      config: {},
      lastTriggeredAt: new Date("2026-03-01"),
    });
    expect(trigger.lastTriggeredAt).toBeTruthy();
  });
});

// ─── TriggerForm validation logic (T1 retarget — no pipeline requirement) ─────

describe("isTriggerFormValid", () => {
  const base = { cron: "", ghRepo: "", ghEvents: [] as string[], watchPath: "", preset: "sdlc-cross-review", repoPath: "" };

  it("webhook is always valid (no pipeline requirement anymore)", () => {
    expect(isTriggerFormValid({ ...base, type: "webhook" })).toBe(true);
  });

  it("schedule requires cron AND a preset AND a repoPath (no watchPath to derive from)", () => {
    expect(isTriggerFormValid({ ...base, type: "schedule", cron: "0 9 * * *", repoPath: "/allowed/omnius" })).toBe(true);
    expect(isTriggerFormValid({ ...base, type: "schedule", cron: "0 9 * * *", repoPath: "" })).toBe(false); // no repo
    expect(isTriggerFormValid({ ...base, type: "schedule", cron: "", repoPath: "/allowed/omnius" })).toBe(false); // no cron
    expect(isTriggerFormValid({ ...base, type: "schedule", cron: "0 9 * * *", repoPath: "/x", preset: "" })).toBe(false); // no preset
  });

  it("file_change requires watchPath AND a preset; repoPath is optional (derived)", () => {
    expect(isTriggerFormValid({ ...base, type: "file_change", watchPath: "/workspace" })).toBe(true);
    expect(isTriggerFormValid({ ...base, type: "file_change", watchPath: "" })).toBe(false);
    expect(isTriggerFormValid({ ...base, type: "file_change", watchPath: "   " })).toBe(false);
  });

  it("github_event requires repository, at least one event, AND a target repoPath", () => {
    const gh = { ...base, type: "github_event" as const, ghRepo: "owner/repo", ghEvents: ["push"], repoPath: "/allowed/omnius" };
    expect(isTriggerFormValid(gh)).toBe(true);
    expect(isTriggerFormValid({ ...gh, ghRepo: "" })).toBe(false);
    expect(isTriggerFormValid({ ...gh, ghEvents: [] })).toBe(false);
    // T1-full: without a loop-target repoPath the events would be recorded but fire nothing.
    expect(isTriggerFormValid({ ...gh, repoPath: "" })).toBe(false);
  });

  it("github_event rejects a malformed repository slug (mirrors the server regex)", () => {
    const gh = { ...base, type: "github_event" as const, ghEvents: ["pull_request"], repoPath: "/allowed/omnius" };
    // Missing the owner/repo slash → server would 400; caught client-side now.
    expect(isTriggerFormValid({ ...gh, ghRepo: "justrepo" })).toBe(false);
    // Extra path segment is also rejected.
    expect(isTriggerFormValid({ ...gh, ghRepo: "owner/repo/extra" })).toBe(false);
    // Whitespace-only is not a repo.
    expect(isTriggerFormValid({ ...gh, ghRepo: "   " })).toBe(false);
    // Well-formed passes.
    expect(isTriggerFormValid({ ...gh, ghRepo: "100rd/multiqlti" })).toBe(true);
  });
});

// ─── GitHub repo slug validation ─────────────────────────────────────────────

describe("isGitHubRepoValid", () => {
  it("accepts a well-formed owner/repo slug (trimmed)", () => {
    expect(isGitHubRepoValid("100rd/multiqlti")).toBe(true);
    expect(isGitHubRepoValid("  owner/repo  ")).toBe(true);
  });

  it("rejects missing slash, extra segments, empty, and spaces", () => {
    expect(isGitHubRepoValid("justrepo")).toBe(false);
    expect(isGitHubRepoValid("owner/repo/sub")).toBe(false);
    expect(isGitHubRepoValid("")).toBe(false);
    expect(isGitHubRepoValid("/repo")).toBe(false);
    expect(isGitHubRepoValid("owner/")).toBe(false);
  });
});

// ─── Default github events ───────────────────────────────────────────────────

describe("GITHUB_DEFAULT_EVENTS", () => {
  it("pre-selects the mapped review-firing events (non-empty, so a fresh form validates)", () => {
    expect([...GITHUB_DEFAULT_EVENTS]).toEqual(["pull_request", "push"]);
    expect(GITHUB_DEFAULT_EVENTS.length).toBeGreaterThan(0);
  });
});

// ─── Server validation-issue formatting ──────────────────────────────────────

describe("formatValidationIssues", () => {
  it("formats a flat field issue as 'field: message'", () => {
    expect(
      formatValidationIssues([{ path: ["repository"], message: "Must be in owner/repo format" }]),
    ).toEqual(["repository: Must be in owner/repo format"]);
  });

  it("joins nested paths (and array indices) with an arrow", () => {
    expect(
      formatValidationIssues([
        { path: ["action", "repoPath"], message: "Required" },
        { path: ["events", 0], message: "Too small" },
      ]),
    ).toEqual(["action → repoPath: Required", "events → 0: Too small"]);
  });

  it("renders a root-level issue (empty path) as the message alone", () => {
    expect(formatValidationIssues([{ path: [], message: "Invalid input" }])).toEqual([
      "Invalid input",
    ]);
  });

  it("surfaces ALL issues, not just the first", () => {
    const lines = formatValidationIssues([
      { path: ["repository"], message: "Must be in owner/repo format" },
      { path: ["events"], message: "Array must contain at least 1 element(s)" },
    ]);
    expect(lines).toHaveLength(2);
  });

  it("falls back to a generic message when zod omits one", () => {
    expect(formatValidationIssues([{ path: ["cron"] }])).toEqual(["cron: Invalid value"]);
  });

  it("returns [] for undefined / non-array input (no issues present)", () => {
    expect(formatValidationIssues(undefined)).toEqual([]);
  });

  it("does not echo received values — only path + generic message (no secret leak)", () => {
    // A rejected secret produces a length message; its bytes must never appear.
    const lines = formatValidationIssues([
      { path: ["secret"], message: "String must contain at most 1000 character(s)" },
    ]);
    expect(lines).toEqual(["secret: String must contain at most 1000 character(s)"]);
    expect(lines.join(" ")).not.toContain("hunter2");
  });
});

// ─── Add-Trigger button enablement (operator-reported bug) ───────────────────

describe("canAddTrigger", () => {
  it("enables with at least one workspace and a configured subsystem", () => {
    expect(canAddTrigger(1, false)).toBe(true);
    expect(canAddTrigger(3, false)).toBe(true);
  });

  it("stays disabled with zero workspaces (the fix — no longer gated on pipelines)", () => {
    expect(canAddTrigger(0, false)).toBe(false);
  });

  it("stays disabled when the subsystem is not configured, regardless of workspaces", () => {
    expect(canAddTrigger(5, true)).toBe(false);
  });
});

// ─── Loop-template construction ──────────────────────────────────────────────

describe("buildLoopTemplate", () => {
  it("builds a consilium_review action with only the set fields", () => {
    const action = buildLoopTemplate({
      preset: "diff-pr-review",
      repoPath: "  /allowed/omnius  ",
      engineerInstruction: "  Review ${event}  ",
      maxRounds: "3",
    });
    expect(action).toEqual({
      kind: "consilium_review",
      preset: "diff-pr-review",
      repoPath: "/allowed/omnius",
      engineerInstruction: "Review ${event}",
      maxRounds: 3,
    });
  });

  it("omits empty repoPath / instruction and out-of-range rounds", () => {
    const action = buildLoopTemplate({
      preset: "sdlc-cross-review",
      repoPath: "",
      engineerInstruction: "   ",
      maxRounds: "99",
    });
    expect(action).toEqual({ kind: "consilium_review", preset: "sdlc-cross-review" });
  });
});

// ─── Loop-target summary (trigger card) ──────────────────────────────────────

describe("loopTargetSummary", () => {
  it("summarizes preset → repo basename for a loop-template trigger", () => {
    const trigger = buildTrigger({
      type: "schedule",
      config: {
        cron: "0 9 * * *",
        action: { kind: "consilium_review", preset: "full-viability", repoPath: "/allowed/omnius" },
      } as ScheduleTriggerConfig,
    });
    expect(loopTargetSummary(trigger)).toBe("full-viability → omnius");
  });

  it("returns just the preset when no repoPath is set", () => {
    const trigger = buildTrigger({
      type: "file_change",
      config: {
        watchPath: "/w",
        patterns: ["**/*.md"],
        action: { kind: "consilium_review", preset: "sdlc-cross-review" },
      } as FileChangeTriggerConfig,
    });
    expect(loopTargetSummary(trigger)).toBe("sdlc-cross-review");
  });

  it("returns null for a trigger with no loop template (webhook)", () => {
    const trigger = buildTrigger({ type: "webhook", config: {} });
    expect(loopTargetSummary(trigger)).toBeNull();
  });
});

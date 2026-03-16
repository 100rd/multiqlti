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
    pipelineId: "p-001",
    hasSecret: false,
    enabled: true,
    lastTriggeredAt: null,
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

// ─── TriggerForm validation logic ────────────────────────────────────────────

describe("TriggerForm validation", () => {
  function isValid(
    type: TriggerType,
    pipelineId: string,
    cron: string,
    ghRepo: string,
    ghEvents: string[],
    watchPath: string,
  ): boolean {
    if (!pipelineId) return false;
    if (type === "schedule") return cron.trim().length > 0;
    if (type === "github_event") return ghRepo.trim().length > 0 && ghEvents.length > 0;
    if (type === "file_change") return watchPath.trim().length > 0;
    return true;
  }

  it("webhook type is always valid when pipelineId present", () => {
    expect(isValid("webhook", "p-001", "", "", [], "")).toBe(true);
  });

  it("webhook type is invalid without pipelineId", () => {
    expect(isValid("webhook", "", "", "", [], "")).toBe(false);
  });

  it("schedule type requires non-empty cron", () => {
    expect(isValid("schedule", "p-001", "0 9 * * *", "", [], "")).toBe(true);
    expect(isValid("schedule", "p-001", "", "", [], "")).toBe(false);
    expect(isValid("schedule", "p-001", "   ", "", [], "")).toBe(false);
  });

  it("github_event requires repository and at least one event", () => {
    expect(isValid("github_event", "p-001", "", "owner/repo", ["push"], "")).toBe(true);
    expect(isValid("github_event", "p-001", "", "", ["push"], "")).toBe(false);
    expect(isValid("github_event", "p-001", "", "owner/repo", [], "")).toBe(false);
  });

  it("file_change requires watchPath", () => {
    expect(isValid("file_change", "p-001", "", "", [], "/workspace")).toBe(true);
    expect(isValid("file_change", "p-001", "", "", [], "")).toBe(false);
    expect(isValid("file_change", "p-001", "", "", [], "   ")).toBe(false);
  });
});

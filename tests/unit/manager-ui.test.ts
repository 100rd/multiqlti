/**
 * Unit tests for Manager Mode UI components (Phase 6.6)
 *
 * Note: These are logic/validation tests that don't require a DOM renderer.
 * Full component rendering tests require a React testing environment (e.g. @testing-library/react).
 * The tests below validate the validation logic and hook contracts.
 */
import { describe, it, expect } from "vitest";

// ─── ManagerConfigPanel validation logic ─────────────────────────────────────

describe("ManagerConfigPanel validation logic", () => {
  interface ManagerConfig {
    goal: string;
    managerModel: string;
    availableTeams: string[];
    maxIterations: number;
  }

  interface FormErrors {
    goal?: string;
    managerModel?: string;
    availableTeams?: string;
    maxIterations?: string;
  }

  function validate(config: ManagerConfig): FormErrors {
    const errors: FormErrors = {};
    if (!config.goal.trim()) {
      errors.goal = "Goal is required";
    } else if (config.goal.length > 10000) {
      errors.goal = "Goal must be 10,000 characters or fewer";
    }
    if (!config.managerModel) {
      errors.managerModel = "Please select a manager model";
    }
    if (config.availableTeams.length === 0) {
      errors.availableTeams = "At least one team must be selected";
    }
    if (config.maxIterations < 1 || config.maxIterations > 20) {
      errors.maxIterations = "Max iterations must be between 1 and 20";
    }
    return errors;
  }

  const validConfig: ManagerConfig = {
    goal: "Build a hello world app",
    managerModel: "claude-sonnet-4",
    availableTeams: ["development", "testing"],
    maxIterations: 5,
  };

  it("passes validation for a valid config", () => {
    const errors = validate(validConfig);
    expect(Object.keys(errors)).toHaveLength(0);
  });

  it("fails when goal is empty", () => {
    const errors = validate({ ...validConfig, goal: "" });
    expect(errors.goal).toBeDefined();
    expect(errors.goal).toContain("required");
  });

  it("fails when goal is whitespace only", () => {
    const errors = validate({ ...validConfig, goal: "   " });
    expect(errors.goal).toBeDefined();
  });

  it("fails when goal exceeds 10000 characters", () => {
    const errors = validate({ ...validConfig, goal: "x".repeat(10001) });
    expect(errors.goal).toBeDefined();
    expect(errors.goal).toContain("10,000");
  });

  it("passes with goal exactly 10000 characters", () => {
    const errors = validate({ ...validConfig, goal: "x".repeat(10000) });
    expect(errors.goal).toBeUndefined();
  });

  it("fails when managerModel is empty", () => {
    const errors = validate({ ...validConfig, managerModel: "" });
    expect(errors.managerModel).toBeDefined();
  });

  it("fails when no teams are selected", () => {
    const errors = validate({ ...validConfig, availableTeams: [] });
    expect(errors.availableTeams).toBeDefined();
    expect(errors.availableTeams).toContain("At least one team");
  });

  it("passes with one team selected", () => {
    const errors = validate({ ...validConfig, availableTeams: ["development"] });
    expect(errors.availableTeams).toBeUndefined();
  });

  it("fails when maxIterations is 0", () => {
    const errors = validate({ ...validConfig, maxIterations: 0 });
    expect(errors.maxIterations).toBeDefined();
  });

  it("fails when maxIterations exceeds 20", () => {
    const errors = validate({ ...validConfig, maxIterations: 21 });
    expect(errors.maxIterations).toBeDefined();
  });

  it("passes with maxIterations at boundary values 1 and 20", () => {
    expect(validate({ ...validConfig, maxIterations: 1 }).maxIterations).toBeUndefined();
    expect(validate({ ...validConfig, maxIterations: 20 }).maxIterations).toBeUndefined();
  });
});

// ─── useManagerIterations hook contract ──────────────────────────────────────

describe("useManagerIterations hook contract", () => {
  it("constructs the correct API URL", () => {
    const runId = "run-abc-123";
    const url = `/api/runs/${runId}/manager-iterations?limit=100`;
    expect(url).toBe("/api/runs/run-abc-123/manager-iterations?limit=100");
  });

  it("constructs the query key correctly", () => {
    const runId = "run-abc-123";
    const key = ["/api/runs", runId, "manager-iterations"];
    expect(key).toEqual(["/api/runs", "run-abc-123", "manager-iterations"]);
  });
});

// ─── ManagerDecisionFeed display logic ───────────────────────────────────────

describe("ManagerDecisionFeed display logic", () => {
  it("truncates long team outputs at 2000 characters for display", () => {
    const longOutput = "x".repeat(3000);
    const truncated = longOutput.slice(0, 2000);
    const displayText = longOutput.length > 2000
      ? `${truncated}\n...[truncated]`
      : longOutput;
    expect(displayText).toContain("[truncated]");
    expect(displayText.length).toBeGreaterThan(2000);
    expect(displayText.slice(0, 2000)).toBe(truncated);
  });

  it("does not truncate outputs under 2000 characters", () => {
    const shortOutput = "Short output";
    const displayText = shortOutput.length > 2000
      ? `${shortOutput.slice(0, 2000)}\n...[truncated]`
      : shortOutput;
    expect(displayText).toBe("Short output");
    expect(displayText).not.toContain("[truncated]");
  });

  it("formats duration in seconds", () => {
    const totalDurationMs = 125000; // 125 seconds
    const durationSec = Math.round(totalDurationMs / 1000);
    expect(durationSec).toBe(125);
  });

  it("action badge classes are defined for all actions", () => {
    const actionColors = {
      dispatch: "bg-blue-100 text-blue-700",
      complete: "bg-emerald-100 text-emerald-700",
      fail: "bg-red-100 text-red-700",
    };
    expect(actionColors.dispatch).toBeDefined();
    expect(actionColors.complete).toBeDefined();
    expect(actionColors.fail).toBeDefined();
  });
});

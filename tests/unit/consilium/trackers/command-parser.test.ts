/**
 * command-parser.test.ts — TRACK-6 (task-tracker-triggers.md §8): STRICT command
 * parsing. A command is recognised ONLY as the exact leading token of a line — never a
 * substring, prefix, or casing bypass (the adversarial "command injection via
 * substring/casing").
 */
import { describe, it, expect } from "vitest";
import { parseTrackerCommand } from "../../../../server/services/consilium/trackers/command-parser.js";

describe("parseTrackerCommand", () => {
  it("recognises each exact command as a leading token", () => {
    expect(parseTrackerCommand("/spec")).toBe("spec");
    expect(parseTrackerCommand("/approve")).toBe("approve");
    expect(parseTrackerCommand("/stop")).toBe("stop");
  });

  it("allows trailing prose after the leading token", () => {
    expect(parseTrackerCommand("/approve looks good to me")).toBe("approve");
    expect(parseTrackerCommand("/stop please, wrong ticket")).toBe("stop");
  });

  it("finds a command on any line (first match wins)", () => {
    expect(parseTrackerCommand("some context\n\n/spec\nthanks")).toBe("spec");
    expect(parseTrackerCommand("/stop\n/approve")).toBe("stop"); // first-wins, deterministic
  });

  it("does NOT substring/prefix match", () => {
    expect(parseTrackerCommand("/specification of the api")).toBeNull();
    expect(parseTrackerCommand("/approved by lead")).toBeNull();
    expect(parseTrackerCommand("/stopwatch")).toBeNull();
  });

  it("does NOT match a command that is not the leading token of its line", () => {
    expect(parseTrackerCommand("please /stop this")).toBeNull();
    expect(parseTrackerCommand("do not /approve")).toBeNull();
    expect(parseTrackerCommand("the `/spec` command")).toBeNull();
  });

  it("is case-sensitive (no casing bypass)", () => {
    expect(parseTrackerCommand("/APPROVE")).toBeNull();
    expect(parseTrackerCommand("/Spec")).toBeNull();
    expect(parseTrackerCommand("/Stop")).toBeNull();
  });

  it("returns null for empty / non-command / non-string bodies", () => {
    expect(parseTrackerCommand("")).toBeNull();
    expect(parseTrackerCommand("just a normal comment")).toBeNull();
    expect(parseTrackerCommand(undefined)).toBeNull();
  });
});

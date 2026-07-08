import { describe, it, expect } from "vitest";
import { MemStorage } from "../../../server/storage.js";

/**
 * Task #52.2: real loop-trust aggregates, replacing the retired mock contour
 * observability demo (formerly `contour-observability.test.ts`, which tested
 * the deleted `ContourObservabilityService` in-memory Map mock). These tests
 * cover the real `getConsiliumLoopSkillStats()` / `getConsiliumLoopOutcomeStats()`
 * aggregates derived from `consilium_loops.appliedSkills` + `state`.
 */
describe("MemStorage.getConsiliumLoopSkillStats", () => {
  it("returns NO entry for a skill applied to zero terminal loops (never a synthetic 100%)", async () => {
    const storage = new MemStorage();
    await storage.createLoop({
      groupId: "group-1",
      repoPath: "/repo/alpha",
      state: "converged",
      appliedSkills: [{ id: "skill-applied", name: "Applied Skill" }],
    });

    const stats = await storage.getConsiliumLoopSkillStats();

    expect(stats.find((s) => s.skillId === "skill-applied")).toMatchObject({
      appliedCount: 1,
      convergedCount: 1,
      successRate: 1,
    });
    // skill-never-applied is not referenced by any loop at all — no entry.
    expect(stats.find((s) => s.skillId === "skill-never-applied")).toBeUndefined();
  });

  it("excludes dropped:true entries from both appliedCount and convergedCount", async () => {
    const storage = new MemStorage();
    // Dropped whole to fit budget — never actually applied to the loop's instruction.
    await storage.createLoop({
      groupId: "group-2",
      repoPath: "/repo/alpha",
      state: "converged",
      appliedSkills: [{ id: "skill-x", name: "Skill X", dropped: true }],
    });
    // Actually applied, converged.
    await storage.createLoop({
      groupId: "group-3",
      repoPath: "/repo/alpha",
      state: "converged",
      appliedSkills: [{ id: "skill-x", name: "Skill X" }],
    });

    const stats = await storage.getConsiliumLoopSkillStats();
    const skillX = stats.find((s) => s.skillId === "skill-x");

    expect(skillX).toMatchObject({ appliedCount: 1, convergedCount: 1, successRate: 1 });
  });

  it("excludes non-terminal loops from the aggregate", async () => {
    const storage = new MemStorage();
    await storage.createLoop({
      groupId: "group-4",
      repoPath: "/repo/alpha",
      state: "reviewing", // non-terminal
      appliedSkills: [{ id: "skill-in-flight", name: "In-flight Skill" }],
    });

    const stats = await storage.getConsiliumLoopSkillStats();

    expect(stats.find((s) => s.skillId === "skill-in-flight")).toBeUndefined();
  });

  it("aggregates appliedCount/convergedCount/successRate across multiple terminal loops", async () => {
    const storage = new MemStorage();
    await storage.createLoop({
      groupId: "group-5",
      repoPath: "/repo/alpha",
      state: "converged",
      appliedSkills: [{ id: "skill-mixed", name: "Mixed Skill" }],
    });
    await storage.createLoop({
      groupId: "group-6",
      repoPath: "/repo/alpha",
      state: "failed",
      appliedSkills: [{ id: "skill-mixed", name: "Mixed Skill" }],
    });
    await storage.createLoop({
      groupId: "group-7",
      repoPath: "/repo/alpha",
      state: "escalated",
      appliedSkills: [{ id: "skill-mixed", name: "Mixed Skill" }],
    });

    const stats = await storage.getConsiliumLoopSkillStats();
    const mixed = stats.find((s) => s.skillId === "skill-mixed");

    expect(mixed).toMatchObject({ appliedCount: 3, convergedCount: 1 });
    expect(mixed?.successRate).toBeCloseTo(1 / 3);
  });
});

describe("MemStorage.getConsiliumLoopOutcomeStats", () => {
  it("returns all-zero rates when there are no terminal loops", async () => {
    const storage = new MemStorage();

    const stats = await storage.getConsiliumLoopOutcomeStats();

    expect(stats).toEqual({ totalTerminalLoops: 0, convergedRate: 0, escalatedRate: 0 });
  });

  it("counts converged/escalated/other terminal states and excludes non-terminal loops", async () => {
    const storage = new MemStorage();
    await storage.createLoop({ groupId: "g-1", repoPath: "/repo/alpha", state: "converged" });
    await storage.createLoop({ groupId: "g-2", repoPath: "/repo/alpha", state: "converged" });
    await storage.createLoop({ groupId: "g-3", repoPath: "/repo/alpha", state: "escalated" });
    await storage.createLoop({ groupId: "g-4", repoPath: "/repo/alpha", state: "failed" });
    await storage.createLoop({ groupId: "g-5", repoPath: "/repo/alpha", state: "stopped_cap" });
    // Non-terminal — must not count toward totalTerminalLoops.
    await storage.createLoop({ groupId: "g-6", repoPath: "/repo/alpha", state: "pending" });

    const stats = await storage.getConsiliumLoopOutcomeStats();

    expect(stats.totalTerminalLoops).toBe(5);
    expect(stats.convergedRate).toBeCloseTo(2 / 5);
    expect(stats.escalatedRate).toBeCloseTo(1 / 5);
  });
});

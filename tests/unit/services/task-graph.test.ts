/**
 * Unit tests for server/services/task-graph.ts — pure DAG validation used by the
 * task-group edit routes. Reject self-dependency, cycles, and dangling refs; OK
 * for any valid DAG (including the empty graph).
 */
import { describe, it, expect } from "vitest";
import { validateTaskGraph } from "../../../server/services/task-graph.js";

describe("validateTaskGraph", () => {
  it("accepts the empty graph", () => {
    expect(validateTaskGraph([])).toEqual({ ok: true });
  });

  it("accepts a single task with no deps", () => {
    expect(validateTaskGraph([{ id: "a", dependsOn: [] }])).toEqual({ ok: true });
  });

  it("accepts a valid linear DAG a -> b -> c", () => {
    const tasks = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];
    expect(validateTaskGraph(tasks)).toEqual({ ok: true });
  });

  it("accepts a diamond DAG (a -> b, a -> c, b&c -> d)", () => {
    const tasks = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["a"] },
      { id: "d", dependsOn: ["b", "c"] },
    ];
    expect(validateTaskGraph(tasks)).toEqual({ ok: true });
  });

  it("rejects a self-dependency", () => {
    const res = validateTaskGraph([{ id: "a", dependsOn: ["a"] }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/self/i);
  });

  it("rejects a dangling dependency (dep id not in the group)", () => {
    const res = validateTaskGraph([{ id: "a", dependsOn: ["ghost"] }]);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/unknown|dangling|not.*exist/i);
  });

  it("rejects a 2-node cycle (a -> b -> a)", () => {
    const tasks = [
      { id: "a", dependsOn: ["b"] },
      { id: "b", dependsOn: ["a"] },
    ];
    const res = validateTaskGraph(tasks);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cycle/i);
  });

  it("rejects a 3-node cycle (a -> b -> c -> a)", () => {
    const tasks = [
      { id: "a", dependsOn: ["c"] },
      { id: "b", dependsOn: ["a"] },
      { id: "c", dependsOn: ["b"] },
    ];
    const res = validateTaskGraph(tasks);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toMatch(/cycle/i);
  });

  it("accepts duplicate dep ids that still form a DAG", () => {
    const tasks = [
      { id: "a", dependsOn: [] },
      { id: "b", dependsOn: ["a", "a"] },
    ];
    expect(validateTaskGraph(tasks)).toEqual({ ok: true });
  });
});

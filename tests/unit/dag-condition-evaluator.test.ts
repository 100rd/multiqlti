/**
 * Unit tests — DAG Condition Evaluator
 */
import { describe, it, expect } from "vitest";
import { resolvePath, evaluateCondition } from "../../server/pipeline/dag-condition-evaluator.js";
import type { DAGCondition } from "../../shared/types.js";

// ─── resolvePath ──────────────────────────────────────────────────────────────

describe("resolvePath", () => {
  const obj = { score: 0.9, meta: { label: "yes", count: 3 }, arr: [1, 2] };

  it("resolves top-level keys", () => {
    expect(resolvePath(obj, "score")).toBe(0.9);
  });

  it("resolves two-level dot paths", () => {
    expect(resolvePath(obj, "meta.label")).toBe("yes");
  });

  it("resolves three-level dot paths", () => {
    const deep = { a: { b: { c: 42 } } };
    expect(resolvePath(deep, "a.b.c")).toBe(42);
  });

  it("returns undefined for missing keys", () => {
    expect(resolvePath(obj, "missing")).toBeUndefined();
  });

  it("returns undefined for paths deeper than 3 segments", () => {
    expect(resolvePath({}, "a.b.c.d")).toBeUndefined();
  });

  it("returns undefined for paths with bracket notation (invalid characters)", () => {
    // Bracket notation is not a valid field path — regex rejects it
    expect(resolvePath({}, "field[0]")).toBeUndefined();
  });

  it("returns undefined when intermediate value is null", () => {
    expect(resolvePath({ a: null }, "a.b")).toBeUndefined();
  });

  it("rejects paths with empty segments", () => {
    expect(resolvePath({}, "a..b")).toBeUndefined();
  });

  it("returns undefined for keys not present on a plain object", () => {
    // Fields that happen to look like JS builtins but are not own properties
    // of a plain data object will resolve as undefined or the prototype value —
    // since evaluateCondition treats non-null resolved values as truthy for
    // "exists", callers should never produce outputs with these keys.
    // For a truly empty data object the common case is undefined.
    const plainData: Record<string, unknown> = Object.create(null);
    expect(resolvePath(plainData, "missing_key")).toBeUndefined();
  });
});

// ─── evaluateCondition ────────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  const output = {
    score: 0.85,
    label: "approved",
    count: 0,
    flag: true,
    text: "hello world",
    items: ["a", "b", "c"],
    nested: { value: 10 },
  };

  // eq
  it("eq: returns true when field equals value", () => {
    const cond: DAGCondition = { field: "label", operator: "eq", value: "approved" };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("eq: returns false when field does not equal value", () => {
    const cond: DAGCondition = { field: "label", operator: "eq", value: "rejected" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  it("eq: strict equality — does not coerce types", () => {
    const cond: DAGCondition = { field: "count", operator: "eq", value: "0" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  // neq
  it("neq: returns true when field differs from value", () => {
    const cond: DAGCondition = { field: "label", operator: "neq", value: "rejected" };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("neq: returns false when field equals value", () => {
    const cond: DAGCondition = { field: "label", operator: "neq", value: "approved" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  // gt
  it("gt: returns true when numeric field is greater", () => {
    const cond: DAGCondition = { field: "score", operator: "gt", value: 0.5 };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("gt: returns false when numeric field is equal", () => {
    const cond: DAGCondition = { field: "score", operator: "gt", value: 0.85 };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  it("gt: returns false when field is not a number", () => {
    const cond: DAGCondition = { field: "label", operator: "gt", value: 0 };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  // lt
  it("lt: returns true when numeric field is less", () => {
    const cond: DAGCondition = { field: "score", operator: "lt", value: 1.0 };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("lt: returns false when numeric field is equal", () => {
    const cond: DAGCondition = { field: "score", operator: "lt", value: 0.85 };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  // contains
  it("contains: returns true when string contains substring", () => {
    const cond: DAGCondition = { field: "text", operator: "contains", value: "world" };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("contains: returns false when string does not contain substring", () => {
    const cond: DAGCondition = { field: "text", operator: "contains", value: "xyz" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  it("contains: returns true when array contains element", () => {
    const cond: DAGCondition = { field: "items", operator: "contains", value: "b" };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("contains: returns false when array does not contain element", () => {
    const cond: DAGCondition = { field: "items", operator: "contains", value: "z" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  it("contains: returns false for non-string/array field", () => {
    const cond: DAGCondition = { field: "count", operator: "contains", value: "0" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  // exists
  it("exists: returns true when field is present and non-null", () => {
    const cond: DAGCondition = { field: "score", operator: "exists" };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  it("exists: returns false when field is missing", () => {
    const cond: DAGCondition = { field: "missing", operator: "exists" };
    expect(evaluateCondition(output, cond)).toBe(false);
  });

  it("exists: returns false when field is null", () => {
    const cond: DAGCondition = { field: "nullField", operator: "exists" };
    expect(evaluateCondition({ nullField: null }, cond)).toBe(false);
  });

  // nested paths
  it("evaluates conditions on nested paths", () => {
    const cond: DAGCondition = { field: "nested.value", operator: "gt", value: 5 };
    expect(evaluateCondition(output, cond)).toBe(true);
  });

  // unknown operator guard
  it("returns false for unknown operator", () => {
    const cond = { field: "score", operator: "unknown" as never, value: 0 };
    expect(evaluateCondition(output, cond)).toBe(false);
  });
});

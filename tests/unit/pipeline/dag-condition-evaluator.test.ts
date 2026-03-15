import { describe, it, expect } from "vitest";
import { resolvePath, evaluateCondition } from "../../../server/pipeline/dag-condition-evaluator.js";

// ─── resolvePath ─────────────────────────────────────────────────────────────

describe("resolvePath", () => {
  const obj = {
    score: 95,
    result: {
      passed: true,
      details: {
        reason: "all checks passed",
      },
    },
    tags: ["a", "b"],
  };

  it("resolves a top-level key", () => {
    expect(resolvePath(obj, "score")).toBe(95);
  });

  it("resolves a 2-level dot-path", () => {
    expect(resolvePath(obj, "result.passed")).toBe(true);
  });

  it("resolves a 3-level dot-path", () => {
    expect(resolvePath(obj, "result.details.reason")).toBe("all checks passed");
  });

  it("returns undefined for missing key", () => {
    expect(resolvePath(obj, "nonexistent")).toBeUndefined();
  });

  it("returns undefined when intermediate is not an object", () => {
    expect(resolvePath(obj, "score.nested")).toBeUndefined();
  });

  it("rejects prototype pollution attempt via __proto__", () => {
    expect(resolvePath(obj, "__proto__.polluted")).toBeUndefined();
  });

  it("rejects constructor pollution attempt", () => {
    expect(resolvePath(obj, "constructor.name")).toBeUndefined();
  });

  it("rejects path with 4 segments (too deep)", () => {
    expect(resolvePath(obj, "a.b.c.d")).toBeUndefined();
  });

  it("rejects path with special characters", () => {
    expect(resolvePath(obj, "result[0].value")).toBeUndefined();
  });

  it("rejects empty path", () => {
    expect(resolvePath(obj, "")).toBeUndefined();
  });

  it("resolves array value (not traversed further)", () => {
    expect(resolvePath(obj, "tags")).toEqual(["a", "b"]);
  });
});

// ─── evaluateCondition ────────────────────────────────────────────────────────

describe("evaluateCondition — exists", () => {
  it("returns true when field exists with a value", () => {
    expect(evaluateCondition({ x: 1 }, { field: "x", operator: "exists" })).toBe(true);
  });

  it("returns false when field is undefined", () => {
    expect(evaluateCondition({}, { field: "x", operator: "exists" })).toBe(false);
  });

  it("returns false when field is null", () => {
    expect(evaluateCondition({ x: null }, { field: "x", operator: "exists" })).toBe(false);
  });
});

describe("evaluateCondition — eq", () => {
  it("matches equal strings", () => {
    expect(evaluateCondition({ status: "done" }, { field: "status", operator: "eq", value: "done" })).toBe(true);
  });

  it("does not match different strings", () => {
    expect(evaluateCondition({ status: "done" }, { field: "status", operator: "eq", value: "pending" })).toBe(false);
  });

  it("matches equal numbers", () => {
    expect(evaluateCondition({ score: 42 }, { field: "score", operator: "eq", value: 42 })).toBe(true);
  });

  it("matches boolean", () => {
    expect(evaluateCondition({ passed: true }, { field: "passed", operator: "eq", value: true })).toBe(true);
  });
});

describe("evaluateCondition — neq", () => {
  it("returns true when values differ", () => {
    expect(evaluateCondition({ status: "failed" }, { field: "status", operator: "neq", value: "done" })).toBe(true);
  });

  it("returns false when values are equal", () => {
    expect(evaluateCondition({ status: "done" }, { field: "status", operator: "neq", value: "done" })).toBe(false);
  });
});

describe("evaluateCondition — gt", () => {
  it("returns true when value is greater", () => {
    expect(evaluateCondition({ score: 80 }, { field: "score", operator: "gt", value: 50 })).toBe(true);
  });

  it("returns false when value is equal", () => {
    expect(evaluateCondition({ score: 50 }, { field: "score", operator: "gt", value: 50 })).toBe(false);
  });

  it("returns false when value is less", () => {
    expect(evaluateCondition({ score: 30 }, { field: "score", operator: "gt", value: 50 })).toBe(false);
  });

  it("returns false when value is not a number", () => {
    expect(evaluateCondition({ score: "high" }, { field: "score", operator: "gt", value: 50 })).toBe(false);
  });
});

describe("evaluateCondition — lt", () => {
  it("returns true when value is less", () => {
    expect(evaluateCondition({ score: 20 }, { field: "score", operator: "lt", value: 50 })).toBe(true);
  });

  it("returns false when value is equal", () => {
    expect(evaluateCondition({ score: 50 }, { field: "score", operator: "lt", value: 50 })).toBe(false);
  });

  it("returns false when value is greater", () => {
    expect(evaluateCondition({ score: 80 }, { field: "score", operator: "lt", value: 50 })).toBe(false);
  });
});

describe("evaluateCondition — contains", () => {
  it("returns true when string contains substring", () => {
    expect(evaluateCondition({ msg: "hello world" }, { field: "msg", operator: "contains", value: "world" })).toBe(true);
  });

  it("returns false when string does not contain substring", () => {
    expect(evaluateCondition({ msg: "hello" }, { field: "msg", operator: "contains", value: "world" })).toBe(false);
  });

  it("returns true when array contains value", () => {
    expect(evaluateCondition({ tags: ["a", "b", "c"] }, { field: "tags", operator: "contains", value: "b" })).toBe(true);
  });

  it("returns false when array does not contain value", () => {
    expect(evaluateCondition({ tags: ["a", "b"] }, { field: "tags", operator: "contains", value: "z" })).toBe(false);
  });

  it("returns false for non-string, non-array value", () => {
    expect(evaluateCondition({ count: 5 }, { field: "count", operator: "contains", value: "5" })).toBe(false);
  });
});

describe("evaluateCondition — edge cases", () => {
  it("returns false for invalid path", () => {
    expect(evaluateCondition({}, { field: "__proto__", operator: "exists" })).toBe(false);
  });

  it("returns false for missing field with eq", () => {
    expect(evaluateCondition({}, { field: "missing", operator: "eq", value: "x" })).toBe(false);
  });
});

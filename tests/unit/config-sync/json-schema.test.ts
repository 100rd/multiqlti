/**
 * Tests for shared/config-sync/json-schema.ts (issue #313)
 *
 * Coverage:
 *   - Each generator function returns an object (not undefined/null)
 *   - Generated schemas contain a JSON Schema root structure
 *     (object with `type`, `anyOf`, `oneOf`, `$ref`, or `definitions`)
 *   - The combined schema carries the correct $id
 *   - KIND_SCHEMAS map covers all entity kinds
 *   - No generator throws at runtime
 *
 * Note: when a `name` option is passed to zodToJsonSchema the library wraps
 * the schema in a definitions block and emits a `$ref` at the root.  The tests
 * accept either the flat form (`type`/`anyOf`/`oneOf` at root) or the named
 * form (`$ref` + `definitions` at root).
 */

import { describe, it, expect } from "vitest";
import {
  generatePipelineJsonSchema,
  generateTriggerJsonSchema,
  generatePromptJsonSchema,
  generateSkillStateJsonSchema,
  generateConnectionJsonSchema,
  generateProviderKeyJsonSchema,
  generatePreferencesJsonSchema,
  generateConfigEntityJsonSchema,
  KIND_SCHEMAS,
  BASE_URI,
} from "../../../shared/config-sync/json-schema.js";

/** True when the value looks like a valid JSON Schema root object. */
function isJsonSchemaRoot(schema: Record<string, unknown>): boolean {
  return (
    "type" in schema ||
    "anyOf" in schema ||
    "oneOf" in schema ||
    "$ref" in schema ||
    "definitions" in schema ||
    "$defs" in schema
  );
}

describe("Per-kind JSON Schema generators", () => {
  const generators = [
    { name: "pipeline", fn: generatePipelineJsonSchema },
    { name: "trigger", fn: generateTriggerJsonSchema },
    { name: "prompt", fn: generatePromptJsonSchema },
    { name: "skill-state", fn: generateSkillStateJsonSchema },
    { name: "connection", fn: generateConnectionJsonSchema },
    { name: "provider-key", fn: generateProviderKeyJsonSchema },
    { name: "preferences", fn: generatePreferencesJsonSchema },
  ];

  for (const { name, fn } of generators) {
    it(`${name}: does not throw`, () => {
      expect(() => fn()).not.toThrow();
    });

    it(`${name}: returns a non-null object`, () => {
      const schema = fn();
      expect(schema).toBeDefined();
      expect(typeof schema).toBe("object");
      expect(schema).not.toBeNull();
    });

    it(`${name}: is a valid JSON Schema root object`, () => {
      const schema = fn();
      expect(isJsonSchemaRoot(schema)).toBe(true);
    });

    it(`${name}: carries a $schema or definitions hint`, () => {
      const schema = fn();
      // zod-to-json-schema always emits at least one of these
      const hasMeta =
        "$schema" in schema ||
        "definitions" in schema ||
        "$defs" in schema ||
        "type" in schema;
      expect(hasMeta).toBe(true);
    });
  }
});

describe("generateConfigEntityJsonSchema", () => {
  it("does not throw", () => {
    expect(() => generateConfigEntityJsonSchema()).not.toThrow();
  });

  it("carries the correct $id", () => {
    const schema = generateConfigEntityJsonSchema();
    expect(schema.$id).toBe(`${BASE_URI}/config-entity.json`);
  });

  it("is a valid JSON Schema root object", () => {
    const schema = generateConfigEntityJsonSchema();
    expect(typeof schema).toBe("object");
    expect(isJsonSchemaRoot(schema)).toBe(true);
  });

  it("contains definitions block for discriminated variants", () => {
    const schema = generateConfigEntityJsonSchema();
    // Whether inline or named, the discriminated union creates a definitions block
    const hasVariants =
      Array.isArray(schema.anyOf) ||
      Array.isArray(schema.oneOf) ||
      typeof schema.definitions === "object" ||
      typeof schema.$defs === "object";
    expect(hasVariants).toBe(true);
  });
});

describe("KIND_SCHEMAS map", () => {
  const expectedKinds = [
    "pipeline",
    "trigger",
    "prompt",
    "skill-state",
    "connection",
    "provider-key",
    "preferences",
  ];

  it("contains all expected kinds", () => {
    for (const kind of expectedKinds) {
      expect(KIND_SCHEMAS).toHaveProperty(kind);
    }
  });

  it("every entry is a callable function", () => {
    for (const [, fn] of Object.entries(KIND_SCHEMAS)) {
      expect(typeof fn).toBe("function");
      expect(() => fn()).not.toThrow();
    }
  });

  it("covers exactly the expected set of kinds", () => {
    const actual = new Set(Object.keys(KIND_SCHEMAS));
    const expected = new Set(expectedKinds);
    expect(actual).toEqual(expected);
  });
});

/**
 * Tests for server/tools/loader.ts
 * Covers: load valid module, reject invalid schema, rollback on failed load,
 * hot-reload (watcher setup), per-workspace isolation via DynamicToolLoader.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { DynamicToolLoader } from "../../../server/tools/loader.js";
import { WorkspaceToolRegistry } from "../../../server/tools/workspace-registry.js";
import { ToolRegistry } from "../../../server/tools/registry.js";
import type { SandboxLimits } from "../../../server/tools/sandbox-vm.js";

const FAST_LIMITS: SandboxLimits = {
  executionTimeoutMs: 2_000,
  maxResultLength: 512_000,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(): WorkspaceToolRegistry {
  return new WorkspaceToolRegistry(new ToolRegistry(), FAST_LIMITS);
}

function writeTempModule(dir: string, source: string): string {
  const entryPath = path.join(dir, "index.js");
  fs.writeFileSync(entryPath, source, "utf8");
  return dir;
}

const VALID_MODULE_SOURCE = `
module.exports = {
  tools: [{
    _kind: 'tool',
    name: 'sample_tool',
    description: 'A sample tool',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
    scopes: [],
    handler: function(args) { return 'result: ' + args.q; },
    sdkVersion: '0.1.0',
  }],
};
`;

const VALID_MULTI_MODULE_SOURCE = `
module.exports = {
  tools: [
    {
      _kind: 'tool',
      name: 'tool_alpha',
      description: 'Alpha tool',
      inputSchema: { type: 'object', properties: {} },
      scopes: [],
      handler: function() { return 'alpha'; },
      sdkVersion: '0.1.0',
    },
  ],
  skills: [{
    _kind: 'skill',
    name: 'alpha_skill',
    description: 'Alpha skill',
    prompts: [{ id: 'default', label: 'Default', systemPrompt: 'You are helpful.' }],
    tools: ['tool_alpha'],
    defaults: {},
    tags: ['alpha'],
    sdkVersion: '0.1.0',
  }],
};
`;

const INVALID_MODULE_SOURCE_NO_EXPORTS = `
// This module exports nothing valid
const x = 42;
`;

const INVALID_SCHEMA_SOURCE = `
module.exports = {
  tools: [{ _kind: 'tool', name: 'INVALID NAME WITH SPACES', description: 'bad', inputSchema: { type: 'object', properties: {} }, scopes: [], handler: function() { return ''; }, sdkVersion: '0.1.0' }]
};
`;

// ─── Load valid module ────────────────────────────────────────────────────────

describe("DynamicToolLoader — load valid module", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. loads valid local module and reports tool count", async () => {
    writeTempModule(tmpDir, VALID_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-load", registry, FAST_LIMITS);

    const result = await loader.load({
      sources: [{ type: "local", path: tmpDir }],
    });

    expect(result.errors).toHaveLength(0);
    expect(result.toolsRegistered).toBe(1);
  });

  it("2. loaded tool is visible in workspace registry", async () => {
    writeTempModule(tmpDir, VALID_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-vis", registry, FAST_LIMITS);

    await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    const tools = registry.getCustomToolDefs("ws-vis");
    expect(tools.map((t) => t.name)).toContain("sample_tool");
  });

  it("3. loads module with tools + skills and counts both", async () => {
    writeTempModule(tmpDir, VALID_MULTI_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-multi", registry, FAST_LIMITS);

    const result = await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    expect(result.toolsRegistered).toBe(1);
    expect(result.skillsRegistered).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("4. loaded skill is accessible via getCustomSkills", async () => {
    writeTempModule(tmpDir, VALID_MULTI_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-skill", registry, FAST_LIMITS);

    await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    const skills = registry.getCustomSkills("ws-skill");
    expect(skills.map((s) => s.name)).toContain("alpha_skill");
  });

  it("5. multiple sources accumulate tools across all sources", async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-b-"));
    try {
      writeTempModule(tmpDir, VALID_MODULE_SOURCE);
      const src2 = `
        module.exports = {
          tools: [{ _kind: 'tool', name: 'second_tool', description: 'Second', inputSchema: { type: 'object', properties: {} }, scopes: [], handler: function() { return '2'; }, sdkVersion: '0.1.0' }]
        };
      `;
      writeTempModule(tmpDir2, src2);

      const registry = makeRegistry();
      const loader = new DynamicToolLoader("ws-multi-src", registry, FAST_LIMITS);

      const result = await loader.load({
        sources: [
          { type: "local", path: tmpDir },
          { type: "local", path: tmpDir2 },
        ],
      });

      expect(result.toolsRegistered).toBe(2);
      expect(result.errors).toHaveLength(0);
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ─── Invalid schema rejection ─────────────────────────────────────────────────

describe("DynamicToolLoader — schema validation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-val-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("6. rejects module that exports nothing valid", async () => {
    writeTempModule(tmpDir, INVALID_MODULE_SOURCE_NO_EXPORTS);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-bad", registry, FAST_LIMITS);

    const result = await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/no tools|nothing|valid/i);
  });

  it("7. rejects module with tool using invalid name", async () => {
    writeTempModule(tmpDir, INVALID_SCHEMA_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-badname", registry, FAST_LIMITS);

    const result = await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("8. error message includes source key for traceability", async () => {
    writeTempModule(tmpDir, INVALID_MODULE_SOURCE_NO_EXPORTS);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-trace", registry, FAST_LIMITS);

    const result = await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    expect(result.errors[0]).toMatch(/local:/);
  });

  it("9. non-existent local path returns error, not throw", async () => {
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-nopath", registry, FAST_LIMITS);

    const result = await loader.load({
      sources: [{ type: "local", path: "/nonexistent/path/that/does/not/exist" }],
    });

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toMatch(/exist|not found/i);
  });
});

// ─── Rollback ─────────────────────────────────────────────────────────────────

describe("DynamicToolLoader — rollback on failed reload", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-rollback-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("10. failed reload preserves previously-loaded tools", async () => {
    // First load — valid
    writeTempModule(tmpDir, VALID_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-rollback", registry, FAST_LIMITS);

    await loader.load({ sources: [{ type: "local", path: tmpDir }] });
    let tools = registry.getCustomToolDefs("ws-rollback").map((t) => t.name);
    expect(tools).toContain("sample_tool");

    // Overwrite with invalid source
    fs.writeFileSync(path.join(tmpDir, "index.js"), INVALID_MODULE_SOURCE_NO_EXPORTS, "utf8");
    const result2 = await loader.load({ sources: [{ type: "local", path: tmpDir }] });

    // Should have errors
    expect(result2.errors.length).toBeGreaterThan(0);

    // But previous tools should still be visible (rollback)
    tools = registry.getCustomToolDefs("ws-rollback").map((t) => t.name);
    expect(tools).toContain("sample_tool");
  });

  it("11. first-time load failure does NOT leave broken state in registry", async () => {
    writeTempModule(tmpDir, INVALID_MODULE_SOURCE_NO_EXPORTS);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-first-fail", registry, FAST_LIMITS);

    const result = await loader.load({ sources: [{ type: "local", path: tmpDir }] });
    expect(result.errors.length).toBeGreaterThan(0);

    // Registry should have zero custom tools for this workspace
    const tools = registry.getCustomToolDefs("ws-first-fail");
    expect(tools).toHaveLength(0);
  });

  it("12. one failed source does not block successful sources", async () => {
    const tmpDir2 = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-ok-"));
    try {
      writeTempModule(tmpDir, INVALID_MODULE_SOURCE_NO_EXPORTS); // bad
      writeTempModule(tmpDir2, VALID_MODULE_SOURCE);              // good

      const registry = makeRegistry();
      const loader = new DynamicToolLoader("ws-partial", registry, FAST_LIMITS);

      const result = await loader.load({
        sources: [
          { type: "local", path: tmpDir },
          { type: "local", path: tmpDir2 },
        ],
      });

      // Partial success: one error, one tool registered
      expect(result.errors.length).toBe(1);
      expect(result.toolsRegistered).toBe(1);

      const tools = registry.getCustomToolDefs("ws-partial").map((t) => t.name);
      expect(tools).toContain("sample_tool");
    } finally {
      fs.rmSync(tmpDir2, { recursive: true, force: true });
    }
  });
});

// ─── Hot-reload ───────────────────────────────────────────────────────────────

describe("DynamicToolLoader — hot-reload watcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-hr-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("13. dispose() closes file watchers without throwing", async () => {
    writeTempModule(tmpDir, VALID_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-disp", registry, FAST_LIMITS);

    await loader.load({ sources: [{ type: "local", path: tmpDir }], hotReload: true });

    expect(() => loader.dispose()).not.toThrow();
  });

  it("14. hotReload: false — watcher is NOT set up", async () => {
    writeTempModule(tmpDir, VALID_MODULE_SOURCE);
    const registry = makeRegistry();
    const loader = new DynamicToolLoader("ws-nowatch", registry, FAST_LIMITS);

    // Should not throw and should work fine without watchers
    await expect(
      loader.load({ sources: [{ type: "local", path: tmpDir }], hotReload: false }),
    ).resolves.toBeDefined();

    loader.dispose(); // Should be a no-op
  });
});

// ─── Per-workspace isolation ──────────────────────────────────────────────────

describe("DynamicToolLoader — per-workspace isolation", () => {
  let tmpDirA: string;
  let tmpDirB: string;

  beforeEach(() => {
    tmpDirA = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-wsa-"));
    tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), "sdk-test-wsb-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDirA, { recursive: true, force: true });
    fs.rmSync(tmpDirB, { recursive: true, force: true });
  });

  it("15. different workspaces load different tools into the same registry", async () => {
    writeTempModule(tmpDirA, VALID_MODULE_SOURCE);
    const srcB = `module.exports = { tools: [{ _kind: 'tool', name: 'ws_b_tool', description: 'B', inputSchema: { type: 'object', properties: {} }, scopes: [], handler: function() { return 'b'; }, sdkVersion: '0.1.0' }] };`;
    writeTempModule(tmpDirB, srcB);

    const registry = makeRegistry();
    const loaderA = new DynamicToolLoader("ws-isol-a", registry, FAST_LIMITS);
    const loaderB = new DynamicToolLoader("ws-isol-b", registry, FAST_LIMITS);

    await loaderA.load({ sources: [{ type: "local", path: tmpDirA }] });
    await loaderB.load({ sources: [{ type: "local", path: tmpDirB }] });

    const toolsA = registry.getCustomToolDefs("ws-isol-a").map((t) => t.name);
    const toolsB = registry.getCustomToolDefs("ws-isol-b").map((t) => t.name);

    expect(toolsA).toContain("sample_tool");
    expect(toolsA).not.toContain("ws_b_tool");

    expect(toolsB).toContain("ws_b_tool");
    expect(toolsB).not.toContain("sample_tool");
  });
});

/**
 * Tests for server/tools/sandbox-vm.ts
 * Covers: context creation, no filesystem access, no network by default,
 * resource limits (timeout), script compilation, execution.
 */

import { describe, it, expect, vi } from "vitest";
import {
  createSandboxContext,
  compileScript,
  runScript,
  wrapModuleSource,
  DEFAULT_SANDBOX_LIMITS,
} from "../../../server/tools/sandbox-vm.js";

// ─── Context creation ─────────────────────────────────────────────────────────

describe("createSandboxContext", () => {
  it("1. returns an object (vm context)", () => {
    const ctx = createSandboxContext([]);
    expect(ctx).toBeDefined();
    expect(typeof ctx).toBe("object");
  });

  it("2. no filesystem access — fs is absent", () => {
    const ctx = createSandboxContext([]) as Record<string, unknown>;
    expect(ctx["require"]).toBeUndefined();
    expect(ctx["process"]).toBeUndefined();
  });

  it("3. fetch is absent when http:outbound scope is NOT declared", () => {
    const ctx = createSandboxContext([]) as Record<string, unknown>;
    expect(ctx["fetch"]).toBeUndefined();
  });

  it("4. fetch is present when http:outbound scope IS declared", () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    expect(ctx["fetch"]).toBeDefined();
    expect(typeof ctx["fetch"]).toBe("function");
  });

  it("5. safe globals are present — JSON, Math, Array, etc.", () => {
    const ctx = createSandboxContext([]) as Record<string, unknown>;
    expect(ctx["JSON"]).toBeDefined();
    expect(ctx["Math"]).toBeDefined();
    expect(ctx["Array"]).toBeDefined();
    expect(ctx["Promise"]).toBeDefined();
    expect(ctx["Map"]).toBeDefined();
    expect(ctx["Set"]).toBeDefined();
  });

  it("6. SharedArrayBuffer is undefined (timing attack vector)", () => {
    const ctx = createSandboxContext([]) as Record<string, unknown>;
    expect(ctx["SharedArrayBuffer"]).toBeUndefined();
  });

  it("7. Atomics is undefined", () => {
    const ctx = createSandboxContext([]) as Record<string, unknown>;
    expect(ctx["Atomics"]).toBeUndefined();
  });
});

// ─── Script wrapping ──────────────────────────────────────────────────────────

describe("wrapModuleSource", () => {
  it("8. wrapped source exports via module.exports", () => {
    const source = `module.exports = { _kind: 'test', value: 42 };`;
    const wrapped = wrapModuleSource(source);
    expect(wrapped).toContain("module.exports");
    expect(wrapped).toContain("return module.exports");
  });

  it("9. wrapped source can use exports shorthand", () => {
    const source = `exports.answer = 42;`;
    const wrapped = wrapModuleSource(source);
    expect(wrapped).toContain("exports");
  });

  it("10. require is blocked — throws on call", () => {
    const ctx = createSandboxContext([]);
    const source = `
      try {
        __sdkRequire('fs');
        module.exports = { failed: false };
      } catch (e) {
        module.exports = { failed: true, msg: e.message };
      }
    `;
    const script = compileScript(wrapModuleSource(source), "test.js", ctx);
    const result = runScript(script, ctx, 1000) as { failed: boolean; msg: string };
    expect(result.failed).toBe(true);
    expect(result.msg).toContain("require()");
  });
});

// ─── Script compilation ───────────────────────────────────────────────────────

describe("compileScript", () => {
  it("11. compiles valid script without throwing", () => {
    const ctx = createSandboxContext([]);
    expect(() => {
      compileScript("1 + 1", "test.js", ctx);
    }).not.toThrow();
  });

  it("12. throws SyntaxError on invalid JS", () => {
    const ctx = createSandboxContext([]);
    expect(() => {
      compileScript("const { = invalid }", "bad.js", ctx);
    }).toThrow(SyntaxError);
  });
});

// ─── runScript + execution ────────────────────────────────────────────────────

describe("runScript", () => {
  it("13. executes script and returns completion value", () => {
    const ctx = createSandboxContext([]);
    const script = compileScript("42", "num.js", ctx);
    const result = runScript(script, ctx, 1000);
    expect(result).toBe(42);
  });

  it("14. module exports a tool-like object via wrapModuleSource", () => {
    const ctx = createSandboxContext([]);
    const source = `
      module.exports = {
        tools: [{
          _kind: 'tool',
          name: 'echo',
          description: 'echo',
          inputSchema: { type: 'object', properties: {} },
          scopes: [],
          handler: function(args) { return String(args.msg); },
          sdkVersion: '0.1.0',
        }]
      };
    `;
    const script = compileScript(wrapModuleSource(source), "echo.js", ctx);
    const result = runScript(script, ctx, 1000) as { tools: Array<{ name: string }> };
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe("echo");
  });

  it("15. sandbox cannot access globalThis (process, fs, etc.)", () => {
    const ctx = createSandboxContext([]);
    const source = `
      const hasProcess = typeof process !== 'undefined';
      module.exports = { hasProcess };
    `;
    const script = compileScript(wrapModuleSource(source), "proc.js", ctx);
    const result = runScript(script, ctx, 1000) as { hasProcess: boolean };
    expect(result.hasProcess).toBe(false);
  });

  it("16. throws on execution timeout for tight loop", () => {
    const ctx = createSandboxContext([]);
    // This is a synchronous tight loop — vm timeout fires
    const source = `while(true) {}`;
    const script = compileScript(source, "inf.js", ctx);
    expect(() => runScript(script, ctx, 100)).toThrow();
  });

  it("17. JSON is available inside the sandbox", () => {
    const ctx = createSandboxContext([]);
    const source = `
      const obj = { a: 1 };
      module.exports = { str: JSON.stringify(obj) };
    `;
    const script = compileScript(wrapModuleSource(source), "json.js", ctx);
    const result = runScript(script, ctx, 1000) as { str: string };
    expect(result.str).toBe('{"a":1}');
  });

  it("18. URL is available inside the sandbox", () => {
    const ctx = createSandboxContext([]);
    const source = `
      const u = new URL('https://example.com/path?q=1');
      module.exports = { hostname: u.hostname, query: u.searchParams.get('q') };
    `;
    const script = compileScript(wrapModuleSource(source), "url.js", ctx);
    const result = runScript(script, ctx, 1000) as { hostname: string; query: string };
    expect(result.hostname).toBe("example.com");
    expect(result.query).toBe("1");
  });

  it("19. TextEncoder is available inside the sandbox", () => {
    const ctx = createSandboxContext([]);
    const source = `
      const enc = new TextEncoder();
      const bytes = enc.encode('hello');
      module.exports = { len: bytes.length };
    `;
    const script = compileScript(wrapModuleSource(source), "enc.js", ctx);
    const result = runScript(script, ctx, 1000) as { len: number };
    expect(result.len).toBe(5);
  });
});

// ─── Restricted fetch (http:outbound) ─────────────────────────────────────────

describe("restrictedFetch in sandbox", () => {
  it("20. fetch throws on non-HTTPS URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await expect(fetchFn("http://example.com/")).rejects.toThrow(/only https/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("21. fetch throws on localhost", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await expect(fetchFn("https://localhost/secret")).rejects.toThrow(/blocked/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("22. fetch throws on 127.0.0.1 (loopback)", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await expect(fetchFn("https://127.0.0.1/secret")).rejects.toThrow(/blocked/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("23. fetch throws on 192.168.x.x private IP", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await expect(fetchFn("https://192.168.1.100/api")).rejects.toThrow(/blocked/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("24. fetch passes through for public HTTPS domain", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await fetchFn("https://api.example.com/data");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("25. fetch throws on invalid URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("ok"));
    const ctx = createSandboxContext(["http:outbound"], mockFetch as unknown as typeof globalThis.fetch) as Record<string, unknown>;
    const fetchFn = ctx["fetch"] as (url: string) => Promise<Response>;

    await expect(fetchFn("not-a-url")).rejects.toThrow(/invalid url/i);
  });
});

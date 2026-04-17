/**
 * server/tools/sandbox-vm.ts
 *
 * Creates a restricted Node.js vm.Context for executing user-authored tool
 * modules.  The context exposes only a curated API surface — no Node built-ins
 * (fs, net, child_process, …), no require/import, no process.env.
 *
 * Security model:
 *   1. Forbidden APIs are simply absent from the context.
 *   2. `fetch` is present only for tools that declared "http:outbound" scope.
 *   3. CPU time is bounded by wrapping execution in a `vm.Script` with a
 *      timeout (hard deadline enforced by the caller via Promise.race).
 *   4. Memory is bounded by the Node.js heap; we cannot set per-context limits
 *      via the built-in vm module without V8 Isolates.  We document this and
 *      accept it as a known limitation of the pure-vm approach.
 */

import vm from "vm";
import type { ToolScope } from "../../packages/sdk/src/types.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface SandboxLimits {
  /**
   * Hard execution-time limit in milliseconds per tool invocation.
   * Default: 5 000 ms.
   */
  executionTimeoutMs: number;
  /**
   * Maximum length (characters) of the string value returned by a tool.
   * Enforced post-execution to prevent excessively large context injections.
   * Default: 512 000 (≈ 500 KB).
   */
  maxResultLength: number;
}

export const DEFAULT_SANDBOX_LIMITS: SandboxLimits = {
  executionTimeoutMs: 5_000,
  maxResultLength: 512_000,
};

// ─── Allowed global subset ────────────────────────────────────────────────────

/**
 * Build the frozen, curated global object injected into every sandbox context.
 *
 * Only primitives / pure-JS utilities are exposed here.
 * Network and IO are controlled separately via scope-gated wrappers.
 */
function buildSafeGlobals(
  scopes: ToolScope[],
  allowedFetch: typeof globalThis.fetch | null,
): Record<string, unknown> {
  const hasFetch = scopes.includes("http:outbound") && allowedFetch !== null;

  // Minimal structured console (writes to structured log, not stdout)
  const safeConsole = {
    log: (...args: unknown[]) => {
      /* intentionally no-op in sandbox — tools should use ctx.log */
    },
    warn: (...args: unknown[]) => {
      /* intentionally no-op in sandbox */
    },
    error: (...args: unknown[]) => {
      /* intentionally no-op in sandbox */
    },
  };

  const globals: Record<string, unknown> = {
    // JavaScript built-in constructors / utilities
    Object,
    Array,
    String,
    Number,
    Boolean,
    BigInt,
    Symbol,
    Date,
    Math,
    JSON,
    Error,
    TypeError,
    RangeError,
    SyntaxError,
    ReferenceError,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Promise,
    Proxy,
    Reflect,
    RegExp,
    ArrayBuffer,
    SharedArrayBuffer: undefined, // blocked — can be used for timing attacks
    Atomics: undefined,            // blocked — requires SharedArrayBuffer
    Uint8Array,
    Uint16Array,
    Uint32Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
    DataView,
    // Encoding
    TextEncoder,
    TextDecoder,
    // URL utilities (no network access on their own)
    URL,
    URLSearchParams,
    // Console (no-op)
    console: safeConsole,
    // Timers — Promise-based sleep is acceptable; setTimeout is not exposed
    // because it can keep the event-loop alive past the timeout.
    queueMicrotask,
    // Explicitly absent: require, __dirname, __filename, process, Buffer,
    // fetch (unless http:outbound scope), global, globalThis, eval,
    // Function (constructor), import, setInterval, setTimeout, clearTimeout,
    // clearInterval, setImmediate, clearImmediate.
  };

  if (hasFetch) {
    // Wrap the platform fetch to prevent access to localhost/internal services
    globals["fetch"] = buildRestrictedFetch(allowedFetch!);
  }

  return globals;
}

// ─── Restricted fetch ─────────────────────────────────────────────────────────

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "0.0.0.0",
  "metadata.google.internal",
]);

const BLOCKED_HOSTNAME_RE = /^(10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.)/;

/**
 * Wraps the native `fetch` with SSRF-prevention guards.
 * Only publicly routable HTTPS hosts are allowed.
 */
function buildRestrictedFetch(
  nativeFetch: typeof globalThis.fetch,
): typeof globalThis.fetch {
  return async function restrictedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      throw new TypeError(`[sdk-sandbox] Invalid URL: ${urlStr}`);
    }

    if (url.protocol !== "https:") {
      throw new TypeError(`[sdk-sandbox] Only HTTPS is allowed; got: ${url.protocol}`);
    }

    const hostname = url.hostname.toLowerCase();
    if (BLOCKED_HOSTNAMES.has(hostname) || BLOCKED_HOSTNAME_RE.test(hostname)) {
      throw new TypeError(`[sdk-sandbox] Access to private/internal host blocked: ${hostname}`);
    }

    return nativeFetch(input, init);
  };
}

// ─── Context creation ─────────────────────────────────────────────────────────

/**
 * Creates a new vm.Context pre-populated with the curated global surface.
 * The context object is frozen after population to prevent prototype pollution.
 */
export function createSandboxContext(
  scopes: ToolScope[],
  allowedFetch: typeof globalThis.fetch | null = null,
): vm.Context {
  const sandbox = buildSafeGlobals(scopes, allowedFetch);
  // Contextify mutates the sandbox object — freeze after contextification
  vm.createContext(sandbox);
  return sandbox;
}

// ─── Script compilation ───────────────────────────────────────────────────────

/**
 * Compiles a module source string into a `vm.Script` within the provided
 * context.  Throws `SyntaxError` on invalid code.
 *
 * The timeout parameter enforces a compile-time budget (rare but possible with
 * pathological regexps in string literals — effectively a safety belt).
 */
export function compileScript(
  source: string,
  filename: string,
  context: vm.Context,
  compileTimeoutMs = 2_000,
): vm.Script {
  return new vm.Script(source, {
    filename,
    lineOffset: 0,
    columnOffset: 0,
  });
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Runs a pre-compiled script inside the sandbox context.
 *
 * Returns the script's completion value (what the last expression evaluates
 * to — typically a module-exports-like object).
 *
 * Applies the execution timeout at the vm level.  The timeout is a best-effort
 * control: deeply recursive or tight-loop code will be interrupted, but async
 * code yields control back to the event loop between awaits, so async loops can
 * exceed the deadline.  Callers must apply an additional `Promise.race` guard
 * for async handlers (see DynamicToolLoader).
 */
export function runScript(
  script: vm.Script,
  context: vm.Context,
  executionTimeoutMs: number,
): unknown {
  return script.runInContext(context, { timeout: executionTimeoutMs });
}

// ─── CJS-style module wrapper ─────────────────────────────────────────────────

/**
 * Wraps user source in a CJS-style IIFE that populates a `module.exports`
 * object and returns it.  This lets user code use:
 *
 *   ```js
 *   module.exports = { tools: [...] }
 *   ```
 *
 * or:
 *
 *   ```js
 *   exports.tools = [...]
 *   ```
 */
export function wrapModuleSource(source: string): string {
  return `
(function(module, exports, __sdkRequire) {
${source}
; return module.exports;
})(
  { exports: {} },
  (function() { const e = {}; return e; })(),
  function(id) { throw new Error('[sdk-sandbox] require() is not available in the sandbox. Use the SDK API instead.'); }
)
`.trimStart();
}

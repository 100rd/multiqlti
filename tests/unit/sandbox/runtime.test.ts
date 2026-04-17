/**
 * Tests for server/sandbox/runtime.ts
 *
 * Sections:
 *  1. probeGvisorAvailability — caching, Docker info parsing
 *  2. selectRuntime — gVisor available
 *  3. selectRuntime — gVisor absent (fallback to runc + warning)
 *  4. selectRuntime — explicit runc preference (skip probe)
 *  5. resetRuntimeCache — cache eviction
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  probeGvisorAvailability,
  selectRuntime,
  resetRuntimeCache,
  RUNTIME_RUNSC,
  RUNTIME_RUNC,
} from "../../../server/sandbox/runtime";

// ─── Fake Docker ──────────────────────────────────────────────────────────────

function makeFakeDocker(runtimes: Record<string, unknown> | null, pingFails = false) {
  return {
    ping: pingFails
      ? vi.fn().mockRejectedValue(new Error("Docker not running"))
      : vi.fn().mockResolvedValue(undefined),
    info: runtimes === null
      ? vi.fn().mockRejectedValue(new Error("Docker not running"))
      : vi.fn().mockResolvedValue({ Runtimes: runtimes }),
  };
}

// ─── 1. probeGvisorAvailability ───────────────────────────────────────────────

describe("probeGvisorAvailability", () => {
  beforeEach(() => resetRuntimeCache());

  it("returns true when runsc is listed in Docker runtimes", async () => {
    const docker = makeFakeDocker({ runsc: {}, runc: {} });
    const result = await probeGvisorAvailability(docker as never);
    expect(result).toBe(true);
  });

  it("returns false when runsc is NOT listed in Docker runtimes", async () => {
    const docker = makeFakeDocker({ runc: {} });
    const result = await probeGvisorAvailability(docker as never);
    expect(result).toBe(false);
  });

  it("returns false when Runtimes is empty", async () => {
    const docker = makeFakeDocker({});
    const result = await probeGvisorAvailability(docker as never);
    expect(result).toBe(false);
  });

  it("returns false and does not throw when Docker daemon is unreachable", async () => {
    const docker = makeFakeDocker(null);
    const result = await probeGvisorAvailability(docker as never);
    expect(result).toBe(false);
  });

  it("uses cached result on second call without forceRefresh", async () => {
    const docker = makeFakeDocker({ runsc: {} });
    await probeGvisorAvailability(docker as never);
    await probeGvisorAvailability(docker as never);
    // info should be called only once (second call reads cache)
    expect(docker.info).toHaveBeenCalledTimes(1);
  });

  it("re-probes when forceRefresh is true", async () => {
    const docker = makeFakeDocker({ runsc: {} });
    await probeGvisorAvailability(docker as never);
    await probeGvisorAvailability(docker as never, true);
    expect(docker.info).toHaveBeenCalledTimes(2);
  });
});

// ─── 2. selectRuntime — gVisor available ─────────────────────────────────────

describe("selectRuntime — gVisor available", () => {
  beforeEach(() => resetRuntimeCache());

  it("returns runsc when gVisor is available and no preference given", async () => {
    const docker = makeFakeDocker({ runsc: {}, runc: {} });
    const result = await selectRuntime(docker as never);
    expect(result.name).toBe(RUNTIME_RUNSC);
    expect(result.gvisorAvailable).toBe(true);
    expect(result.usedFallback).toBe(false);
  });

  it("returns runsc when preferred runtime is runsc", async () => {
    const docker = makeFakeDocker({ runsc: {} });
    const result = await selectRuntime(docker as never, RUNTIME_RUNSC);
    expect(result.name).toBe(RUNTIME_RUNSC);
    expect(result.usedFallback).toBe(false);
  });
});

// ─── 3. selectRuntime — gVisor absent (fallback to runc + warning) ────────────

describe("selectRuntime — gVisor absent", () => {
  beforeEach(() => resetRuntimeCache());
  afterEach(() => vi.restoreAllMocks());

  it("falls back to runc when gVisor is not available", async () => {
    const docker = makeFakeDocker({ runc: {} });
    const result = await selectRuntime(docker as never);
    expect(result.name).toBe(RUNTIME_RUNC);
    expect(result.gvisorAvailable).toBe(false);
    expect(result.usedFallback).toBe(true);
  });

  it("emits a console.warn when falling back to runc", async () => {
    const docker = makeFakeDocker({ runc: {} });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await selectRuntime(docker as never);
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toContain("gVisor");
    expect(msg).toContain("runsc");
    expect(msg).toContain("REDUCED isolation");
  });

  it("does NOT warn when gVisor is available", async () => {
    const docker = makeFakeDocker({ runsc: {}, runc: {} });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await selectRuntime(docker as never);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

// ─── 4. selectRuntime — explicit runc preference ──────────────────────────────

describe("selectRuntime — explicit runc preference", () => {
  beforeEach(() => resetRuntimeCache());

  it("always uses runc when explicitly preferred, without probing Docker", async () => {
    const docker = makeFakeDocker({ runsc: {} });
    const result = await selectRuntime(docker as never, RUNTIME_RUNC);
    expect(result.name).toBe(RUNTIME_RUNC);
    expect(result.usedFallback).toBe(false);
    // info should NOT be called since we skipped the probe
    expect(docker.info).not.toHaveBeenCalled();
  });
});

// ─── 5. resetRuntimeCache ─────────────────────────────────────────────────────

describe("resetRuntimeCache", () => {
  it("clears the cached probe result so next call re-probes", async () => {
    // First probe: no gVisor
    const dockerNoGvisor = makeFakeDocker({ runc: {} });
    const r1 = await probeGvisorAvailability(dockerNoGvisor as never);
    expect(r1).toBe(false);

    // Reset and re-probe with gVisor available
    resetRuntimeCache();
    const dockerWithGvisor = makeFakeDocker({ runsc: {}, runc: {} });
    const r2 = await probeGvisorAvailability(dockerWithGvisor as never);
    expect(r2).toBe(true);
  });
});

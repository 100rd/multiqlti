/**
 * gVisor runtime detection and selection.
 *
 * Responsibilities:
 *  - Probe Docker daemon for `runsc` runtime registration
 *  - Return the appropriate runtime string for `docker run --runtime=<…>`
 *  - Fall back to `runc` with a loud console warning when gVisor is absent
 *
 * The probe result is cached for the lifetime of the process so repeated
 * calls do not generate extra Docker API round-trips.
 */

import Docker from "dockerode";
import type { SandboxRuntime } from "@shared/types";

// ─── Constants ────────────────────────────────────────────────────────────────

export const RUNTIME_RUNSC = "runsc" as const;
export const RUNTIME_RUNC = "runc" as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RuntimeInfo {
  /** The runtime name to pass to `docker run --runtime=`. */
  name: SandboxRuntime;
  /** True when gVisor (`runsc`) is available on this host. */
  gvisorAvailable: boolean;
  /** True when gVisor was requested but fell back to runc. */
  usedFallback: boolean;
}

// ─── Internal state ───────────────────────────────────────────────────────────

/** Cached result of the gVisor availability probe. null = not yet probed. */
let cachedGvisorAvailable: boolean | null = null;

// ─── Runtime detection ────────────────────────────────────────────────────────

/**
 * Probe Docker for the `runsc` runtime.
 * Result is cached in-process; pass `forceRefresh` to re-probe (tests only).
 */
export async function probeGvisorAvailability(
  docker: Docker,
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh && cachedGvisorAvailable !== null) {
    return cachedGvisorAvailable;
  }

  try {
    const info = await docker.info();
    const runtimes: Record<string, unknown> = (info.Runtimes as Record<string, unknown>) ?? {};
    cachedGvisorAvailable = RUNTIME_RUNSC in runtimes;
  } catch {
    // Docker daemon not reachable — assume gVisor unavailable
    cachedGvisorAvailable = false;
  }

  return cachedGvisorAvailable;
}

/**
 * Reset the in-process cache.
 * Exposed for testing; do NOT call in production paths.
 */
export function resetRuntimeCache(): void {
  cachedGvisorAvailable = null;
}

// ─── Runtime selection ────────────────────────────────────────────────────────

/**
 * Select the OCI runtime for a sandbox container.
 *
 * Algorithm:
 *  1. If `preferred` is `runc` → always use runc (caller explicitly opted out).
 *  2. If `preferred` is `runsc` (or unset) → probe Docker for gVisor.
 *     - gVisor present  → use `runsc`
 *     - gVisor absent   → use `runc` + emit warning
 *
 * @param docker       Dockerode instance for probing
 * @param preferred    Caller's preferred runtime (undefined = prefer runsc)
 * @param forceRefresh Re-probe even if cache is warm (tests only)
 */
export async function selectRuntime(
  docker: Docker,
  preferred?: SandboxRuntime,
  forceRefresh = false,
): Promise<RuntimeInfo> {
  if (preferred === RUNTIME_RUNC) {
    return { name: RUNTIME_RUNC, gvisorAvailable: false, usedFallback: false };
  }

  const gvisorAvailable = await probeGvisorAvailability(docker, forceRefresh);

  if (gvisorAvailable) {
    return { name: RUNTIME_RUNSC, gvisorAvailable: true, usedFallback: false };
  }

  // gVisor requested but unavailable — fall back with loud warning
  console.warn(
    "[sandbox/runtime] WARNING: gVisor (runsc) was requested but is NOT " +
      "registered in the Docker daemon. Falling back to runc. " +
      "Untrusted code will have REDUCED isolation. " +
      "Install gVisor and register it in /etc/docker/daemon.json to eliminate this warning.",
  );

  return { name: RUNTIME_RUNC, gvisorAvailable: false, usedFallback: true };
}

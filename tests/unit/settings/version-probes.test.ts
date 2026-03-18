/**
 * Unit tests for the version probe functions exported from server/routes/settings.ts
 *
 * These tests run in isolation — no real network calls or child processes are spawned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mocks declared before any imports ───────────────────────────────────────

vi.mock("../../../server/db.js", () => ({
  db: {
    select: () => ({ from: () => Promise.resolve([]) }),
    insert: () => ({ values: () => ({ onConflictDoUpdate: () => Promise.resolve() }) }),
    delete: () => ({ where: () => Promise.resolve() }),
    execute: () => Promise.resolve([]),
  },
}));

vi.mock("../../../server/crypto.js", () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ""),
}));

const { mockSpawnSync } = vi.hoisted(() => {
  return { mockSpawnSync: vi.fn() };
});

vi.mock("child_process", () => ({
  spawnSync: mockSpawnSync,
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import {
  probeDockerVersion,
  probeVllmVersion,
  probeOllamaVersion,
  extractPostgresVersion,
} from "../../../server/routes/settings.js";

// ─── extractPostgresVersion ───────────────────────────────────────────────────

describe("extractPostgresVersion", () => {
  it("extracts major.minor from a full PostgreSQL version string", () => {
    const raw = "PostgreSQL 16.1 on x86_64-pc-linux-gnu, compiled by gcc (GCC) 12.3.0, 64-bit";
    expect(extractPostgresVersion(raw)).toBe("16.1");
  });

  it("extracts version from shorter string", () => {
    expect(extractPostgresVersion("PostgreSQL 15.4")).toBe("15.4");
  });

  it("returns null for an unrecognisable string", () => {
    expect(extractPostgresVersion("some random text")).toBeNull();
  });

  it("handles empty string", () => {
    expect(extractPostgresVersion("")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(extractPostgresVersion("postgresql 14.10 on linux")).toBe("14.10");
  });
});

// ─── probeDockerVersion ───────────────────────────────────────────────────────

describe("probeDockerVersion", () => {
  beforeEach(() => {
    mockSpawnSync.mockReset();
  });

  it("returns trimmed version string when docker is available", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "24.0.5\n",
      stderr: "",
      error: undefined,
    });
    expect(probeDockerVersion()).toBe("24.0.5");
  });

  it("returns null when binary is not found (spawnSync error)", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: new Error("ENOENT"),
    });
    expect(probeDockerVersion()).toBeNull();
  });

  it("returns null when exit status is non-zero", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "Cannot connect to Docker daemon",
      error: undefined,
    });
    expect(probeDockerVersion()).toBeNull();
  });

  it("returns null when stdout is empty", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "",
      stderr: "",
      error: undefined,
    });
    expect(probeDockerVersion()).toBeNull();
  });

  it("returns null when spawnSync throws", () => {
    mockSpawnSync.mockImplementation(() => {
      throw new Error("Unexpected error");
    });
    expect(probeDockerVersion()).toBeNull();
  });
});

// ─── probeVllmVersion ────────────────────────────────────────────────────────

describe("probeVllmVersion", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("returns null when VLLM_BASE_URL is not set", async () => {
    delete process.env.VLLM_BASE_URL;
    const result = await probeVllmVersion();
    expect(result).toBeNull();
  });

  it("returns version string on successful fetch", async () => {
    process.env.VLLM_BASE_URL = "http://localhost:8000";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "0.4.1" }),
    });
    const result = await probeVllmVersion();
    expect(result).toBe("0.4.1");
  });

  it("returns null on fetch error", async () => {
    process.env.VLLM_BASE_URL = "http://localhost:8000";
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Network error"));
    const result = await probeVllmVersion();
    expect(result).toBeNull();
  });

  it("returns null when response is not ok", async () => {
    process.env.VLLM_BASE_URL = "http://localhost:8000";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });
    const result = await probeVllmVersion();
    expect(result).toBeNull();
  });

  it("returns null when version field is missing from response", async () => {
    process.env.VLLM_BASE_URL = "http://localhost:8000";
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });
    const result = await probeVllmVersion();
    expect(result).toBeNull();
  });
});

// ─── probeOllamaVersion ───────────────────────────────────────────────────────

describe("probeOllamaVersion", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  it("returns version string on successful fetch", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "0.1.27" }),
    });
    const result = await probeOllamaVersion();
    expect(result).toBe("0.1.27");
  });

  it("returns null on fetch error", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("Connection refused"));
    const result = await probeOllamaVersion();
    expect(result).toBeNull();
  });

  it("uses OLLAMA_BASE_URL env var when set", async () => {
    process.env.OLLAMA_BASE_URL = "http://custom-ollama:11434";
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ version: "0.2.0" }),
    });
    vi.stubGlobal("fetch", mockFetch);
    await probeOllamaVersion();
    expect(mockFetch).toHaveBeenCalledWith(
      "http://custom-ollama:11434/api/version",
      expect.any(Object),
    );
  });

  it("returns null when response is not ok", async () => {
    (fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      json: () => Promise.resolve({}),
    });
    const result = await probeOllamaVersion();
    expect(result).toBeNull();
  });
});

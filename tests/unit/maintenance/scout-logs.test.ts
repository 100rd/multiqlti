/**
 * Unit tests for scanProductionLogs (Phase 6.11)
 *
 * Mocks fs/promises and global fetch. No real I/O occurs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile, realpath } from "fs/promises";
import path from "path";

// ── Mock fs/promises ──────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
  realpath: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);
const mockRealpath = vi.mocked(realpath);

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { scanProductionLogs } from "../../../server/maintenance/scout.js";
import type { LogSourceConfig } from "@shared/types";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = "/app/workspace";

function fileConfig(relPath: string): LogSourceConfig {
  return { type: "file", path: path.join(WORKSPACE, relPath) };
}

function httpConfig(url: string, headers?: Record<string, string>): LogSourceConfig {
  return { type: "http", url, headers };
}

function okTextFetch(text: string): Response {
  return {
    ok: true,
    text: async () => text,
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanProductionLogs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: realpath resolves to the input path (identity for test paths)
    mockRealpath.mockImplementation(async (p: unknown) => p as string);
  });

  // ── File source ─────────────────────────────────────────────────────────────

  describe("file source", () => {
    it("returns empty array when path is missing", async () => {
      const cfg: LogSourceConfig = { type: "file" };
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", cfg);
      expect(findings).toEqual([]);
    });

    it("returns empty array when file cannot be read", async () => {
      mockReadFile.mockRejectedValue(new Error("ENOENT"));
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));
      expect(findings).toEqual([]);
    });

    it("blocks path traversal outside workspace", async () => {
      // realpath identity mock: /etc/passwd stays as /etc/passwd, not under /app/workspace
      const cfg: LogSourceConfig = { type: "file", path: "/etc/passwd" };
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", cfg);
      expect(findings).toHaveLength(1);
      expect(findings[0].severity).toBe("high");
      expect(findings[0].title).toContain("traversal");
      expect(findings[0].category).toBe("log_analysis");
    });

    it("returns empty array for clean logs", async () => {
      mockReadFile.mockResolvedValue("INFO Server started\nINFO Request processed\n");
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));
      expect(findings).toEqual([]);
    });

    it("detects OOM events as critical", async () => {
      mockReadFile.mockResolvedValue(
        "2024-01-01T10:00:00 INFO starting\n2024-01-01T10:01:00 FATAL Out of memory: Kill process\n",
      );
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));

      const oomFinding = findings.find((f) => f.title.toLowerCase().includes("out-of-memory"));
      expect(oomFinding).toBeDefined();
      expect(oomFinding?.severity).toBe("critical");
      expect(oomFinding?.category).toBe("log_analysis");
    });

    it("detects crash loop as high severity", async () => {
      mockReadFile.mockResolvedValue(
        "2024-01-01T10:00:00 WARNING CrashLoopBackOff detected for container app\n",
      );
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));

      const crashFinding = findings.find((f) => f.title.toLowerCase().includes("crash"));
      expect(crashFinding).toBeDefined();
      expect(crashFinding?.severity).toBe("high");
    });

    it("detects error spike as high severity", async () => {
      // >10 error lines without timestamps (no 5-min window) → total count check
      const logLines = Array.from({ length: 15 }, (_, i) => `line ${i}: error occurred`).join("\n");
      mockReadFile.mockResolvedValue(logLines);
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));

      const spikeFinding = findings.find((f) => f.title.toLowerCase().includes("error spike"));
      expect(spikeFinding).toBeDefined();
      expect(spikeFinding?.severity).toBe("high");
    });

    it("detects repeated exception as medium severity", async () => {
      const lines = Array.from({ length: 8 }, () => "2024-01-01 WARN NullPointerException: ref was null").join("\n");
      mockReadFile.mockResolvedValue(lines);
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));

      const exFinding = findings.find((f) => f.title.includes("NullPointerException"));
      expect(exFinding).toBeDefined();
      expect(exFinding?.severity).toBe("medium");
    });

    it("does not flag repeated exception when count ≤5", async () => {
      const lines = Array.from({ length: 5 }, () => "2024-01-01 WARN NullPointerException: ref was null").join("\n");
      mockReadFile.mockResolvedValue(lines);
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", fileConfig("logs/app.log"));

      const exFinding = findings.find((f) => f.title.includes("NullPointerException"));
      expect(exFinding).toBeUndefined();
    });

    it("sets correct scanId and status on findings", async () => {
      mockReadFile.mockResolvedValue("FATAL OOMKilled container");
      const findings = await scanProductionLogs(WORKSPACE, "scan-99", fileConfig("logs/app.log"));
      expect(findings[0].scanId).toBe("scan-99");
      expect(findings[0].status).toBe("open");
    });
  });

  // ── HTTP source ─────────────────────────────────────────────────────────────

  describe("http source", () => {
    it("returns empty array when url is missing", async () => {
      const cfg: LogSourceConfig = { type: "http" };
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", cfg);
      expect(findings).toEqual([]);
    });

    it("returns empty array when fetch fails", async () => {
      // "https://logs.example.com/app" is a safe external URL
      mockFetch.mockRejectedValue(new Error("Connection refused"));
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("https://logs.example.com/app"));
      expect(findings).toEqual([]);
    });

    it("returns empty array when fetch returns non-ok", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 } as unknown as Response);
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("https://logs.example.com/app"));
      expect(findings).toEqual([]);
    });

    it("analyzes log text fetched from HTTP", async () => {
      mockFetch.mockResolvedValue(okTextFetch("FATAL out of memory: Kill process\n"));
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("https://logs.example.com/app.log"));
      const oomFinding = findings.find((f) => f.title.toLowerCase().includes("out-of-memory"));
      expect(oomFinding).toBeDefined();
      expect(oomFinding?.severity).toBe("critical");
    });

    it("sends custom headers to fetch", async () => {
      mockFetch.mockResolvedValue(okTextFetch("INFO ok"));
      const headers = { Authorization: "Bearer token123" };
      await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("https://logs.example.com/app.log", headers));
      expect(mockFetch).toHaveBeenCalledWith(
        "https://logs.example.com/app.log",
        expect.objectContaining({ headers }),
      );
    });

    it("blocks private IP URL with SSRF protection finding", async () => {
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("http://169.254.169.254/latest/meta-data/"));
      expect(findings).toHaveLength(1);
      expect(findings[0].title).toContain("SSRF");
      expect(findings[0].severity).toBe("high");
    });

    it("blocks localhost URL with SSRF protection finding", async () => {
      const findings = await scanProductionLogs(WORKSPACE, "scan-1", httpConfig("http://localhost:9200/logs"));
      expect(findings).toHaveLength(1);
      expect(findings[0].title).toContain("SSRF");
    });
  });
});

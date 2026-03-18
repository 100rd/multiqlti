/**
 * Unit tests for scanContainerImages (Phase 6.11)
 *
 * Mocks child_process (for safeExec/trivy/which) and fs/promises.
 * No real Docker or Trivy calls occur.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFile } from "fs/promises";

// ── Mock fs/promises ──────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);

// ── Mock child_process ────────────────────────────────────────────────────────

type ExecCallback = (err: Error | null, result: { stdout: string } | null) => void;

// We need different responses per command. Use a map indexed by command.
const execResponses = new Map<string, { stdout: string } | Error>();

vi.mock("child_process", () => ({
  execFile: (
    cmd: string,
    _args: string[],
    _options: unknown,
    callback: ExecCallback,
  ) => {
    const result = execResponses.get(cmd);
    if (result instanceof Error) {
      callback(result, null);
    } else if (result) {
      callback(null, result);
    } else {
      // default: success with empty stdout
      callback(null, { stdout: "" });
    }
  },
}));

import { scanContainerImages } from "../../../server/maintenance/scout.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const WORKSPACE = "/app/workspace";

function makeTrivyReport(vulns: Array<{ id: string; severity: string; pkg?: string }>): string {
  return JSON.stringify({
    Results: [
      {
        Target: "image:latest (ubuntu 22.04)",
        Vulnerabilities: vulns.map((v) => ({
          VulnerabilityID: v.id,
          Severity: v.severity,
          PkgName: v.pkg ?? "libssl",
          Title: `Vulnerability ${v.id}`,
          Description: `Description for ${v.id}`,
        })),
      },
    ],
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanContainerImages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execResponses.clear();
    mockReadFile.mockRejectedValue(new Error("ENOENT")); // default: no files
  });

  it("returns empty array when no Dockerfile or docker-compose.yml", async () => {
    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toEqual([]);
  });

  it("extracts image from Dockerfile FROM line", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM node:18-alpine\nRUN npm install\n";
      }
      throw new Error("ENOENT");
    });
    // trivy not found
    execResponses.set("which", new Error("not found"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toHaveLength(1);
    expect(findings[0].category).toBe("container_scan");
    expect(findings[0].severity).toBe("info");
    expect(findings[0].title).toContain("Trivy");
    expect(findings[0].currentValue).toBe("node:18-alpine");
  });

  it("extracts multiple images from multi-stage Dockerfile", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM node:18-alpine AS builder\nFROM nginx:latest AS runner\n";
      }
      throw new Error("ENOENT");
    });
    execResponses.set("which", new Error("not found"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    // Two images → two "install trivy" info findings
    expect(findings).toHaveLength(2);
    const images = findings.map((f) => f.currentValue);
    expect(images).toContain("node:18-alpine");
    expect(images).toContain("nginx:latest");
  });

  it("extracts images from docker-compose.yml", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("docker-compose.yml")) {
        return `
services:
  web:
    image: nginx:1.25
  db:
    image: postgres:16
`;
      }
      throw new Error("ENOENT");
    });
    execResponses.set("which", new Error("not found"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toHaveLength(2);
    const images = findings.map((f) => f.currentValue);
    expect(images).toContain("nginx:1.25");
    expect(images).toContain("postgres:16");
  });

  it("deduplicates images appearing in both Dockerfile and compose", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM node:18-alpine\n";
      }
      if ((filePath as string).endsWith("docker-compose.yml")) {
        return `
services:
  app:
    image: node:18-alpine
`;
      }
      throw new Error("ENOENT");
    });
    execResponses.set("which", new Error("not found"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    // Should produce only 1 info finding for node:18-alpine (deduplicated)
    const nodeFindings = findings.filter((f) => f.currentValue === "node:18-alpine");
    expect(nodeFindings).toHaveLength(1);
  });

  it("produces info finding when trivy is not installed", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM alpine:3.18\n";
      }
      throw new Error("ENOENT");
    });
    execResponses.set("which", new Error("not found"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("info");
    expect(findings[0].category).toBe("container_scan");
  });

  it("runs trivy and maps CRITICAL severity", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM ubuntu:22.04\n";
      }
      throw new Error("ENOENT");
    });
    // trivy found
    execResponses.set("which", { stdout: "/usr/bin/trivy\n" });
    execResponses.set("trivy", { stdout: makeTrivyReport([{ id: "CVE-2024-1234", severity: "CRITICAL" }]) });

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("container_scan");
    expect(findings[0].title).toContain("CVE-2024-1234");
  });

  it("runs trivy and maps HIGH severity", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) return "FROM ubuntu:22.04\n";
      throw new Error("ENOENT");
    });
    execResponses.set("which", { stdout: "/usr/bin/trivy\n" });
    execResponses.set("trivy", { stdout: makeTrivyReport([{ id: "CVE-2024-5678", severity: "HIGH" }]) });

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings[0].severity).toBe("high");
  });

  it("returns empty findings when trivy reports no vulnerabilities", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) return "FROM alpine:3.18\n";
      throw new Error("ENOENT");
    });
    execResponses.set("which", { stdout: "/usr/bin/trivy\n" });
    execResponses.set("trivy", {
      stdout: JSON.stringify({ Results: [{ Target: "alpine:3.18", Vulnerabilities: [] }] }),
    });

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toEqual([]);
  });

  it("handles trivy returning null/empty output gracefully", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) return "FROM alpine:3.18\n";
      throw new Error("ENOENT");
    });
    execResponses.set("which", { stdout: "/usr/bin/trivy\n" });
    execResponses.set("trivy", new Error("trivy timeout"));

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toEqual([]);
  });

  it("ignores scratch base image", async () => {
    mockReadFile.mockImplementation(async (filePath) => {
      if ((filePath as string).endsWith("Dockerfile")) {
        return "FROM scratch\nCOPY app /app\n";
      }
      throw new Error("ENOENT");
    });

    const findings = await scanContainerImages(WORKSPACE, "scan-1");
    expect(findings).toEqual([]);
  });
});

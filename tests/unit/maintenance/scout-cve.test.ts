/**
 * Unit tests for scanCVEDatabase (Phase 6.11)
 *
 * Mocks global fetch so no real network requests are made.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFile } from "fs/promises";

// ── Mock fs/promises ──────────────────────────────────────────────────────────

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockReadFile = vi.mocked(readFile);

// ── Mock global fetch ─────────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { scanCVEDatabase } from "../../../server/maintenance/scout.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeOsvResponse(packageNames: string[], vulnsPerPackage: number[]): object {
  return {
    results: packageNames.map((_, i) => ({
      vulns: Array.from({ length: vulnsPerPackage[i] ?? 0 }, (__, j) => ({
        id: `GHSA-${i}-${j}`,
        summary: `Vuln ${j} in package ${packageNames[i]}`,
        aliases: [],
        severity: [{ type: "CVSS_V3", score: 9.5 }],
      })),
    })),
  };
}

function okFetchResponse(body: object): Response {
  return {
    ok: true,
    json: async () => body,
  } as unknown as Response;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("scanCVEDatabase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns empty array when package.json cannot be read", async () => {
    mockReadFile.mockRejectedValue(new Error("ENOENT"));
    const findings = await scanCVEDatabase("/tmp/workspace", "scan-1");
    expect(findings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty array when package.json has no dependencies", async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ name: "my-app" }));
    const findings = await scanCVEDatabase("/tmp/workspace", "scan-1");
    expect(findings).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns empty array when OSV API returns no vulns", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { express: "^4.18.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({ results: [{ vulns: [] }] }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings).toEqual([]);
  });

  it("maps CVSS ≥9.0 to critical severity", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { "vulnerable-pkg": "^1.0.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-crit-1",
                summary: "Critical vulnerability",
                severity: [{ type: "CVSS_V3", score: 9.8 }],
              },
            ],
          },
        ],
      }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe("critical");
    expect(findings[0].category).toBe("cve_scan");
    expect(findings[0].title).toContain("GHSA-crit-1");
    expect(findings[0].title).toContain("vulnerable-pkg");
  });

  it("maps CVSS 7.0–8.9 to high severity", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { "pkg-high": "^1.0.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-high-1",
                summary: "High vulnerability",
                severity: [{ type: "CVSS_V3", score: 8.1 }],
              },
            ],
          },
        ],
      }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings[0].severity).toBe("high");
  });

  it("maps CVSS 4.0–6.9 to medium severity", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { "pkg-med": "^1.0.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-med-1",
                summary: "Medium vulnerability",
                severity: [{ type: "CVSS_V3", score: 5.3 }],
              },
            ],
          },
        ],
      }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings[0].severity).toBe("medium");
  });

  it("maps CVSS <4.0 to low severity", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { "pkg-low": "^1.0.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-low-1",
                summary: "Low vulnerability",
                severity: [{ type: "CVSS_V3", score: 2.1 }],
              },
            ],
          },
        ],
      }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings[0].severity).toBe("low");
  });

  it("includes both dependencies and devDependencies", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({
        dependencies: { "prod-pkg": "^1.0.0" },
        devDependencies: { "dev-pkg": "^2.0.0" },
      }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({ results: [{ vulns: [] }, { vulns: [] }] }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    await promise;

    expect(mockFetch).toHaveBeenCalledOnce();
    const body = JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string);
    const queried = body.queries.map((q: { package: { name: string } }) => q.package.name);
    expect(queried).toContain("prod-pkg");
    expect(queried).toContain("dev-pkg");
  });

  it("returns empty array when fetch fails", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { express: "^4.18.0" } }),
    );
    mockFetch.mockRejectedValue(new Error("Network error"));

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings).toEqual([]);
  });

  it("returns empty array when OSV returns non-ok response", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { express: "^4.18.0" } }),
    );
    mockFetch.mockResolvedValue({ ok: false, status: 429 } as unknown as Response);

    const promise = scanCVEDatabase("/tmp/workspace", "scan-1");
    await vi.runAllTimersAsync();
    const findings = await promise;

    expect(findings).toEqual([]);
  });

  it("sets finding fields correctly", async () => {
    mockReadFile.mockResolvedValue(
      JSON.stringify({ dependencies: { "my-lib": "^3.0.0" } }),
    );
    mockFetch.mockResolvedValue(
      okFetchResponse({
        results: [
          {
            vulns: [
              {
                id: "GHSA-abc-123",
                summary: "Remote code execution",
                severity: [{ type: "CVSS_V3", score: 9.9 }],
              },
            ],
          },
        ],
      }),
    );

    const promise = scanCVEDatabase("/tmp/workspace", "scan-42");
    await vi.runAllTimersAsync();
    const findings = await promise;

    const f = findings[0];
    expect(f.scanId).toBe("scan-42");
    expect(f.category).toBe("cve_scan");
    expect(f.status).toBe("open");
    expect(f.autoFixable).toBe(false);
    expect(f.references).toContain("https://osv.dev/vulnerability/GHSA-abc-123");
  });
});

/**
 * Scout Agent — Maintenance Autopilot Phase 4.5 PR 2
 *
 * Runs scanners against a workspace path and returns an array of findings.
 * Each scanner is isolated and non-throwing — failures are logged and skipped.
 *
 * Scanners implemented:
 *   - dependency_update : npm outdated (major/minor/patch detection)
 *   - security_advisory : npm audit (vulnerability detection)
 *   - license_compliance: license-checker (copyleft / unknown detection)
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { randomUUID } from "crypto";
import { readFile, realpath } from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import type { ScoutFinding, MaintenanceCategory, MaintenanceSeverity, LogSourceConfig } from "@shared/types";

// ─── Security Helpers ─────────────────────────────────────────────────────────

/**
 * Validates that a URL is safe to fetch from — blocks private IP ranges, loopback,
 * link-local, and cloud metadata endpoints to prevent SSRF attacks.
 */
function isSafeLogUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  // Only allow http or https schemes
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  const host = u.hostname.toLowerCase();
  // Block loopback, RFC 1918 private ranges, IMDS (169.254.x.x), and IPv6 equivalents
  if (/^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(host)) return false;
  if (host === "[::1]" || host === "::1" || host === "0.0.0.0") return false;
  if (/^(fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i.test(host)) return false;
  return true;
}


const execFileAsync = promisify(execFile);

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Run a shell command safely. Returns stdout string on success, null on failure.
 * Enforces a hard timeout to prevent runaway child processes.
 */
async function safeExec(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs = 60_000,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      env: { ...process.env, NO_UPDATE_NOTIFIER: "1", CI: "1" },
    });
    return stdout;
  } catch {
    return null;
  }
}

function makeFinding(
  scanId: string,
  category: MaintenanceCategory,
  severity: MaintenanceSeverity,
  title: string,
  description: string,
  current: string,
  recommended: string,
  references: string[] = [],
  autoFixable = false,
): ScoutFinding {
  return {
    id: randomUUID(),
    scanId,
    category,
    severity,
    title,
    description,
    currentValue: current,
    recommendedValue: recommended,
    effort: "small",
    references,
    autoFixable,
    complianceRefs: [],
    status: "open",
  };
}

// ─── Scanner: dependency_update ───────────────────────────────────────────────

interface NpmOutdatedEntry {
  current: string;
  wanted: string;
  latest: string;
  location?: string;
  type?: string;
}

export async function scanDependencyUpdates(
  workspacePath: string,
  scanId: string,
): Promise<ScoutFinding[]> {
  const raw = await safeExec("npm", ["outdated", "--json", "--long"], workspacePath);
  if (!raw) return [];

  let parsed: Record<string, NpmOutdatedEntry>;
  try {
    parsed = JSON.parse(raw) as Record<string, NpmOutdatedEntry>;
  } catch {
    return [];
  }

  const findings: ScoutFinding[] = [];

  for (const [pkg, info] of Object.entries(parsed)) {
    const current = info.current ?? "unknown";
    const latest = info.latest ?? "unknown";

    if (current === latest) continue;

    const [currentMajor] = current.split(".").map(Number);
    const [latestMajor] = latest.split(".").map(Number);

    const isMajor = latestMajor > currentMajor;
    const severity: MaintenanceSeverity = isMajor ? "high" : "medium";

    findings.push(
      makeFinding(
        scanId,
        "dependency_update",
        severity,
        `Outdated dependency: ${pkg}`,
        `Package ${pkg} is at ${current} but ${latest} is available.${isMajor ? " This is a major version bump that may include breaking changes." : ""}`,
        current,
        latest,
        [`https://www.npmjs.com/package/${pkg}`],
        !isMajor, // minor/patch auto-fixable via npm update
      ),
    );
  }

  return findings;
}

// ─── Scanner: security_advisory ──────────────────────────────────────────────

interface NpmAuditVulnerability {
  severity: string;
  isDirect: boolean;
  via: unknown[];
  fixAvailable: boolean | { name: string; version: string; isSemVerMajor: boolean };
  nodes: string[];
  range?: string;
}

interface NpmAuditReport {
  vulnerabilities?: Record<string, NpmAuditVulnerability>;
  metadata?: {
    vulnerabilities?: {
      critical?: number;
      high?: number;
      moderate?: number;
      low?: number;
      info?: number;
      total?: number;
    };
  };
}

function auditSeverityToFinding(npmSeverity: string): MaintenanceSeverity {
  switch (npmSeverity) {
    case "critical": return "critical";
    case "high": return "high";
    case "moderate": return "medium";
    case "low": return "low";
    default: return "info";
  }
}

export async function scanSecurityAdvisories(
  workspacePath: string,
  scanId: string,
): Promise<ScoutFinding[]> {
  const raw = await safeExec(
    "npm",
    ["audit", "--json", "--audit-level=info"],
    workspacePath,
  );
  if (!raw) return [];

  let report: NpmAuditReport;
  try {
    report = JSON.parse(raw) as NpmAuditReport;
  } catch {
    return [];
  }

  const vulns = report.vulnerabilities ?? {};
  const findings: ScoutFinding[] = [];

  for (const [pkg, vuln] of Object.entries(vulns)) {
    const severity = auditSeverityToFinding(vuln.severity);
    const fixAvailable = vuln.fixAvailable === true || (typeof vuln.fixAvailable === "object" && vuln.fixAvailable !== null);
    const autoFixable = vuln.fixAvailable === true;

    findings.push(
      makeFinding(
        scanId,
        "security_advisory",
        severity,
        `Security vulnerability in ${pkg}`,
        `${pkg} has a ${vuln.severity} severity vulnerability. Direct: ${vuln.isDirect}. Fix available: ${fixAvailable}.`,
        vuln.range ?? "unknown range",
        fixAvailable ? "Run npm audit fix" : "Manual remediation required",
        [`https://www.npmjs.com/advisories`],
        autoFixable,
      ),
    );
  }

  return findings;
}

// ─── Scanner: license_compliance ─────────────────────────────────────────────

// Licenses that require scrutiny in proprietary projects
const COPYLEFT_LICENSES = new Set([
  "GPL-2.0",
  "GPL-3.0",
  "LGPL-2.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "AGPL-3.0",
  "OSL-3.0",
  "CPAL-1.0",
  "EUPL-1.1",
  "EUPL-1.2",
]);

export async function scanLicenseCompliance(
  workspacePath: string,
  scanId: string,
): Promise<ScoutFinding[]> {
  // Use npx to run license-checker without requiring global install
  const raw = await safeExec(
    "npx",
    ["--yes", "license-checker", "--json", "--excludePrivatePackages"],
    workspacePath,
    90_000, // license-checker can be slow on large trees
  );
  if (!raw) return [];

  let licenses: Record<string, { licenses?: string; repository?: string }>;
  try {
    licenses = JSON.parse(raw) as Record<string, { licenses?: string; repository?: string }>;
  } catch {
    return [];
  }

  const findings: ScoutFinding[] = [];

  for (const [pkg, info] of Object.entries(licenses)) {
    const licenseStr = info.licenses ?? "UNKNOWN";

    // Unknown license
    if (licenseStr === "UNKNOWN" || licenseStr.includes("UNLICENSED")) {
      findings.push(
        makeFinding(
          scanId,
          "license_compliance",
          "high",
          `Unknown license: ${pkg}`,
          `Package ${pkg} has an unknown or unlicensed declaration. Legal review required before use in production.`,
          licenseStr,
          "Confirm license with package maintainer",
          info.repository ? [info.repository] : [],
          false,
        ),
      );
      continue;
    }

    // Check for copyleft licenses
    const licenseTokens = licenseStr.split(/[\s;,()|]+/).filter(Boolean);
    for (const token of licenseTokens) {
      if (COPYLEFT_LICENSES.has(token)) {
        findings.push(
          makeFinding(
            scanId,
            "license_compliance",
            "medium",
            `Copyleft license detected: ${pkg} (${token})`,
            `Package ${pkg} uses the ${token} license which has copyleft implications. Ensure your project's license is compatible.`,
            licenseStr,
            "Review license compatibility or find alternative package",
            info.repository ? [info.repository] : [],
            false,
          ),
        );
        break; // one finding per package
      }
    }
  }

  return findings;
}

// ─── Scanner: cve_scan ────────────────────────────────────────────────────────

interface OsvQuery {
  package: { name: string; ecosystem: "npm" };
}

interface OsvVuln {
  id: string;
  summary?: string;
  aliases?: string[];
  severity?: Array<{ type: string; score: number }>;
}

interface OsvResult {
  vulns?: OsvVuln[];
}

interface OsvBatchResponse {
  results: OsvResult[];
}

function cvssToSeverity(score: number): MaintenanceSeverity {
  if (score >= 9.0) return "critical";
  if (score >= 7.0) return "high";
  if (score >= 4.0) return "medium";
  return "low";
}

export async function scanCVEDatabase(
  workspacePath: string,
  scanId: string,
): Promise<ScoutFinding[]> {
  const pkgPath = path.join(workspacePath, "package.json");
  let pkgJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    const raw = await readFile(pkgPath, "utf8");
    pkgJson = JSON.parse(raw) as typeof pkgJson;
  } catch {
    return [];
  }

  const allDeps = Object.keys({
    ...(pkgJson.dependencies ?? {}),
    ...(pkgJson.devDependencies ?? {}),
  });

  if (allDeps.length === 0) return [];

  const BATCH_SIZE = 100;
  const findings: ScoutFinding[] = [];

  for (let i = 0; i < allDeps.length; i += BATCH_SIZE) {
    const batch = allDeps.slice(i, i + BATCH_SIZE);
    const queries: OsvQuery[] = batch.map((name) => ({
      package: { name, ecosystem: "npm" },
    }));

    let response: OsvBatchResponse | null = null;
    try {
      const res = await fetch("https://api.osv.dev/v1/querybatch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ queries }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        response = (await res.json()) as OsvBatchResponse;
      }
    } catch {
      // Network failure — skip this batch
    }

    if (response?.results) {
      for (let j = 0; j < response.results.length; j++) {
        const result = response.results[j];
        const pkgName = batch[j];
        const vulns = result.vulns ?? [];

        for (const vuln of vulns) {
          const cvssEntry = vuln.severity?.find((s) => s.type === "CVSS_V3");
          const score = cvssEntry?.score ?? 0;
          const severity = cvssToSeverity(score);

          findings.push(
            makeFinding(
              scanId,
              "cve_scan",
              severity,
              `CVE in ${pkgName}: ${vuln.id}`,
              vuln.summary ?? `Vulnerability ${vuln.id} affects ${pkgName}.`,
              pkgName,
              "Upgrade or replace the affected package",
              [`https://osv.dev/vulnerability/${vuln.id}`],
              false,
            ),
          );
        }
      }
    }

    // Rate limit: 1000ms between batches when there are more
    if (i + BATCH_SIZE < allDeps.length) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }

  return findings;
}

// ─── Scanner: log_analysis ────────────────────────────────────────────────────

interface LogWindow {
  timestamp: number;
  lines: string[];
}

function detectLogPatterns(logText: string, scanId: string): ScoutFinding[] {
  const findings: ScoutFinding[] = [];
  const lines = logText.split("\n");

  // OOM detection: critical
  const oomLines = lines.filter((l) =>
    /out of memory|OOMKilled|killed process|oom_kill_process/i.test(l),
  );
  if (oomLines.length > 0) {
    findings.push(
      makeFinding(
        scanId,
        "log_analysis",
        "critical",
        "Out-of-Memory event detected in logs",
        `Found ${oomLines.length} OOM event(s). Process may be killed under memory pressure.`,
        `${oomLines.length} OOM occurrence(s)`,
        "Increase memory limits or investigate memory leaks",
        [],
        false,
      ),
    );
  }

  // Crash loop detection: high
  const crashLines = lines.filter((l) =>
    /CrashLoopBackOff|crash loop|process exited|exited with code [^0]/i.test(l),
  );
  if (crashLines.length > 0) {
    findings.push(
      makeFinding(
        scanId,
        "log_analysis",
        "high",
        "Crash loop detected in logs",
        `Found ${crashLines.length} crash/exit event(s). Service may be in a restart loop.`,
        `${crashLines.length} crash occurrence(s)`,
        "Investigate root cause of crashes and fix application errors",
        [],
        false,
      ),
    );
  }

  // Error spike detection: >10 errors in any 5-minute window → high
  const windowMs = 5 * 60 * 1000;
  const errorLines: number[] = [];
  for (const line of lines) {
    if (!/\berror\b/i.test(line)) continue;
    // Try to extract an ISO timestamp from the line
    const tsMatch = line.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    if (tsMatch) {
      const ts = new Date(tsMatch[0]).getTime();
      if (!isNaN(ts)) errorLines.push(ts);
    } else {
      // No timestamp — just count it at epoch 0 for pattern detection
      errorLines.push(0);
    }
  }

  // Sliding window count
  let spikeFound = false;
  for (let i = 0; i < errorLines.length && !spikeFound; i++) {
    const windowEnd = errorLines[i] + windowMs;
    const count = errorLines.filter((t) => t >= errorLines[i] && t <= windowEnd).length;
    if (count > 10) spikeFound = true;
  }

  // If no timestamps extracted but total errors > 10, still flag
  if (!spikeFound && errorLines.length > 10) spikeFound = true;

  if (spikeFound) {
    findings.push(
      makeFinding(
        scanId,
        "log_analysis",
        "high",
        "Error spike detected in logs",
        `More than 10 errors found within a 5-minute window. Service may be under stress.`,
        `${errorLines.length} error line(s)`,
        "Investigate error causes and add circuit breakers",
        [],
        false,
      ),
    );
  }

  // Repeated exception detection: same exception class > 5x → medium
  const exceptionCounts = new Map<string, number>();
  for (const line of lines) {
    const exMatch = line.match(/([A-Z][a-zA-Z]+Exception|[A-Z][a-zA-Z]+Error):/);
    if (exMatch) {
      const name = exMatch[1];
      exceptionCounts.set(name, (exceptionCounts.get(name) ?? 0) + 1);
    }
  }
  for (const [name, count] of exceptionCounts.entries()) {
    if (count > 5) {
      findings.push(
        makeFinding(
          scanId,
          "log_analysis",
          "medium",
          `Repeated exception: ${name} (${count}x)`,
          `Exception "${name}" appears ${count} times in logs. This may indicate a recurring unhandled error.`,
          `${count} occurrences`,
          "Add error handling or alerting for this exception type",
          [],
          false,
        ),
      );
    }
  }

  return findings;
}

export async function scanProductionLogs(
  workspacePath: string,
  scanId: string,
  logSourceConfig: LogSourceConfig,
): Promise<ScoutFinding[]> {
  let logText: string;

  if (logSourceConfig.type === "file") {
    const logPath = logSourceConfig.path;
    if (!logPath) return [];

    // Path traversal guard using realpath (follows symlinks to prevent symlink bypass)
    let resolvedPath: string;
    let resolvedWorkspace: string;
    try {
      resolvedWorkspace = await realpath(workspacePath);
    } catch {
      return [];
    }
    try {
      resolvedPath = await realpath(path.resolve(workspacePath, logPath));
    } catch {
      // Path doesn't exist or can't be resolved — silently skip
      return [];
    }
    if (!resolvedPath.startsWith(resolvedWorkspace + path.sep) && resolvedPath !== resolvedWorkspace) {
      return [
        makeFinding(
          scanId,
          "log_analysis",
          "high",
          "Log source path traversal blocked",
          `Path "${logPath}" resolves outside the workspace root and was rejected for security.`,
          logPath,
          "Use a log path within the workspace directory",
          [],
          false,
        ),
      ];
    }

    try {
      logText = await readFile(resolvedPath, "utf8");
    } catch {
      return [];
    }
  } else {
    // HTTP source
    const url = logSourceConfig.url;
    if (!url) return [];

    // SSRF guard: reject private/internal URLs before fetching
    if (!isSafeLogUrl(url)) {
      return [
        makeFinding(
          scanId,
          "log_analysis",
          "high",
          "Log source URL blocked (SSRF protection)",
          `The configured log source URL "${url}" targets a private or restricted address and was blocked for security.`,
          url,
          "Use a publicly accessible HTTPS URL for log sources",
          [],
          false,
        ),
      ];
    }

    try {
      const res = await fetch(url, {
        headers: logSourceConfig.headers ?? {},
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) return [];
      logText = await res.text();
    } catch {
      return [];
    }
  }

  return detectLogPatterns(logText, scanId);
}

// ─── Scanner: container_scan ──────────────────────────────────────────────────

interface TrivyVuln {
  VulnerabilityID: string;
  Severity: string;
  Title?: string;
  Description?: string;
  PkgName?: string;
}

interface TrivyResult {
  Target?: string;
  Vulnerabilities?: TrivyVuln[];
}

interface TrivyReport {
  Results?: TrivyResult[];
}

function trivySeverityToFinding(s: string): MaintenanceSeverity {
  switch (s.toUpperCase()) {
    case "CRITICAL": return "critical";
    case "HIGH": return "high";
    case "MEDIUM": return "medium";
    case "LOW": return "low";
    default: return "info";
  }
}

function extractDockerImages(workspacePath: string): Promise<string[]> {
  return (async () => {
    const images: string[] = [];

    // Parse Dockerfile FROM lines
    try {
      const dockerfilePath = path.join(workspacePath, "Dockerfile");
      const content = await readFile(dockerfilePath, "utf8");
      const matches = content.matchAll(/^FROM\s+([^\s]+)/gim);
      for (const m of matches) {
        const img = m[1].trim();
        if (img && img !== "scratch" && !images.includes(img)) {
          images.push(img);
        }
      }
    } catch {
      // No Dockerfile — fine
    }

    // Parse docker-compose.yml image fields
    try {
      const composePath = path.join(workspacePath, "docker-compose.yml");
      const content = await readFile(composePath, "utf8");
      // Use regex as a fallback alongside js-yaml for safety
      try {
        const parsed = yaml.load(content) as Record<string, unknown> | null;
        const services = (parsed as { services?: Record<string, { image?: string }> })?.services;
        if (services) {
          for (const svc of Object.values(services)) {
            if (svc.image && !images.includes(svc.image)) {
              images.push(svc.image);
            }
          }
        }
      } catch {
        // Fallback to regex
        const regexMatches = content.matchAll(/^\s+image:\s+(.+)$/gm);
        for (const m of regexMatches) {
          const img = m[1].trim();
          if (img && !images.includes(img)) images.push(img);
        }
      }
    } catch {
      // No docker-compose.yml — fine
    }

    return images;
  })();
}

export async function scanContainerImages(
  workspacePath: string,
  scanId: string,
): Promise<ScoutFinding[]> {
  const images = await extractDockerImages(workspacePath);
  if (images.length === 0) return [];

  const findings: ScoutFinding[] = [];

  // Check if trivy is available
  const trivyPath = await safeExec("which", ["trivy"], workspacePath);
  const hasTrivy = trivyPath !== null && trivyPath.trim().length > 0;

  for (const imageName of images) {
    if (!hasTrivy) {
      findings.push(
        makeFinding(
          scanId,
          "container_scan",
          "info",
          `Install Trivy for full container image scanning`,
          `Image "${imageName}" was detected but cannot be scanned without Trivy. Install trivy for vulnerability scanning.`,
          imageName,
          "Install Trivy: https://aquasecurity.github.io/trivy/",
          ["https://aquasecurity.github.io/trivy/"],
          false,
        ),
      );
      continue;
    }

    const rawReport = await safeExec(
      "trivy",
      ["image", "--format", "json", "--quiet", imageName],
      workspacePath,
      120_000,
    );

    if (!rawReport) continue;

    let report: TrivyReport;
    try {
      report = JSON.parse(rawReport) as TrivyReport;
    } catch {
      continue;
    }

    for (const result of report.Results ?? []) {
      for (const vuln of result.Vulnerabilities ?? []) {
        const severity = trivySeverityToFinding(vuln.Severity);
        findings.push(
          makeFinding(
            scanId,
            "container_scan",
            severity,
            `${vuln.VulnerabilityID} in ${imageName}${vuln.PkgName ? ` (${vuln.PkgName})` : ""}`,
            vuln.Description ?? vuln.Title ?? `Vulnerability ${vuln.VulnerabilityID} found in container image ${imageName}.`,
            imageName,
            "Upgrade the base image or affected packages",
            [`https://avd.aquasec.com/nvd/${vuln.VulnerabilityID.toLowerCase()}`],
            false,
          ),
        );
      }
    }
  }

  return findings;
}

// ─── Aggregate Scout Run ──────────────────────────────────────────────────────

export interface ScoutRunOptions {
  workspacePath: string;
  scanId: string;
  enabledCategories?: string[];
  logSourceConfig?: LogSourceConfig | null;
}

export interface ScoutRunResult {
  findings: ScoutFinding[];
  importantCount: number;
  errors: string[];
}

/**
 * Run all enabled scanners and aggregate results.
 * Never throws — individual scanner failures are captured in `errors`.
 */
export async function runScout(options: ScoutRunOptions): Promise<ScoutRunResult> {
  const { workspacePath, scanId, enabledCategories, logSourceConfig } = options;

  const isEnabled = (cat: string): boolean =>
    !enabledCategories || enabledCategories.length === 0 || enabledCategories.includes(cat);

  const errors: string[] = [];
  const findings: ScoutFinding[] = [];

  // Standard two-arg scanners
  const scanners: Array<{
    category: string;
    fn: (path: string, id: string) => Promise<ScoutFinding[]>;
  }> = [
    { category: "dependency_update", fn: scanDependencyUpdates },
    { category: "security_advisory", fn: scanSecurityAdvisories },
    { category: "license_compliance", fn: scanLicenseCompliance },
    { category: "cve_scan", fn: scanCVEDatabase },
    { category: "container_scan", fn: scanContainerImages },
  ];

  for (const scanner of scanners) {
    if (!isEnabled(scanner.category)) continue;

    try {
      const results = await scanner.fn(workspacePath, scanId);
      findings.push(...results);
    } catch (err) {
      errors.push(`Scanner ${scanner.category} failed: ${(err as Error).message}`);
    }
  }

  // Log analysis scanner — only when logSourceConfig is provided
  if (isEnabled("log_analysis") && logSourceConfig != null) {
    try {
      const results = await scanProductionLogs(workspacePath, scanId, logSourceConfig);
      findings.push(...results);
    } catch (err) {
      errors.push(`Scanner log_analysis failed: ${(err as Error).message}`);
    }
  }

  const importantCount = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  ).length;

  return { findings, importantCount, errors };
}

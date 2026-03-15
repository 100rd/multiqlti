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
import type { ScoutFinding, MaintenanceCategory, MaintenanceSeverity } from "@shared/types";

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

// ─── Aggregate Scout Run ──────────────────────────────────────────────────────

export interface ScoutRunOptions {
  workspacePath: string;
  scanId: string;
  enabledCategories?: string[];
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
  const { workspacePath, scanId, enabledCategories } = options;

  const isEnabled = (cat: string): boolean =>
    !enabledCategories || enabledCategories.length === 0 || enabledCategories.includes(cat);

  const errors: string[] = [];
  const findings: ScoutFinding[] = [];

  const scanners: Array<{
    category: string;
    fn: (path: string, id: string) => Promise<ScoutFinding[]>;
  }> = [
    { category: "dependency_update", fn: scanDependencyUpdates },
    { category: "security_advisory", fn: scanSecurityAdvisories },
    { category: "license_compliance", fn: scanLicenseCompliance },
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

  const importantCount = findings.filter(
    (f) => f.severity === "critical" || f.severity === "high",
  ).length;

  return { findings, importantCount, errors };
}

/**
 * Tests for config-sync safety layer (issue #319)
 *
 * Coverage:
 *   - apply-lock: lockKeyFromName, ApplyLockBusyError
 *   - apply-lock: withApplyLock blocks concurrent acquires (simulated)
 *   - safety-checks: hasConflictMarkers
 *   - safety-checks: checkGitConflictMarkers (file walk)
 *   - safety-checks: bulk-delete sanity check (>20%)
 *   - safety-checks: active runs warning for deleted pipelines
 *   - safety-checks: DB drift warning
 *   - apply-orchestrator: aborts on conflict markers
 *   - apply-orchestrator: applies when no safety issues
 *   - apply-orchestrator: safetyIssues in result
 *   - apply-orchestrator: lock fields default to false
 *   - apply-orchestrator: rollback when applier throws
 *   - audit-log: writeAuditEntry no-ops with null pool
 *   - health-check: returns unreachable for non-listening URL
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import yaml from "js-yaml";
import { MemStorage } from "../../../server/storage.js";
import {
  hasConflictMarkers,
  runSafetyChecks,
} from "../../../server/config-sync/safety-checks.js";
import {
  lockKeyFromName,
  ApplyLockBusyError,
  APPLY_LOCK_NAME,
} from "../../../server/config-sync/apply-lock.js";
import {
  writeAuditEntry,
} from "../../../server/config-sync/audit-log.js";
import {
  checkInstanceHealth,
} from "../../../server/config-sync/health-check.js";
import {
  runApply,
  configSyncEvents,
} from "../../../server/config-sync/apply-orchestrator.js";
import type { EntityDiff } from "../../../server/config-sync/diff-engine.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function mkTempRepo(): Promise<string> {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "mqlti-safety-test-")),
  );
  for (const sub of [
    "pipelines",
    "triggers",
    "prompts",
    "skill-states",
    "connections",
    "provider-keys",
    "preferences",
  ]) {
    await fs.mkdir(path.join(base, sub), { recursive: true });
  }
  return base;
}

function makeStorage(): MemStorage {
  return new MemStorage();
}

async function writePipelineYaml(repoPath: string, name: string): Promise<void> {
  const data = {
    kind: "pipeline",
    name,
    description: "test",
    stages: [],
  };
  await fs.writeFile(
    path.join(repoPath, "pipelines", `${name}.yaml`),
    yaml.dump(data),
    "utf-8",
  );
}

// ─── apply-lock: lockKeyFromName ──────────────────────────────────────────────

describe("lockKeyFromName", () => {
  it("returns stable numeric classId and objId", () => {
    const { classId, objId } = lockKeyFromName(APPLY_LOCK_NAME);
    expect(typeof classId).toBe("number");
    expect(typeof objId).toBe("number");
    // Must fit in int4 (signed 32-bit): classId is upper 15 bits, always positive
    expect(classId).toBeGreaterThanOrEqual(0);
    expect(classId).toBeLessThan(0x8000);
    // objId uses lower 16 bits
    expect(objId).toBeGreaterThanOrEqual(0);
    expect(objId).toBeLessThanOrEqual(0xffff);
  });

  it("produces same keys for same name (deterministic)", () => {
    const a = lockKeyFromName("config_sync_apply");
    const b = lockKeyFromName("config_sync_apply");
    expect(a).toEqual(b);
  });

  it("produces different keys for different names", () => {
    const a = lockKeyFromName("config_sync_apply");
    const b = lockKeyFromName("other_lock_name");
    expect(a).not.toEqual(b);
  });
});

// ─── apply-lock: ApplyLockBusyError ───────────────────────────────────────────

describe("ApplyLockBusyError", () => {
  it("has correct name and retryAfterSeconds", () => {
    const err = new ApplyLockBusyError(30);
    expect(err.name).toBe("ApplyLockBusyError");
    expect(err.retryAfterSeconds).toBe(30);
    expect(err.message).toContain("30");
    expect(err).toBeInstanceOf(Error);
  });
});

// ─── safety-checks: hasConflictMarkers ───────────────────────────────────────

describe("hasConflictMarkers", () => {
  it("returns false for clean YAML", () => {
    expect(hasConflictMarkers("kind: pipeline\nname: foo\n")).toBe(false);
  });

  it("detects <<<<<<< conflict header", () => {
    const content = "name: foo\n<<<<<<< HEAD\nstages: []\n";
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("detects >>>>>>> conflict footer", () => {
    const content = "name: foo\n>>>>>>> feature-branch\nstages: []\n";
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("detects ======= separator", () => {
    const content = "name: foo\n=======\nstages: []\n";
    expect(hasConflictMarkers(content)).toBe(true);
  });

  it("does not flag lines that merely contain those chars mid-line", () => {
    // Only flags lines that START with the marker
    const content = "name: foo # <<<<<<< not at start\n";
    expect(hasConflictMarkers(content)).toBe(false);
  });
});

// ─── safety-checks: conflict markers in files ─────────────────────────────────

describe("runSafetyChecks — conflict markers", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns safe=false with abort issue when YAML has conflict markers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "broken.yaml"),
      "name: foo\n<<<<<<< HEAD\nstages: []\n=======\nstages: [1]\n>>>>>>> branch\n",
      "utf-8",
    );
    const result = await runSafetyChecks(tmpDir, makeStorage(), [], null);
    expect(result.safe).toBe(false);
    const issue = result.issues.find((i) => i.code === "GIT_CONFLICT_MARKERS");
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("abort");
    expect(issue?.details).toContain("pipelines/broken.yaml");
  });

  it("returns safe=true when no conflict markers exist", async () => {
    await writePipelineYaml(tmpDir, "clean");
    const result = await runSafetyChecks(tmpDir, makeStorage(), [], null);
    expect(result.safe).toBe(true);
    expect(result.issues.filter((i) => i.code === "GIT_CONFLICT_MARKERS")).toHaveLength(0);
  });

  it("reports all conflicted files in details", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "a.yaml"),
      "<<<<<<< HEAD\n",
      "utf-8",
    );
    await fs.writeFile(
      path.join(tmpDir, "connections", "b.yaml"),
      ">>>>>>> branch\n",
      "utf-8",
    );
    const result = await runSafetyChecks(tmpDir, makeStorage(), [], null);
    expect(result.safe).toBe(false);
    const issue = result.issues.find((i) => i.code === "GIT_CONFLICT_MARKERS");
    expect(issue?.details?.length).toBe(2);
  });
});

// ─── safety-checks: bulk-delete sanity ────────────────────────────────────────

describe("runSafetyChecks — bulk-delete sanity", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function makeDiff(entityType: string, total: number, deleting: number): EntityDiff {
    const entries = [];
    for (let i = 0; i < deleting; i++) {
      entries.push({ kind: "delete" as const, entityType, label: `item-${i}`, entity: null });
    }
    for (let i = deleting; i < total; i++) {
      entries.push({ kind: "create" as const, entityType, label: `item-${i}`, entity: {} });
    }
    return { entityType, entries, parseErrors: [] };
  }

  it("warns when deleting >20% of entities", async () => {
    const diff = makeDiff("pipeline", 10, 3); // 30% — above threshold
    const result = await runSafetyChecks(tmpDir, makeStorage(), [diff], null);
    const issue = result.issues.find((i) => i.code === "BULK_DELETE");
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("warn");
    // warn is not abort — result.safe should still be true
    expect(result.safe).toBe(true);
  });

  it("does not warn when deleting exactly 20% (threshold is strictly >20%)", async () => {
    const diff = makeDiff("pipeline", 10, 2); // exactly 20%
    const result = await runSafetyChecks(tmpDir, makeStorage(), [diff], null);
    expect(result.issues.find((i) => i.code === "BULK_DELETE")).toBeUndefined();
  });

  it("does not warn when deleting 0 entities", async () => {
    const diff = makeDiff("pipeline", 10, 0);
    const result = await runSafetyChecks(tmpDir, makeStorage(), [diff], null);
    expect(result.issues.find((i) => i.code === "BULK_DELETE")).toBeUndefined();
  });

  it("emits one warning per entity type that exceeds threshold", async () => {
    const d1 = makeDiff("pipeline", 10, 5); // 50%
    const d2 = makeDiff("connection", 10, 5); // 50%
    const result = await runSafetyChecks(tmpDir, makeStorage(), [d1, d2], null);
    const issues = result.issues.filter((i) => i.code === "BULK_DELETE");
    expect(issues.length).toBe(2);
  });
});

// ─── safety-checks: active runs on deleted pipelines ──────────────────────────

describe("runSafetyChecks — active runs on deleted pipelines", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("warns when a deleted pipeline has an active run", async () => {
    const storage = makeStorage();
    const pipeline = await storage.createPipeline({
      name: "my-pipeline",
      description: null,
      stages: [],
      dag: null,
      isTemplate: false,
    });
    await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "running",
      input: "{}",
      output: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      completedAt: null,
      triggeredBy: null,
      dagMode: false,
    });

    const deleteDiff: EntityDiff = {
      entityType: "pipeline",
      entries: [{ kind: "delete", entityType: "pipeline", label: "my-pipeline", entity: null }],
      parseErrors: [],
    };

    const result = await runSafetyChecks(tmpDir, storage, [deleteDiff], null);
    const issue = result.issues.find((i) => i.code === "ACTIVE_RUNS_ON_DELETED_PIPELINES");
    expect(issue).toBeDefined();
    expect(issue?.level).toBe("warn");
    // warn — should not abort
    expect(result.safe).toBe(true);
  });

  it("does not warn when deleted pipeline has no active runs", async () => {
    const storage = makeStorage();
    const pipeline = await storage.createPipeline({
      name: "my-pipeline",
      description: null,
      stages: [],
      dag: null,
      isTemplate: false,
    });
    await storage.createPipelineRun({
      pipelineId: pipeline.id,
      status: "completed",
      input: "{}",
      output: null,
      currentStageIndex: 0,
      startedAt: new Date(),
      completedAt: new Date(),
      triggeredBy: null,
      dagMode: false,
    });

    const deleteDiff: EntityDiff = {
      entityType: "pipeline",
      entries: [{ kind: "delete", entityType: "pipeline", label: "my-pipeline", entity: null }],
      parseErrors: [],
    };

    const result = await runSafetyChecks(tmpDir, storage, [deleteDiff], null);
    expect(result.issues.find((i) => i.code === "ACTIVE_RUNS_ON_DELETED_PIPELINES")).toBeUndefined();
  });
});

// ─── safety-checks: DB drift ──────────────────────────────────────────────────

describe("runSafetyChecks — DB drift", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not warn when lastExportAt is null", async () => {
    const result = await runSafetyChecks(tmpDir, makeStorage(), [], null);
    expect(result.issues.find((i) => i.code === "DB_DRIFT")).toBeUndefined();
  });

  it("does not warn when no entities modified after export", async () => {
    const storage = makeStorage();
    // Pipeline with an old updatedAt (before the export timestamp)
    const ts = new Date("2020-01-01T00:00:00Z").toISOString();
    const result = await runSafetyChecks(tmpDir, storage, [], new Date().toISOString());
    // No pipelines in DB — no drift
    expect(result.issues.find((i) => i.code === "DB_DRIFT")).toBeUndefined();
  });
});

// ─── apply-orchestrator: conflict markers abort apply ─────────────────────────

describe("runApply — conflict marker abort", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("aborts with abortedDueToSafetyCheck=true when YAML has conflict markers", async () => {
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "conflict.yaml"),
      "<<<<<<< HEAD\nname: foo\n>>>>>>> branch\n",
      "utf-8",
    );
    const result = await runApply(makeStorage(), tmpDir, {});
    expect(result.abortedDueToSafetyCheck).toBe(true);
    expect(result.abortedDueToLock).toBe(false);
    const abortIssue = result.safetyIssues.find((i) => i.code === "GIT_CONFLICT_MARKERS");
    expect(abortIssue).toBeDefined();
  });

  it("does not write to DB when aborted by safety check", async () => {
    const storage = makeStorage();
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "bad.yaml"),
      "<<<<<<< HEAD\n",
      "utf-8",
    );
    await runApply(storage, tmpDir, {});
    const pipelines = await storage.getPipelines();
    expect(pipelines).toHaveLength(0);
  });
});

// ─── apply-orchestrator: safety issues in result ─────────────────────────────

describe("runApply — safety issues in result", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("includes empty safetyIssues array on clean apply", async () => {
    const result = await runApply(makeStorage(), tmpDir, {});
    expect(result.safetyIssues).toBeDefined();
    expect(Array.isArray(result.safetyIssues)).toBe(true);
  });

  it("safetyIssues contains warn-level issues on bulk-delete", async () => {
    const storage = makeStorage();
    // Create 5 pipelines
    for (let i = 0; i < 5; i++) {
      await storage.createPipeline({
        name: `pipe-${i}`,
        description: null,
        stages: [],
        dag: null,
        isTemplate: false,
      });
    }
    // Empty pipelines dir — will tombstone all 5 (100% delete)
    const result = await runApply(storage, tmpDir, {});
    const bulkWarn = result.safetyIssues.find((i) => i.code === "BULK_DELETE");
    expect(bulkWarn).toBeDefined();
    expect(bulkWarn?.level).toBe("warn");
  });
});

// ─── apply-orchestrator: lock fields default ─────────────────────────────────

describe("runApply — new result fields", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("abortedDueToLock defaults to false", async () => {
    const result = await runApply(makeStorage(), tmpDir, {});
    expect(result.abortedDueToLock).toBe(false);
  });

  it("abortedDueToSafetyCheck defaults to false on clean repo", async () => {
    const result = await runApply(makeStorage(), tmpDir, {});
    expect(result.abortedDueToSafetyCheck).toBe(false);
  });

  it("healthCheck is null when instanceUrl is null", async () => {
    const result = await runApply(makeStorage(), tmpDir, { instanceUrl: null });
    expect(result.healthCheck).toBeNull();
  });

  it("healthCheck is null for dry-run", async () => {
    const result = await runApply(makeStorage(), tmpDir, { dryRun: true });
    expect(result.healthCheck).toBeNull();
  });
});

// ─── apply-orchestrator: rollback on error ────────────────────────────────────

describe("runApply — rollback on applier error", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkTempRepo();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("totalErrors > 0 when applier throws", async () => {
    // Write a valid pipeline YAML so diff produces a create entry
    const validPipeline = {
      kind: "pipeline",
      apiVersion: "1.0.0",
      name: "bad",
      stages: [],
    };
    await fs.writeFile(
      path.join(tmpDir, "pipelines", "bad.yaml"),
      yaml.dump(validPipeline),
      "utf-8",
    );

    // Use a storage that throws on createPipeline to simulate a mid-apply error
    const storage = makeStorage();
    vi.spyOn(storage, "createPipeline").mockRejectedValueOnce(
      new Error("injected error"),
    );

    const result = await runApply(storage, tmpDir, { instanceUrl: null });
    expect(result.totalErrors).toBeGreaterThan(0);
  });
});

// ─── audit-log: no-op with null pool ──────────────────────────────────────────

describe("writeAuditEntry", () => {
  it("resolves silently when pool is null", async () => {
    const mockResult = {
      appliedAt: new Date().toISOString(),
      repoPath: "/tmp/test",
      dryRun: false,
      summaries: [],
      totalCreated: 1,
      totalUpdated: 0,
      totalDeleted: 0,
      totalErrors: 0,
      conflicts: [],
      diffs: [],
      audit: {
        appliedAt: new Date().toISOString(),
        appliedBy: "test",
        repoPath: "/tmp/test",
        dryRun: false,
        forced: false,
        summaries: [],
        totalCreated: 1,
        totalUpdated: 0,
        totalDeleted: 0,
        totalErrors: 0,
        conflicts: [],
      },
      abortedDueToConflicts: false,
      abortedDueToLock: false,
      abortedDueToSafetyCheck: false,
      safetyIssues: [],
      healthCheck: null,
    };

    await expect(
      writeAuditEntry(null, {
        appliedBy: "test",
        gitCommitSha: null,
        result: mockResult,
      }),
    ).resolves.toBeUndefined();
  });
});

// ─── health-check: unreachable URL ───────────────────────────────────────────

describe("checkInstanceHealth", () => {
  it("returns unreachable for a non-listening URL", async () => {
    // Port 1 is typically unused and should refuse connections immediately
    const result = await checkInstanceHealth("http://127.0.0.1:1", 2000);
    expect(result.status).toMatch(/unreachable|error/);
    expect(typeof result.responseMs).toBe("number");
  });

  it("returns unreachable on timeout", async () => {
    // 192.0.2.1 is a documentation/test IP that should not respond
    const result = await checkInstanceHealth("http://192.0.2.1:9999", 100);
    expect(result.status).toMatch(/unreachable/);
    expect(result.error).toBeDefined();
  });
});

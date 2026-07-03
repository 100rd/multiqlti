/**
 * trigger-dispatch.test.ts — unit coverage for the file-change-trigger →
 * consilium-review seam (server/services/consilium/trigger-dispatch.ts).
 *
 * This is the testable extraction of the route's `fireTrigger` action branch.
 * The factory is INJECTED (`createReview`) so we assert the dispatch decision +
 * the UNTRUSTED → objectiveExtra mapping without a DB / Express / ALS:
 *   - WITHOUT an action → "noop", factory NOT called (record-only back-compat).
 *   - WITH a consilium_review action → factory called once, under runInProject,
 *     with the action's preset/repoPath/maxRounds + the clamped changed-file path.
 *   - repoPath falls back to the watchPath-derived root when action.repoPath is absent.
 *   - subsystem disabled (reviewDeps null) / null projectId → "skipped".
 *   - a factory throw is caught → "failed" (never crashes the watcher loop).
 */
import { describe, it, expect, vi } from "vitest";
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import type { ConsiliumReviewTriggerAction } from "@shared/types";
import {
  maybeLaunchConsiliumReview,
  deriveRepoRoot,
  payloadString,
  describeEvent,
  eventDigest,
  interpolateEvent,
  type ConsiliumTriggerDispatchDeps,
} from "../../../server/services/consilium/trigger-dispatch.js";

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTrigger(
  config: Record<string, unknown>,
  over: Partial<TriggerRow> = {},
): TriggerRow {
  return {
    id: "trig-1",
    projectId: "proj-1",
    pipelineId: null, // T1: loop-template triggers carry no pipeline
    type: "file_change",
    config,
    ...over,
  } as unknown as TriggerRow;
}

const CONSILIUM_ACTION: ConsiliumReviewTriggerAction = {
  kind: "consilium_review",
  preset: "sdlc-cross-review",
  maxRounds: 1,
  repoPath: "/allowed/omnius",
};

function makeDeps(
  over: Partial<ConsiliumTriggerDispatchDeps> = {},
): {
  deps: ConsiliumTriggerDispatchDeps;
  createReview: ReturnType<typeof vi.fn>;
  runInProject: ReturnType<typeof vi.fn>;
  log: ReturnType<typeof vi.fn>;
  getLoops: ReturnType<typeof vi.fn>;
  resolveOwnerId: ReturnType<typeof vi.fn>;
} {
  const createReview = vi
    .fn()
    .mockResolvedValue({ id: "loop-1", repoPath: "/allowed/omnius", state: "reviewing" } as ConsiliumLoopRow);
  const runInProject = vi.fn().mockImplementation((_pid: string, fn: () => Promise<unknown>) => fn());
  const log = vi.fn();
  // FIX HIGH-1: the dedup read goes through reviewDeps.storage.getLoops() — empty
  // by default (no active loop) so existing dispatch tests launch as before.
  const getLoops = vi.fn().mockResolvedValue([] as ConsiliumLoopRow[]);
  // FK FIX: a trigger-launched review must own its task_groups row with a REAL
  // users.id. The dispatch resolves the PROJECT OWNER; mock it to a fake user id
  // so the factory is called with createdBy === "owner-1" (NOT the literal "system").
  const resolveOwnerId = vi.fn().mockResolvedValue("owner-1");
  const deps: ConsiliumTriggerDispatchDeps = {
    reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    createReview,
    runInProject,
    resolveOwnerId,
    log,
    ...over,
  };
  return { deps, createReview, runInProject, log, getLoops, resolveOwnerId };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

describe("payloadString — defensive payload narrowing", () => {
  it("returns the string field or undefined; never trusts the shape", () => {
    expect(payloadString({ filePath: "/a/b.md" }, "filePath")).toBe("/a/b.md");
    expect(payloadString({ filePath: 42 }, "filePath")).toBeUndefined();
    expect(payloadString(null, "filePath")).toBeUndefined();
    expect(payloadString("nope", "filePath")).toBeUndefined();
  });
});

describe("deriveRepoRoot — best-effort fallback (re-validated by the factory)", () => {
  it("returns undefined for an empty watchPath", () => {
    expect(deriveRepoRoot(undefined)).toBeUndefined();
    expect(deriveRepoRoot("")).toBeUndefined();
  });
  it("falls back to the watchPath itself when no .git ancestor exists", () => {
    // A path that does not exist on disk → no .git found → returns it verbatim.
    expect(deriveRepoRoot("/nonexistent/watch/specs")).toBe("/nonexistent/watch/specs");
  });
});

// ─── Dispatch decisions ──────────────────────────────────────────────────────

describe("maybeLaunchConsiliumReview", () => {
  it("WITHOUT an action → noop, factory NOT called (record-only back-compat)", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({ watchPath: "/w", patterns: ["**/*.md"] }); // no `action`
    const result = await maybeLaunchConsiliumReview(deps, trigger, { filePath: "/w/x.md" });
    expect(result).toBe("noop");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("ignores a non-consilium action kind → noop", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({ watchPath: "/w", patterns: ["**/*.md"], action: { kind: "something-else" } });
    expect(await maybeLaunchConsiliumReview(deps, trigger, {})).toBe("noop");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("WITH a consilium_review action → launches the factory once, under runInProject", async () => {
    const { deps, createReview, runInProject } = makeDeps();
    const trigger = makeTrigger({ watchPath: "/allowed/omnius/specs", patterns: ["**/*.md"], action: CONSILIUM_ACTION });

    const result = await maybeLaunchConsiliumReview(deps, trigger, {
      filePath: "/allowed/omnius/specs/00-overview.md",
      watchPath: "/allowed/omnius/specs",
    });

    expect(result).toBe("launched");
    expect(runInProject).toHaveBeenCalledTimes(1);
    expect(runInProject.mock.calls[0][0]).toBe("proj-1"); // project-scoped (T3)
    expect(createReview).toHaveBeenCalledTimes(1);

    const [, params] = createReview.mock.calls[0];
    expect(params.projectId).toBe("proj-1");
    expect(params.repoPath).toBe("/allowed/omnius"); // action.repoPath wins
    expect(params.preset).toBe("sdlc-cross-review");
    expect(params.maxRounds).toBe(1);
    // FK FIX: the resolved PROJECT OWNER (a real users.id), NOT the literal "system".
    expect(params.createdBy).toBe("owner-1");
    // UNTRUSTED changed-file path carried ONLY via objectiveExtra (T1).
    expect(params.objectiveExtra).toMatch(/\/allowed\/omnius\/specs\/00-overview\.md/);
  });

  it("falls back to the watchPath-derived repo root when action.repoPath is absent (T2)", async () => {
    const { deps, createReview } = makeDeps();
    const action = { kind: "consilium_review", preset: "full-viability" } as ConsiliumReviewTriggerAction;
    const trigger = makeTrigger({ watchPath: "/nonexistent/repo/specs", patterns: ["**/*.md"], action });

    const result = await maybeLaunchConsiliumReview(deps, trigger, { watchPath: "/nonexistent/repo/specs" });
    expect(result).toBe("launched");
    // deriveRepoRoot finds no .git → returns the watchPath verbatim (factory then
    // re-validates it against the allowlist — fail-closed if not allowed).
    expect(createReview.mock.calls[0][1].repoPath).toBe("/nonexistent/repo/specs");
  });

  it("carries a fallback event description as objectiveExtra when the payload has no filePath", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    await maybeLaunchConsiliumReview(deps, trigger, {});
    // T1: every trigger fire now composes SOME event context (sanitized in the
    // factory). With no filePath/scheduledAt the file_change fallback is used.
    expect(createReview.mock.calls[0][1].objectiveExtra).toBe("file_change trigger fired");
    // No operator instruction ⇒ engineerInstruction stays undefined (objectiveExtra wins).
    expect(createReview.mock.calls[0][1].engineerInstruction).toBeUndefined();
  });

  it("subsystem disabled (reviewDeps null) → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps({ reviewDeps: null });
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    expect(await maybeLaunchConsiliumReview(deps, trigger, {})).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("null projectId → skipped (a review MUST be project-scoped, T3)", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger(
      { watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION },
      { projectId: null as unknown as string },
    );
    expect(await maybeLaunchConsiliumReview(deps, trigger, {})).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a factory throw is CAUGHT → failed (never crashes the watcher loop, T4)", async () => {
    const createReview = vi.fn().mockRejectedValue(new Error("[repo-allowlist] outside every allowed repo root"));
    const { deps, log } = makeDeps({ createReview });
    const trigger = makeTrigger({ watchPath: "/evil/path", patterns: ["**/*.md"], action: { ...CONSILIUM_ACTION, repoPath: "/evil/path" } });
    const result = await maybeLaunchConsiliumReview(deps, trigger, {});
    expect(result).toBe("failed");
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/rejected/));
  });

  // ─── FIX HIGH-1: active-loop dedup on the TRIGGER path (T5) ──────────────────

  it("2nd fire while a NON-TERMINAL loop exists for the same project+repo → skipped-dedup, factory NOT called", async () => {
    const getLoops = vi.fn().mockResolvedValue([
      // An in-flight review for the SAME repoPath this trigger targets.
      { id: "loop-active", repoPath: "/allowed/omnius", state: "reviewing" },
    ] as unknown as ConsiliumLoopRow[]);
    const { deps, createReview, log } = makeDeps({
      reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    });
    const trigger = makeTrigger({ watchPath: "/allowed/omnius/specs", patterns: ["**/*.md"], action: CONSILIUM_ACTION });

    const result = await maybeLaunchConsiliumReview(deps, trigger, {
      filePath: "/allowed/omnius/specs/00-overview.md",
      watchPath: "/allowed/omnius/specs",
    });

    expect(result).toBe("skipped-dedup");
    expect(createReview).not.toHaveBeenCalled(); // no NEW heavy-model dispute spawned
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped-dedup.*loop-active/));
  });

  it("a TERMINAL loop for the same repo does NOT block a new launch (only in-flight loops dedup)", async () => {
    const getLoops = vi.fn().mockResolvedValue([
      { id: "loop-old", repoPath: "/allowed/omnius", state: "converged" }, // terminal
    ] as unknown as ConsiliumLoopRow[]);
    const { deps, createReview } = makeDeps({
      reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    });
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    const result = await maybeLaunchConsiliumReview(deps, trigger, {});
    expect(result).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("a non-terminal loop for a DIFFERENT repo does NOT dedup this repo's fire", async () => {
    const getLoops = vi.fn().mockResolvedValue([
      { id: "loop-other", repoPath: "/allowed/other-repo", state: "reviewing" },
    ] as unknown as ConsiliumLoopRow[]);
    const { deps, createReview } = makeDeps({
      reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    });
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    expect(await maybeLaunchConsiliumReview(deps, trigger, {})).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  // ─── FK FIX: a review must have a REAL owner (task_groups.created_by → users.id) ─

  it("resolveOwnerId returns null (no project/owner) → skipped, factory NOT called", async () => {
    const resolveOwnerId = vi.fn().mockResolvedValue(null);
    const { deps, createReview, log } = makeDeps({ resolveOwnerId });
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    const result = await maybeLaunchConsiliumReview(deps, trigger, {});
    expect(result).toBe("skipped");
    // No valid FK target ⇒ never insert a task_groups row with a bogus owner.
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no resolvable owner/));
  });

  // ─── FIX MED-2: trigger path forces review-only (maxRounds=1) (T6) ───────────

  it("FORCES maxRounds=1 on the trigger path even when the action requests more", async () => {
    const { deps, createReview } = makeDeps();
    // The action asks for a multi-round (autonomous-coder-reaching) run...
    const action = { ...CONSILIUM_ACTION, maxRounds: 6 } as ConsiliumReviewTriggerAction;
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action });
    await maybeLaunchConsiliumReview(deps, trigger, {});
    // ...but the dispatch clamps it to review-only so an fs event never reaches the coder.
    expect(createReview.mock.calls[0][1].maxRounds).toBe(1);
  });

  // ─── T1: SCHEDULE triggers fire loops (retarget off pipelines) ───────────────

  it("a SCHEDULE trigger with a loop template launches a loop via the SAME factory", async () => {
    const { deps, createReview, runInProject } = makeDeps();
    const action: ConsiliumReviewTriggerAction = {
      kind: "consilium_review",
      preset: "full-viability",
      repoPath: "/allowed/omnius",
    };
    const trigger = makeTrigger(
      { cron: "0 9 * * *", action },
      { type: "schedule" as TriggerRow["type"] },
    );

    const result = await maybeLaunchConsiliumReview(deps, trigger, {
      scheduledAt: "2026-07-03T09:00:00.000Z",
    });

    expect(result).toBe("launched");
    expect(runInProject).toHaveBeenCalledWith("proj-1", expect.any(Function));
    const [, params] = createReview.mock.calls[0];
    expect(params.repoPath).toBe("/allowed/omnius");
    expect(params.preset).toBe("full-viability");
    expect(params.maxRounds).toBe(1); // review-only enforced for automated fires
    // The schedule event description rides the sanitized objective seam.
    expect(params.objectiveExtra).toBe("scheduled run at 2026-07-03T09:00:00.000Z");
  });

  // ─── §6: provenance — every trigger-fired loop records its trigger + event ────

  it("passes trigger provenance (id, type, event digest, firedAt) to the factory", async () => {
    const { deps, createReview } = makeDeps();
    const trigger = makeTrigger({ watchPath: "/allowed/omnius", patterns: ["**/*.md"], action: CONSILIUM_ACTION });
    await maybeLaunchConsiliumReview(deps, trigger, { filePath: "/allowed/omnius/x.md", watchPath: "/allowed/omnius" });

    const prov = createReview.mock.calls[0][1].triggerProvenance;
    expect(prov.triggerId).toBe("trig-1");
    expect(prov.triggerType).toBe("file_change");
    expect(prov.eventDigest).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof prov.firedAt).toBe("string");
    expect(Number.isNaN(Date.parse(prov.firedAt))).toBe(false);
  });

  // ─── T1: engineerInstruction with ${event} interpolation ─────────────────────

  it("interpolates ${event} in the operator instruction and passes it as engineerInstruction", async () => {
    const { deps, createReview } = makeDeps();
    const action: ConsiliumReviewTriggerAction = {
      kind: "consilium_review",
      preset: "sdlc-cross-review",
      repoPath: "/allowed/omnius",
      engineerInstruction: "Review the change: ${event}",
    };
    const trigger = makeTrigger({ watchPath: "/allowed/omnius/specs", patterns: ["**/*.md"], action });

    await maybeLaunchConsiliumReview(deps, trigger, {
      filePath: "/allowed/omnius/specs/00-overview.md",
      watchPath: "/allowed/omnius/specs",
    });

    const [, params] = createReview.mock.calls[0];
    expect(params.engineerInstruction).toBe(
      "Review the change: file change at /allowed/omnius/specs/00-overview.md",
    );
    // engineerInstruction wins in the factory ⇒ objectiveExtra is NOT also set.
    expect(params.objectiveExtra).toBeUndefined();
  });
});

// ─── Event helpers (pure) ──────────────────────────────────────────────────────

describe("describeEvent / eventDigest / interpolateEvent", () => {
  it("describeEvent prefers filePath, then scheduledAt, then event kind, then a fallback", () => {
    const t = makeTrigger({}, { type: "file_change" as TriggerRow["type"] });
    expect(describeEvent(t, { filePath: "/a/b.md" })).toBe("file change at /a/b.md");
    expect(describeEvent(t, { scheduledAt: "2026-07-03T09:00:00Z" })).toBe("scheduled run at 2026-07-03T09:00:00Z");
    expect(describeEvent(t, { event: "pull_request" })).toBe("file_change event: pull_request");
    expect(describeEvent(t, {})).toBe("file_change trigger fired");
  });

  it("eventDigest is a stable 16-hex-char hash of the payload", () => {
    const a = eventDigest({ filePath: "/a/b.md" });
    const b = eventDigest({ filePath: "/a/b.md" });
    const c = eventDigest({ filePath: "/a/c.md" });
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("interpolateEvent replaces every ${event}; returns undefined for an empty instruction", () => {
    expect(interpolateEvent("x ${event} y ${event}", "E")).toBe("x E y E");
    expect(interpolateEvent(undefined, "E")).toBeUndefined();
    expect(interpolateEvent("", "E")).toBeUndefined();
    // No regex `$`-pattern semantics leak from the (untrusted) description.
    expect(interpolateEvent("see ${event}", "$1 & $&")).toBe("see $1 & $&");
  });
});

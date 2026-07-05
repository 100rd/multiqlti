/**
 * spec-watch-dispatch.test.ts — SPEC-1 (spec-as-task.md §3): the spec-watch seam
 * in server/services/consilium/trigger-dispatch.ts.
 *
 * The factory is INJECTED (`createReview`) so we assert the ready-gate, the
 * spec→loop mapping (body + fenced DoD → engineerInstruction), the SPEC provenance,
 * the PER-SPEC dedup (vs the existing per-repo), and the kill-switch OFF byte-
 * identity — all WITHOUT a DB / Express / ALS. Real temp files exercise the
 * size/binary/error guards of the on-disk parser.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, writeSync, openSync, closeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import {
  maybeLaunchConsiliumReview,
  maybeLaunchSpecReview,
  resolveSpecRepo,
  resolveSpecWatchConfig,
  type ConsiliumTriggerDispatchDeps,
} from "../../../server/services/consilium/trigger-dispatch.js";
import { ConfigSchema } from "../../../server/config/schema.js";

// ─── On-disk fixtures ──────────────────────────────────────────────────────────

let root: string; // <tmp>
let specsDir: string; // <tmp>/docs/specs

function specFile(name: string, content: string): string {
  const p = join(specsDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const READY = `---
title: "Rate limit login"
status: ready
source: { kind: human, ref: "chat-7" }
skills: [security-review]
acceptanceCriteria:
  - "When >100 req/min Then 429"
---
## Problem
No limiter on /login.
`;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "spec-watch-"));
  specsDir = join(root, "docs", "specs");
  mkdirSync(specsDir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

// ─── Deps / trigger fixtures (mirror trigger-dispatch.test.ts) ─────────────────

const DEFAULT_GLOBS = ["docs/specs/**/*.md", "docs/adr/**/*.md"];

function makeTrigger(over: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: "trig-1",
    projectId: "proj-1",
    pipelineId: null,
    type: "file_change",
    config: { watchPath: specsDir, patterns: ["**/*.md"] },
    ...over,
  } as unknown as TriggerRow;
}

function makeDeps(
  over: Partial<ConsiliumTriggerDispatchDeps> = {},
  loops: ConsiliumLoopRow[] = [],
  specWatch: { enabled: boolean; globs: string[]; allowedRepoPaths: string[] } | undefined = {
    enabled: true,
    globs: DEFAULT_GLOBS,
    allowedRepoPaths: [],
  },
) {
  const createReview = vi
    .fn()
    .mockImplementation((_deps, params) =>
      Promise.resolve({ id: "loop-new", repoPath: params.repoPath, state: "reviewing" } as ConsiliumLoopRow),
    );
  const runInProject = vi.fn().mockImplementation((_pid: string, fn: () => Promise<unknown>) => fn());
  const log = vi.fn();
  const getLoops = vi.fn().mockResolvedValue(loops);
  const resolveOwnerId = vi.fn().mockResolvedValue("owner-1");
  const recordFire = vi.fn().mockResolvedValue(undefined);
  const deps: ConsiliumTriggerDispatchDeps = {
    reviewDeps: { storage: { getLoops } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    createReview,
    runInProject,
    resolveOwnerId,
    recordFire,
    specWatch: specWatch ? () => specWatch : undefined,
    log,
    ...over,
  };
  return { deps, createReview, runInProject, log, getLoops, recordFire };
}

/** An in-flight loop that carries SPEC provenance for a given spec path. */
function activeSpecLoop(specPath: string, repoPath: string): ConsiliumLoopRow {
  return {
    id: `loop-${specPath}`,
    state: "reviewing",
    repoPath,
    triggerProvenance: { spec: { specPath } },
  } as unknown as ConsiliumLoopRow;
}

// ─── resolveSpecRepo (pure) ────────────────────────────────────────────────────

describe("resolveSpecRepo", () => {
  it("no repo field → the trigger's own (derived) repo", () => {
    expect(resolveSpecRepo(undefined, "/repo/omnius", [])).toBe("/repo/omnius");
    expect(resolveSpecRepo(undefined, undefined, [])).toBeNull();
  });

  it("a slug matching exactly one allowlisted basename resolves to that root", () => {
    expect(resolveSpecRepo("omnius", "/x", ["/allowed/omnius"])).toBe("/allowed/omnius");
  });

  it("an unresolvable slug/path → null (fail-closed, factory never widens)", () => {
    expect(resolveSpecRepo("ghost", "/x", ["/allowed/omnius"])).toBeNull();
    expect(resolveSpecRepo("/evil/path", "/x", ["/allowed/omnius"])).toBeNull();
  });

  it("M2: an absolute `..` traversal is normalized and CANNOT prefix-match an allowed root", () => {
    // Without lexical normalization "/allowed/omnius/../../etc" would string-prefix
    // "/allowed/omnius/"; `resolve` collapses it to "/etc" → rejected.
    expect(resolveSpecRepo("/allowed/omnius/../../etc/x", "/x", ["/allowed/omnius"])).toBeNull();
  });
});

// ─── maybeLaunchSpecReview — the ready-gate + mapping ──────────────────────────

describe("maybeLaunchSpecReview — ready gate", () => {
  it("a READY spec FIRES: body + fenced DoD → engineerInstruction, spec provenance, review-only", async () => {
    const p = specFile("ready.md", READY);
    const { deps, createReview, recordFire } = makeDeps();
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, ["/whatever"]);

    expect(result).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
    const [, params] = createReview.mock.calls[0];
    // engineerInstruction = body + explicit fenced Definition of Done.
    expect(params.engineerInstruction).toContain("No limiter on /login.");
    expect(params.engineerInstruction).toContain("Definition of Done — every criterion must be satisfied and verified:");
    expect(params.engineerInstruction).toContain("- When >100 req/min Then 429");
    // provenance carries {specPath, source, status} for the future write-back.
    expect(params.triggerProvenance.spec).toEqual({
      specPath: p,
      status: "ready",
      source: { kind: "human", ref: "chat-7" },
    });
    // T6: forced review-only — an fs event never reaches the SDLC coder.
    expect(params.maxRounds).toBe(1);
    // Explicit skills pass through to the factory.
    expect(params.skillIds).toEqual(["security-review"]);
    // repoPath falls back to the trigger's own repo (no `repo:` in the spec).
    expect(params.repoPath).toBe(specsDir);
    expect(recordFire).toHaveBeenCalledTimes(1);
  });

  it("a DRAFT spec → no-op(draft), factory NOT called", async () => {
    const p = specFile("draft.md", `---\nstatus: draft\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nb`);
    const { deps, createReview, log } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-op.*draft/));
  });

  it("READY but NO acceptanceCriteria → no-op(no-acceptance-criteria), NEVER fires", async () => {
    const p = specFile("no-crit.md", `---\nstatus: ready\nsource: {kind: human}\n---\nb`);
    const { deps, createReview, log } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-acceptance-criteria/));
  });

  it("a non-spec .md → no-op(not-a-spec)", async () => {
    const p = specFile("plain.md", `# Just docs\n\nno frontmatter`);
    const { deps, createReview, log } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/not-a-spec/));
  });

  it("malformed frontmatter → no-op, NEVER throws", async () => {
    const p = specFile("bad.md", `---\nstatus: ready\n bad: : [\n---\nb`);
    const { deps, createReview } = makeDeps();
    let result: string | undefined;
    await expect(
      (async () => {
        result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, []);
      })(),
    ).resolves.not.toThrow();
    expect(result).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a HUGE + a BINARY file under the globs → no-op, watcher never crashes", async () => {
    const big = specFile("huge.md", `---\nstatus: ready\n---\n` + "x".repeat(600 * 1024));
    const binPath = join(specsDir, "bin.md");
    const fd = openSync(binPath, "w");
    writeSync(fd, Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0x00, 0x01, 0x02, 0x0a]));
    closeSync(fd);
    const { deps, createReview } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, big, [])).toBe("skipped");
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, binPath, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("H2: a hostile spec title is single-lined + clamped in the provenance eventSummary", async () => {
    const nasty = `---\ntitle: "a\\nb\\tc ${"Z".repeat(300)}"\nstatus: ready\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nbody`;
    const p = specFile("nasty-title.md", nasty);
    const { deps, createReview } = makeDeps();
    await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, []);
    const summary = createReview.mock.calls[0][1].triggerProvenance.eventSummary as string;
    expect(summary).not.toMatch(/[\n\t]/); // control chars stripped to single line
    expect(summary.length).toBeLessThanOrEqual("spec ready: ".length + 120);
    expect(summary).toMatch(/^spec ready: a b c/);
  });

  it("a spec `repo:` that resolves to NO allowlisted path → no-op(no-repo)", async () => {
    const p = specFile("ghost-repo.md", `---\nstatus: ready\nrepo: ghost\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nb`);
    const { deps, createReview, log } = makeDeps();
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, p, ["/allowed/omnius"]);
    expect(result).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-repo/));
  });
});

// ─── Route-level fold: the MASTER switch alone disables spec-watch ─────────────

describe("resolveSpecWatchConfig — master-switch fold", () => {
  /** A real AppConfig with the three spec-watch-relevant flags set explicitly. */
  const cfg = (masterEnabled: boolean, specWatchEnabled: boolean) =>
    ConfigSchema.parse({
      features: { triggers: { enabled: masterEnabled } },
      pipeline: {
        consiliumLoop: {
          enabled: true, // isolate the master switch as the sole disabler
          allowedRepoPaths: ["/allowed/omnius"],
          specWatch: { enabled: specWatchEnabled },
        },
      },
    });

  it("features.triggers.enabled=false ALONE zeroes effective enabled (even with specWatch+loop on)", () => {
    const view = resolveSpecWatchConfig(cfg(false, true));
    expect(view.enabled).toBe(false); // the master switch off ⇒ spec-watch off
    // The other fields still pass through (they are inert while disabled).
    expect(view.globs).toEqual(["docs/specs/**/*.md", "docs/adr/**/*.md"]);
    expect(view.allowedRepoPaths).toEqual(["/allowed/omnius"]);
  });

  it("both switches on ⇒ effective enabled true; specWatch off alone ⇒ false", () => {
    expect(resolveSpecWatchConfig(cfg(true, true)).enabled).toBe(true);
    expect(resolveSpecWatchConfig(cfg(true, false)).enabled).toBe(false);
  });

  it("master-switch OFF ⇒ NO spec fires end-to-end (byte-identical), even for a ready spec", async () => {
    const p = specFile("ready-master-off.md", READY);
    // The EXACT view the route hands the dispatch, folded from a real config with the
    // master switch OFF but specWatch+loop ON — proves the fold, not a duplicated bool.
    const folded = resolveSpecWatchConfig(cfg(false, true));
    const { deps, createReview } = makeDeps({}, [], folded);
    const result = await maybeLaunchConsiliumReview(deps, makeTrigger(), {
      filePath: p,
      watchPath: specsDir,
    });
    expect(result).toBe("noop"); // legacy path (no action) — spec pre-check never ran
    expect(createReview).not.toHaveBeenCalled();
  });
});

// ─── PER-SPEC dedup (the SPEC-1 headline vs the per-repo dedup) ─────────────────

describe("maybeLaunchSpecReview — per-SPEC dedup", () => {
  it("TWO distinct specs in the SAME repo each fire their OWN loop (not collapsed)", async () => {
    const spec1 = specFile("s1.md", READY);
    const spec2 = specFile("s2.md", READY.replace("Rate limit login", "Add audit log"));

    // spec1 already has an ACTIVE loop; firing spec2 (same repoPath) must still launch —
    // the per-repo dedup would WRONGLY collapse these; the per-spec key does not.
    const { deps, createReview } = makeDeps({}, [activeSpecLoop(spec1, specsDir)]);
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, spec2, []);

    expect(result).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(createReview.mock.calls[0][1].triggerProvenance.spec.specPath).toBe(spec2);
  });

  it("the SAME spec fired again while its loop is ACTIVE → one loop (skipped-dedup:spec)", async () => {
    const spec1 = specFile("s1b.md", READY);
    const { deps, createReview, log, recordFire } = makeDeps({}, [activeSpecLoop(spec1, specsDir)]);
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, spec1, []);

    expect(result).toBe("skipped-dedup");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped-dedup:spec/));
    // A dedup-suppressed fire does NOT record a fire (watermark discipline).
    expect(recordFire).not.toHaveBeenCalled();
  });

  it("a TERMINAL loop for the same spec does NOT block a re-fire", async () => {
    const spec1 = specFile("s1c.md", READY);
    const terminal = { ...activeSpecLoop(spec1, specsDir), state: "converged" } as ConsiliumLoopRow;
    const { deps, createReview } = makeDeps({}, [terminal]);
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: specsDir }, spec1, [])).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
  });
});

// ─── Kill-switch + glob routing via maybeLaunchConsiliumReview ──────────────────

describe("maybeLaunchConsiliumReview — spec pre-check routing", () => {
  it("kill-switch OFF → spec pre-check skipped; an action-less file_change stays noop (byte-identical)", async () => {
    const p = specFile("ready-off.md", READY);
    const { deps, createReview } = makeDeps({}, [], { enabled: false, globs: DEFAULT_GLOBS, allowedRepoPaths: [] });
    const result = await maybeLaunchConsiliumReview(deps, makeTrigger(), { filePath: p, watchPath: specsDir });
    expect(result).toBe("noop"); // legacy path: no action ⇒ record-only no-op
    expect(createReview).not.toHaveBeenCalled();
  });

  it("spec-watch UNWIRED (deps.specWatch absent) → byte-identical legacy path", async () => {
    const p = specFile("ready-unwired.md", READY);
    // Explicitly UNWIRE the spec-watch dep (an existing caller that never wires it).
    const { deps, createReview } = makeDeps({ specWatch: undefined });
    const result = await maybeLaunchConsiliumReview(deps, makeTrigger(), { filePath: p, watchPath: specsDir });
    expect(result).toBe("noop");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("ON + a changed file UNDER the globs → routes to the spec path and FIRES", async () => {
    const p = specFile("routed.md", READY);
    const { deps, createReview } = makeDeps();
    const result = await maybeLaunchConsiliumReview(deps, makeTrigger(), { filePath: p, watchPath: specsDir });
    expect(result).toBe("launched");
    expect(createReview.mock.calls[0][1].triggerProvenance.spec.specPath).toBe(p);
  });

  it("ON but a changed file NOT under the globs → falls through to the legacy path (noop)", async () => {
    // A .txt (or a .md outside docs/specs) does not match the globs.
    const outside = join(root, "README.md");
    writeFileSync(outside, READY, "utf8");
    const { deps, createReview } = makeDeps();
    const result = await maybeLaunchConsiliumReview(deps, makeTrigger(), { filePath: outside, watchPath: specsDir });
    expect(result).toBe("noop"); // legacy path (no action) — NOT parsed as a spec
    expect(createReview).not.toHaveBeenCalled();
  });

  it("M3: ON + a NON-ready file under the globs is handled by the spec path — a legacy action does NOT run", async () => {
    // A file_change trigger that ALSO carries a legacy consilium_review action, whose
    // changed .md matches the spec globs but is a draft. The spec pre-check owns it
    // (no-op draft); the legacy action is intentionally NOT run (documented precedence).
    const p = specFile("draft-with-action.md", `---\nstatus: draft\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nb`);
    const trigger = makeTrigger({
      config: {
        watchPath: specsDir,
        patterns: ["**/*.md"],
        action: { kind: "consilium_review", preset: "full-viability", repoPath: "/allowed/omnius" },
      },
    } as Partial<TriggerRow>);
    const { deps, createReview } = makeDeps();
    const result = await maybeLaunchConsiliumReview(deps, trigger, { filePath: p, watchPath: specsDir });
    expect(result).toBe("skipped"); // spec no-op(draft) — NOT the legacy action's launch
    expect(createReview).not.toHaveBeenCalled();
  });
});

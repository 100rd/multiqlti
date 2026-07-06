/**
 * adr-intake.test.ts — SPEC-4 (spec-as-task.md §2/§7): an ADR under the watched globs
 * is a valid task. Covers the pure parser surface (`isAdrCandidate` / `applyAdrIntake`
 * — ADR detection, accepted→ready normalisation, the implicit decision-DoD) AND the
 * dispatch seam (`maybeLaunchSpecReview` firing an ADR, its provenance marker, and the
 * per-spec dedup holding). Reuses the SPEC-1 parser/ready-gate/dedup — it extends them.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { load as jsYamlLoad } from "js-yaml";
import type { TriggerRow, ConsiliumLoopRow } from "@shared/schema";
import {
  parseSpecContent,
  applyAdrIntake,
  isAdrCandidate,
  evaluateReadyGate,
  ADR_IMPLICIT_CRITERIA,
} from "../../../server/services/consilium/spec-parser.js";
import {
  maybeLaunchSpecReview,
  type ConsiliumTriggerDispatchDeps,
} from "../../../server/services/consilium/trigger-dispatch.js";

const load = (s: string) => jsYamlLoad(s);

// ─── Pure: ADR detection + normalisation (applyAdrIntake / isAdrCandidate) ──────

/** Build a spec parse result from raw markdown (through the real parser). */
function parse(md: string) {
  return parseSpecContent(md, load);
}

const ADR_ACCEPTED_NO_CRIT = `---
title: "Adopt event sourcing for the ledger"
status: accepted
source: { kind: human, ref: "adr-0007" }
---
## Decision
We will store ledger mutations as an append-only event log.
`;

describe("isAdrCandidate — detection", () => {
  it("a file under docs/adr/ is an ADR (path convention)", () => {
    const p = parse(ADR_ACCEPTED_NO_CRIT);
    expect(p.kind).toBe("spec");
    if (p.kind !== "spec") return;
    expect(isAdrCandidate("/repo/docs/adr/0007-event-sourcing.md", p.frontmatter)).toBe(true);
  });

  it("a docs/specs file is NOT an ADR (no path/marker)", () => {
    const p = parse(`---\nstatus: ready\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nb`);
    if (p.kind !== "spec") throw new Error("expected spec");
    expect(isAdrCandidate("/repo/docs/specs/foo.md", p.frontmatter)).toBe(false);
  });

  it("an `adr:` / `decision:` frontmatter marks an ADR OUTSIDE docs/adr/", () => {
    const withAdr = parse(`---\nstatus: accepted\nadr: true\nsource: {kind: human}\n---\nbody`);
    const withDecision = parse(`---\nstatus: accepted\ndecision: "use X"\nsource: {kind: human}\n---\nbody`);
    if (withAdr.kind !== "spec" || withDecision.kind !== "spec") throw new Error("expected spec");
    expect(isAdrCandidate("/repo/docs/notes/x.md", withAdr.frontmatter)).toBe(true);
    expect(isAdrCandidate("/repo/docs/notes/y.md", withDecision.frontmatter)).toBe(true);
  });

  it("`docs/adr` mid-segment does NOT falsely match (boundary-anchored)", () => {
    const p = parse(`---\nstatus: ready\nsource: {kind: human}\nacceptanceCriteria: ["c"]\n---\nb`);
    if (p.kind !== "spec") throw new Error("expected spec");
    expect(isAdrCandidate("/repo/mydocs/adrs/x.md", p.frontmatter)).toBe(false);
  });
});

describe("applyAdrIntake — normalisation + implicit DoD", () => {
  it("ADR accepted + NO criteria → status normalised to ready + implicit decision-DoD; FIRES", () => {
    const raw = parse(ADR_ACCEPTED_NO_CRIT);
    const { parsed, isAdr } = applyAdrIntake(raw, "/repo/docs/adr/0007.md");
    expect(isAdr).toBe(true);
    if (parsed.kind !== "spec") throw new Error("expected spec");
    expect(parsed.frontmatter.status).toBe("ready"); // accepted → ready
    expect(parsed.frontmatter.acceptanceCriteria).toEqual([...ADR_IMPLICIT_CRITERIA]);
    // The SAME ready-gate now fires it (an ADR NEVER fires with an empty DoD).
    const gate = evaluateReadyGate(parsed);
    expect(gate.fire).toBe(true);
  });

  it("ADR with EXPLICIT criteria keeps them (implicit DoD not injected)", () => {
    const raw = parse(
      `---\nstatus: accepted\nsource: {kind: human}\nacceptanceCriteria:\n  - "Ledger writes are append-only"\n---\n## Decision\nx`,
    );
    const { parsed, isAdr } = applyAdrIntake(raw, "/repo/docs/adr/9.md");
    expect(isAdr).toBe(true);
    if (parsed.kind !== "spec") throw new Error("expected spec");
    expect(parsed.frontmatter.acceptanceCriteria).toEqual(["Ledger writes are append-only"]);
    expect(evaluateReadyGate(parsed).fire).toBe(true);
  });

  it("a PROPOSED ADR does NOT fire (only accepted/ready is the go-state)", () => {
    const raw = parse(`---\nstatus: proposed\nsource: {kind: human}\n---\n## Decision\nx`);
    const { parsed, isAdr } = applyAdrIntake(raw, "/repo/docs/adr/1.md");
    expect(isAdr).toBe(true);
    if (parsed.kind !== "spec") throw new Error("expected spec");
    expect(parsed.frontmatter.status).toBe("proposed"); // NOT normalised
    expect(evaluateReadyGate(parsed).fire).toBe(false);
  });

  it("a DRAFT ADR does NOT fire", () => {
    const raw = parse(`---\nstatus: draft\nsource: {kind: human}\n---\n## Decision\nx`);
    const { parsed } = applyAdrIntake(raw, "/repo/docs/adr/2.md");
    expect(evaluateReadyGate(parsed).fire).toBe(false);
  });

  it("a NON-ADR spec is returned UNCHANGED (byte-identical SPEC-1/2)", () => {
    const raw = parse(`---\nstatus: accepted\nsource: {kind: human}\n---\nbody`);
    const { parsed, isAdr } = applyAdrIntake(raw, "/repo/docs/specs/foo.md");
    expect(isAdr).toBe(false);
    expect(parsed).toBe(raw); // same reference — no normalisation applied
    // A docs/specs file with `accepted` (a non-spec status) still does NOT fire.
    expect(evaluateReadyGate(parsed).fire).toBe(false);
  });

  it("a not-a-spec input is passed through untouched", () => {
    const raw = parse(`# just markdown, no frontmatter`);
    const { parsed, isAdr } = applyAdrIntake(raw, "/repo/docs/adr/x.md");
    expect(isAdr).toBe(false);
    expect(parsed.kind).toBe("not-a-spec");
  });
});

// ─── Dispatch: an ADR fires a loop, marks provenance, and dedups ───────────────

let root: string;
let adrDir: string;

function adrFile(name: string, content: string): string {
  const p = join(adrDir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "adr-intake-"));
  adrDir = join(root, "docs", "adr");
  mkdirSync(adrDir, { recursive: true });
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeTrigger(over: Partial<TriggerRow> = {}): TriggerRow {
  return {
    id: "trig-adr",
    projectId: "proj-1",
    pipelineId: null,
    type: "file_change",
    config: { watchPath: adrDir, patterns: ["**/*.md"] },
    ...over,
  } as unknown as TriggerRow;
}

function makeDeps(loops: ConsiliumLoopRow[] = []) {
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
    specWatch: () => ({ enabled: true, globs: ["docs/adr/**/*.md"], allowedRepoPaths: [] }),
    log,
  };
  return { deps, createReview, log, recordFire };
}

function activeSpecLoop(specPath: string, repoPath: string): ConsiliumLoopRow {
  return {
    id: `loop-${specPath}`,
    state: "reviewing",
    repoPath,
    triggerProvenance: { spec: { specPath } },
  } as unknown as ConsiliumLoopRow;
}

describe("maybeLaunchSpecReview — ADR intake", () => {
  it("an ADR under docs/adr (accepted, no explicit criteria) FIRES with the implicit DoD + ADR provenance", async () => {
    const p = adrFile("0007.md", ADR_ACCEPTED_NO_CRIT);
    const { deps, createReview } = makeDeps();
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, p, ["/whatever"]);

    expect(result).toBe("launched");
    const [, params] = createReview.mock.calls[0];
    // The decision is the objective; the implicit criteria are the fenced DoD.
    expect(params.engineerInstruction).toContain("append-only event log");
    expect(params.engineerInstruction).toContain(
      "The decision described in this ADR is implemented in the codebase.",
    );
    // Provenance records it is an ADR (status reflects the normalised ready).
    expect(params.triggerProvenance.spec).toEqual(
      expect.objectContaining({ specPath: p, status: "ready", artifact: "adr" }),
    );
  });

  it("an ADR with status:ready + explicit criteria fires with those criteria", async () => {
    const p = adrFile("ready-explicit.md", `---\nstatus: ready\nsource: {kind: human}\nacceptanceCriteria:\n  - "The cache is invalidated on write"\n---\n## Decision\nWrite-through cache.`);
    const { deps, createReview } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, p, [])).toBe("launched");
    expect(createReview.mock.calls[0][1].engineerInstruction).toContain("The cache is invalidated on write");
    expect(createReview.mock.calls[0][1].triggerProvenance.spec.artifact).toBe("adr");
  });

  it("a PROPOSED ADR is a NO-OP (does not fire)", async () => {
    const p = adrFile("proposed.md", `---\nstatus: proposed\nsource: {kind: human}\n---\n## Decision\nx`);
    const { deps, createReview, log } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, p, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/no-op.*(unknown-status|draft)/));
  });

  it("a DRAFT ADR is a NO-OP (does not fire)", async () => {
    const p = adrFile("draft.md", `---\nstatus: draft\nsource: {kind: human}\n---\n## Decision\nx`);
    const { deps, createReview } = makeDeps();
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, p, [])).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("PER-SPEC dedup holds for ADRs: an ACTIVE loop for the SAME ADR → skipped-dedup", async () => {
    const p = adrFile("dedup.md", ADR_ACCEPTED_NO_CRIT);
    const { deps, createReview, log } = makeDeps([activeSpecLoop(p, adrDir)]);
    const result = await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, p, []);
    expect(result).toBe("skipped-dedup");
    expect(createReview).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/skipped-dedup:spec/));
  });

  it("two DISTINCT ADRs in the same dir each fire their own loop", async () => {
    const a = adrFile("a.md", ADR_ACCEPTED_NO_CRIT);
    const b = adrFile("b.md", ADR_ACCEPTED_NO_CRIT.replace("event sourcing", "CQRS"));
    const { deps, createReview } = makeDeps([activeSpecLoop(a, adrDir)]);
    expect(await maybeLaunchSpecReview(deps, makeTrigger(), { watchPath: adrDir }, b, [])).toBe("launched");
    expect(createReview.mock.calls[0][1].triggerProvenance.spec.specPath).toBe(b);
  });
});

import { describe, it, expect } from "vitest";
import {
  buildSdlcTrace,
  buildResearchTrace,
  clampTrace,
  type SdlcOutcomeLike,
} from "../../../server/services/consilium/execution-trace";
import type { ExecutionTrace } from "@shared/types";

describe("execution-trace — buildSdlcTrace (coder path)", () => {
  const outcomes: SdlcOutcomeLike[] = [
    {
      index: 1,
      priority: "P0",
      title: "fix logger type error",
      status: "completed",
      skills: ["test-author", "coder"],
      verification: { method: "test-run", ran: true, passed: true, summary: "ok", fixIterations: 1, criterion: "When built Then compiles" },
    },
    {
      index: 2,
      priority: "P1",
      title: "pin helm image",
      status: "failed",
      note: "coder errored",
    },
  ];

  it("maps outcomes → workers with skills (capability from the name map) + criterion leaves", () => {
    const t = buildSdlcTrace("repo-assessment", outcomes, { prRef: "https://gh/pr/1" });
    expect(t.controller.kind).toBe("sdlc-executor");
    expect(t.controller.workers).toHaveLength(2);
    const w0 = t.controller.workers[0];
    expect(w0.skills.map((s) => s.skillName)).toEqual(["test-author", "coder"]);
    // capability + permissions derived from the skill-name map (worktree-write → Edit/Write/Read)
    expect(w0.skills[0].capability).toBe("worktree-write");
    expect(w0.skills[0].permissionsUsed).toEqual(["Edit", "Write", "Read"]);
    expect(w0.skills[0].green).toBe(true); // status !== failed
    expect(w0.criteria).toHaveLength(1);
    expect(w0.criteria[0].method).toBe("test-run");
    expect(w0.criteria[0].passed).toBe(true);
    // failed worker → skills green=false-derived (none here) + status failed
    expect(t.controller.workers[1].status).toBe("failed");
    expect(t.controller.workers[1].note).toBe("coder errored");
  });

  it("Stage A: stamps passedAtFinal on every test-run criterion when finalPassed is given", () => {
    const green = buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" }, true);
    expect(green.controller.workers[0].criteria[0].passedAtFinal).toBe(true);
    const red = buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" }, false);
    expect(red.controller.workers[0].criteria[0].passedAtFinal).toBe(false);
    // A regression: the criterion passed at implement time but NOT at final re-verify.
    expect(red.controller.workers[0].criteria[0].passed).toBe(true);
    expect(red.controller.workers[0].criteria[0].passedAtFinal).toBe(false);
  });

  it("Stage A: OMITS passedAtFinal when finalPassed is undefined (byte-for-byte the prior trace)", () => {
    const t = buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" });
    expect("passedAtFinal" in t.controller.workers[0].criteria[0]).toBe(false);
  });

  it("Stage A: clampTrace preserves an already-set passedAtFinal", () => {
    const t = clampTrace({
      schemaVersion: 1,
      archetype: "repo-assessment",
      controller: {
        kind: "sdlc-executor",
        label: "x",
        green: false,
        workers: [
          {
            index: 1,
            priority: "P0",
            title: "t",
            status: "completed",
            skills: [],
            criteria: [{ criterion: "c", method: "test-run", ran: true, passed: true, passedAtFinal: false }],
          },
        ],
      },
    });
    expect(t.controller.workers[0].criteria[0].passedAtFinal).toBe(false);
  });

  it("Timeout policy: stamps timedOut:true from a per-AP verification that timed out", () => {
    const apTimedOut: SdlcOutcomeLike[] = [
      {
        index: 1,
        priority: "P0",
        title: "t",
        status: "completed",
        verification: { method: "test-run", ran: true, passed: false, summary: "TIMED OUT after 300000ms", fixIterations: 0, criterion: "c", timedOut: true },
      },
    ];
    const crit = buildSdlcTrace("repo-assessment", apTimedOut, { prRef: "x" }).controller.workers[0].criteria[0];
    expect(crit.timedOut).toBe(true);
    expect(crit.ran).toBe(true); // the process DID run — unlike a launch failure
    expect(crit.passed).toBe(false);
  });

  it("Timeout policy: a FINAL timeout marks timedOut AND OMITS passedAtFinal (no bogus regression)", () => {
    // finalPassed:false alongside finalTimedOut:true ⇒ do NOT stamp passedAtFinal (there
    // is no adjudicated pass/fail); mark the criterion timedOut instead.
    const t = buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" }, false, true);
    const crit = t.controller.workers[0].criteria[0];
    expect(crit.timedOut).toBe(true);
    expect("passedAtFinal" in crit).toBe(false);
  });

  it("Timeout policy: OMITS timedOut when neither the AP nor the final run timed out", () => {
    const t = buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" }, true);
    expect("timedOut" in t.controller.workers[0].criteria[0]).toBe(false);
  });

  it("Timeout policy: clampTrace preserves an already-set timedOut and drops non-boolean (old snapshot)", () => {
    const t = clampTrace({
      schemaVersion: 1,
      archetype: "repo-assessment",
      controller: {
        kind: "sdlc-executor",
        label: "x",
        green: false,
        workers: [
          { index: 1, priority: "P0", title: "t", status: "completed", skills: [], criteria: [{ criterion: "c", method: "test-run", ran: true, passed: false, timedOut: true }] },
          // Old snapshot: absent timedOut field → stays absent (byte-for-byte legacy).
          { index: 2, priority: "P0", title: "u", status: "completed", skills: [], criteria: [{ criterion: "d", method: "test-run", ran: true, passed: true }] },
        ],
      },
    });
    expect(t.controller.workers[0].criteria[0].timedOut).toBe(true);
    expect("timedOut" in t.controller.workers[1].criteria[0]).toBe(false);
  });

  it("controller green requires a PR AND no unmet P0 criterion", () => {
    expect(buildSdlcTrace("repo-assessment", outcomes, { prRef: "x" }).controller.green).toBe(true);
    expect(buildSdlcTrace("repo-assessment", outcomes, { prRef: null }).controller.green).toBe(false);
    const unmetP0: SdlcOutcomeLike[] = [
      { index: 1, priority: "P0", title: "t", status: "completed", verification: { method: "test-run", ran: true, passed: false, summary: "red", fixIterations: 3, criterion: "c" } },
    ];
    expect(buildSdlcTrace("repo-assessment", unmetP0, { prRef: "x" }).controller.green).toBe(false);
  });
});

describe("execution-trace — buildResearchTrace (research path)", () => {
  it("builds a research-runner controller with research→synthesize→verify + web-evidence criteria", () => {
    const t = buildResearchTrace(
      "research",
      [{ criterion: "cite source A", cited: true }, { criterion: "cite source B", cited: false }],
      { verdict: "flagged" },
    );
    expect(t.controller.kind).toBe("research-runner");
    expect(t.controller.green).toBe(false); // verdict flagged
    expect(t.controller.workers.map((w) => w.title)).toEqual(["research", "synthesize", "verify"]);
    const verify = t.controller.workers[2];
    expect(verify.skills[0].capability).toBe("web-read");
    expect(verify.skills[0].permissionsUsed).toEqual(["web_search"]);
    expect(verify.criteria).toHaveLength(2);
    expect(verify.criteria[0].method).toBe("web-evidence");
    expect(verify.criteria[0].passed).toBe(true);
    expect(verify.criteria[1].passed).toBe(false);
  });

  it("green when the report verdict is green; degraded (null report) → failed steps", () => {
    expect(buildResearchTrace("research", [], { verdict: "green" }).controller.green).toBe(true);
    const degraded = buildResearchTrace("research", [], null, "web_search unavailable");
    expect(degraded.controller.green).toBe(false);
    expect(degraded.controller.note).toBe("web_search unavailable");
    expect(degraded.controller.workers.every((w) => w.status === "failed")).toBe(true);
  });
});

describe("execution-trace — clampTrace", () => {
  it("bounds counts + strips control chars (note) / paths (criterion summary); permission names survive", () => {
    const huge: ExecutionTrace = {
      schemaVersion: 1,
      archetype: "repo-assessment",
      controller: {
        kind: "sdlc-executor",
        label: "ctl\n\tlabel",
        green: true,
        note: "error\n\there",
        workers: Array.from({ length: 500 }, (_, i) => ({
          index: i,
          priority: "P0",
          title: "t",
          status: "completed" as const,
          skills: [{ skillName: "coder", capability: "worktree-write" as const, permissionsUsed: ["Edit", "Write", "Read"], green: true }],
          criteria: [{ criterion: "c", method: "test-run" as const, ran: true, passed: false, summary: "failed at /Users/secret/file.ts" }],
        })),
      },
    };
    const c = clampTrace(huge);
    expect(c.controller.workers.length).toBeLessThanOrEqual(200);
    expect(c.controller.label).toBe("ctl label"); // control chars collapsed
    expect(c.controller.note).toBe("error here"); // control-stripped
    // criterion summary is path-scrubbed via scrub()
    expect(c.controller.workers[0].criteria[0].summary).not.toContain("/Users/secret");
    expect(c.controller.workers[0].skills[0].permissionsUsed).toEqual(["Edit", "Write", "Read"]);
  });
});

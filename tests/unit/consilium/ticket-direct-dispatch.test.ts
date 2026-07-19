/**
 * ticket-direct-dispatch.test.ts — ADR-004 Block A: `launchTicketReview` (direct
 * ticket → loop, no spec-PR). Covers: the launch plan reaching the factory carries
 * the per-ticket dedup anchor + provenance source and forces review-only (T6);
 * the instruction is DoD-first (criteria before body); an ACTIVE loop with the same
 * anchor dedup-suppresses (no second factory call); a disabled consilium loop
 * (reviewDeps null) skips fail-closed.
 */
import { describe, it, expect, vi } from "vitest";
import { launchTicketReview } from "../../../server/services/consilium/trigger-dispatch.js";
import type { TriggerRow } from "../../../shared/schema.js";

function trigger(): TriggerRow {
  return {
    id: "trk-1",
    projectId: "proj-1",
    type: "tracker_event",
    config: {},
    enabled: true,
  } as unknown as TriggerRow;
}

function makeDeps(existingLoops: unknown[] = []) {
  const created: Array<Record<string, unknown>> = [];
  const recordFire = vi.fn(async () => {});
  const deps = {
    reviewDeps: {
      storage: { getLoops: async () => existingLoops },
      orchestrator: {},
      controller: {},
      config: () => ({}),
    },
    createReview: vi.fn(async (_rd: unknown, args: Record<string, unknown>) => {
      created.push(args);
      return { id: "loop-1" };
    }),
    runInProject: async <T,>(_p: string, fn: () => Promise<T>) => fn(),
    resolveOwnerId: async () => "user-1",
    recordFire,
    log: () => {},
  };
  return { deps, created, recordFire };
}

const ARGS = {
  projectId: "proj-1",
  repoPath: "/repo/widget",
  ticket: {
    kind: "jira",
    key: "PDO-850",
    title: "Enable caching",
    url: "https://jira.example.co/browse/PDO-850",
  },
  spec: {
    problem: "Pipelines are slow",
    scope: "cicd templates",
    criteria: ["gradle cache restored", "cache policy is pull"],
  },
};

describe("launchTicketReview (ADR-004 Block A)", () => {
  it("launches with the per-ticket anchor, source provenance, T6 review-only, DoD-first instruction", async () => {
    const { deps, created, recordFire } = makeDeps();
    const res = await launchTicketReview(deps as never, trigger(), ARGS);
    expect(res).toBe("launched");
    expect(created).toHaveLength(1);
    const plan = created[0];

    // Per-ticket dedup anchor + join-able provenance source.
    expect(plan.triggerProvenance).toMatchObject({
      spec: {
        specPath: "ticket:jira:PDO-850",
        status: "ready",
        source: { kind: "jira", ref: "PDO-850", url: ARGS.ticket.url },
      },
    });
    // T6: an unattended launch NEVER reaches the coder — review-only.
    expect(plan.maxRounds).toBe(1);
    expect(plan.preset).toBe("sdlc-cross-review");
    // No poller-resolved ref ⇒ working-tree HEAD (null), the pre-existing default.
    expect(plan.ref).toBeNull();

    // DoD-first: criteria reach the objective BEFORE the body (H1 clamp discipline).
    const instruction = plan.engineerInstruction as string;
    expect(instruction).toContain("gradle cache restored");
    expect(instruction.indexOf("gradle cache restored")).toBeLessThan(
      instruction.indexOf("Pipelines are slow"),
    );
    expect(recordFire).toHaveBeenCalledTimes(1);
  });

  it("passes the poller-resolved fresh ref through to the launch plan", async () => {
    const { deps, created } = makeDeps();
    const res = await launchTicketReview(deps as never, trigger(), {
      ...ARGS,
      ref: "origin/main",
    });
    expect(res).toBe("launched");
    expect(created[0].ref).toBe("origin/main");
  });

  it("dedup-suppresses when an ACTIVE loop already carries the same ticket anchor", async () => {
    const active = {
      state: "reviewing",
      repoPath: "/somewhere/else",
      triggerProvenance: { spec: { specPath: "ticket:jira:PDO-850" } },
    };
    const { deps, created } = makeDeps([active]);
    const res = await launchTicketReview(deps as never, trigger(), ARGS);
    expect(res).toBe("skipped-dedup");
    expect(created).toHaveLength(0);
  });

  it("skips fail-closed when the consilium loop is disabled (reviewDeps null)", async () => {
    const { deps, created } = makeDeps();
    (deps as { reviewDeps: unknown }).reviewDeps = null;
    const res = await launchTicketReview(deps as never, trigger(), ARGS);
    expect(res).toBe("skipped");
    expect(created).toHaveLength(0);
  });
});

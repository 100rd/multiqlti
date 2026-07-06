/**
 * spec-status-terminal.test.ts — SPEC-2 (spec-as-task.md §4): the loop-controller
 * side of the spec status lifecycle. On a SPEC-FIRED loop reaching a TERMINAL state,
 * the controller invokes the injected `onSpecLoopTerminal` hook (the route wires it
 * to the spec-status writer). Asserts:
 *   - a terminal transition of a spec-fired loop fires the hook once, with the state,
 *   - a NON-spec loop never fires it (no triggerProvenance.spec),
 *   - a hook throw never crashes the terminal transition (best-effort).
 *
 * Driven via `cancel()` (the simplest terminal path: reviewing → cancelled), which
 * commits through the SAME `commit()`/casLoopState seam every terminal transition
 * uses, so the hook fires for failed/stopped_cap/escalated/converged identically.
 */
import { describe, it, expect, vi } from "vitest";
import { ConsiliumLoopController } from "../../../server/services/consilium/consilium-loop-controller.js";
import type { ConsiliumLoopRow, ConsiliumLoopState } from "@shared/schema";

function makeLoop(over: Partial<ConsiliumLoopRow>): ConsiliumLoopRow {
  return {
    id: "loop-1",
    projectId: "proj1",
    groupId: "grp1",
    state: "reviewing",
    round: 1,
    maxRounds: 1,
    repoPath: "/repo/widget",
    lastReviewedCommit: null,
    currentIterationNumber: 1,
    devGroupId: null,
    prRef: null,
    headCommitAtReview: null,
    openP0: null,
    error: null,
    triggerProvenance: null,
    createdBy: "user1",
    createdAt: new Date(),
    updatedAt: new Date(),
    completedAt: null,
    ...over,
  } as ConsiliumLoopRow;
}

function fakeStorage(loop: ConsiliumLoopRow) {
  let current = loop;
  const storage = {
    getLoop: vi.fn(async () => current),
    casLoopState: vi.fn(
      async (id: string, expected: ConsiliumLoopState, next: ConsiliumLoopState, extra?: Record<string, unknown>) => {
        if (id !== current.id || current.state !== expected) return undefined;
        current = { ...current, ...(extra ?? {}), state: next };
        return current;
      },
    ),
  };
  return storage;
}

function makeController(loop: ConsiliumLoopRow, onSpecLoopTerminal?: ReturnType<typeof vi.fn>) {
  const storage = fakeStorage(loop);
  const controller = new ConsiliumLoopController({
    storage: storage as never,
    taskOrchestrator: { cancelGroup: vi.fn(async () => undefined) } as never,
    config: () => ({}) as never,
    onSpecLoopTerminal,
  });
  return { controller, storage };
}

const SPEC_PROV = { spec: { specPath: "/repo/widget/docs/specs/x.md", status: "ready" } };

describe("controller terminal → onSpecLoopTerminal (SPEC-2)", () => {
  it("a SPEC-FIRED loop reaching terminal fires the hook once with the terminal state", async () => {
    const hook = vi.fn(async () => undefined);
    const loop = makeLoop({ triggerProvenance: SPEC_PROV as never });
    const { controller } = makeController(loop, hook);

    const out = await controller.cancel("loop-1", { reason: "operator" });
    expect(out?.state).toBe("cancelled");
    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(expect.objectContaining({ id: "loop-1", state: "cancelled" }), "cancelled");
  });

  it("a NON-spec loop reaching terminal NEVER fires the hook", async () => {
    const hook = vi.fn(async () => undefined);
    const loop = makeLoop({ triggerProvenance: null }); // human/API launched
    const { controller } = makeController(loop, hook);

    const out = await controller.cancel("loop-1");
    expect(out?.state).toBe("cancelled");
    expect(hook).not.toHaveBeenCalled();
  });

  it("a hook throw is swallowed — the terminal transition still commits", async () => {
    const hook = vi.fn(async () => {
      throw new Error("gh down");
    });
    const loop = makeLoop({ triggerProvenance: SPEC_PROV as never });
    const { controller } = makeController(loop, hook);

    const out = await controller.cancel("loop-1");
    expect(out?.state).toBe("cancelled"); // transition survived the hook failure.
    expect(hook).toHaveBeenCalledTimes(1);
  });
});

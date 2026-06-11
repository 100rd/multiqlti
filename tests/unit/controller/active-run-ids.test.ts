/**
 * Unit tests for the read-only getActiveRunIds() accessors added to
 * PipelineController and ConsensusController for the /api/activity lens.
 *
 * The accessor must reflect adds + removes from the private in-memory
 * `activeRuns` registry (the authoritative live truth) without mutating it.
 */
import { describe, it, expect, vi } from "vitest";
import { PipelineController } from "../../../server/controller/pipeline-controller.js";
import { ConsensusController } from "../../../server/consensus/consensus-controller.js";

/** Reach the private registry to simulate runs starting/finishing. */
function registryOf(c: { getActiveRunIds(): string[] }): Map<string, AbortController> {
  return (c as unknown as { activeRuns: Map<string, AbortController> }).activeRuns;
}

const wsStub = { broadcastToRun: vi.fn(), broadcastGlobal: vi.fn() } as never;

describe("PipelineController.getActiveRunIds", () => {
  function make(): PipelineController {
    return new PipelineController({} as never, {} as never, wsStub);
  }

  it("starts empty", () => {
    expect(make().getActiveRunIds()).toEqual([]);
  });

  it("reflects adds and removes", () => {
    const c = make();
    const reg = registryOf(c);
    reg.set("run-a", new AbortController());
    reg.set("run-b", new AbortController());
    expect(c.getActiveRunIds().sort()).toEqual(["run-a", "run-b"]);

    reg.delete("run-a");
    expect(c.getActiveRunIds()).toEqual(["run-b"]);
  });

  it("returns a copy that does not mutate the registry", () => {
    const c = make();
    registryOf(c).set("run-a", new AbortController());
    const ids = c.getActiveRunIds();
    ids.push("phantom");
    expect(c.getActiveRunIds()).toEqual(["run-a"]);
  });

  it("agrees with isRunActive", () => {
    const c = make();
    registryOf(c).set("run-x", new AbortController());
    expect(c.isRunActive("run-x")).toBe(true);
    expect(c.getActiveRunIds()).toContain("run-x");
  });
});

describe("ConsensusController.getActiveRunIds", () => {
  function make(): ConsensusController {
    return new ConsensusController(
      {} as never,
      {} as never,
      { claudeModelSlug: "claude-opus" },
      () => Promise.resolve([]),
    );
  }

  it("starts empty", () => {
    expect(make().getActiveRunIds()).toEqual([]);
  });

  it("reflects adds and removes", () => {
    const c = make();
    const reg = registryOf(c);
    reg.set("c-1", new AbortController());
    expect(c.getActiveRunIds()).toEqual(["c-1"]);
    reg.delete("c-1");
    expect(c.getActiveRunIds()).toEqual([]);
  });
});

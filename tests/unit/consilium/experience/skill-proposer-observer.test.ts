/**
 * skill-proposer-observer.test.ts — DREAM-4: the background, SCHEDULED skill-feedback
 * proposer observer. FAKE storage exercises the read → pure-propose → insert loop. Covers:
 *   - kill-switch OFF ⇒ start() does not start AND a manual pass writes nothing;
 *   - kill-switch ON ⇒ a repeatedly-verified pattern → ONE `skill_proposals` insert, and it
 *     is ALWAYS `status: 'unverified'` (the human gate — never auto-graduated);
 *   - dedup: a pattern whose dedupKey already exists is NOT re-proposed;
 *   - it writes ONLY the skill_proposals seam — there is structurally NO experience-item or
 *     SKILL.md write seam in its deps (§5 propose-only boundary);
 *   - a throwing insert is CAUGHT (the pass never crashes the interval).
 */
import { describe, it, expect, vi } from "vitest";
import {
  SkillProposerObserver,
  type SkillProposerObserverDeps,
} from "../../../../server/services/consilium/experience/skill-proposer-observer.js";
import type { ExperienceItemRow, InsertSkillProposal } from "@shared/schema";
import type { ExperienceScope } from "@shared/types";
import type { AppConfig } from "../../../../server/config/schema.js";

function cfg(enabled: boolean): AppConfig {
  return {
    pipeline: {
      consiliumLoop: {
        experiencePlane: {
          enabled: true,
          skillFeedback: { enabled, intervalSec: 3_600, minVerifiedLoops: 3, minSuccessDelta: 0.5 },
        },
      },
    },
  } as unknown as AppConfig;
}

const T0 = "2026-07-06T00:00:00.000Z";
const SCOPE: ExperienceScope = { repo: "widget", archetype: "repo-assessment", criterionClass: "test-run" };

function item(id: string): ExperienceItemRow {
  const loop = `loop-${id}`;
  return {
    id,
    projectId: "proj-1",
    scope: SCOPE,
    claim: "On widget, coverage gates close by adding --cov-fail-under to pyproject + a CI gate.",
    evidence: [{ loopId: loop, round: 1, apTitle: `AP ${id}`, diffRef: "sha" }],
    verification: { method: "test-run", outcome: "independent-pass", groundingRatioAtTime: 1 },
    confidence: "verified",
    successDelta: 0.7,
    provenance: { createdAt: T0, dreamRunId: "dr-0", sourceLoops: [loop] },
    freshness: { lastConfirmedAt: T0, decayPolicy: "reuse:5" },
    consolidation: null,
    relatedComponents: [],
    sourceLoopId: loop,
    createdAt: new Date(T0),
  } as ExperienceItemRow;
}

function fakeDeps(
  items: ExperienceItemRow[],
  seedDedupKeys: string[] = [],
): { deps: SkillProposerObserverDeps; created: InsertSkillProposal[]; spies: Record<string, ReturnType<typeof vi.fn>> } {
  const created: InsertSkillProposal[] = [];
  const dedupKeys = new Set(seedDedupKeys);
  const listSpy = vi.fn(async (_limit: number) => items);
  const dedupSpy = vi.fn(async () => Array.from(dedupKeys));
  const createSpy = vi.fn(async (rows: InsertSkillProposal[]) => {
    const out: InsertSkillProposal[] = [];
    for (const r of rows) {
      if (dedupKeys.has(r.dedupKey)) continue; // storage ON CONFLICT DO NOTHING.
      dedupKeys.add(r.dedupKey);
      created.push(r);
      out.push(r);
    }
    return out;
  });
  const skillIdSpy = vi.fn(async (_name: string) => "skill-coder-id");
  return {
    created,
    spies: { listSpy, dedupSpy, createSpy, skillIdSpy },
    deps: {
      runInSystem: (fn) => fn(),
      listExperienceItems: listSpy,
      listSkillProposalDedupKeys: dedupSpy,
      createSkillProposals: createSpy,
      getSkillIdByName: skillIdSpy,
      config: () => cfg(true), // overridden per-test via makeObserver
      log: () => {},
      now: () => new Date(T0),
    },
  };
}

function makeObserver(deps: SkillProposerObserverDeps, config: AppConfig): SkillProposerObserver {
  return new SkillProposerObserver({ ...deps, config: () => config });
}

describe("SkillProposerObserver", () => {
  it("kill-switch OFF ⇒ start() does not read, and a pass writes nothing", async () => {
    const { deps, spies } = fakeDeps([item("a"), item("b"), item("c")]);
    const obs = makeObserver(deps, cfg(false));
    obs.start();
    expect(spies.listSpy).not.toHaveBeenCalled();
    await obs.runPass();
    expect(spies.listSpy).not.toHaveBeenCalled();
    expect(spies.createSpy).not.toHaveBeenCalled();
  });

  it("kill-switch ON ⇒ a repeatedly-verified pattern → ONE proposal, always status 'unverified'", async () => {
    const { deps, spies, created } = fakeDeps([item("a"), item("b"), item("c")]);
    const obs = makeObserver(deps, cfg(true));

    await obs.runPass();

    expect(spies.createSpy).toHaveBeenCalled();
    expect(created).toHaveLength(1);
    // The HUMAN GATE: the proposer only ever opens `unverified` — never auto-graduated.
    expect(created[0].status).toBe("unverified");
    expect(created[0].skillName).toBe("coder");
    // The registry link was RESOLVED via a READ (getSkillIdByName), not a write.
    expect(created[0].skillId).toBe("skill-coder-id");
    expect(spies.skillIdSpy).toHaveBeenCalledWith("coder");
  });

  it("dedup: an already-proposed pattern is not re-proposed", async () => {
    // First pass to learn the dedupKey.
    const first = fakeDeps([item("a"), item("b"), item("c")]);
    await makeObserver(first.deps, cfg(true)).runPass();
    const key = first.created[0].dedupKey;

    // Second pass seeded with that key ⇒ no new proposal.
    const second = fakeDeps([item("a"), item("b"), item("c")], [key]);
    await makeObserver(second.deps, cfg(true)).runPass();
    expect(second.created).toHaveLength(0);
  });

  it("below-threshold input ⇒ no proposal (empty + single-loop cases)", async () => {
    const empty = fakeDeps([]);
    await makeObserver(empty.deps, cfg(true)).runPass();
    expect(empty.created).toHaveLength(0);

    const oneLoop = fakeDeps([item("a")]);
    await makeObserver(oneLoop.deps, cfg(true)).runPass();
    expect(oneLoop.created).toHaveLength(0);
  });

  it("a throwing insert is caught — the pass never rejects", async () => {
    const { deps, spies } = fakeDeps([item("a"), item("b"), item("c")]);
    spies.createSpy.mockRejectedValueOnce(new Error("db down"));
    const obs = makeObserver(deps, cfg(true));
    await expect(obs.runPass()).resolves.toBeUndefined();
  });

  it("deps expose ONLY read+propose seams — no experience-item or SKILL.md write seam exists", () => {
    const { deps } = fakeDeps([item("a")]);
    const keys = Object.keys(deps);
    // The ONLY write seam is createSkillProposals; everything else is a read or context.
    expect(keys).toContain("createSkillProposals");
    expect(keys).not.toContain("updateExperienceItem");
    expect(keys).not.toContain("createExperienceItems");
    expect(keys).not.toContain("deleteExperienceItems");
    expect(keys.some((k) => /skill.*(write|patch|apply|graduate)/i.test(k))).toBe(false);
  });
});

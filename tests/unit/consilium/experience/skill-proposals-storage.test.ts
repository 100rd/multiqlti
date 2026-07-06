/**
 * skill-proposals-storage.test.ts — DREAM-4: the MemStorage skill_proposals seam.
 * Spec: experience-plane-dream §5/§9.
 *
 * Covers the storage contract the proposer + review endpoint rely on:
 *   - createSkillProposals inserts with `status: 'unverified'` by default (the envelope entry);
 *   - dedup: a second insert with the SAME dedupKey is a no-op (ON CONFLICT DO NOTHING);
 *   - listSkillProposalDedupKeys returns the persisted keys (the proposer's pre-filter);
 *   - listSkillProposals filters by status;
 *   - updateSkillProposalStatus (the human gate) moves status + stamps the review note;
 *   - getSkillIdByName resolves a registry name → id (a READ).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { MemStorage } from "../../../../server/storage.js";
import type { InsertSkillProposal } from "@shared/schema";
import type { ExperienceScope } from "@shared/types";

const SCOPE: ExperienceScope = { repo: "widget", archetype: "repo-assessment", criterionClass: "test-run" };

function proposal(p: Partial<InsertSkillProposal> & { dedupKey: string }): InsertSkillProposal {
  return {
    projectId: "proj-1",
    skillName: "coder",
    skillId: null,
    dedupKey: p.dedupKey,
    patternKey: "coverage gates close via pyproject",
    scope: SCOPE,
    patchText: "### proposed addition",
    status: "unverified",
    evidence: [{ loopId: "loop-1", round: 1, apTitle: "AP", diffRef: "sha" }],
    provenance: {
      createdAt: "2026-07-06T00:00:00.000Z",
      dreamRunId: "dr-1",
      experienceItemIds: ["a", "b", "c"],
      sourceLoops: ["loop-1", "loop-2", "loop-3"],
      verifiedLoopCount: 3,
      successDelta: 0.7,
      criterionClass: "test-run",
    },
    reviewNote: null,
    ...p,
  } as InsertSkillProposal;
}

describe("MemStorage — skill_proposals (DREAM-4)", () => {
  let storage: MemStorage;
  beforeEach(() => {
    storage = new MemStorage();
  });

  it("createSkillProposals defaults status to 'unverified' (the trust-envelope entry)", async () => {
    const [row] = await storage.createSkillProposals([proposal({ dedupKey: "k1" })]);
    expect(row.status).toBe("unverified");
    expect(row.id).toBeTruthy();
    expect(row.createdAt).toBeInstanceOf(Date);
  });

  it("dedup: a duplicate dedupKey is a no-op (ON CONFLICT DO NOTHING)", async () => {
    const first = await storage.createSkillProposals([proposal({ dedupKey: "k1" })]);
    expect(first).toHaveLength(1);
    const second = await storage.createSkillProposals([proposal({ dedupKey: "k1" })]);
    expect(second).toHaveLength(0); // not re-inserted.
    expect(await storage.listSkillProposals()).toHaveLength(1);
  });

  it("listSkillProposalDedupKeys returns the persisted keys", async () => {
    await storage.createSkillProposals([proposal({ dedupKey: "k1" }), proposal({ dedupKey: "k2" })]);
    expect((await storage.listSkillProposalDedupKeys()).sort()).toEqual(["k1", "k2"]);
  });

  it("listSkillProposals filters by status", async () => {
    await storage.createSkillProposals([proposal({ dedupKey: "k1" })]);
    const [p] = await storage.listSkillProposals();
    await storage.updateSkillProposalStatus(p.id, "verified", "graduated after reuse");
    expect(await storage.listSkillProposals({ status: "unverified" })).toHaveLength(0);
    expect(await storage.listSkillProposals({ status: "verified" })).toHaveLength(1);
  });

  it("updateSkillProposalStatus (the human gate) moves status + stamps the review note", async () => {
    await storage.createSkillProposals([proposal({ dedupKey: "k1" })]);
    const [p] = await storage.listSkillProposals();
    const updated = await storage.updateSkillProposalStatus(p.id, "verified", "looks good");
    expect(updated?.status).toBe("verified");
    expect(updated?.reviewNote).toBe("looks good");
    expect(updated?.updatedAt.getTime()).toBeGreaterThanOrEqual(p.createdAt.getTime());
  });

  it("updateSkillProposalStatus on an unknown id is a safe no-op (undefined)", async () => {
    expect(await storage.updateSkillProposalStatus("nope", "verified")).toBeUndefined();
  });

  it("getSkillIdByName resolves a registry name → id (a READ)", async () => {
    const skill = await storage.createSkill({
      name: "coder",
      description: "",
      teamId: "team-1",
      systemPromptOverride: "",
      tools: [],
      tags: [],
    } as unknown as Parameters<MemStorage["createSkill"]>[0]);
    expect(await storage.getSkillIdByName("coder")).toBe(skill.id);
    expect(await storage.getSkillIdByName("missing")).toBeNull();
  });
});

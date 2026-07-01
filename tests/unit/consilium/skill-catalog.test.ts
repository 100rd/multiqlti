/**
 * skill-catalog.test.ts — Stage 2a skill catalog (selection + binding layer).
 *
 * Asserts:
 *   - selectSkillSet: repo-assessment → an ordered [test-author, coder] TDD pair;
 *     research / infra / null / unknown → [] (⇒ executor falls back to today's
 *     single unskilled coder; NO regression).
 *   - capabilityTools: read-only ⇒ ["Read"]; worktree-write ⇒ the coder baseline.
 *   - bindSkillStep: baked-in default works against an EMPTY skills table; a
 *     same-named skills row LAYERS its systemPromptOverride and INTERSECTS its tools
 *     with the capability ceiling — intersection can only NARROW, never widen (a row
 *     can never grant Edit to a read-only step, nor Bash to anyone).
 */
import { describe, it, expect } from "vitest";
import {
  selectSkillSet,
  capabilityTools,
  bindSkillStep,
  type SkilledStep,
} from "../../../server/services/consilium/skills/catalog.js";
import { ALLOWED_TOOLS } from "../../../server/services/sdlc/coder.js";
import type { Skill } from "@shared/schema";

/** Minimal Skill row fixture (only the fields the binding layer reads matter). */
function makeSkill(over: Partial<Skill>): Skill {
  return {
    projectId: null,
    id: "skill-1",
    name: "coder",
    description: "",
    teamId: "t1",
    systemPromptOverride: "",
    tools: [],
    modelPreference: null,
    outputSchema: null,
    tags: [],
    isBuiltin: false,
    isPublic: true,
    createdBy: "system",
    version: "1.0.0",
    sharing: "public",
    usageCount: 0,
    forkedFrom: null,
    sourceType: "manual",
    gitSourceId: null,
    externalSource: null,
    externalId: null,
    externalVersion: null,
    installedAt: null,
    autoUpdate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as Skill;
}

describe("selectSkillSet — archetype → ordered skilled steps", () => {
  it("repo-assessment → an ordered [test-author, coder] TDD pair (worktree-write, verify=test-run)", () => {
    const steps = selectSkillSet("repo-assessment", null);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.skillName)).toEqual(["test-author", "coder"]);
    for (const s of steps) {
      expect(s.capability).toBe("worktree-write");
      // The verification METHOD is RECORDED for Stage 2b; Stage 2a never runs it.
      expect(s.verification).toBe("test-run");
      expect(s.systemPrompt.length).toBeGreaterThan(0); // baked-in default exists
      expect(s.id).toMatch(/^repo-assessment\//);
    }
  });

  it("Stage 3: research → an ordered [research, synthesize] web-read pair (verify=web-evidence/judge)", () => {
    const steps = selectSkillSet("research", null);
    expect(steps).toHaveLength(2);
    expect(steps.map((s) => s.skillName)).toEqual(["research", "synthesize"]);
    // BOTH steps are web-read (web_search ONLY) — NEVER worktree-write.
    for (const s of steps) {
      expect(s.capability).toBe("web-read");
      expect(s.systemPrompt.length).toBeGreaterThan(0);
      expect(s.id).toMatch(/^research\//);
    }
    // research verifies via web-evidence; synthesize is a judge step.
    expect(steps[0].verification).toBe("web-evidence");
    expect(steps[1].verification).toBe("judge");
  });

  it("infra / null → [] (executor falls back to today's single coder — NO regression)", () => {
    expect(selectSkillSet("infra", null)).toEqual([]);
    expect(selectSkillSet(null, null)).toEqual([]);
  });

  it("an unknown/garbage archetype → [] (default branch)", () => {
    // The column is enum-clamped on write, but defend the selector regardless.
    expect(selectSkillSet("totally-unknown" as never, null)).toEqual([]);
  });
});

describe("capabilityTools — the tool ceiling per capability", () => {
  it("read-only ⇒ exactly [Read] (no Edit/Write)", () => {
    expect(capabilityTools("read-only")).toEqual(["Read"]);
  });
  it("worktree-write ⇒ the EXISTING coder baseline (Edit/Write/Read)", () => {
    expect(capabilityTools("worktree-write")).toEqual([...ALLOWED_TOOLS]);
  });
  it("web-read ⇒ exactly [web_search] — read-only network, NO url_reader/fs/worktree", () => {
    expect(capabilityTools("web-read")).toEqual(["web_search"]);
    expect(capabilityTools("web-read")).not.toContain("url_reader");
    expect(capabilityTools("web-read")).not.toContain("Read");
    expect(capabilityTools("web-read")).not.toContain("Edit");
  });
  it("never includes Bash (all capabilities are subsets of the baseline)", () => {
    expect(capabilityTools("read-only")).not.toContain("Bash");
    expect(capabilityTools("worktree-write")).not.toContain("Bash");
    expect(capabilityTools("web-read")).not.toContain("Bash");
  });
});

describe("bindSkillStep — layering a skills-table row over a baked-in step", () => {
  const wwStep: SkilledStep = {
    id: "repo-assessment/coder",
    skillName: "coder",
    capability: "worktree-write",
    verification: "test-run",
    systemPrompt: "BAKED-IN coder role.",
  };
  const roStep: SkilledStep = {
    id: "x/reader",
    skillName: "reader",
    capability: "read-only",
    verification: "judge",
    systemPrompt: "BAKED-IN reader role.",
  };

  it("NO matching row ⇒ baked-in default prompt + the capability base tools (works against an EMPTY skills table)", () => {
    const bound = bindSkillStep(wwStep, undefined);
    expect(bound.systemPrompt).toBe("BAKED-IN coder role.");
    expect(bound.allowedTools).toEqual([...ALLOWED_TOOLS]);
    expect(bound.boundSkillId).toBeNull();
  });

  it("a row's systemPromptOverride is LAYERED onto (not replacing) the baked-in default", () => {
    const row = makeSkill({ name: "coder", systemPromptOverride: "PROJECT override: prefer pytest." });
    const bound = bindSkillStep(wwStep, row);
    expect(bound.systemPrompt).toContain("BAKED-IN coder role."); // default kept
    expect(bound.systemPrompt).toContain("PROJECT override: prefer pytest."); // override appended
    expect(bound.boundSkillId).toBe("skill-1");
  });

  it("a row's tools INTERSECT the capability base (narrow only — Bash is dropped, never granted)", () => {
    const row = makeSkill({ name: "coder", tools: ["Edit", "Read", "Bash", "WebSearch"] });
    const bound = bindSkillStep(wwStep, row);
    // base (Edit/Write/Read) ∩ row (Edit/Read/Bash/WebSearch) = Edit/Read. Write is
    // narrowed away by the row; Bash/WebSearch can NEVER be granted (outside base).
    expect([...bound.allowedTools].sort()).toEqual(["Edit", "Read"]);
    expect(bound.allowedTools).not.toContain("Write");
    expect(bound.allowedTools).not.toContain("Bash");
  });

  it("a row whose tools are DISJOINT from the ceiling keeps the capability base (never zeroes the step)", () => {
    const row = makeSkill({ name: "coder", tools: ["Bash", "WebSearch"] });
    const bound = bindSkillStep(wwStep, row);
    expect(bound.allowedTools).toEqual([...ALLOWED_TOOLS]); // base preserved
    expect(bound.allowedTools).not.toContain("Bash");
  });

  it("a read-only step can NEVER be widened by a row listing Edit/Write (ceiling wins)", () => {
    const row = makeSkill({ name: "reader", tools: ["Edit", "Write", "Read"] });
    const bound = bindSkillStep(roStep, row);
    // read-only base is just [Read]; intersection with the row stays [Read].
    expect(bound.allowedTools).toEqual(["Read"]);
    expect(bound.allowedTools).not.toContain("Edit");
    expect(bound.allowedTools).not.toContain("Write");
  });

  it("an EMPTY row.tools imposes no constraint (capability base kept)", () => {
    const row = makeSkill({ name: "coder", tools: [] });
    const bound = bindSkillStep(wwStep, row);
    expect(bound.allowedTools).toEqual([...ALLOWED_TOOLS]);
  });
});

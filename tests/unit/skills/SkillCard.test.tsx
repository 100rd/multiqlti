import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SkillCard } from "@/components/skills/SkillCard";
import type { Skill, ConsiliumLoopSkillStat } from "@shared/schema";

/**
 * Task #52.2: SkillCard's loop-trust stat display, replacing the dead
 * `usageCount` stat. The critical regression this guards against is the
 * retired mock contour observability's `records.length === 0 → 100%` bug —
 * a skill with no data must show "No data", never a synthetic rate.
 */
function makeSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "skill-1",
    projectId: null,
    name: "Test Skill",
    description: "A skill for testing.",
    teamId: "development",
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
    autoUpdate: false,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  } as Skill;
}

const noop = () => {};

describe("SkillCard loop-trust stat (Task #52.2)", () => {
  it('shows "No data" (not a synthetic rate) when the skill has zero applied terminal loops', () => {
    render(
      <SkillCard
        skill={makeSkill()}
        stat={undefined}
        onView={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(screen.getByTestId("skill-stat-no-data")).toHaveTextContent("No data");
    expect(screen.queryByText(/0% success/)).not.toBeInTheDocument();
    expect(screen.queryByText(/100% success/)).not.toBeInTheDocument();
    expect(screen.queryByTestId("skill-stat")).not.toBeInTheDocument();
  });

  it("renders the real success-rate/applied-count when a stat is present", () => {
    const stat: ConsiliumLoopSkillStat = {
      skillId: "skill-1",
      appliedCount: 4,
      convergedCount: 3,
      successRate: 0.75,
    };

    render(
      <SkillCard skill={makeSkill()} stat={stat} onView={noop} onEdit={noop} onDelete={noop} />,
    );

    expect(screen.getByTestId("skill-stat")).toHaveTextContent("75% success");
    expect(screen.getByTestId("skill-stat")).toHaveTextContent("4 applied");
    expect(screen.queryByTestId("skill-stat-no-data")).not.toBeInTheDocument();
  });

  it("no longer displays the retired usageCount stat even when usageCount > 0", () => {
    render(
      <SkillCard
        skill={makeSkill({ usageCount: 42 })}
        stat={undefined}
        onView={noop}
        onEdit={noop}
        onDelete={noop}
      />,
    );

    expect(screen.queryByText(/42 use/)).not.toBeInTheDocument();
  });
});

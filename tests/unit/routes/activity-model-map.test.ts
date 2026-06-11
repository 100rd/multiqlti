/**
 * Unit tests for the pure Activity model-derivation helpers
 * (server/routes/activity-model-map.ts).
 *
 * These map an ENUM (orchestrator step type / SDLC team id) to a best-effort
 * model slug. No I/O, no untrusted text — table tests over every enum member.
 */
import { describe, it, expect } from "vitest";
import {
  orchestratorStepModel,
  managerTeamModel,
  type ActivityOrchestratorModels,
} from "../../../server/routes/activity-model-map.js";
import { SDLC_TEAMS } from "../../../shared/constants.js";
import type { OrchestratorStepType } from "../../../shared/types.js";

const MODELS: ActivityOrchestratorModels = {
  planModelSlug: "plan-m",
  synthesizeModelSlug: "synth-m",
  proposerModelSlug: "prop-m",
  criticModelSlug: "crit-m",
  judgeModelSlug: "judge-m",
};

describe("orchestratorStepModel", () => {
  const cases: Array<[OrchestratorStepType, string]> = [
    ["research", "synth-m"],
    ["analyze-code", "synth-m"],
    ["ground", "synth-m"],
    ["synthesize", "synth-m"],
    ["debate", "prop-m"],
  ];

  for (const [type, expected] of cases) {
    it(`maps "${type}" → ${expected}`, () => {
      expect(orchestratorStepModel(type, MODELS)).toBe(expected);
    });
  }

  it("returns null for an unknown step type (defensive)", () => {
    expect(orchestratorStepModel("nope" as OrchestratorStepType, MODELS)).toBeNull();
  });
});

describe("managerTeamModel", () => {
  it("resolves the SDLC default model for a known team id", () => {
    const teamId = Object.keys(SDLC_TEAMS)[0];
    expect(managerTeamModel(teamId)).toBe(
      SDLC_TEAMS[teamId as keyof typeof SDLC_TEAMS].defaultModelSlug,
    );
  });

  it("covers EVERY SDLC team id", () => {
    for (const [teamId, team] of Object.entries(SDLC_TEAMS)) {
      expect(managerTeamModel(teamId)).toBe(team.defaultModelSlug);
    }
  });

  it("returns null for an unknown/custom team id (best-effort)", () => {
    expect(managerTeamModel("custom-team")).toBeNull();
  });

  it("returns null when the team id is undefined", () => {
    expect(managerTeamModel(undefined)).toBeNull();
  });
});

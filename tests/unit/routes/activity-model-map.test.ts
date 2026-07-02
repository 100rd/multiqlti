/**
 * Unit tests for the pure Activity model-derivation helpers
 * (server/routes/activity-model-map.ts).
 *
 * These map an ENUM (SDLC team id) to a best-effort model slug. No I/O, no
 * untrusted text — table tests over every enum member.
 */
import { describe, it, expect } from "vitest";
import { managerTeamModel } from "../../../server/routes/activity-model-map.js";
import { SDLC_TEAMS } from "../../../shared/constants.js";

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

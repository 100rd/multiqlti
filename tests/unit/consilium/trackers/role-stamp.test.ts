/**
 * role-stamp.test.ts — TRACK-6 (standing-role.md §5): the PURE stamp resolution that
 * turns a loaded Standing Role + a firing tracker concern into the `{ role, skills }`
 * a crystallised spec carries. Covers the fail-closed gates (adversarial: a tracker
 * concern waking a DISABLED role / a disabled or missing concern).
 */
import { describe, it, expect } from "vitest";
import type { StandingRoleRow } from "@shared/schema";
import type { StandingRoleConcern } from "@shared/types";
import { resolveRoleStamp } from "../../../../server/services/consilium/trackers/role-stamp.js";

function concern(over: Partial<StandingRoleConcern> = {}): StandingRoleConcern {
  return {
    id: "c-1",
    repoPath: "/allowed/widget",
    focus: "implement the ticket",
    trigger: { type: "tracker_event", filter: { tracker: "github", repo: "acme/widget", label: "agent" } },
    ...over,
  };
}

function role(over: Partial<StandingRoleRow> = {}): StandingRoleRow {
  return {
    id: "role-1",
    name: "backend-dev",
    persona: "You are a senior backend engineer.",
    skills: ["python-dev", "test-authoring"],
    loopTemplate: { preset: "sdlc-cross-review" },
    concerns: [concern()],
    policy: null,
    enabled: true,
    createdBy: "u-1",
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...over,
  } as unknown as StandingRoleRow;
}

describe("resolveRoleStamp", () => {
  it("stamps role name + skills for an enabled role + concern", () => {
    const res = resolveRoleStamp(role(), "c-1");
    expect(res).toEqual({ ok: true, stamp: { role: "backend-dev", skills: ["python-dev", "test-authoring"] } });
  });

  it("omits skills when the role has none", () => {
    const res = resolveRoleStamp(role({ skills: [] } as Partial<StandingRoleRow>), "c-1");
    expect(res).toEqual({ ok: true, stamp: { role: "backend-dev" } });
  });

  it("fails closed for a missing role", () => {
    expect(resolveRoleStamp(undefined, "c-1")).toEqual({ ok: false, reason: "role-not-found" });
  });

  it("fails closed for a DISABLED role (never wakes a disabled role)", () => {
    expect(resolveRoleStamp(role({ enabled: false } as Partial<StandingRoleRow>), "c-1")).toEqual({
      ok: false,
      reason: "role-disabled",
    });
  });

  it("fails closed for a concern not on the role", () => {
    expect(resolveRoleStamp(role(), "nope")).toEqual({ ok: false, reason: "concern-not-found" });
  });

  it("fails closed for a DISABLED concern", () => {
    const r = role({ concerns: [concern({ enabled: false })] } as Partial<StandingRoleRow>);
    expect(resolveRoleStamp(r, "c-1")).toEqual({ ok: false, reason: "concern-disabled" });
  });
});

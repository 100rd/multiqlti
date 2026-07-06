/**
 * role-wake.test.ts — ROLE-2 (standing-role.md §3/§8, loop-triggers.md §4): a
 * role-bound trigger firing WAKES the Standing Role → spawns its loop.
 *
 * The factory + storage are INJECTED so we assert the wake decision + the role→loop
 * composition + the per-role rails without a DB / Express / ALS:
 *   - a role-bound file_change trigger fires → factory called once on the CONCERN's
 *     repoPath, with persona+focus+event, role skills, template reviewMode, role
 *     provenance {roleId,name,concernId,cascadeDepth:1}, maxRounds forced review-only.
 *   - a role-bound github_event concern → factory called with the PR head/base ref +
 *     the ROLE template preset (not the event's default).
 *   - per-(role,concern) DEDUP, per-role CASCADE ceiling, per-role/day BUDGET.
 *   - a DISABLED role never wakes; a disabled concern never wakes.
 *   - allowlist fail-closed: a factory throw → "failed" (never a review of a bad repo).
 *   - the legacy (non-role) dispatch is untouched (maybeLaunchConsiliumReview ignores
 *     a roleConcern-less trigger — covered by trigger-dispatch.test.ts).
 */
import { describe, it, expect, vi } from "vitest";
import type { TriggerRow, ConsiliumLoopRow, StandingRoleRow } from "@shared/schema";
import type { StandingRoleConcern } from "@shared/types";
import {
  maybeLaunchRoleWake,
  evaluateRoleRails,
  DEFAULT_ROLE_BUDGET_PER_DAY,
  DEFAULT_ROLE_CASCADE_CEILING,
  type ConsiliumTriggerDispatchDeps,
} from "../../../server/services/consilium/trigger-dispatch.js";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);

// ─── Fixtures ────────────────────────────────────────────────────────────────

function fileConcern(over: Partial<StandingRoleConcern> = {}): StandingRoleConcern {
  return {
    id: "concern-1",
    repoPath: "/allowed/iac",
    focus: "a new or changed Terraform module version",
    trigger: { type: "file_change", filter: { watchPath: "/allowed/iac/modules" } },
    ...over,
  };
}

function githubConcern(over: Partial<StandingRoleConcern> = {}): StandingRoleConcern {
  return {
    id: "concern-gh",
    repoPath: "/allowed/iac",
    focus: "review this module PR",
    trigger: { type: "github_event", filter: { repository: "owner/repo", events: ["pull_request"] } },
    ...over,
  };
}

function makeRole(over: Partial<StandingRoleRow> = {}): StandingRoleRow {
  return {
    id: "role-1",
    projectId: "proj-1",
    name: "devops-reviewer",
    persona: "You are a senior DevOps reviewer. Prioritise CIS/security and cost.",
    skills: ["skill-a", "skill-b"],
    loopTemplate: { preset: "diff-pr-review", maxRounds: 3, reviewMode: "single-verifier" },
    concerns: [fileConcern()],
    policy: null,
    enabled: true,
    createdBy: "owner-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  } as unknown as StandingRoleRow;
}

function makeTrigger(
  binding: { roleId: string; concernId: string },
  over: Partial<TriggerRow> = {},
): TriggerRow {
  return {
    id: "trig-role-1",
    projectId: "proj-1",
    pipelineId: null,
    type: "file_change",
    config: { watchPath: "/allowed/iac/modules", roleConcern: binding },
    ...over,
  } as unknown as TriggerRow;
}

function envelope(event: string, ghPayload: unknown) {
  return { event, delivery: "d-1", payload: ghPayload };
}

function prPayload(over: Record<string, unknown> = {}) {
  return {
    action: "opened",
    number: 12,
    pull_request: { title: "Add module", head: { sha: HEAD }, base: { sha: BASE } },
    repository: { full_name: "owner/repo", default_branch: "main" },
    ...over,
  };
}

function makeDeps(
  role: StandingRoleRow | undefined,
  over: Partial<ConsiliumTriggerDispatchDeps> = {},
  loops: ConsiliumLoopRow[] = [],
) {
  const createReview = vi
    .fn()
    .mockResolvedValue({ id: "loop-1", repoPath: "/allowed/iac", state: "reviewing" } as ConsiliumLoopRow);
  const runInProject = vi.fn().mockImplementation((_pid: string, fn: () => Promise<unknown>) => fn());
  const log = vi.fn();
  const getLoops = vi.fn().mockResolvedValue(loops);
  const getStandingRole = vi.fn().mockResolvedValue(role);
  const resolveOwnerId = vi.fn().mockResolvedValue("owner-1");
  const recordFire = vi.fn().mockResolvedValue(undefined);
  const deps: ConsiliumTriggerDispatchDeps = {
    reviewDeps: { storage: { getLoops, getStandingRole } } as unknown as ConsiliumTriggerDispatchDeps["reviewDeps"],
    createReview,
    runInProject,
    resolveOwnerId,
    recordFire,
    log,
    ...over,
  };
  return { deps, createReview, runInProject, log, getLoops, getStandingRole, resolveOwnerId, recordFire };
}

/** A non-terminal loop woken by a given (role, concern) — for the rails tests. */
function roleLoop(roleId: string, concernId: string, over: Partial<ConsiliumLoopRow> = {}): ConsiliumLoopRow {
  return {
    id: `loop-${roleId}-${concernId}-${Math.random().toString(36).slice(2, 6)}`,
    repoPath: "/allowed/iac",
    state: "reviewing",
    createdAt: new Date(),
    triggerProvenance: { firedAt: new Date().toISOString(), role: { roleId, name: "r", concernId } },
    ...over,
  } as unknown as ConsiliumLoopRow;
}

// ─── file_change wake ─────────────────────────────────────────────────────────

describe("maybeLaunchRoleWake — file_change concern", () => {
  it("wakes the role → factory once on the concern repo, with role composition + provenance", async () => {
    const role = makeRole();
    const { deps, createReview, runInProject, recordFire } = makeDeps(role);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });

    const result = await maybeLaunchRoleWake(deps, trigger, {
      filePath: "/allowed/iac/modules/vpc/main.tf",
      watchPath: "/allowed/iac/modules",
    });

    expect(result).toBe("launched");
    expect(runInProject).toHaveBeenCalledWith("proj-1", expect.any(Function));
    expect(createReview).toHaveBeenCalledTimes(1);
    expect(recordFire).toHaveBeenCalledTimes(1);

    const [, params] = createReview.mock.calls[0];
    // WHERE: the CONCERN's repoPath (not the trigger's watchPath) — factory re-validates.
    expect(params.repoPath).toBe("/allowed/iac");
    // SHAPE: the ROLE template.
    expect(params.preset).toBe("diff-pr-review");
    expect(params.reviewMode).toBe("single-verifier");
    // T6: review-only forced even for a role wake (template maxRounds:3 is NOT honoured
    // on the automated path — escalation to develop is a human action).
    expect(params.maxRounds).toBe(1);
    // WHAT: persona + concern.focus + the fired event, all in the engineerInstruction.
    expect(params.engineerInstruction).toContain(role.persona);
    expect(params.engineerInstruction).toContain("Terraform module version");
    expect(params.engineerInstruction).toContain("/allowed/iac/modules/vpc/main.tf");
    // CAPABILITY: the role's skills (re-resolved project-scoped by the factory).
    expect(params.skillIds).toEqual(["skill-a", "skill-b"]);
    // OWNER: the resolved project owner (never the literal "system").
    expect(params.createdBy).toBe("owner-1");
    // PROVENANCE: the originating role + concern + cascade depth.
    expect(params.triggerProvenance.role).toMatchObject({
      roleId: "role-1",
      name: "devops-reviewer",
      concernId: "concern-1",
      cascadeDepth: 1,
    });
    expect(params.triggerProvenance.triggerId).toBe("trig-role-1");
  });

  it("interpolates ${event} in the concern focus when the operator embedded the token", async () => {
    const role = makeRole({ concerns: [fileConcern({ focus: "watch: ${event}" })] });
    const { deps, createReview } = makeDeps(role);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });

    await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" });
    const [, params] = createReview.mock.calls[0];
    expect(params.engineerInstruction).toContain("watch: file change at /allowed/iac/modules/x.tf");
  });
});

// ─── github_event wake ────────────────────────────────────────────────────────

describe("maybeLaunchRoleWake — github_event concern", () => {
  it("wakes the role on a PR → PR head/base ref, ROLE template preset (not the event default)", async () => {
    const role = makeRole({
      concerns: [githubConcern()],
      loopTemplate: { preset: "sdlc-cross-review", reviewMode: "full-dispute" },
    });
    const { deps, createReview } = makeDeps(role);
    const trigger = makeTrigger(
      { roleId: "role-1", concernId: "concern-gh" },
      { type: "github_event", config: { repository: "owner/repo", events: ["pull_request"], roleConcern: { roleId: "role-1", concernId: "concern-gh" } } as unknown as TriggerRow["config"] },
    );

    const result = await maybeLaunchRoleWake(deps, trigger, envelope("pull_request", prPayload()));

    expect(result).toBe("launched");
    const [, params] = createReview.mock.calls[0];
    expect(params.ref).toBe(HEAD);
    expect(params.baselineCommit).toBe(BASE);
    // The ROLE template's preset wins over the github event mapping's diff-pr-review.
    expect(params.preset).toBe("sdlc-cross-review");
    expect(params.engineerInstruction).toContain("PR #12: Add module");
    expect(params.triggerProvenance.role.concernId).toBe("concern-gh");
  });

  it("an unmapped github event (issues) → noop-event, factory NOT called", async () => {
    const role = makeRole({ concerns: [githubConcern()] });
    const { deps, createReview } = makeDeps(role);
    const trigger = makeTrigger(
      { roleId: "role-1", concernId: "concern-gh" },
      { type: "github_event", config: { repository: "owner/repo", events: ["issues"], roleConcern: { roleId: "role-1", concernId: "concern-gh" } } as unknown as TriggerRow["config"] },
    );
    expect(await maybeLaunchRoleWake(deps, trigger, envelope("issues", { action: "opened" }))).toBe("noop-event");
    expect(createReview).not.toHaveBeenCalled();
  });
});

// ─── Safety: disabled role / concern, missing role / concern ──────────────────

describe("maybeLaunchRoleWake — enabled gate + resolution (§6)", () => {
  it("a DISABLED role never wakes → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps(makeRole({ enabled: false }));
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a DISABLED concern never wakes → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps(makeRole({ concerns: [fileConcern({ enabled: false })] }));
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("an unknown role id → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps(undefined);
    const trigger = makeTrigger({ roleId: "ghost", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, {})).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a concern id not on the role → skipped, factory NOT called", async () => {
    const { deps, createReview } = makeDeps(makeRole());
    const trigger = makeTrigger({ roleId: "role-1", concernId: "ghost-concern" });
    expect(await maybeLaunchRoleWake(deps, trigger, {})).toBe("skipped");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a trigger with no roleConcern binding → noop (defensive; the route pre-checks)", async () => {
    const { deps, createReview } = makeDeps(makeRole());
    const trigger = { id: "t", projectId: "proj-1", type: "file_change", config: { watchPath: "/w" } } as unknown as TriggerRow;
    expect(await maybeLaunchRoleWake(deps, trigger, {})).toBe("noop");
    expect(createReview).not.toHaveBeenCalled();
  });
});

// ─── Allowlist fail-closed (R1) ───────────────────────────────────────────────

describe("maybeLaunchRoleWake — allowlist fail-closed", () => {
  it("a factory throw (repoPath outside the allowlist) → failed, never a review", async () => {
    const role = makeRole({ concerns: [fileConcern({ repoPath: "/etc/evil" })] });
    const createReview = vi.fn().mockRejectedValue(new Error("repoPath is outside every allowed root (fail-closed)"));
    const { deps } = makeDeps(role, { createReview });
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/etc/evil/x" })).toBe("failed");
  });
});

// ─── Per-role rails: dedup / cascade / budget ─────────────────────────────────

describe("maybeLaunchRoleWake — per-role rails (loop-triggers.md §4)", () => {
  it("DEDUP: an active loop for the SAME (role, concern) → skipped-dedup, factory NOT called", async () => {
    const role = makeRole();
    const { deps, createReview } = makeDeps(role, {}, [roleLoop("role-1", "concern-1")]);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("skipped-dedup");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("a loop for a DIFFERENT concern of the SAME role does NOT dedup (per-(role,concern))", async () => {
    const role = makeRole({ concerns: [fileConcern(), fileConcern({ id: "concern-2" })] });
    const { deps, createReview } = makeDeps(role, {}, [roleLoop("role-1", "concern-2")]);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("launched");
    expect(createReview).toHaveBeenCalledTimes(1);
  });

  it("CASCADE: active loops for the role at the ceiling → skipped-cascade, factory NOT called", async () => {
    const role = makeRole({
      concerns: [fileConcern(), fileConcern({ id: "c2" }), fileConcern({ id: "c3" }), fileConcern({ id: "c4" })],
      policy: { cascadeDepth: 2 },
    });
    // Two active loops across OTHER concerns → at the ceiling of 2 → the new concern is
    // suppressed by cascade (before dedup would even apply, since it's a different concern).
    const { deps, createReview } = makeDeps(role, {}, [roleLoop("role-1", "c2"), roleLoop("role-1", "c3")]);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("skipped-cascade");
    expect(createReview).not.toHaveBeenCalled();
  });

  it("BUDGET: role at its daily cap → skipped-budget, factory NOT called", async () => {
    const role = makeRole({ policy: { budgetPerDay: 2, cascadeDepth: 10 } });
    // Two TERMINAL loops for the role within 24h → budget spent (2/2), but not active so
    // cascade (concurrent) does not trip; budget does.
    const terminal = (concernId: string) =>
      roleLoop("role-1", concernId, { state: "converged", createdAt: new Date() });
    const { deps, createReview } = makeDeps(role, {}, [terminal("c-old-1"), terminal("c-old-2")]);
    const trigger = makeTrigger({ roleId: "role-1", concernId: "concern-1" });
    expect(await maybeLaunchRoleWake(deps, trigger, { filePath: "/allowed/iac/modules/x.tf" })).toBe("skipped-budget");
    expect(createReview).not.toHaveBeenCalled();
  });
});

// ─── evaluateRoleRails (pure) ─────────────────────────────────────────────────

describe("evaluateRoleRails — pure rail evaluation", () => {
  const rails = { roleId: "r", concernId: "c", budgetPerDay: 5, cascadeCeiling: 3 };
  const now = new Date("2026-07-06T12:00:00Z");

  it("empty loop list → no suppression", () => {
    expect(evaluateRoleRails([], rails, now)).toEqual({});
  });

  it("dedup wins over cascade/budget when the SAME concern is active", () => {
    const loops = [roleLoop("r", "c", { id: "dup-1" })];
    expect(evaluateRoleRails(loops, rails, now)).toEqual({ suppress: "dedup", loopId: "dup-1" });
  });

  it("cascade trips when concurrent active role loops reach the ceiling", () => {
    const loops = [roleLoop("r", "x"), roleLoop("r", "y"), roleLoop("r", "z")];
    expect(evaluateRoleRails(loops, rails, now).suppress).toBe("cascade");
  });

  it("budget trips on recent (24h) loops when none are concurrently active", () => {
    const recent = (c: string) => roleLoop("r", c, { state: "converged", createdAt: new Date("2026-07-06T06:00:00Z") });
    const loops = [recent("a"), recent("b"), recent("c"), recent("d"), recent("e")];
    expect(evaluateRoleRails(loops, rails, now).suppress).toBe("budget");
  });

  it("loops OLDER than the 24h window do not count against budget", () => {
    const old = (c: string) => roleLoop("r", c, { state: "converged", createdAt: new Date("2026-07-04T00:00:00Z") });
    const loops = [old("a"), old("b"), old("c"), old("d"), old("e"), old("f")];
    expect(evaluateRoleRails(loops, rails, now)).toEqual({});
  });

  it("loops of OTHER roles are ignored entirely", () => {
    const loops = [roleLoop("other", "c"), roleLoop("other", "c"), roleLoop("other", "c")];
    expect(evaluateRoleRails(loops, rails, now)).toEqual({});
  });

  it("exposes sane server defaults", () => {
    expect(DEFAULT_ROLE_BUDGET_PER_DAY).toBeGreaterThan(0);
    expect(DEFAULT_ROLE_CASCADE_CEILING).toBeGreaterThan(0);
  });
});

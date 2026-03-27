import { describe, it, expect } from "vitest";
import {
  getDefaultPermissions,
  resolvePermissions,
  canChat,
  canVote,
  canViewStage,
  canViewMemories,
  filterEvent,
} from "../../server/federation/permissions";
import type { SharedSession, SharePermissions } from "../../shared/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSession(overrides: Partial<SharedSession> = {}): SharedSession {
  return {
    id: "session-1",
    runId: "run-1",
    shareToken: "abc123",
    ownerInstanceId: "local-instance",
    createdBy: "user-1",
    expiresAt: null,
    isActive: true,
    createdAt: new Date(),
    ...overrides,
  };
}

function makePermissions(overrides: Partial<SharePermissions> = {}): SharePermissions {
  return {
    role: "collaborator",
    allowedStages: null,
    canChat: true,
    canVote: true,
    canViewMemories: true,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("getDefaultPermissions", () => {
  it("returns full access for owner role", () => {
    const perms = getDefaultPermissions("owner");
    expect(perms.role).toBe("owner");
    expect(perms.canChat).toBe(true);
    expect(perms.canVote).toBe(true);
    expect(perms.canViewMemories).toBe(true);
    expect(perms.allowedStages).toBeNull();
  });

  it("returns full access for collaborator role", () => {
    const perms = getDefaultPermissions("collaborator");
    expect(perms.role).toBe("collaborator");
    expect(perms.canChat).toBe(true);
    expect(perms.canVote).toBe(true);
    expect(perms.canViewMemories).toBe(true);
    expect(perms.allowedStages).toBeNull();
  });

  it("returns read-only for viewer role", () => {
    const perms = getDefaultPermissions("viewer");
    expect(perms.role).toBe("viewer");
    expect(perms.canChat).toBe(false);
    expect(perms.canVote).toBe(false);
    expect(perms.canViewMemories).toBe(true);
    expect(perms.allowedStages).toBeNull();
  });

  it("returns a fresh copy each time", () => {
    const a = getDefaultPermissions("owner");
    const b = getDefaultPermissions("owner");
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });
});

describe("resolvePermissions", () => {
  it("uses session permissions when present", () => {
    const session = makeSession({
      permissions: makePermissions({ role: "viewer", canChat: false }),
    });
    const perms = resolvePermissions(session);
    expect(perms.role).toBe("viewer");
    expect(perms.canChat).toBe(false);
  });

  it("falls back to collaborator defaults when no permissions", () => {
    const session = makeSession({ permissions: undefined });
    const perms = resolvePermissions(session);
    expect(perms.role).toBe("collaborator");
    expect(perms.canChat).toBe(true);
    expect(perms.canVote).toBe(true);
  });
});

describe("canChat", () => {
  it("returns true for collaborator", () => {
    const session = makeSession({
      permissions: makePermissions({ role: "collaborator", canChat: true }),
    });
    expect(canChat(session)).toBe(true);
  });

  it("returns false for viewer", () => {
    const session = makeSession({
      permissions: makePermissions({ role: "viewer", canChat: false }),
    });
    expect(canChat(session)).toBe(false);
  });

  it("returns true for session without permissions (backward compat)", () => {
    const session = makeSession({ permissions: undefined });
    expect(canChat(session)).toBe(true);
  });
});

describe("canVote", () => {
  it("returns true for collaborator", () => {
    const session = makeSession({
      permissions: makePermissions({ canVote: true }),
    });
    expect(canVote(session)).toBe(true);
  });

  it("returns false when explicitly disabled", () => {
    const session = makeSession({
      permissions: makePermissions({ canVote: false }),
    });
    expect(canVote(session)).toBe(false);
  });
});

describe("canViewMemories", () => {
  it("returns true by default", () => {
    const session = makeSession({
      permissions: makePermissions({ canViewMemories: true }),
    });
    expect(canViewMemories(session)).toBe(true);
  });

  it("returns false when explicitly disabled", () => {
    const session = makeSession({
      permissions: makePermissions({ canViewMemories: false }),
    });
    expect(canViewMemories(session)).toBe(false);
  });
});

describe("canViewStage", () => {
  it("returns true when allowedStages is null (all stages)", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: null }),
    });
    expect(canViewStage(session, "stage-1")).toBe(true);
    expect(canViewStage(session, "stage-99")).toBe(true);
  });

  it("returns true when stage is in allowedStages", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1", "stage-2"] }),
    });
    expect(canViewStage(session, "stage-1")).toBe(true);
    expect(canViewStage(session, "stage-2")).toBe(true);
  });

  it("returns false when stage is not in allowedStages", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1"] }),
    });
    expect(canViewStage(session, "stage-2")).toBe(false);
  });

  it("returns false for empty allowedStages array", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: [] }),
    });
    expect(canViewStage(session, "stage-1")).toBe(false);
  });
});

describe("filterEvent", () => {
  it("passes through non-typed events", () => {
    const session = makeSession({
      permissions: makePermissions({ canChat: false }),
    });
    const event = { data: "hello" };
    expect(filterEvent(session, event)).toEqual(event);
  });

  it("filters chat events when canChat is false", () => {
    const session = makeSession({
      permissions: makePermissions({ canChat: false }),
    });
    expect(filterEvent(session, { type: "chat:message", content: "hi" })).toBeNull();
    expect(filterEvent(session, { type: "chat_message", content: "hi" })).toBeNull();
  });

  it("passes chat events when canChat is true", () => {
    const session = makeSession({
      permissions: makePermissions({ canChat: true }),
    });
    const event = { type: "chat:message", content: "hi" };
    expect(filterEvent(session, event)).toEqual(event);
  });

  it("filters vote events when canVote is false", () => {
    const session = makeSession({
      permissions: makePermissions({ canVote: false }),
    });
    expect(filterEvent(session, { type: "vote:cast" })).toBeNull();
    expect(filterEvent(session, { type: "approval_vote" })).toBeNull();
  });

  it("passes vote events when canVote is true", () => {
    const session = makeSession({
      permissions: makePermissions({ canVote: true }),
    });
    expect(filterEvent(session, { type: "vote:cast" })).not.toBeNull();
  });

  it("filters memory events when canViewMemories is false", () => {
    const session = makeSession({
      permissions: makePermissions({ canViewMemories: false }),
    });
    expect(filterEvent(session, { type: "memory:created" })).toBeNull();
    expect(filterEvent(session, { type: "memory_created" })).toBeNull();
  });

  it("passes memory events when canViewMemories is true", () => {
    const session = makeSession({
      permissions: makePermissions({ canViewMemories: true }),
    });
    expect(filterEvent(session, { type: "memory:created" })).not.toBeNull();
  });

  it("filters stage events when stage not in allowedStages", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1"] }),
    });
    const event = { type: "stage:update", payload: { stageId: "stage-2" } };
    expect(filterEvent(session, event)).toBeNull();
  });

  it("passes stage events when stage is in allowedStages", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1", "stage-2"] }),
    });
    const event = { type: "stage:update", payload: { stageId: "stage-1" } };
    expect(filterEvent(session, event)).toEqual(event);
  });

  it("passes stage events when allowedStages is null", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: null }),
    });
    const event = { type: "stage:update", payload: { stageId: "stage-99" } };
    expect(filterEvent(session, event)).toEqual(event);
  });

  it("passes stage events with stageId at top level", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1"] }),
    });
    const event = { type: "stage_update", stageId: "stage-1" };
    expect(filterEvent(session, event)).toEqual(event);
  });

  it("filters stage events with stageId at top level when not allowed", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1"] }),
    });
    const event = { type: "stage_update", stageId: "stage-2" };
    expect(filterEvent(session, event)).toBeNull();
  });

  it("passes stage events without stageId when stages restricted", () => {
    const session = makeSession({
      permissions: makePermissions({ allowedStages: ["stage-1"] }),
    });
    const event = { type: "stage:started" };
    expect(filterEvent(session, event)).toEqual(event);
  });
});

describe("permission update (owner only)", () => {
  it("only owner can update -- tested at service/route level", () => {
    // This is a placeholder to document the authorization rule.
    // The actual enforcement is in SessionSharingService.updatePermissions
    // and the PATCH route handler, which check session.createdBy === requesterId.
    expect(true).toBe(true);
  });
});

describe("backward compatibility", () => {
  it("sessions without permissions default to collaborator behavior", () => {
    const session = makeSession({ permissions: undefined });
    expect(canChat(session)).toBe(true);
    expect(canVote(session)).toBe(true);
    expect(canViewMemories(session)).toBe(true);
    expect(canViewStage(session, "any-stage")).toBe(true);
  });

  it("filtering passes all events for sessions without permissions", () => {
    const session = makeSession({ permissions: undefined });
    expect(filterEvent(session, { type: "chat:message" })).not.toBeNull();
    expect(filterEvent(session, { type: "stage:update", payload: { stageId: "s1" } })).not.toBeNull();
    expect(filterEvent(session, { type: "vote:cast" })).not.toBeNull();
    expect(filterEvent(session, { type: "memory:created" })).not.toBeNull();
  });
});

describe("share with custom permissions", () => {
  it("viewer with memory access disabled", () => {
    const session = makeSession({
      permissions: makePermissions({
        role: "viewer",
        canChat: false,
        canVote: false,
        canViewMemories: false,
        allowedStages: ["stage-1"],
      }),
    });
    expect(canChat(session)).toBe(false);
    expect(canVote(session)).toBe(false);
    expect(canViewMemories(session)).toBe(false);
    expect(canViewStage(session, "stage-1")).toBe(true);
    expect(canViewStage(session, "stage-2")).toBe(false);
  });

  it("collaborator restricted to specific stages", () => {
    const session = makeSession({
      permissions: makePermissions({
        role: "collaborator",
        canChat: true,
        canVote: true,
        canViewMemories: true,
        allowedStages: ["design", "review"],
      }),
    });
    expect(canChat(session)).toBe(true);
    expect(canViewStage(session, "design")).toBe(true);
    expect(canViewStage(session, "review")).toBe(true);
    expect(canViewStage(session, "deploy")).toBe(false);
  });

  it("event filtering with combined restrictions", () => {
    const session = makeSession({
      permissions: makePermissions({
        role: "viewer",
        canChat: false,
        canVote: false,
        canViewMemories: false,
        allowedStages: ["stage-a"],
      }),
    });

    // Chat blocked
    expect(filterEvent(session, { type: "chat:message" })).toBeNull();
    // Vote blocked
    expect(filterEvent(session, { type: "vote:cast" })).toBeNull();
    // Memory blocked
    expect(filterEvent(session, { type: "memory:created" })).toBeNull();
    // Allowed stage passes
    expect(
      filterEvent(session, { type: "stage:update", payload: { stageId: "stage-a" } }),
    ).not.toBeNull();
    // Disallowed stage blocked
    expect(
      filterEvent(session, { type: "stage:update", payload: { stageId: "stage-b" } }),
    ).toBeNull();
    // Non-restricted event type passes
    expect(filterEvent(session, { type: "run:started" })).not.toBeNull();
  });
});

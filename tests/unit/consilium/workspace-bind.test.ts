/**
 * Unit tests for server/services/consilium/workspace-bind.ts (Phase D.3).
 *
 * Drives `resolveLoopWorkspace` with a FAKE storage (no DB). The allowlist is
 * the real cwd so the H-5 path check + realpath succeed against an on-disk path.
 * Covers (§14.7):
 *   - existing matching local workspace → returned, NO create
 *   - none → createWorkspace called with the realpath'd path
 *   - non-allowlisted repoPath → throws BEFORE any create (H-5)
 *   - poisoned-path existing row → rejected (re-validated, not used)
 */
import { describe, it, expect, vi } from "vitest";
import { realpathSync } from "fs";
import { resolveLoopWorkspace, findLoopWorkspace, type WorkspaceBindStorage } from "../../../server/services/consilium/workspace-bind.js";
import type { InsertWorkspace, WorkspaceRow } from "@shared/schema";

const REPO = process.cwd();
const RESOLVED = realpathSync(REPO);
const ALLOW = [REPO];
const OWNER = "owner-1";

function row(over: Partial<WorkspaceRow>): WorkspaceRow {
  return {
    id: "ws-existing",
    name: "x",
    type: "local",
    path: RESOLVED,
    branch: "main",
    status: "active",
    lastSyncAt: null,
    createdAt: new Date(),
    ownerId: OWNER,
    indexStatus: "idle",
    ...over,
  } as WorkspaceRow;
}

function fakeStorage(rows: WorkspaceRow[]): {
  storage: WorkspaceBindStorage;
  createWorkspace: ReturnType<typeof vi.fn>;
} {
  const createWorkspace = vi.fn(async (data: InsertWorkspace & { id?: string }) =>
    row({ id: "ws-new", ...data }),
  );
  return {
    storage: { getWorkspaces: vi.fn(async () => rows), createWorkspace },
    createWorkspace,
  };
}

describe("resolveLoopWorkspace", () => {
  it("returns an existing matching local workspace without creating", async () => {
    const { storage, createWorkspace } = fakeStorage([row({ id: "ws-existing" })]);
    const ws = await resolveLoopWorkspace(storage, REPO, OWNER, ALLOW);
    expect(ws.id).toBe("ws-existing");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("creates a local workspace with the realpath'd path when none match", async () => {
    const { storage, createWorkspace } = fakeStorage([]);
    const ws = await resolveLoopWorkspace(storage, REPO, OWNER, ALLOW);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    const arg = createWorkspace.mock.calls[0][0] as InsertWorkspace;
    expect(arg.type).toBe("local");
    expect(arg.path).toBe(RESOLVED); // realpath'd, not raw input
    expect(arg.ownerId).toBe(OWNER);
    expect(ws.path).toBe(RESOLVED);
  });

  it("ignores a non-local row and creates a fresh local workspace", async () => {
    const { storage, createWorkspace } = fakeStorage([row({ id: "remote-x", type: "remote" })]);
    await resolveLoopWorkspace(storage, REPO, OWNER, ALLOW);
    expect(createWorkspace).toHaveBeenCalledTimes(1);
  });

  it("throws on a non-allowlisted repoPath BEFORE any create (H-5)", async () => {
    const { storage, createWorkspace } = fakeStorage([]);
    await expect(
      resolveLoopWorkspace(storage, "/tmp/not-allowed", OWNER, ALLOW),
    ).rejects.toThrow(/repo-allowlist/);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("fails closed on an empty allowlist", async () => {
    const { storage } = fakeStorage([]);
    await expect(resolveLoopWorkspace(storage, REPO, OWNER, [])).rejects.toThrow(/empty/);
  });

  it("rejects a poisoned-path existing row (re-validated, not used) → creates fresh", async () => {
    // The stored row's path points outside the allowlist (poisoned out-of-band).
    const poisoned = row({ id: "ws-poisoned", path: "/etc/passwd" });
    const { storage, createWorkspace } = fakeStorage([poisoned]);
    const ws = await resolveLoopWorkspace(storage, REPO, OWNER, ALLOW);
    // Poisoned row skipped → a fresh, allowlisted workspace is created instead.
    expect(ws.id).not.toBe("ws-poisoned");
    expect(createWorkspace).toHaveBeenCalledTimes(1);
    expect((createWorkspace.mock.calls[0][0] as InsertWorkspace).path).toBe(RESOLVED);
  });
});

describe("findLoopWorkspace (read-only — never creates)", () => {
  it("returns an existing matching local workspace WITHOUT creating", async () => {
    const { storage, createWorkspace } = fakeStorage([row({ id: "ws-existing" })]);
    const ws = await findLoopWorkspace(storage, REPO, ALLOW);
    expect(ws?.id).toBe("ws-existing");
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("returns undefined when no workspace is bound (never creates)", async () => {
    const { storage, createWorkspace } = fakeStorage([]);
    const ws = await findLoopWorkspace(storage, REPO, ALLOW);
    expect(ws).toBeUndefined();
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("returns undefined for a non-allowlisted repoPath (never throws)", async () => {
    const { storage } = fakeStorage([row({ id: "ws-existing" })]);
    const ws = await findLoopWorkspace(storage, "/tmp/not-allowed", ALLOW);
    expect(ws).toBeUndefined();
  });

  it("skips a poisoned-path row and returns undefined", async () => {
    const { storage } = fakeStorage([row({ id: "ws-poisoned", path: "/etc/passwd" })]);
    const ws = await findLoopWorkspace(storage, REPO, ALLOW);
    expect(ws).toBeUndefined();
  });
});

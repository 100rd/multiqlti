/**
 * Unit tests for the H3 task-group fallback in WsManager.authorizeAndSubscribe.
 *
 * When `getPipelineRun(runId)` misses, the gate falls back to
 * `getTaskGroup(runId)` and applies the SAME isVisible(createdBy,user) rule:
 *   - group owner subscribes; non-owner denied; admin bypass; ownerless denied
 *     to non-admin; unknown id (both spaces) denied; missing user / no storage
 *     fail closed; the pipeline path is unchanged (pipeline-first ordering).
 *
 * A real (non-listening) HTTP server backs the WsManager; no network I/O.
 */
import { describe, it, expect, vi } from "vitest";
import { createServer } from "http";
import type { IStorage } from "../../../server/storage.js";

async function createManager(storage?: IStorage) {
  const { WsManager } = await import("../../../server/ws/manager.js");
  const httpServer = createServer();
  const manager = new WsManager(httpServer, storage);
  return { manager };
}

function makeFakeWs(readyState = 1) {
  return { readyState, send: vi.fn() };
}

/** Storage where the id is a task group (no pipeline run), owned by `createdBy`. */
function groupStorage(createdBy: string | null): IStorage {
  return {
    getPipelineRun: vi.fn(async () => undefined),
    getTaskGroup: vi.fn(async () => ({ id: "g", createdBy })),
  } as unknown as IStorage;
}

/** Storage where the id IS a pipeline run (the unchanged path); getTaskGroup must NOT be hit. */
function pipelineStorage(triggeredBy: string | null) {
  const getTaskGroup = vi.fn(async () => undefined);
  const storage = {
    getPipelineRun: vi.fn(async () => ({ id: "r", triggeredBy })),
    getTaskGroup,
  } as unknown as IStorage;
  return { storage, getTaskGroup };
}

const owner = { id: "owner", role: "user" } as never;
const intruder = { id: "intruder", role: "user" } as never;
const admin = { id: "boss", role: "admin" } as never;

describe("WsManager.authorizeAndSubscribe — task-group fallback (H3)", () => {
  it("allows the group OWNER to subscribe to a task-group id", async () => {
    const { manager } = await createManager(groupStorage("owner"));
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, owner, "g");
    expect(ok).toBe(true);
    manager.broadcastToRun("g", { type: "taskgroup:started", runId: "g", payload: {}, timestamp: "t" });
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("DENIES a non-owner on a task-group id", async () => {
    const { manager } = await createManager(groupStorage("owner"));
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, intruder, "g")).toBe(false);
  });

  it("allows an ADMIN on any task-group id", async () => {
    const { manager } = await createManager(groupStorage("owner"));
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, admin, "g")).toBe(true);
  });

  it("DENIES an ownerless group (createdBy null) to a non-admin", async () => {
    const { manager } = await createManager(groupStorage(null));
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, owner, "g")).toBe(false);
  });

  it("allows an ownerless group to an admin", async () => {
    const { manager } = await createManager(groupStorage(null));
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, admin, "g")).toBe(true);
  });

  it("DENIES an id unknown in BOTH spaces (fail closed)", async () => {
    const storage = {
      getPipelineRun: vi.fn(async () => undefined),
      getTaskGroup: vi.fn(async () => undefined),
    } as unknown as IStorage;
    const { manager } = await createManager(storage);
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, owner, "ghost")).toBe(false);
  });

  it("fails closed with no user", async () => {
    const { manager } = await createManager(groupStorage("owner"));
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, undefined, "g")).toBe(false);
  });

  it("fails closed with no storage", async () => {
    const { manager } = await createManager(undefined);
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, owner, "g")).toBe(false);
  });
});

describe("WsManager.authorizeAndSubscribe — pipeline path unchanged", () => {
  it("a pipeline run is authorized via triggeredBy and NEVER consults getTaskGroup", async () => {
    const { storage, getTaskGroup } = pipelineStorage("owner");
    const { manager } = await createManager(storage);
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, owner, "r");
    expect(ok).toBe(true);
    expect(getTaskGroup).not.toHaveBeenCalled();
  });

  it("a pipeline run owned by another user is denied (and getTaskGroup not consulted)", async () => {
    const { storage, getTaskGroup } = pipelineStorage("owner");
    const { manager } = await createManager(storage);
    const ws = makeFakeWs();
    expect(await manager.authorizeAndSubscribe(ws as never, intruder, "r")).toBe(false);
    expect(getTaskGroup).not.toHaveBeenCalled();
  });
});

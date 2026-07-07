/**
 * Unit tests for WsManager.authorizeAndSubscribe's task-group ownership gate
 * (H3). `getTaskGroup(runId)` is the sole authorization path:
 *   - group owner subscribes; non-owner denied; admin bypass; ownerless denied
 *     to non-admin; unknown id denied; missing user / no storage fail closed.
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

/** Storage where the id is a task group, owned by `createdBy`. */
function groupStorage(createdBy: string | null): IStorage {
  return {
    getTaskGroup: vi.fn(async () => ({ id: "g", createdBy })),
  } as unknown as IStorage;
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

  it("DENIES an unknown id (fail closed)", async () => {
    const storage = {
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

/**
 * Unit tests for server/ws/manager.ts — WsManager class.
 *
 * WsManager wraps a WebSocketServer that requires an HTTP server at
 * construction time. In tests we create a real HTTP server but never
 * listen on it, so no port is bound and no network I/O occurs.
 *
 * The subscribe/unsubscribe/broadcastToRun behaviour is tested using
 * fake WebSocket stubs with a controlled readyState and a send() spy.
 *
 * Tests:
 *   - emit with a registered subscriber delivers the event
 *   - unsubscribe removes the listener; no more events are received
 *   - multiple subscribers all receive the event
 *   - emit with no subscribers does not crash
 *   - emitted event shape is preserved exactly (JSON.stringify matches)
 *   - subscriber for a different runId does not receive the event
 *   - closed/closing WebSocket stubs are skipped during broadcast
 *   - authorizeAndSubscribe enforces owner/admin ownership (IDOR hardening)
 */
import { describe, it, expect, vi } from "vitest";
import { createServer } from "http";
import type { IStorage } from "../../../server/storage.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a WsManager with a real (non-listening) HTTP server.
 */
async function createManager(storage?: IStorage) {
  const { WsManager } = await import("../../../server/ws/manager.js");
  const httpServer = createServer();
  const manager = new WsManager(httpServer, storage);
  return { manager, httpServer };
}

/**
 * Fake WebSocket stub with a send() spy.
 * readyState 1 = WebSocket.OPEN (will receive broadcasts).
 */
function makeFakeWs(readyState: number = 1) {
  return { readyState, send: vi.fn() };
}

/** Minimal valid WsEvent using an event type present in WsEventType. */
function makeEvent(runId: string) {
  return {
    type: "pipeline:started" as const,
    runId,
    payload: {},
    timestamp: new Date().toISOString(),
  };
}

/** A storage double exposing only getTaskGroup for ownership checks. */
function storageWithRun(createdBy: string | null): IStorage {
  return {
    getTaskGroup: vi.fn(async () => ({ id: "r", createdBy })),
  } as unknown as IStorage;
}

// ─── subscribe + broadcastToRun ───────────────────────────────────────────────

describe("WsManager.subscribe + broadcastToRun", () => {
  it("registered subscriber receives the emitted event", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    manager.subscribe(fakeWs as never, "run-001");
    manager.broadcastToRun("run-001", makeEvent("run-001"));

    expect(fakeWs.send).toHaveBeenCalledTimes(1);
  });

  it("emitted event payload is JSON-stringified exactly as provided", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    const event = {
      type: "pipeline:completed" as const,
      runId: "run-002",
      payload: { result: "success", stagesCompleted: 3 },
      timestamp: "2026-01-01T00:00:00.000Z",
    };

    manager.subscribe(fakeWs as never, "run-002");
    manager.broadcastToRun("run-002", event);

    expect(fakeWs.send).toHaveBeenCalledWith(JSON.stringify(event));
  });

  it("does not crash when there are no subscribers for the run", async () => {
    const { manager } = await createManager();

    expect(() => {
      manager.broadcastToRun("run-no-subs", makeEvent("run-no-subs"));
    }).not.toThrow();
  });

  it("multiple subscribers all receive the same event", async () => {
    const { manager } = await createManager();
    const ws1 = makeFakeWs();
    const ws2 = makeFakeWs();
    const ws3 = makeFakeWs();

    manager.subscribe(ws1 as never, "run-multi");
    manager.subscribe(ws2 as never, "run-multi");
    manager.subscribe(ws3 as never, "run-multi");

    manager.broadcastToRun("run-multi", makeEvent("run-multi"));

    expect(ws1.send).toHaveBeenCalledTimes(1);
    expect(ws2.send).toHaveBeenCalledTimes(1);
    expect(ws3.send).toHaveBeenCalledTimes(1);
  });

  it("subscriber for a different runId does not receive the event", async () => {
    const { manager } = await createManager();
    const wsA = makeFakeWs();
    const wsB = makeFakeWs();

    manager.subscribe(wsA as never, "run-aaa");
    manager.subscribe(wsB as never, "run-bbb");

    manager.broadcastToRun("run-aaa", makeEvent("run-aaa"));

    expect(wsA.send).toHaveBeenCalledTimes(1);
    expect(wsB.send).toHaveBeenCalledTimes(0);
  });
});

// ─── unsubscribe ──────────────────────────────────────────────────────────────

describe("WsManager.unsubscribe", () => {
  it("after unsubscribe the client no longer receives events", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    manager.subscribe(fakeWs as never, "run-unsub");
    manager.unsubscribe(fakeWs as never, "run-unsub");

    manager.broadcastToRun("run-unsub", makeEvent("run-unsub"));

    expect(fakeWs.send).toHaveBeenCalledTimes(0);
  });

  it("does not crash when unsubscribing a client that was never subscribed", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    expect(() => {
      manager.unsubscribe(fakeWs as never, "run-never-subbed");
    }).not.toThrow();
  });

  it("remaining subscribers still receive events after one unsubscribes", async () => {
    const { manager } = await createManager();
    const staying = makeFakeWs();
    const leaving = makeFakeWs();

    manager.subscribe(staying as never, "run-partial");
    manager.subscribe(leaving as never, "run-partial");
    manager.unsubscribe(leaving as never, "run-partial");

    manager.broadcastToRun("run-partial", makeEvent("run-partial"));

    expect(staying.send).toHaveBeenCalledTimes(1);
    expect(leaving.send).toHaveBeenCalledTimes(0);
  });
});

// ─── closed/closing WebSocket handling ───────────────────────────────────────

describe("WsManager — non-OPEN WebSocket states are skipped", () => {
  it("does not send to a subscriber with readyState CONNECTING (0)", async () => {
    const { manager } = await createManager();
    const connectingWs = makeFakeWs(0);

    manager.subscribe(connectingWs as never, "run-connecting");
    manager.broadcastToRun("run-connecting", makeEvent("run-connecting"));

    expect(connectingWs.send).toHaveBeenCalledTimes(0);
  });

  it("does not send to a subscriber with readyState CLOSING (2)", async () => {
    const { manager } = await createManager();
    const closingWs = makeFakeWs(2);

    manager.subscribe(closingWs as never, "run-closing");
    manager.broadcastToRun("run-closing", makeEvent("run-closing"));

    expect(closingWs.send).toHaveBeenCalledTimes(0);
  });

  it("does not send to a subscriber with readyState CLOSED (3)", async () => {
    const { manager } = await createManager();
    const closedWs = makeFakeWs(3);

    manager.subscribe(closedWs as never, "run-closed");
    manager.broadcastToRun("run-closed", makeEvent("run-closed"));

    expect(closedWs.send).toHaveBeenCalledTimes(0);
  });

  it("sends only to OPEN subscribers when mixed with closed ones", async () => {
    const { manager } = await createManager();
    const openWs = makeFakeWs(1);
    const closedWs = makeFakeWs(3);

    manager.subscribe(openWs as never, "run-mixed");
    manager.subscribe(closedWs as never, "run-mixed");

    manager.broadcastToRun("run-mixed", makeEvent("run-mixed"));

    expect(openWs.send).toHaveBeenCalledTimes(1);
    expect(closedWs.send).toHaveBeenCalledTimes(0);
  });
});

// ─── authorizeAndSubscribe — ownership gate (IDOR hardening) ──────────────────

describe("WsManager.authorizeAndSubscribe — ownership gate", () => {
  const owner = { id: "owner", role: "user" } as never;
  const intruder = { id: "intruder", role: "user" } as never;
  const admin = { id: "boss", role: "admin" } as never;

  it("allows the owner to subscribe to their own run", async () => {
    const { manager } = await createManager(storageWithRun("owner"));
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, owner, "run-x");
    expect(ok).toBe(true);
    manager.broadcastToRun("run-x", makeEvent("run-x"));
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("REJECTS a non-owner subscribing to another user's run (and does not register)", async () => {
    const { manager } = await createManager(storageWithRun("owner"));
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, intruder, "run-x");
    expect(ok).toBe(false);
    manager.broadcastToRun("run-x", makeEvent("run-x"));
    expect(ws.send).toHaveBeenCalledTimes(0);
  });

  it("allows an admin to subscribe to any run", async () => {
    const { manager } = await createManager(storageWithRun("owner"));
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, admin, "run-x");
    expect(ok).toBe(true);
    manager.broadcastToRun("run-x", makeEvent("run-x"));
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it("REJECTS subscribing to an ownerless run as a non-admin", async () => {
    const { manager } = await createManager(storageWithRun(null));
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, owner, "run-x");
    expect(ok).toBe(false);
  });

  it("REJECTS subscribing to a missing run", async () => {
    const storage = {
      getTaskGroup: vi.fn(async () => undefined),
    } as unknown as IStorage;
    const { manager } = await createManager(storage);
    const ws = makeFakeWs();
    const ok = await manager.authorizeAndSubscribe(ws as never, owner, "missing");
    expect(ok).toBe(false);
  });
});

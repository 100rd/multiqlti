/**
 * Unit tests for server/ws/manager.ts — WsManager class.
 *
 * WsManager wraps a WebSocketServer that requires an HTTP server at
 * construction time. In tests we create a real HTTP server but never
 * listen on it, so no port is bound and no network I/O occurs.
 *
 * The WebSocket subscribe/unsubscribe/emit behaviour is tested using
 * real WebSocket objects in OPEN state created via jest-compatible fakes
 * (we construct them from the 'ws' package directly with a mock socket).
 *
 * Tests:
 *   - emit with a registered subscriber delivers the event
 *   - subscribe returns an unsubscribe function; after calling it no more events
 *   - multiple subscribers all receive the event
 *   - emit with no subscribers does not crash
 *   - emitted event shape is preserved exactly
 */
import { describe, it, expect, vi } from "vitest";
import { createServer } from "http";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a WsManager with a real (non-listening) HTTP server.
 * The manager's WebSocketServer is bound to the server but since the server
 * never listens, no connections arrive from the outside.
 */
async function createManager() {
  const { WsManager } = await import("../../server/ws/manager.js");
  const httpServer = createServer();
  const manager = new WsManager(httpServer);
  return { manager, httpServer };
}

/**
 * Create a minimal fake WebSocket stub that satisfies the broadcastToRun
 * call signature. We only need readyState = OPEN and a send() spy.
 */
function makeFakeWs(readyState: number = 1 /* WebSocket.OPEN */) {
  return {
    readyState,
    send: vi.fn(),
  };
}

// ─── subscribe + broadcastToRun ───────────────────────────────────────────────

describe("WsManager.subscribe + broadcastToRun", () => {
  it("registered subscriber receives the emitted event", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    manager.subscribe(fakeWs as never, "run-001");
    manager.broadcastToRun("run-001", {
      type: "run:started",
      runId: "run-001",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(fakeWs.send).toHaveBeenCalledTimes(1);
  });

  it("emitted event payload is JSON-stringified exactly as provided", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    const event = {
      type: "run:completed" as const,
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
      manager.broadcastToRun("run-no-subs", {
        type: "run:started",
        runId: "run-no-subs",
        payload: {},
        timestamp: new Date().toISOString(),
      });
    }).not.toThrow();
  });

  it("multiple subscribers all receive the same event", async () => {
    const { manager } = await createManager();
    const fakeWs1 = makeFakeWs();
    const fakeWs2 = makeFakeWs();
    const fakeWs3 = makeFakeWs();

    manager.subscribe(fakeWs1 as never, "run-multi");
    manager.subscribe(fakeWs2 as never, "run-multi");
    manager.subscribe(fakeWs3 as never, "run-multi");

    manager.broadcastToRun("run-multi", {
      type: "run:stage_complete",
      runId: "run-multi",
      payload: { stageIndex: 1 },
      timestamp: new Date().toISOString(),
    });

    expect(fakeWs1.send).toHaveBeenCalledTimes(1);
    expect(fakeWs2.send).toHaveBeenCalledTimes(1);
    expect(fakeWs3.send).toHaveBeenCalledTimes(1);
  });

  it("subscriber for different runId does not receive event", async () => {
    const { manager } = await createManager();
    const fakeWsA = makeFakeWs();
    const fakeWsB = makeFakeWs();

    manager.subscribe(fakeWsA as never, "run-aaa");
    manager.subscribe(fakeWsB as never, "run-bbb");

    manager.broadcastToRun("run-aaa", {
      type: "run:started",
      runId: "run-aaa",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(fakeWsA.send).toHaveBeenCalledTimes(1);
    expect(fakeWsB.send).toHaveBeenCalledTimes(0);
  });
});

// ─── unsubscribe ──────────────────────────────────────────────────────────────

describe("WsManager.unsubscribe", () => {
  it("after unsubscribe the client no longer receives events", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    manager.subscribe(fakeWs as never, "run-unsub");
    manager.unsubscribe(fakeWs as never, "run-unsub");

    manager.broadcastToRun("run-unsub", {
      type: "run:started",
      runId: "run-unsub",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(fakeWs.send).toHaveBeenCalledTimes(0);
  });

  it("does not crash when unsubscribing a client that was never subscribed", async () => {
    const { manager } = await createManager();
    const fakeWs = makeFakeWs();

    expect(() => {
      manager.unsubscribe(fakeWs as never, "run-never-subbed");
    }).not.toThrow();
  });

  it("other subscribers still receive events after one unsubscribes", async () => {
    const { manager } = await createManager();
    const staying = makeFakeWs();
    const leaving = makeFakeWs();

    manager.subscribe(staying as never, "run-partial");
    manager.subscribe(leaving as never, "run-partial");
    manager.unsubscribe(leaving as never, "run-partial");

    manager.broadcastToRun("run-partial", {
      type: "run:started",
      runId: "run-partial",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(staying.send).toHaveBeenCalledTimes(1);
    expect(leaving.send).toHaveBeenCalledTimes(0);
  });
});

// ─── CLOSED state ─────────────────────────────────────────────────────────────

describe("WsManager — closed WebSocket is skipped", () => {
  it("does not send to a subscriber whose readyState is CLOSING (2)", async () => {
    const { manager } = await createManager();
    const closingWs = makeFakeWs(2 /* WebSocket.CLOSING */);

    manager.subscribe(closingWs as never, "run-closing");
    manager.broadcastToRun("run-closing", {
      type: "run:started",
      runId: "run-closing",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(closingWs.send).toHaveBeenCalledTimes(0);
  });

  it("does not send to a subscriber whose readyState is CLOSED (3)", async () => {
    const { manager } = await createManager();
    const closedWs = makeFakeWs(3 /* WebSocket.CLOSED */);

    manager.subscribe(closedWs as never, "run-closed");
    manager.broadcastToRun("run-closed", {
      type: "run:started",
      runId: "run-closed",
      payload: {},
      timestamp: new Date().toISOString(),
    });

    expect(closedWs.send).toHaveBeenCalledTimes(0);
  });
});

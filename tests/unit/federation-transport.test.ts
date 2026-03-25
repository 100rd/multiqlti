/**
 * Unit tests for FederationTransport -- WebSocket-based peer mesh.
 *
 * Tests use real WebSocket connections on localhost ephemeral ports.
 */
import { describe, it, expect, afterEach } from "vitest";
import { FederationTransport } from "../../server/federation/transport.js";
import type { FederationConfig } from "../../server/federation/types.js";

const SECRET = "test-cluster-secret-for-transport-tests";

let transports: FederationTransport[] = [];

function makeConfig(overrides: Partial<FederationConfig> = {}): FederationConfig {
  return {
    enabled: true,
    instanceId: "instance-a",
    instanceName: "Instance A",
    clusterSecret: SECRET,
    listenPort: 0, // will be overridden per test
    peers: [],
    ...overrides,
  };
}

/** Pick a random high port unlikely to collide. */
function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

afterEach(async () => {
  // Clean up all transports created during tests
  for (const t of transports) {
    await t.close().catch(() => {});
  }
  transports = [];
});

/** Helper: wait for a condition with timeout. */
function waitFor(
  fn: () => boolean,
  timeoutMs = 3000,
  intervalMs = 50,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      if (fn()) return resolve();
      if (Date.now() > deadline) return reject(new Error("waitFor timed out"));
      setTimeout(check, intervalMs);
    };
    check();
  });
}

describe("federation/transport", () => {
  it("server starts on configured port", async () => {
    const port = randomPort();
    const t = new FederationTransport(makeConfig({ listenPort: port }));
    transports.push(t);
    t.startServer();
    // If startServer throws, the test fails. Otherwise we just verify it created.
    expect(t.getPeers()).toEqual([]);
  });

  it("two transports can connect and complete hello handshake", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "server-a", instanceName: "Server A", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "client-b", instanceName: "Client B", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);

    // Wait for both sides to register the peer
    await waitFor(() => tA.getPeers().length === 1 && tB.getPeers().length === 1);

    const peersA = tA.getPeers();
    expect(peersA).toHaveLength(1);
    expect(peersA[0].instanceId).toBe("client-b");
    expect(peersA[0].status).toBe("connected");

    const peersB = tB.getPeers();
    expect(peersB).toHaveLength(1);
    expect(peersB[0].instanceId).toBe("server-a");
    expect(peersB[0].status).toBe("connected");
  });

  it("rejects connection with invalid HMAC (wrong secret)", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "server-a", listenPort: portA }),
    );
    const tBad = new FederationTransport(
      makeConfig({
        instanceId: "bad-client",
        clusterSecret: "completely-wrong-secret-here",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tBad);

    tA.startServer();
    await tBad.connectToPeer(`ws://127.0.0.1:${portA}`);

    // Give time for the handshake to fail
    await new Promise((r) => setTimeout(r, 500));

    // Server should NOT have accepted the peer
    expect(tA.getPeers()).toHaveLength(0);
  });

  it("broadcasts message to all connected peers", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "hub", instanceName: "Hub", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "spoke-b", instanceName: "Spoke B", listenPort: randomPort() }),
    );
    const tC = new FederationTransport(
      makeConfig({ instanceId: "spoke-c", instanceName: "Spoke C", listenPort: randomPort() }),
    );
    transports.push(tA, tB, tC);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await tC.connectToPeer(`ws://127.0.0.1:${portA}`);

    await waitFor(() => tA.getPeers().length === 2);

    const received: string[] = [];
    tB.on("ping", (msg) => {
      received.push(`b:${(msg.payload as { val: string }).val}`);
    });
    tC.on("ping", (msg) => {
      received.push(`c:${(msg.payload as { val: string }).val}`);
    });

    // Hub broadcasts to all spokes
    tA.send({
      type: "ping",
      correlationId: "broadcast-1",
      payload: { val: "hello" },
    });

    await waitFor(() => received.length === 2);
    expect(received.sort()).toEqual(["b:hello", "c:hello"]);
  });

  it("sends targeted message to specific peer", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "hub", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "spoke-b", listenPort: randomPort() }),
    );
    const tC = new FederationTransport(
      makeConfig({ instanceId: "spoke-c", listenPort: randomPort() }),
    );
    transports.push(tA, tB, tC);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await tC.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 2);

    let bReceived = false;
    let cReceived = false;
    tB.on("targeted", () => { bReceived = true; });
    tC.on("targeted", () => { cReceived = true; });

    // Send only to spoke-b
    tA.send({
      type: "targeted",
      to: "spoke-b",
      correlationId: "target-1",
      payload: null,
    });

    await waitFor(() => bReceived, 2000);
    // Give a moment to ensure C does NOT receive
    await new Promise((r) => setTimeout(r, 200));

    expect(bReceived).toBe(true);
    expect(cReceived).toBe(false);
  });

  it("exchanges messages bidirectionally", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "alpha", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "beta", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 1 && tB.getPeers().length === 1);

    const aReceived: unknown[] = [];
    const bReceived: unknown[] = [];

    tA.on("data", (msg) => aReceived.push(msg.payload));
    tB.on("data", (msg) => bReceived.push(msg.payload));

    // A -> B
    tA.send({ type: "data", correlationId: "1", payload: "from-a" });
    // B -> A
    tB.send({ type: "data", correlationId: "2", payload: "from-b" });

    await waitFor(() => aReceived.length === 1 && bReceived.length === 1);

    expect(bReceived).toEqual(["from-a"]);
    expect(aReceived).toEqual(["from-b"]);
  });

  it("getPeers returns connected peers with correct info", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "srv", instanceName: "Server", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "cli", instanceName: "Client", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    expect(tA.getPeers()).toHaveLength(0);

    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 1);

    const peer = tA.getPeers()[0];
    expect(peer.instanceId).toBe("cli");
    expect(peer.instanceName).toBe("Client");
    expect(peer.status).toBe("connected");
    expect(peer.connectedAt).toBeInstanceOf(Date);
    expect(peer.lastMessageAt).toBeInstanceOf(Date);
  });

  it("close shuts down cleanly", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "srv", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "cli", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 1);

    await tA.close();
    await tB.close();

    expect(tA.getPeers()).toHaveLength(0);
    expect(tB.getPeers()).toHaveLength(0);
  });

  it("handles multiple message types with separate handlers", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "hub", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "spoke", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tB.getPeers().length === 1);

    const typeAMsgs: unknown[] = [];
    const typeBMsgs: unknown[] = [];

    tB.on("type-a", (msg) => typeAMsgs.push(msg.payload));
    tB.on("type-b", (msg) => typeBMsgs.push(msg.payload));

    tA.send({ type: "type-a", correlationId: "1", payload: "a1" });
    tA.send({ type: "type-b", correlationId: "2", payload: "b1" });
    tA.send({ type: "type-a", correlationId: "3", payload: "a2" });

    await waitFor(() => typeAMsgs.length === 2 && typeBMsgs.length === 1);

    expect(typeAMsgs).toEqual(["a1", "a2"]);
    expect(typeBMsgs).toEqual(["b1"]);
  });

  it("removes peer on disconnect", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "srv", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "cli", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 1);

    // Close client side
    await tB.close();

    // Server should detect disconnect
    await waitFor(() => tA.getPeers().length === 0, 3000);
    expect(tA.getPeers()).toHaveLength(0);
  });
});

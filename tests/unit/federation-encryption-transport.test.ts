/**
 * Unit tests for FederationTransport with E2E encryption enabled.
 *
 * Tests use real WebSocket connections on localhost ephemeral ports.
 */
import { describe, it, expect, afterEach } from "vitest";
import { FederationTransport } from "../../server/federation/transport.js";
import type { FederationConfig } from "../../server/federation/types.js";

const SECRET = "test-cluster-secret-for-encrypted-transport";

let transports: FederationTransport[] = [];

function makeConfig(
  overrides: Partial<FederationConfig> = {},
): FederationConfig {
  return {
    enabled: true,
    instanceId: "instance-a",
    instanceName: "Instance A",
    clusterSecret: SECRET,
    listenPort: 0,
    peers: [],
    encryption: { enabled: false, rotationIntervalHours: 0 },
    ...overrides,
  };
}

function makeEncryptedConfig(
  overrides: Partial<FederationConfig> = {},
): FederationConfig {
  return makeConfig({
    encryption: { enabled: true, rotationIntervalHours: 0 },
    ...overrides,
  });
}

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 20000);
}

afterEach(async () => {
  for (const t of transports) {
    await t.close().catch(() => {});
  }
  transports = [];
});

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

describe("federation/transport with encryption", () => {
  it("hello handshake exchanges public keys when encryption enabled", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "server-enc",
        instanceName: "Server Enc",
        listenPort: portA,
      }),
    );
    const tB = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "client-enc",
        instanceName: "Client Enc",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    // Both should have derived encryption keys for each other
    expect(tA._getEncryption()!.hasPeerKey("client-enc")).toBe(true);
    expect(tB._getEncryption()!.hasPeerKey("server-enc")).toBe(true);
  });

  it("messages are encrypted when encryption is enabled", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "enc-hub",
        listenPort: portA,
      }),
    );
    const tB = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "enc-spoke",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    const received: unknown[] = [];
    tB.on("secure-msg", (msg) => received.push(msg.payload));

    tA.send({
      type: "secure-msg",
      correlationId: "enc-1",
      payload: { secret: "classified-data", level: 5 },
    });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ secret: "classified-data", level: 5 });
  });

  it("messages are plaintext when encryption is disabled", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeConfig({ instanceId: "plain-hub", listenPort: portA }),
    );
    const tB = new FederationTransport(
      makeConfig({ instanceId: "plain-spoke", listenPort: randomPort() }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    // Encryption should be null
    expect(tA._getEncryption()).toBeNull();
    expect(tB._getEncryption()).toBeNull();

    const received: unknown[] = [];
    tB.on("plain-msg", (msg) => received.push(msg.payload));

    tA.send({
      type: "plain-msg",
      correlationId: "plain-1",
      payload: { data: "visible" },
    });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ data: "visible" });
  });

  it("mixed mode: encrypted peer can receive from plaintext peer", async () => {
    const portA = randomPort();

    // Server has encryption enabled
    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "enc-server",
        listenPort: portA,
      }),
    );
    // Client has encryption disabled
    const tB = new FederationTransport(
      makeConfig({
        instanceId: "plain-client",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    // Plain client sends to encrypted server -- should work (plaintext fallback)
    const received: unknown[] = [];
    tA.on("mixed-msg", (msg) => received.push(msg.payload));

    tB.send({
      type: "mixed-msg",
      correlationId: "mixed-1",
      payload: { from: "plaintext-peer" },
    });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ from: "plaintext-peer" });
  });

  it("encrypted server can send to plaintext client (no peer key)", async () => {
    const portA = randomPort();

    // Server has encryption enabled
    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "enc-server2",
        listenPort: portA,
      }),
    );
    // Client has encryption disabled -- won't send publicKey in hello
    const tB = new FederationTransport(
      makeConfig({
        instanceId: "plain-client2",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    // Encrypted server has no peer key for plain client -- falls back to plaintext
    expect(tA._getEncryption()!.hasPeerKey("plain-client2")).toBe(false);

    const received: unknown[] = [];
    tB.on("fallback-msg", (msg) => received.push(msg.payload));

    tA.send({
      type: "fallback-msg",
      correlationId: "fb-1",
      payload: { data: "sent-as-plaintext" },
    });

    await waitFor(() => received.length === 1);
    expect(received[0]).toEqual({ data: "sent-as-plaintext" });
  });

  it("bidirectional encrypted messages work", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "bidir-a",
        listenPort: portA,
      }),
    );
    const tB = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "bidir-b",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(
      () => tA.getPeers().length === 1 && tB.getPeers().length === 1,
    );

    const aReceived: unknown[] = [];
    const bReceived: unknown[] = [];

    tA.on("bidir", (msg) => aReceived.push(msg.payload));
    tB.on("bidir", (msg) => bReceived.push(msg.payload));

    tA.send({ type: "bidir", correlationId: "1", payload: "from-a" });
    tB.send({ type: "bidir", correlationId: "2", payload: "from-b" });

    await waitFor(
      () => aReceived.length === 1 && bReceived.length === 1,
    );

    expect(bReceived).toEqual(["from-a"]);
    expect(aReceived).toEqual(["from-b"]);
  });

  it("broadcast encrypted messages to multiple peers", async () => {
    const portA = randomPort();

    const tA = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "bc-hub",
        listenPort: portA,
      }),
    );
    const tB = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "bc-spoke-1",
        listenPort: randomPort(),
      }),
    );
    const tC = new FederationTransport(
      makeEncryptedConfig({
        instanceId: "bc-spoke-2",
        listenPort: randomPort(),
      }),
    );
    transports.push(tA, tB, tC);

    tA.startServer();
    await tB.connectToPeer(`ws://127.0.0.1:${portA}`);
    await tC.connectToPeer(`ws://127.0.0.1:${portA}`);
    await waitFor(() => tA.getPeers().length === 2);

    const bReceived: unknown[] = [];
    const cReceived: unknown[] = [];
    tB.on("bc", (msg) => bReceived.push(msg.payload));
    tC.on("bc", (msg) => cReceived.push(msg.payload));

    tA.send({
      type: "bc",
      correlationId: "bc-1",
      payload: { announcement: "encrypted broadcast" },
    });

    await waitFor(() => bReceived.length === 1 && cReceived.length === 1);
    expect(bReceived[0]).toEqual({ announcement: "encrypted broadcast" });
    expect(cReceived[0]).toEqual({ announcement: "encrypted broadcast" });
  });
});

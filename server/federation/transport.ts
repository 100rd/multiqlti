import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import type {
  FederationConfig,
  FederationMessage,
  FederationMessageHandler,
  PeerInfo,
} from "./types.js";
import { signMessage, verifyMessage, signEnvelope, verifyEnvelope } from "./auth.js";

/**
 * WebSocket-based federation transport.
 *
 * Handles both inbound (server) and outbound (client) connections to peer
 * instances. All messages are HMAC-signed and verified before processing.
 */
export class FederationTransport {
  private wss: WebSocketServer | null = null;
  private peers = new Map<string, { ws: WebSocket; info: PeerInfo }>();
  private handlers = new Map<string, FederationMessageHandler[]>();

  constructor(private config: FederationConfig) {}

  /** Start listening for incoming peer connections. */
  startServer(): void {
    this.wss = new WebSocketServer({ port: this.config.listenPort });
    this.wss.on("connection", (ws) => this.handleConnection(ws));
  }

  /** Connect to a remote peer endpoint. */
  async connectToPeer(endpoint: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(endpoint);

      ws.on("open", () => {
        // Send hello handshake
        const timestamp = Date.now();
        const hmac = signMessage(this.config.clusterSecret, this.config.instanceId, timestamp);
        const hello: FederationMessage = {
          type: "hello",
          from: this.config.instanceId,
          correlationId: crypto.randomUUID(),
          payload: { instanceName: this.config.instanceName },
          hmac,
          timestamp,
        };
        ws.send(JSON.stringify(hello));
        resolve();
      });

      ws.on("message", (data) => {
        try {
          const msg = JSON.parse(data.toString()) as FederationMessage;

          if (msg.type === "hello-ack") {
            this.handleHelloAck(ws, msg, endpoint);
            return;
          }

          // Regular message — verify envelope HMAC
          if (!verifyEnvelope(this.config.clusterSecret, msg)) {
            return;
          }

          const peer = this.findPeerByInstanceId(msg.from);
          if (peer) {
            peer.info.lastMessageAt = new Date();
            this.dispatch(msg, peer.info);
          }
        } catch {
          // Ignore unparseable messages
        }
      });

      ws.on("error", (err) => {
        reject(err);
      });

      ws.on("close", () => {
        // Find and remove peer associated with this ws
        for (const [id, entry] of this.peers) {
          if (entry.ws === ws) {
            entry.info.status = "disconnected";
            this.peers.delete(id);
            break;
          }
        }
      });
    });
  }

  /**
   * Send a message to a specific peer (if `to` is set) or broadcast
   * to all connected peers.
   */
  send(
    msg: Omit<FederationMessage, "hmac" | "from" | "timestamp">,
  ): void {
    const timestamp = Date.now();
    const envelope: Omit<FederationMessage, "hmac"> = {
      ...msg,
      from: this.config.instanceId,
      timestamp,
    };
    const hmac = signEnvelope(this.config.clusterSecret, envelope);
    const full: FederationMessage = { ...envelope, hmac };
    const serialized = JSON.stringify(full);

    if (msg.to) {
      const peer = this.peers.get(msg.to);
      if (peer && peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(serialized);
      }
    } else {
      // Broadcast
      for (const [, peer] of this.peers) {
        if (peer.ws.readyState === WebSocket.OPEN) {
          peer.ws.send(serialized);
        }
      }
    }
  }

  /** Register a handler for a specific message type. */
  on(type: string, handler: FederationMessageHandler): void {
    const existing = this.handlers.get(type) ?? [];
    existing.push(handler);
    this.handlers.set(type, existing);
  }

  /** Get a snapshot of all connected peers. */
  getPeers(): PeerInfo[] {
    return Array.from(this.peers.values()).map((entry) => ({ ...entry.info }));
  }

  /** Gracefully shut down all connections and the server. */
  async close(): Promise<void> {
    for (const [, entry] of this.peers) {
      entry.ws.close();
    }
    this.peers.clear();

    if (this.wss) {
      await new Promise<void>((resolve, reject) => {
        this.wss!.close((err) => (err ? reject(err) : resolve()));
      });
      this.wss = null;
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  /** Handle an inbound WebSocket connection (server side). */
  private handleConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as FederationMessage;

        if (msg.type === "hello") {
          this.handleHello(ws, msg);
          return;
        }

        // Regular message — verify envelope HMAC
        if (!verifyEnvelope(this.config.clusterSecret, msg)) {
          return;
        }

        const peer = this.findPeerByInstanceId(msg.from);
        if (peer) {
          peer.info.lastMessageAt = new Date();
          this.dispatch(msg, peer.info);
        }
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.on("close", () => {
      for (const [id, entry] of this.peers) {
        if (entry.ws === ws) {
          entry.info.status = "disconnected";
          this.peers.delete(id);
          break;
        }
      }
    });
  }

  /** Validate and accept a hello handshake from a remote peer. */
  private handleHello(ws: WebSocket, msg: FederationMessage): void {
    const valid = verifyMessage(
      this.config.clusterSecret,
      msg.from,
      msg.timestamp,
      msg.hmac,
    );

    if (!valid) {
      ws.close(4001, "Invalid HMAC");
      return;
    }

    const now = new Date();
    const payload = msg.payload as { instanceName?: string } | undefined;
    const info: PeerInfo = {
      instanceId: msg.from,
      instanceName: payload?.instanceName ?? msg.from,
      endpoint: "",
      connectedAt: now,
      lastMessageAt: now,
      status: "connected",
    };

    this.peers.set(msg.from, { ws, info });

    // Send hello-ack back
    const timestamp = Date.now();
    const hmac = signMessage(this.config.clusterSecret, this.config.instanceId, timestamp);
    const ack: FederationMessage = {
      type: "hello-ack",
      from: this.config.instanceId,
      correlationId: msg.correlationId,
      payload: { instanceName: this.config.instanceName },
      hmac,
      timestamp,
    };
    ws.send(JSON.stringify(ack));
  }

  /** Handle hello-ack response from a peer we connected to. */
  private handleHelloAck(
    ws: WebSocket,
    msg: FederationMessage,
    endpoint: string,
  ): void {
    const valid = verifyMessage(
      this.config.clusterSecret,
      msg.from,
      msg.timestamp,
      msg.hmac,
    );

    if (!valid) {
      ws.close(4001, "Invalid HMAC");
      return;
    }

    const now = new Date();
    const payload = msg.payload as { instanceName?: string } | undefined;
    const info: PeerInfo = {
      instanceId: msg.from,
      instanceName: payload?.instanceName ?? msg.from,
      endpoint,
      connectedAt: now,
      lastMessageAt: now,
      status: "connected",
    };

    this.peers.set(msg.from, { ws, info });
  }

  /** Find a peer entry by instance ID. */
  private findPeerByInstanceId(
    instanceId: string,
  ): { ws: WebSocket; info: PeerInfo } | undefined {
    return this.peers.get(instanceId);
  }

  /** Dispatch a message to all registered handlers for its type. */
  private dispatch(msg: FederationMessage, peer: PeerInfo): void {
    const list = this.handlers.get(msg.type);
    if (!list) return;
    for (const handler of list) {
      try {
        const result = handler(msg, peer);
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch(() => {});
        }
      } catch {
        // Handler errors are swallowed to prevent one bad handler
        // from breaking all message processing.
      }
    }
  }
}

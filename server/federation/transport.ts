import { WebSocketServer, WebSocket } from "ws";
import crypto from "crypto";
import type {
  FederationConfig,
  FederationMessage,
  FederationMessageHandler,
  PeerInfo,
} from "./types.js";
import { signMessage, verifyMessage, signEnvelope, verifyEnvelope } from "./auth.js";
import { FederationEncryption, isEncryptedPayload } from "./encryption.js";

/** Handshake payload sent in hello / hello-ack messages. */
interface HandshakePayload {
  instanceName: string;
  publicKey?: string;
}

/** Payload for key:rotate messages. */
interface KeyRotatePayload {
  publicKey: string;
  generation: number;
}

/**
 * WebSocket-based federation transport.
 *
 * Handles both inbound (server) and outbound (client) connections to peer
 * instances. All messages are HMAC-signed and verified before processing.
 * When encryption is enabled, payloads are E2E encrypted with AES-256-GCM
 * using per-peer keys derived from ECDH key exchange.
 */
export class FederationTransport {
  private wss: WebSocketServer | null = null;
  private peers = new Map<string, { ws: WebSocket; info: PeerInfo }>();
  private handlers = new Map<string, FederationMessageHandler[]>();
  private encryption: FederationEncryption | null = null;
  private rotationTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: FederationConfig) {
    if (config.encryption?.enabled) {
      this.encryption = new FederationEncryption(config.clusterSecret);
      this.startKeyRotation();
    }
  }

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
        const timestamp = Date.now();
        const hmac = signMessage(this.config.clusterSecret, this.config.instanceId, timestamp);
        const hello: FederationMessage = {
          type: "hello",
          from: this.config.instanceId,
          correlationId: crypto.randomUUID(),
          payload: this.buildHandshakePayload(),
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

          if (!verifyEnvelope(this.config.clusterSecret, msg)) {
            return;
          }

          const peer = this.findPeerByInstanceId(msg.from);
          if (!peer) return;
          peer.info.lastMessageAt = new Date();

          if (msg.type === "key:rotate") {
            this.handleKeyRotate(msg, peer.info);
            return;
          }

          const decrypted = this.decryptIncoming(msg);
          if (peer) {
            this.dispatch(decrypted, peer.info);
          }
        } catch {
          // Ignore unparseable messages
        }
      });

      ws.on("error", (err) => {
        reject(err);
      });

      ws.on("close", () => {
        this.removePeerByWs(ws);
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

    if (msg.to) {
      this.sendToPeer(msg, timestamp, msg.to);
    } else {
      for (const [peerId] of this.peers) {
        this.sendToPeer(msg, timestamp, peerId);
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

  /** Check if encryption is active and has a key for the given peer. */
  hasEncryptionForPeer(peerId: string): boolean {
    return this.encryption?.hasPeerKey(peerId) ?? false;
  }

  /** Visible for testing only — returns encryption instance. */
  _getEncryption(): FederationEncryption | null {
    return this.encryption;
  }

  /** Gracefully shut down all connections and the server. */
  async close(): Promise<void> {
    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = null;
    }

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

  // -- Private helpers --------------------------------------------------------

  /** Build the handshake payload, including public key if encryption is on. */
  private buildHandshakePayload(): HandshakePayload {
    const payload: HandshakePayload = {
      instanceName: this.config.instanceName,
    };
    if (this.encryption) {
      payload.publicKey = this.encryption.getPublicKey();
    }
    return payload;
  }

  /** Handle an inbound WebSocket connection (server side). */
  private handleConnection(ws: WebSocket): void {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as FederationMessage;

        if (msg.type === "hello") {
          this.handleHello(ws, msg);
          return;
        }

        if (!verifyEnvelope(this.config.clusterSecret, msg)) {
          return;
        }

        const peer = this.findPeerByInstanceId(msg.from);
        if (!peer) return;
        peer.info.lastMessageAt = new Date();

        if (msg.type === "key:rotate") {
          this.handleKeyRotate(msg, peer.info);
          return;
        }

        const decrypted = this.decryptIncoming(msg);
        this.dispatch(decrypted, peer.info);
      } catch {
        // Ignore unparseable messages
      }
    });

    ws.on("close", () => {
      this.removePeerByWs(ws);
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

    const payload = msg.payload as HandshakePayload | undefined;
    this.registerPeer(ws, msg.from, payload, "");

    // Derive shared encryption key if both sides support it
    if (this.encryption && payload?.publicKey) {
      this.encryption.deriveSharedKey(msg.from, payload.publicKey);
    }

    // Send hello-ack back
    const timestamp = Date.now();
    const hmac = signMessage(this.config.clusterSecret, this.config.instanceId, timestamp);
    const ack: FederationMessage = {
      type: "hello-ack",
      from: this.config.instanceId,
      correlationId: msg.correlationId,
      payload: this.buildHandshakePayload(),
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

    const payload = msg.payload as HandshakePayload | undefined;
    this.registerPeer(ws, msg.from, payload, endpoint);

    // Derive shared encryption key if both sides support it
    if (this.encryption && payload?.publicKey) {
      this.encryption.deriveSharedKey(msg.from, payload.publicKey);
    }
  }

  /** Handle key rotation message from an authenticated, registered peer. */
  private handleKeyRotate(msg: FederationMessage, peer: PeerInfo): void {
    if (!this.encryption) return;
    // Only accept key rotation from the peer whose connection we verified
    if (msg.from !== peer.instanceId) return;
    const payload = msg.payload as KeyRotatePayload | undefined;
    if (!payload?.publicKey) return;
    this.encryption.deriveSharedKey(msg.from, payload.publicKey);
  }

  /** Register a peer after successful handshake. */
  private registerPeer(
    ws: WebSocket,
    instanceId: string,
    payload: HandshakePayload | undefined,
    endpoint: string,
  ): void {
    const now = new Date();
    const info: PeerInfo = {
      instanceId,
      instanceName: payload?.instanceName ?? instanceId,
      endpoint,
      connectedAt: now,
      lastMessageAt: now,
      status: "connected",
    };
    this.peers.set(instanceId, { ws, info });
  }

  /** Send a message to a single peer, encrypting if possible. */
  private sendToPeer(
    msg: Omit<FederationMessage, "hmac" | "from" | "timestamp">,
    timestamp: number,
    peerId: string,
  ): void {
    const peer = this.peers.get(peerId);
    if (!peer || peer.ws.readyState !== WebSocket.OPEN) return;

    const encryptedPayload = this.encryptOutgoing(peerId, msg.payload);
    const envelope: Omit<FederationMessage, "hmac"> = {
      ...msg,
      payload: encryptedPayload,
      from: this.config.instanceId,
      timestamp,
    };
    const hmac = signEnvelope(this.config.clusterSecret, envelope);
    const full: FederationMessage = { ...envelope, hmac };
    peer.ws.send(JSON.stringify(full));
  }

  /** Encrypt payload for a peer if encryption is available. */
  private encryptOutgoing(peerId: string, payload: unknown): unknown {
    if (!this.encryption) return payload;
    if (!this.encryption.hasPeerKey(peerId)) {
      console.warn(`[federation] WARNING: sending plaintext to peer ${peerId} — no encryption key established`);
      return payload;
    }
    return this.encryption.encrypt(peerId, payload);
  }

  /** Decrypt incoming payload if it is encrypted. */
  private decryptIncoming(msg: FederationMessage): FederationMessage {
    if (!isEncryptedPayload(msg.payload)) return msg;
    if (!this.encryption) return msg;
    const decrypted = this.encryption.decrypt(msg.from, msg.payload);
    return { ...msg, payload: decrypted };
  }

  /** Remove a peer entry by WebSocket reference. */
  private removePeerByWs(ws: WebSocket): void {
    for (const [id, entry] of this.peers) {
      if (entry.ws === ws) {
        entry.info.status = "disconnected";
        this.peers.delete(id);
        if (this.encryption) {
          this.encryption.removePeer(id);
        }
        break;
      }
    }
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

  /** Start automatic key rotation if configured. */
  private startKeyRotation(): void {
    const hours = this.config.encryption?.rotationIntervalHours ?? 0;
    if (hours <= 0 || !this.encryption) return;

    const ms = hours * 60 * 60 * 1000;
    this.rotationTimer = setInterval(() => {
      this.performKeyRotation();
    }, ms);
  }

  /** Rotate keys and broadcast new public key to all peers. */
  private performKeyRotation(): void {
    if (!this.encryption) return;
    const newPublicKey = this.encryption.rotateKeys();
    const payload: KeyRotatePayload = {
      publicKey: newPublicKey,
      generation: this.encryption.getGeneration(),
    };

    // Broadcast key rotation to all peers via raw send (no encryption on this message)
    const timestamp = Date.now();
    const envelope: Omit<FederationMessage, "hmac"> = {
      type: "key:rotate",
      from: this.config.instanceId,
      correlationId: crypto.randomUUID(),
      payload,
      timestamp,
    };
    const hmac = signEnvelope(this.config.clusterSecret, envelope);
    const full: FederationMessage = { ...envelope, hmac };
    const serialized = JSON.stringify(full);

    for (const [, peer] of this.peers) {
      if (peer.ws.readyState === WebSocket.OPEN) {
        peer.ws.send(serialized);
      }
    }
  }
}

/**
 * libp2p transport adapter (GossipSub pubsub + Noise encryption).
 *
 * Simulates libp2p characteristics without requiring a running libp2p node.
 * Real client: @libp2p/js-libp2p (npm, TypeScript-native).
 *
 * Key characteristics:
 * - Peer-to-peer overlay network — no central broker
 * - GossipSub v1.1 for pub/sub: epidemic broadcast with redundancy
 * - Noise protocol for E2E encryption (replaces WireGuard-style handshake)
 * - Peer identity: Ed25519 keypairs (PeerId from public key)
 * - Transport: TCP, WebTransport (QUIC), WebRTC, WebSockets
 * - NAT traversal: built-in hole punching via AutoNAT + Circuit Relay v2
 * - Multi-tenant: peer topic namespacing + PeerScore spam protection
 * - DHT for peer discovery (Kademlia or mDNS for LAN)
 * - Reconnect: automatic, DHT-driven re-discovery
 * - TS maturity: js-libp2p v2.x is actively maintained by Protocol Labs
 *   but API churn has been frequent; production readiness is lower than NATS/gRPC
 * - Operational complexity: HIGH — DHT bootstrap nodes, relay nodes, ACL
 */

import type {
  TransportAdapter,
  BenchMessage,
  LatencySample,
  ReconnectMetrics,
} from "../types.js";

/** Simulated network parameters for libp2p GossipSub over Noise. */
const BASE_LATENCY_MS = 2.0; // GossipSub has gossip fan-out overhead
const LATENCY_JITTER_MS = 3.0; // High jitter due to overlay routing
const NOISE_HANDSHAKE_MS = 0.5; // Noise XX pattern per peer
const DHT_DISCOVERY_MS = 500; // DHT lookup latency on reconnect
const RELAY_OVERHEAD_MS = 5.0; // Circuit relay adds latency behind NAT
const RECONNECT_ATTEMPTS = 4; // DHT re-discovery + relay negotiation

export class Libp2pAdapter implements TransportAdapter {
  readonly name = "libp2p-gossipsub";
  readonly description =
    "libp2p GossipSub v1.1 pubsub over Noise encryption. " +
    "Built-in NAT traversal (AutoNAT + Circuit Relay v2), Ed25519 peer IDs. " +
    "Node.js client: @libp2p/js-libp2p v2.x (npm). " +
    "High operational complexity: DHT bootstrap nodes, relay nodes required. " +
    "Best for decentralized/peer-to-peer topologies, not hub-and-spoke.";

  private partitioned = false;
  private peerConnected = true;

  async setup(): Promise<void> {
    // Real setup (abbreviated):
    // const node = await createLibp2p({
    //   transports: [tcp(), webTransport()],
    //   connectionEncrypters: [noise()],
    //   streamMuxers: [yamux()],
    //   services: { pubsub: gossipsub({ allowPublishToZeroTopicPeers: false }) },
    //   peerDiscovery: [mdns(), bootstrap({ list: bootstrapAddrs })],
    // });
    // await node.services.pubsub.subscribe('federation/v1');
    this.peerConnected = true;
  }

  async send(msg: BenchMessage, lossRate: number): Promise<LatencySample> {
    if (this.partitioned || !this.peerConnected) {
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: false,
      };
    }

    if (Math.random() < lossRate) {
      return {
        messageId: msg.id,
        latencyMs: 0,
        success: false,
        droppedByPacketLoss: true,
      };
    }

    // GossipSub: noise handshake (amortized) + gossip fan-out + overlay routing
    const latencyMs =
      BASE_LATENCY_MS +
      NOISE_HANDSHAKE_MS / 10 + // amortized over many messages
      (Math.random() > 0.9 ? RELAY_OVERHEAD_MS : 0) + // occasional relay path
      Math.random() * LATENCY_JITTER_MS;

    await simulateDelay(latencyMs);

    return {
      messageId: msg.id,
      latencyMs,
      success: true,
    };
  }

  async partition(): Promise<void> {
    this.partitioned = true;
    this.peerConnected = false;
  }

  async recover(): Promise<ReconnectMetrics> {
    const startMs = Date.now();

    // libp2p reconnect: DHT peer re-discovery + Noise handshake + relay negotiation
    await simulateDelay(DHT_DISCOVERY_MS * RECONNECT_ATTEMPTS);

    this.partitioned = false;
    this.peerConnected = true;

    return {
      partitionDetectedMs: 5000, // libp2p connection manager heartbeat (configurable)
      reconnectAttempts: RECONNECT_ATTEMPTS,
      reconnectDurationMs: Date.now() - startMs,
      messagesDropped: 10, // GossipSub may not buffer during partition
      messagesRedelivered: 0, // No built-in persistence; use DHT content routing
    };
  }

  async teardown(): Promise<void> {
    this.partitioned = false;
    this.peerConnected = false;
  }
}

function simulateDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

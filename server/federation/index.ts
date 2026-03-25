import crypto from "crypto";
import type { FederationConfig, FederationMessageHandler, PeerInfo } from "./types.js";
import { FederationTransport } from "./transport.js";
import { FederationDiscovery } from "./discovery.js";

/**
 * Top-level federation manager.
 *
 * Coordinates transport (WebSocket server/client) and discovery
 * (static + DNS SRV peers). Federation is entirely opt-in via
 * the FEDERATION_ENABLED environment variable.
 */
export class FederationManager {
  private transport: FederationTransport;
  private discovery: FederationDiscovery;
  private config: FederationConfig;

  constructor(config: FederationConfig) {
    this.config = config;
    this.transport = new FederationTransport(config);
    this.discovery = new FederationDiscovery();
  }

  /** Start the federation server and connect to discovered peers. */
  async start(): Promise<void> {
    this.transport.startServer();
    const peers = await this.discovery.discoverAll(this.config);
    for (const peer of peers) {
      await this.transport.connectToPeer(peer).catch(() => {
        // Peer may not be online yet; that is fine -- they will connect to us.
      });
    }
  }

  /** Shut down transport and all peer connections. */
  async stop(): Promise<void> {
    await this.transport.close();
  }

  /** Send a typed message to one peer or broadcast to all. */
  send(type: string, payload: unknown, to?: string): void {
    this.transport.send({
      type,
      to,
      correlationId: crypto.randomUUID(),
      payload,
    });
  }

  /** Register a handler for a specific message type. */
  on(type: string, handler: FederationMessageHandler): void {
    this.transport.on(type, handler);
  }

  /** Get snapshot of all connected peers. */
  getPeers(): PeerInfo[] {
    return this.transport.getPeers();
  }

  /** Whether federation is enabled in the config. */
  isEnabled(): boolean {
    return this.config.enabled;
  }
}

export { FederationTransport } from "./transport.js";
export { FederationDiscovery } from "./discovery.js";
export type { FederationConfig, FederationMessage, PeerInfo } from "./types.js";

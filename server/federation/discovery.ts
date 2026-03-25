import dns from "dns/promises";
import type { FederationConfig } from "./types.js";

/** Minimal interface for DNS SRV resolution, injectable for testing. */
export type DnsResolver = (
  hostname: string,
) => Promise<Array<{ name: string; port: number }>>;

const defaultResolver: DnsResolver = (hostname) => dns.resolveSrv(hostname);

/**
 * Peer discovery for federation.
 *
 * Supports two mechanisms:
 * 1. Static peers from configuration
 * 2. DNS SRV record lookup (for Kubernetes headless services)
 */
export class FederationDiscovery {
  private resolver: DnsResolver;

  constructor(resolver?: DnsResolver) {
    this.resolver = resolver ?? defaultResolver;
  }

  /** Discover peers via Kubernetes DNS SRV records. */
  async discoverFromDns(serviceName: string): Promise<string[]> {
    try {
      const records = await this.resolver(serviceName);
      return records.map((r) => `ws://${r.name}:${r.port}`);
    } catch {
      return [];
    }
  }

  /** Return static peers from the federation config. */
  getStaticPeers(config: FederationConfig): string[] {
    return config.peers;
  }

  /** Combine DNS and static peers, deduplicating the results. */
  async discoverAll(
    config: FederationConfig,
    dnsService?: string,
  ): Promise<string[]> {
    const staticPeers = this.getStaticPeers(config);
    const dnsPeers = dnsService
      ? await this.discoverFromDns(dnsService)
      : [];
    return [...new Set([...staticPeers, ...dnsPeers])];
  }
}

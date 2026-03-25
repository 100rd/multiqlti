/**
 * Unit tests for FederationDiscovery -- peer discovery via static config and DNS SRV.
 */
import { describe, it, expect, vi } from "vitest";
import { FederationDiscovery } from "../../server/federation/discovery.js";
import type { DnsResolver } from "../../server/federation/discovery.js";
import type { FederationConfig } from "../../server/federation/types.js";

function makeConfig(overrides: Partial<FederationConfig> = {}): FederationConfig {
  return {
    enabled: true,
    instanceId: "instance-a",
    instanceName: "Instance A",
    clusterSecret: "test-secret",
    listenPort: 5001,
    peers: [],
    ...overrides,
  };
}

describe("federation/discovery", () => {
  describe("getStaticPeers", () => {
    it("returns empty array when no peers configured", () => {
      const d = new FederationDiscovery();
      expect(d.getStaticPeers(makeConfig())).toEqual([]);
    });

    it("returns configured static peers", () => {
      const d = new FederationDiscovery();
      const peers = ["ws://peer-a:5001", "ws://peer-b:5001"];
      expect(d.getStaticPeers(makeConfig({ peers }))).toEqual(peers);
    });

    it("preserves peer order", () => {
      const d = new FederationDiscovery();
      const peers = ["ws://c:5001", "ws://a:5001", "ws://b:5001"];
      expect(d.getStaticPeers(makeConfig({ peers }))).toEqual(peers);
    });
  });

  describe("discoverFromDns", () => {
    it("returns WebSocket URLs from DNS SRV records", async () => {
      const resolver: DnsResolver = vi.fn().mockResolvedValue([
        { name: "multiqlti-0.federation.svc.cluster.local", port: 5001 },
        { name: "multiqlti-1.federation.svc.cluster.local", port: 5001 },
      ]);

      const d = new FederationDiscovery(resolver);
      const result = await d.discoverFromDns("_federation._tcp.multiqlti.svc.cluster.local");

      expect(result).toEqual([
        "ws://multiqlti-0.federation.svc.cluster.local:5001",
        "ws://multiqlti-1.federation.svc.cluster.local:5001",
      ]);
      expect(resolver).toHaveBeenCalledWith("_federation._tcp.multiqlti.svc.cluster.local");
    });

    it("returns empty array when DNS lookup fails", async () => {
      const resolver: DnsResolver = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));

      const d = new FederationDiscovery(resolver);
      const result = await d.discoverFromDns("nonexistent.service");
      expect(result).toEqual([]);
    });

    it("handles DNS records with different ports", async () => {
      const resolver: DnsResolver = vi.fn().mockResolvedValue([
        { name: "host-a", port: 5001 },
        { name: "host-b", port: 6001 },
      ]);

      const d = new FederationDiscovery(resolver);
      const result = await d.discoverFromDns("my-service");
      expect(result).toEqual(["ws://host-a:5001", "ws://host-b:6001"]);
    });
  });

  describe("discoverAll", () => {
    it("returns only static peers when no DNS service is provided", async () => {
      const d = new FederationDiscovery();
      const config = makeConfig({
        peers: ["ws://peer-a:5001", "ws://peer-b:5001"],
      });

      const result = await d.discoverAll(config);
      expect(result).toEqual(["ws://peer-a:5001", "ws://peer-b:5001"]);
    });

    it("combines static and DNS peers", async () => {
      const resolver: DnsResolver = vi.fn().mockResolvedValue([
        { name: "dns-peer.svc.local", port: 5001 },
      ]);

      const d = new FederationDiscovery(resolver);
      const config = makeConfig({
        peers: ["ws://static-peer:5001"],
      });

      const result = await d.discoverAll(config, "_fed._tcp.svc.local");

      expect(result).toContain("ws://static-peer:5001");
      expect(result).toContain("ws://dns-peer.svc.local:5001");
      expect(result).toHaveLength(2);
    });

    it("deduplicates peers that appear in both static and DNS", async () => {
      const resolver: DnsResolver = vi.fn().mockResolvedValue([
        { name: "shared-peer", port: 5001 },
      ]);

      const d = new FederationDiscovery(resolver);
      const config = makeConfig({
        peers: ["ws://shared-peer:5001", "ws://only-static:5001"],
      });

      const result = await d.discoverAll(config, "_fed._tcp.svc.local");

      expect(result).toContain("ws://shared-peer:5001");
      expect(result).toContain("ws://only-static:5001");
      // "ws://shared-peer:5001" should appear only once
      expect(result.filter((p) => p === "ws://shared-peer:5001")).toHaveLength(1);
      expect(result).toHaveLength(2);
    });

    it("returns empty when no static peers and DNS fails", async () => {
      const resolver: DnsResolver = vi.fn().mockRejectedValue(new Error("ENOTFOUND"));

      const d = new FederationDiscovery(resolver);
      const result = await d.discoverAll(makeConfig(), "_fed._tcp.svc.local");
      expect(result).toEqual([]);
    });

    it("returns empty when no static peers and no DNS service", async () => {
      const d = new FederationDiscovery();
      const result = await d.discoverAll(makeConfig());
      expect(result).toEqual([]);
    });
  });
});

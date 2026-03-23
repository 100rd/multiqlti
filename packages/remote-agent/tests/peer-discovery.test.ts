import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PeerDiscovery } from "../src/peer-discovery.js";

// ─── Mock fetch globally ─────────────────────────────────────────────────────

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function agentCardResponse(name: string) {
  return {
    ok: true,
    json: async () => ({
      name,
      description: `${name} agent`,
      version: "0.1.0",
      url: `http://localhost:8080`,
      capabilities: { streaming: false },
      skills: [{ id: "test", name: "test", description: "test skill" }],
    }),
  };
}

function taskResponse(text: string) {
  return {
    ok: true,
    json: async () => ({
      jsonrpc: "2.0",
      id: "test-id",
      result: {
        id: "task-1",
        status: "completed",
        output: { role: "agent", parts: [{ type: "text", text }] },
      },
    }),
  };
}

function unreachableResponse() {
  return Promise.reject(new Error("ECONNREFUSED"));
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("PeerDiscovery", () => {
  let discovery: PeerDiscovery;

  beforeEach(() => {
    mockFetch.mockReset();
    discovery = new PeerDiscovery("k8s-agent", "test-ns");
  });

  afterEach(() => {
    discovery.stop();
  });

  // ─── discoverPeers ─────────────────────────────────────────────────────

  it("discovers available peers via K8s service DNS", async () => {
    // k8s is self, so it should probe helm, observability, triage, release
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      if (url.includes("abox-agents-observability") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("observability-agent"));
      }
      // triage and release are unreachable
      return unreachableResponse();
    });

    const peers = await discovery.discoverPeers();

    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.type)).toContain("helm");
    expect(peers.map((p) => p.type)).toContain("observability");
  });

  it("skips self when discovering peers", async () => {
    // k8s-agent should never probe abox-agents-k8s
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-k8s")) {
        throw new Error("Should not probe self");
      }
      return unreachableResponse();
    });

    const peers = await discovery.discoverPeers();
    expect(peers).toHaveLength(0);
    // If we got here without throwing, self was correctly skipped
  });

  it("handles unreachable peers gracefully", async () => {
    mockFetch.mockImplementation(() => unreachableResponse());

    const peers = await discovery.discoverPeers();
    expect(peers).toHaveLength(0);
  });

  it("removes previously known peers that become unreachable", async () => {
    // First discovery: helm is reachable
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      return unreachableResponse();
    });

    await discovery.discoverPeers();
    expect(discovery.getPeer("helm")).toBeDefined();

    // Second discovery: helm is unreachable
    mockFetch.mockImplementation(() => unreachableResponse());

    await discovery.discoverPeers();
    expect(discovery.getPeer("helm")).toBeUndefined();
  });

  // ─── getPeer ────────────────────────────────────────────────────────────

  it("returns peer by agent type", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      return unreachableResponse();
    });

    await discovery.discoverPeers();

    const peer = discovery.getPeer("helm");
    expect(peer).toBeDefined();
    expect(peer!.name).toBe("helm-agent");
    expect(peer!.type).toBe("helm");
    expect(peer!.endpoint).toContain("abox-agents-helm.test-ns.svc.cluster.local:8081");
  });

  it("returns undefined for unknown agent type", () => {
    const peer = discovery.getPeer("nonexistent");
    expect(peer).toBeUndefined();
  });

  // ─── callPeer ───────────────────────────────────────────────────────────

  it("sends A2A task and returns text result", async () => {
    // Setup: discover helm peer
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      return unreachableResponse();
    });
    await discovery.discoverPeers();

    // Now mock the sendTask call
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("/a2a")) {
        return Promise.resolve(taskResponse("helm list output"));
      }
      return unreachableResponse();
    });

    const result = await discovery.callPeer("helm", "list releases");
    expect(result).toBe("helm list output");
  });

  it("sends A2A task with specific skill", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      return unreachableResponse();
    });
    await discovery.discoverPeers();

    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      if (url.includes("/a2a")) {
        const body = JSON.parse(opts?.body as string);
        expect(body.params.skill).toBe("helm_list");
        return Promise.resolve(taskResponse("release-1\nrelease-2"));
      }
      return unreachableResponse();
    });

    const result = await discovery.callPeer("helm", "list releases", "helm_list");
    expect(result).toBe("release-1\nrelease-2");
  });

  it("throws when calling unknown peer", async () => {
    await expect(discovery.callPeer("nonexistent", "test")).rejects.toThrow(
      "Peer agent 'nonexistent' not found or not connected",
    );
  });

  // ─── listPeers ──────────────────────────────────────────────────────────

  it("returns list of known peers", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      if (url.includes("abox-agents-release") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("release-agent"));
      }
      return unreachableResponse();
    });

    await discovery.discoverPeers();

    const list = discovery.listPeers();
    expect(list).toHaveLength(2);
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).toHaveProperty("type");
    expect(list[0]).toHaveProperty("endpoint");
    // Should not expose the client object
    expect(list[0]).not.toHaveProperty("client");
  });

  // ─── stop ───────────────────────────────────────────────────────────────

  it("clears peers and stops refresh on stop()", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("abox-agents-helm") && url.includes("agent.json")) {
        return Promise.resolve(agentCardResponse("helm-agent"));
      }
      return unreachableResponse();
    });

    await discovery.discoverPeers();
    discovery.startRefresh(60_000);

    expect(discovery.listPeers()).toHaveLength(1);

    discovery.stop();

    expect(discovery.listPeers()).toHaveLength(0);
    expect(discovery.getPeer("helm")).toBeUndefined();
  });

  // ─── namespace and auth ─────────────────────────────────────────────────

  it("uses correct namespace in service DNS endpoints", async () => {
    const customDiscovery = new PeerDiscovery("helm-agent", "production", "my-token");

    mockFetch.mockImplementation((url: string, opts?: RequestInit) => {
      // helm is self, so it should probe k8s, observability, triage, release
      if (url.includes(".production.svc.cluster.local") && url.includes("agent.json")) {
        // Verify auth header is set
        const headers = opts?.headers as Record<string, string>;
        expect(headers?.["Authorization"]).toBe("Bearer my-token");
        return Promise.resolve(agentCardResponse("k8s-agent"));
      }
      return unreachableResponse();
    });

    const peers = await customDiscovery.discoverPeers();
    // k8s should be found (helm skips self)
    const k8sPeer = peers.find((p) => p.type === "k8s");
    expect(k8sPeer).toBeDefined();
    expect(k8sPeer!.endpoint).toContain(".production.svc.cluster.local");

    customDiscovery.stop();
  });
});

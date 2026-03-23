import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentDiscoveryService } from "../../server/remote-agents/agent-discovery.js";
import type { AgentCard, RemoteAgentConfig } from "@shared/types";

// ─── Module Mocks (hoisted) ─────────────────────────────────────────────────

const readFileMock = vi.fn();
vi.mock("fs/promises", () => ({
  readFile: readFileMock,
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function mockFetchResponse(body: unknown, status = 200, statusText = "OK") {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      statusText,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

const AGENT_CARD: AgentCard = {
  name: "test-agent",
  version: "1.0.0",
  url: "https://agent.example.com",
  skills: [{ id: "code", name: "Code Generation" }],
};

const STREAMING_AGENT_CARD: AgentCard = {
  name: "streaming-agent",
  version: "1.0.0",
  url: "https://streaming.example.com",
  skills: [{ id: "stream", name: "Streaming Skill" }],
  capabilities: { streaming: true },
};

function makeRemoteAgent(overrides: Partial<RemoteAgentConfig> = {}): RemoteAgentConfig {
  return {
    id: "agent-1",
    name: "Test Agent",
    environment: "docker",
    transport: "a2a-http",
    endpoint: "https://agent.example.com",
    enabled: true,
    autoConnect: false,
    status: "offline",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("AgentDiscoveryService", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let service: AgentDiscoveryService;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    readFileMock.mockReset();
    service = new AgentDiscoveryService();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.KUBERNETES_SERVICE_HOST;
    delete process.env.KUBERNETES_SERVICE_PORT;
  });

  // ── discoverEndpoint ─────────────────────────────────────────────────────

  describe("discoverEndpoint()", () => {
    it("returns DiscoveryResult with correct fields", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const result = await service.discoverEndpoint("https://agent.example.com");

      expect(result.endpoint).toBe("https://agent.example.com");
      expect(result.agentCard).toEqual(AGENT_CARD);
      expect(result.transport).toBe("a2a-http");
    });

    it("passes authToken to A2AClient (sent as Bearer header)", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      await service.discoverEndpoint("https://agent.example.com", "secret-token");

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers["Authorization"]).toBe("Bearer secret-token");
    });

    it("detects streaming transport from capabilities", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(STREAMING_AGENT_CARD));

      const result = await service.discoverEndpoint("https://streaming.example.com");

      expect(result.transport).toBe("mcp-streamable-http");
    });

    it("throws when discovery fails with HTTP error", async () => {
      fetchSpy.mockReturnValueOnce(
        mockFetchResponse({ error: "not found" }, 404, "Not Found"),
      );

      await expect(
        service.discoverEndpoint("https://bad.example.com"),
      ).rejects.toThrow("A2A discovery failed");
    });
  });

  // ── healthCheck ──────────────────────────────────────────────────────────

  describe("healthCheck()", () => {
    it("returns online status with latency on success", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const agent = makeRemoteAgent();
      const result = await service.healthCheck(agent);

      expect(result.status).toBe("online");
      expect(result.agentCard).toEqual(AGENT_CARD);
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.error).toBeUndefined();
    });

    it("returns offline status on error", async () => {
      fetchSpy.mockReturnValueOnce(
        mockFetchResponse({}, 500, "Internal Server Error"),
      );

      const agent = makeRemoteAgent();
      const result = await service.healthCheck(agent);

      expect(result.status).toBe("offline");
      expect(result.error).toBeDefined();
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
      expect(result.agentCard).toBeUndefined();
    });

    it("passes authTokenEnc as Bearer token", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const agent = makeRemoteAgent({ authTokenEnc: "encrypted-tok" });
      await service.healthCheck(agent);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers["Authorization"]).toBe("Bearer encrypted-tok");
    });

    it("omits Authorization header when authTokenEnc is null", async () => {
      fetchSpy.mockReturnValueOnce(mockFetchResponse(AGENT_CARD));

      const agent = makeRemoteAgent({ authTokenEnc: null });
      await service.healthCheck(agent);

      const [, init] = fetchSpy.mock.calls[0];
      expect(init.headers["Authorization"]).toBeUndefined();
    });
  });

  // ── discoverFromKubernetes ───────────────────────────────────────────────

  describe("discoverFromKubernetes()", () => {
    it("returns empty array when KUBERNETES_SERVICE_HOST is not set", async () => {
      delete process.env.KUBERNETES_SERVICE_HOST;

      const results = await service.discoverFromKubernetes();

      expect(results).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("parses K8s service list and probes each service", async () => {
      process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
      process.env.KUBERNETES_SERVICE_PORT = "443";
      readFileMock.mockResolvedValue("k8s-token-xyz");

      const k8sServiceList = {
        items: [
          {
            metadata: { name: "agent-svc-1", namespace: "ml" },
            spec: { ports: [{ name: "a2a", port: 9090 }] },
          },
          {
            metadata: { name: "agent-svc-2", namespace: "ml" },
            spec: { ports: [{ name: "http", port: 8080 }] },
          },
        ],
      };

      // First call: K8s API listing services
      // Second call: discovery for agent-svc-1
      // Third call: discovery for agent-svc-2
      fetchSpy
        .mockReturnValueOnce(mockFetchResponse(k8sServiceList))
        .mockReturnValueOnce(mockFetchResponse(AGENT_CARD))
        .mockReturnValueOnce(mockFetchResponse(STREAMING_AGENT_CARD));

      const results = await service.discoverFromKubernetes("ml");

      expect(results).toHaveLength(2);

      // First service with named a2a port
      expect(results[0].endpoint).toBe("http://agent-svc-1.ml.svc.cluster.local:9090");
      expect(results[0].agentCard).toEqual(AGENT_CARD);

      // Second service falls back to port 8080 (no a2a/mcp named port)
      expect(results[1].endpoint).toBe("http://agent-svc-2.ml.svc.cluster.local:8080");
      expect(results[1].agentCard).toEqual(STREAMING_AGENT_CARD);

      // Verify K8s API call
      const [k8sUrl, k8sInit] = fetchSpy.mock.calls[0];
      expect(k8sUrl).toContain("/api/v1/namespaces/ml/services");
      expect(k8sUrl).toContain("labelSelector=");
      expect(k8sInit.headers["Authorization"]).toBe("Bearer k8s-token-xyz");
    });

    it("skips unreachable services during K8s discovery", async () => {
      process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
      readFileMock.mockResolvedValue("k8s-token");

      const k8sServiceList = {
        items: [
          {
            metadata: { name: "good-svc", namespace: "default" },
            spec: { ports: [{ name: "a2a", port: 8080 }] },
          },
          {
            metadata: { name: "bad-svc", namespace: "default" },
            spec: { ports: [{ name: "a2a", port: 8080 }] },
          },
        ],
      };

      fetchSpy
        .mockReturnValueOnce(mockFetchResponse(k8sServiceList))
        .mockReturnValueOnce(mockFetchResponse(AGENT_CARD))
        .mockReturnValueOnce(mockFetchResponse({}, 503, "Service Unavailable"));

      const results = await service.discoverFromKubernetes();

      // Only the reachable service is returned
      expect(results).toHaveLength(1);
      expect(results[0].endpoint).toContain("good-svc");
    });

    it("returns empty array when K8s API returns non-OK status", async () => {
      process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
      readFileMock.mockResolvedValue("k8s-token");

      fetchSpy.mockReturnValueOnce(mockFetchResponse({}, 403, "Forbidden"));

      const results = await service.discoverFromKubernetes();

      expect(results).toEqual([]);
    });

    it("uses default namespace when none specified", async () => {
      process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
      process.env.KUBERNETES_SERVICE_PORT = "6443";
      readFileMock.mockResolvedValue("k8s-token");

      fetchSpy.mockReturnValueOnce(mockFetchResponse({ items: [] }));

      await service.discoverFromKubernetes();

      const [url] = fetchSpy.mock.calls[0];
      expect(url).toContain("/api/v1/namespaces/default/services");
      expect(url).toContain("https://10.0.0.1:6443");
    });
  });
});

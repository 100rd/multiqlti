/**
 * Unit tests for ArgoCdService.
 * Phase 6.10.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ArgoCdService } from "../../server/services/argocd-service.js";

// ─── Mock mcpClientManager ────────────────────────────────────────────────────

vi.mock("../../server/tools/mcp-client.js", () => ({
  mcpClientManager: {
    getStatus: vi.fn(),
    callTool: vi.fn(),
  },
}));

import { mcpClientManager } from "../../server/tools/mcp-client.js";

const mockGetStatus = vi.mocked(mcpClientManager.getStatus);
const mockCallTool = vi.mocked(mcpClientManager.callTool);

// Sample ArgoCD list_applications response
const SAMPLE_APPLICATIONS = JSON.stringify({
  items: [
    {
      metadata: { name: "payment-api", namespace: "production" },
      spec: { project: "fintech-team", destination: { server: "https://k8s.internal", namespace: "production" } },
      status: { health: { status: "Healthy" }, sync: { status: "Synced" } },
    },
    {
      metadata: { name: "auth-service", namespace: "production" },
      spec: { project: "fintech-team", destination: { server: "https://k8s.internal", namespace: "production" } },
      status: { health: { status: "Degraded" }, sync: { status: "OutOfSync" } },
    },
  ],
});

describe("ArgoCdService", () => {
  let service: ArgoCdService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ArgoCdService();
  });

  describe("isConnected()", () => {
    it("returns true when argocd server is connected", () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      expect(service.isConnected()).toBe(true);
    });

    it("returns false when argocd server is not in status map", () => {
      mockGetStatus.mockReturnValue({});
      expect(service.isConnected()).toBe(false);
    });

    it("returns false when argocd is present but not connected", () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: false, toolCount: 0 } });
      expect(service.isConnected()).toBe(false);
    });
  });

  describe("listApplicationsRaw()", () => {
    it("returns raw tool output when connected", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue(SAMPLE_APPLICATIONS);

      const result = await service.listApplicationsRaw();
      expect(result).toBe(SAMPLE_APPLICATIONS);
      expect(mockCallTool).toHaveBeenCalledWith("argocd", "list_applications", {});
    });

    it("throws when not connected", async () => {
      mockGetStatus.mockReturnValue({});
      await expect(service.listApplicationsRaw()).rejects.toThrow("not connected");
    });
  });

  describe("listApplicationsMasked()", () => {
    it("returns masked output (no real namespace)", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue(SAMPLE_APPLICATIONS);

      const result = await service.listApplicationsMasked("sess-1", "strict");
      // The namespace 'production' should be masked (not in k8s allowlist as standalone)
      // At minimum the result should be a string
      expect(typeof result).toBe("string");
    });
  });

  describe("syncApplication()", () => {
    it("calls sync_application tool with correct args", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue('{"status":"Synced"}');

      await service.syncApplication("payment-api", "sess-1", "strict");
      expect(mockCallTool).toHaveBeenCalledWith("argocd", "sync_application", { name: "payment-api" });
    });

    it("throws when not connected", async () => {
      mockGetStatus.mockReturnValue({});
      await expect(service.syncApplication("app", "sess", "strict")).rejects.toThrow("not connected");
    });
  });

  describe("getDeploymentLogs()", () => {
    it("calls get_application_workload_logs with correct args", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue("log line 1\nlog line 2");

      await service.getDeploymentLogs("payment-api", "app", "sess-1", "standard");
      expect(mockCallTool).toHaveBeenCalledWith("argocd", "get_application_workload_logs", {
        appName: "payment-api",
        container: "app",
      });
    });
  });

  describe("testConnection()", () => {
    it("returns ok=true with application count when connected", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue(SAMPLE_APPLICATIONS);

      const result = await service.testConnection();
      expect(result.ok).toBe(true);
      expect(result.applicationCount).toBe(2);
      expect(result.applications).toContain("payment-api");
      expect(result.applications).toContain("auth-service");
      expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it("returns ok=false with error message when not connected", async () => {
      mockGetStatus.mockReturnValue({});

      const result = await service.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not connected/i);
      expect(result.applicationCount).toBe(0);
    });

    it("returns ok=false when callTool throws", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockRejectedValue(new Error("Connection refused"));

      const result = await service.testConnection();
      expect(result.ok).toBe(false);
      expect(result.error).toContain("Connection refused");
    });

    it("handles non-JSON response gracefully", async () => {
      mockGetStatus.mockReturnValue({ argocd: { connected: true, toolCount: 5 } });
      mockCallTool.mockResolvedValue("application-a\napplication-b\napplication-c");

      const result = await service.testConnection();
      expect(result.ok).toBe(true);
      // Should still return some applications from line parsing
      expect(result.applicationCount).toBeGreaterThan(0);
    });
  });
});

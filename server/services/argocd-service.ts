/**
 * ArgoCdService — wraps MCP tool calls to the ArgoCD server with privacy masking.
 * All tool responses are passed through AnonymizerService before being returned.
 *
 * Phase 6.10.
 */
import { mcpClientManager } from "../tools/mcp-client";
import { AnonymizerService } from "../privacy/anonymizer";
import type { AnonymizationLevel } from "@shared/types";

const ARGOCD_SERVER_NAME = "argocd";

export interface ArgoCdAppSummary {
  name: string;
  namespace: string;
  server: string;
  healthStatus: string;
  syncStatus: string;
  project: string;
}

export interface ArgoCdTestResult {
  ok: boolean;
  applicationCount: number;
  applications: string[];
  latencyMs: number;
  error?: string;
}

export class ArgoCdService {
  private anonymizer: AnonymizerService;

  constructor(anonymizer?: AnonymizerService) {
    this.anonymizer = anonymizer ?? new AnonymizerService();
  }

  /** Check whether the argocd MCP server is currently connected. */
  isConnected(): boolean {
    const status = mcpClientManager.getStatus();
    return !!status[ARGOCD_SERVER_NAME]?.connected;
  }

  /**
   * List all ArgoCD applications.
   * Returns raw (unmasked) tool output — masking is left to the caller (pipeline/skill layer).
   */
  async listApplicationsRaw(): Promise<string> {
    this.assertConnected();
    return mcpClientManager.callTool(ARGOCD_SERVER_NAME, "list_applications", {});
  }

  /**
   * List applications with privacy masking applied.
   */
  async listApplicationsMasked(sessionId: string, level: AnonymizationLevel): Promise<string> {
    const raw = await this.listApplicationsRaw();
    const result = this.anonymizer.anonymize(raw, sessionId, level);
    return result.anonymizedText;
  }

  /**
   * Get a specific application. Returns masked output.
   */
  async getApplication(appName: string, sessionId: string, level: AnonymizationLevel): Promise<string> {
    this.assertConnected();
    const raw = await mcpClientManager.callTool(ARGOCD_SERVER_NAME, "get_application", { name: appName });
    return this.anonymizer.anonymize(raw, sessionId, level).anonymizedText;
  }

  /**
   * Trigger a sync for an ArgoCD application.
   * Returns masked output confirming the sync was initiated.
   */
  async syncApplication(appName: string, sessionId: string, level: AnonymizationLevel): Promise<string> {
    this.assertConnected();
    const raw = await mcpClientManager.callTool(ARGOCD_SERVER_NAME, "sync_application", { name: appName });
    return this.anonymizer.anonymize(raw, sessionId, level).anonymizedText;
  }

  /**
   * Get deployment logs for a workload. Returns masked output.
   */
  async getDeploymentLogs(
    appName: string,
    container: string,
    sessionId: string,
    level: AnonymizationLevel,
  ): Promise<string> {
    this.assertConnected();
    const raw = await mcpClientManager.callTool(ARGOCD_SERVER_NAME, "get_application_workload_logs", {
      appName,
      container,
    });
    return this.anonymizer.anonymize(raw, sessionId, level).anonymizedText;
  }

  /**
   * Get the resource tree for an application. Returns masked output.
   */
  async getResourceTree(appName: string, sessionId: string, level: AnonymizationLevel): Promise<string> {
    this.assertConnected();
    const raw = await mcpClientManager.callTool(
      ARGOCD_SERVER_NAME,
      "get_application_resource_tree",
      { applicationName: appName },
    );
    return this.anonymizer.anonymize(raw, sessionId, level).anonymizedText;
  }

  /**
   * Test ArgoCD connectivity by calling list_applications and returning a summary.
   */
  async testConnection(): Promise<ArgoCdTestResult> {
    if (!this.isConnected()) {
      return { ok: false, applicationCount: 0, applications: [], latencyMs: 0, error: "ArgoCD MCP server is not connected" };
    }

    const start = Date.now();
    try {
      const raw = await mcpClientManager.callTool(ARGOCD_SERVER_NAME, "list_applications", {});
      const latencyMs = Date.now() - start;

      // Parse application names from the raw response (JSON or text)
      const appNames = this.extractAppNames(raw);

      return {
        ok: true,
        applicationCount: appNames.length,
        applications: appNames.slice(0, 10), // return at most 10 for UI display
        latencyMs,
      };
    } catch (err) {
      return {
        ok: false,
        applicationCount: 0,
        applications: [],
        latencyMs: Date.now() - start,
        error: (err as Error).message,
      };
    }
  }

  private assertConnected(): void {
    if (!this.isConnected()) {
      throw new Error("ArgoCD MCP server is not connected. Configure it in Settings → Infrastructure → ArgoCD.");
    }
  }

  private extractAppNames(raw: string): string[] {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed
          .map((item: unknown) => {
            if (typeof item === "object" && item !== null) {
              const obj = item as Record<string, unknown>;
              const metadata = obj["metadata"] as Record<string, unknown> | undefined;
              return (metadata?.["name"] as string) ?? (obj["name"] as string) ?? "";
            }
            return String(item);
          })
          .filter(Boolean);
      }
      // Try items array (common ArgoCD response format)
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const items = obj["items"];
        if (Array.isArray(items)) {
          return items
            .map((item: unknown) => {
              if (typeof item === "object" && item !== null) {
                const o = item as Record<string, unknown>;
                const metadata = o["metadata"] as Record<string, unknown> | undefined;
                return (metadata?.["name"] as string) ?? "";
              }
              return "";
            })
            .filter(Boolean);
        }
      }
    } catch {
      // Not JSON — try to extract from text
    }
    // Fallback: count lines that look like app names
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l.length < 100 && !l.startsWith("{") && !l.startsWith("["));
  }
}

/** Singleton instance */
export const argoCdService = new ArgoCdService();

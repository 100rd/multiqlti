/**
 * Built-in GitLab MCP server (issue #270).
 *
 * Tools exposed (read-heavy — no project settings mutation):
 *   gitlab_list_mrs        — list merge requests
 *   gitlab_get_mr_diff     — get the diff for a merge request
 *   gitlab_list_pipelines  — list CI/CD pipelines
 *   gitlab_post_note       — post a note (comment) on an MR or issue
 *   gitlab_list_commits    — list commits for a project branch
 *
 * Security:
 *   - The GitLab token is sourced from `secrets["token"]` — NEVER logged.
 *   - No project settings, protected branches, access token, or admin mutations.
 *   - `gitlab_post_note` is the only write operation (non-destructive).
 *   - All output is redacted of secret values.
 */

import type { ToolHandler } from "../../tools/registry";
import type { IBuiltinMcpServer, BuiltinMcpServerConfig, ToolScope } from "../base";
import { redactSecrets } from "../base";

// ─── GitLab API client ────────────────────────────────────────────────────────

interface GitLabApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

function buildGitLabClient(host: string, token: string): GitLabApiClient {
  const apiBase = `${host.replace(/\/$/, "")}/api/v4`;

  async function request(path: string, method = "GET", body?: unknown): Promise<unknown> {
    const url = `${apiBase}${path}`;
    const headers: Record<string, string> = {
      "PRIVATE-TOKEN": token,
      "Content-Type": "application/json",
    };

    const fetchRes = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!fetchRes.ok) {
      const text = await fetchRes.text().catch(() => "");
      throw new Error(`GitLab API ${fetchRes.status}: ${text.slice(0, 200)}`);
    }

    return fetchRes.json().catch(() => null);
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, "POST", body),
  };
}

/**
 * URL-encode a GitLab project path (namespace/project).
 * GitLab requires the project ID or URL-encoded "namespace%2Fproject".
 */
function encodeProjectId(project: string): string {
  return encodeURIComponent(project);
}

// ─── Tool name constants ──────────────────────────────────────────────────────

const TOOL_LIST_MRS = "gitlab_list_mrs";
const TOOL_GET_MR_DIFF = "gitlab_get_mr_diff";
const TOOL_LIST_PIPELINES = "gitlab_list_pipelines";
const TOOL_POST_NOTE = "gitlab_post_note";
const TOOL_LIST_COMMITS = "gitlab_list_commits";

const TOOL_SCOPES: Record<string, ToolScope> = {
  [TOOL_LIST_MRS]: "read",
  [TOOL_GET_MR_DIFF]: "read",
  [TOOL_LIST_PIPELINES]: "read",
  [TOOL_POST_NOTE]: "read",   // posting a note is not destructive
  [TOOL_LIST_COMMITS]: "read",
};

// ─── GitLabMcpServer ──────────────────────────────────────────────────────────

export class GitLabMcpServer implements IBuiltinMcpServer {
  readonly connectionType = "gitlab" as const;

  private cfg: BuiltinMcpServerConfig | null = null;
  private client: GitLabApiClient | null = null;
  private defaultProject = "";

  async start(cfg: BuiltinMcpServerConfig): Promise<void> {
    this.cfg = cfg;

    const host = String(cfg.config["host"] ?? "https://gitlab.com");
    const owner = String(cfg.config["owner"] ?? "");
    const project = String(cfg.config["project"] ?? "");

    // Store defaultProject as "owner/project" if both given
    if (owner && project) {
      this.defaultProject = `${owner}/${project}`;
    } else if (owner.includes("/")) {
      this.defaultProject = owner;
    } else {
      this.defaultProject = project || owner;
    }

    const token = cfg.secrets["token"] ?? cfg.secrets["gitlabToken"] ?? "";
    this.client = buildGitLabClient(host, token);
  }

  async stop(): Promise<void> {
    this.cfg = null;
    this.client = null;
  }

  getToolScope(toolName: string): ToolScope | undefined {
    return TOOL_SCOPES[toolName];
  }

  getToolHandlers(): ToolHandler[] {
    if (!this.cfg || !this.client) {
      throw new Error("GitLabMcpServer: call start() before getToolHandlers()");
    }

    const cfg = this.cfg;
    const client = this.client;
    const defaultProject = this.defaultProject;

    function resolveProject(args: Record<string, unknown>): string {
      const p = String(args["project"] ?? "").trim() || defaultProject;
      if (!p) throw new Error("project is required (set on connection config or pass as argument)");
      return p;
    }

    function safe(value: unknown): string {
      return redactSecrets(JSON.stringify(value, null, 2), cfg.secrets);
    }

    return [
      // ── gitlab_list_mrs ────────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_LIST_MRS,
          description:
            "List merge requests for a GitLab project. Returns MR IID, title, state, author, and URL.",
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project path (\"namespace/project\") or ID. Uses connection default if omitted.",
              },
              state: {
                type: "string",
                enum: ["opened", "closed", "merged", "locked", "all"],
                description: "MR state filter (default: \"opened\").",
              },
              perPage: {
                type: "number",
                description: "Results per page (default: 20, max: 100).",
              },
              page: {
                type: "number",
                description: "Page number (default: 1).",
              },
            },
            required: [],
          },
          source: "mcp" as const,
          mcpServer: `builtin:gitlab:${cfg.connectionId}`,
          tags: ["gitlab", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const project = resolveProject(args);
          const state = String(args["state"] ?? "opened");
          const perPage = Math.min(Number(args["perPage"] ?? 20), 100);
          const page = Number(args["page"] ?? 1);

          const data = await client.get(
            `/projects/${encodeProjectId(project)}/merge_requests?state=${state}&per_page=${perPage}&page=${page}`,
          );
          return safe(data);
        },
      },

      // ── gitlab_get_mr_diff ─────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_GET_MR_DIFF,
          description:
            "Get the diff for a GitLab merge request. Returns per-file diffs.",
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project path or ID. Uses connection default if omitted.",
              },
              mrIid: {
                type: "number",
                description: "Merge request IID (project-scoped integer ID).",
              },
            },
            required: ["mrIid"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:gitlab:${cfg.connectionId}`,
          tags: ["gitlab", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const project = resolveProject(args);
          const mrIid = Number(args["mrIid"]);
          if (!mrIid) return "Error: mrIid is required.";

          const data = await client.get(
            `/projects/${encodeProjectId(project)}/merge_requests/${mrIid}/diffs`,
          );
          return safe(data);
        },
      },

      // ── gitlab_list_pipelines ──────────────────────────────────────────────
      {
        definition: {
          name: TOOL_LIST_PIPELINES,
          description:
            "List CI/CD pipeline runs for a GitLab project. Returns pipeline ID, status, ref, and URL.",
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project path or ID. Uses connection default if omitted.",
              },
              ref: {
                type: "string",
                description: "Filter by branch or tag name.",
              },
              status: {
                type: "string",
                enum: ["created", "waiting_for_resource", "preparing", "pending", "running", "success", "failed", "canceled", "skipped", "manual", "scheduled"],
                description: "Filter by pipeline status.",
              },
              perPage: {
                type: "number",
                description: "Results per page (default: 10, max: 100).",
              },
            },
            required: [],
          },
          source: "mcp" as const,
          mcpServer: `builtin:gitlab:${cfg.connectionId}`,
          tags: ["gitlab", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const project = resolveProject(args);
          const perPage = Math.min(Number(args["perPage"] ?? 10), 100);
          const params = new URLSearchParams({ per_page: String(perPage) });
          if (args["ref"]) params.set("ref", String(args["ref"]));
          if (args["status"]) params.set("status", String(args["status"]));

          const data = await client.get(
            `/projects/${encodeProjectId(project)}/pipelines?${params.toString()}`,
          );
          return safe(data);
        },
      },

      // ── gitlab_post_note ───────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_POST_NOTE,
          description:
            "Post a note (comment) on a GitLab merge request or issue. Returns the created note URL.",
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project path or ID. Uses connection default if omitted.",
              },
              resourceType: {
                type: "string",
                enum: ["merge_requests", "issues"],
                description: "Resource type to comment on (default: \"merge_requests\").",
              },
              resourceIid: {
                type: "number",
                description: "MR or issue IID.",
              },
              body: {
                type: "string",
                description: "Note body (Markdown supported).",
              },
            },
            required: ["resourceIid", "body"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:gitlab:${cfg.connectionId}`,
          tags: ["gitlab", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const project = resolveProject(args);
          const resourceType = String(args["resourceType"] ?? "merge_requests");
          const resourceIid = Number(args["resourceIid"]);
          const body = String(args["body"] ?? "").trim();

          if (!resourceIid) return "Error: resourceIid is required.";
          if (!body) return "Error: note body is required.";

          const data = await client.post(
            `/projects/${encodeProjectId(project)}/${resourceType}/${resourceIid}/notes`,
            { body },
          );

          const result = data as Record<string, unknown>;
          const noteId = String(result?.["id"] ?? "");
          return redactSecrets(
            `Note posted (id: ${noteId}) on ${resourceType} #${resourceIid}`,
            cfg.secrets,
          );
        },
      },

      // ── gitlab_list_commits ────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_LIST_COMMITS,
          description:
            "List commits for a GitLab project branch. Returns commit SHA, title, author, and timestamp.",
          inputSchema: {
            type: "object",
            properties: {
              project: {
                type: "string",
                description: "Project path or ID. Uses connection default if omitted.",
              },
              ref: {
                type: "string",
                description: "Branch, tag, or commit SHA (default: default branch).",
              },
              perPage: {
                type: "number",
                description: "Results per page (default: 20, max: 100).",
              },
              page: {
                type: "number",
                description: "Page number (default: 1).",
              },
            },
            required: [],
          },
          source: "mcp" as const,
          mcpServer: `builtin:gitlab:${cfg.connectionId}`,
          tags: ["gitlab", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const project = resolveProject(args);
          const perPage = Math.min(Number(args["perPage"] ?? 20), 100);
          const page = Number(args["page"] ?? 1);
          const params = new URLSearchParams({
            per_page: String(perPage),
            page: String(page),
          });
          if (args["ref"]) params.set("ref_name", String(args["ref"]));

          const data = await client.get(
            `/projects/${encodeProjectId(project)}/repository/commits?${params.toString()}`,
          );
          return safe(data);
        },
      },
    ];
  }
}

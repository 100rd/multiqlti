/**
 * Built-in GitHub MCP server (issue #270).
 *
 * Tools exposed (read-heavy — no repo settings mutation):
 *   github_list_prs        — list open/closed PRs with pagination
 *   github_get_pr_files    — list files changed in a PR
 *   github_get_pr_diff     — get the raw unified diff for a PR
 *   github_post_comment    — post a comment on a PR or issue
 *   github_list_workflows  — list recent workflow runs for the repo
 *
 * Security:
 *   - The GitHub token is sourced from `secrets["token"]` — NEVER logged.
 *   - No repo settings, branch protection, secrets, or admin mutations.
 *   - `github_post_comment` is the only write operation (non-destructive;
 *     destructive would be delete, force-push, etc.).
 *   - All output is redacted of secret values.
 */

import type { ToolHandler } from "../../tools/registry";
import type { IBuiltinMcpServer, BuiltinMcpServerConfig, ToolScope } from "../base";
import { redactSecrets } from "../base";

// ─── GitHub API client ────────────────────────────────────────────────────────

interface GitHubRequestOptions {
  method?: string;
  body?: unknown;
}

interface GitHubApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

function buildGitHubClient(host: string, token: string): GitHubApiClient {
  const baseUrl = host.endsWith("/") ? host.slice(0, -1) : host;

  async function request(path: string, opts: GitHubRequestOptions = {}): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    };

    const fetchRes = await fetch(url, {
      method: opts.method ?? "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });

    if (!fetchRes.ok) {
      const text = await fetchRes.text().catch(() => "");
      throw new Error(`GitHub API ${fetchRes.status}: ${text.slice(0, 200)}`);
    }

    return fetchRes.json().catch(() => null);
  }

  return {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", body }),
  };
}

// ─── Tool name constants ──────────────────────────────────────────────────────

const TOOL_LIST_PRS = "github_list_prs";
const TOOL_GET_PR_FILES = "github_get_pr_files";
const TOOL_GET_PR_DIFF = "github_get_pr_diff";
const TOOL_POST_COMMENT = "github_post_comment";
const TOOL_LIST_WORKFLOWS = "github_list_workflows";

const TOOL_SCOPES: Record<string, ToolScope> = {
  [TOOL_LIST_PRS]: "read",
  [TOOL_GET_PR_FILES]: "read",
  [TOOL_GET_PR_DIFF]: "read",
  [TOOL_POST_COMMENT]: "read",   // posting a comment is not destructive
  [TOOL_LIST_WORKFLOWS]: "read",
};

// ─── GitHubMcpServer ──────────────────────────────────────────────────────────

export class GitHubMcpServer implements IBuiltinMcpServer {
  readonly connectionType = "github" as const;

  private cfg: BuiltinMcpServerConfig | null = null;
  private client: GitHubApiClient | null = null;
  private repoOwner = "";
  private repoName = "";

  async start(cfg: BuiltinMcpServerConfig): Promise<void> {
    this.cfg = cfg;

    const host = String(cfg.config["host"] ?? "https://api.github.com");
    const owner = String(cfg.config["owner"] ?? "");
    const repo = String(cfg.config["repo"] ?? "");

    // owner/repo can be split from a single "owner/repo" field
    if (owner.includes("/")) {
      const [o, r] = owner.split("/", 2);
      this.repoOwner = o ?? owner;
      this.repoName = r ?? repo;
    } else {
      this.repoOwner = owner;
      this.repoName = repo;
    }

    const token = cfg.secrets["token"] ?? cfg.secrets["githubToken"] ?? "";
    this.client = buildGitHubClient(host, token);
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
      throw new Error("GitHubMcpServer: call start() before getToolHandlers()");
    }

    const cfg = this.cfg;
    const client = this.client;
    const defaultOwner = this.repoOwner;
    const defaultRepo = this.repoName;

    function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } {
      const raw = String(args["repo"] ?? "");
      if (raw.includes("/")) {
        const [o, r] = raw.split("/", 2);
        return { owner: o ?? defaultOwner, repo: r ?? defaultRepo };
      }
      return {
        owner: String(args["owner"] ?? defaultOwner),
        repo: raw || defaultRepo,
      };
    }

    function safe(value: unknown): string {
      return redactSecrets(JSON.stringify(value, null, 2), cfg.secrets);
    }

    return [
      // ── github_list_prs ────────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_LIST_PRS,
          description:
            "List pull requests for a GitHub repository. Returns PR number, title, state, author, and URL.",
          inputSchema: {
            type: "object",
            properties: {
              repo: {
                type: "string",
                description: "Repository in \"owner/repo\" format, or just \"repo\" if owner is set on the connection.",
              },
              state: {
                type: "string",
                enum: ["open", "closed", "all"],
                description: "PR state filter (default: \"open\").",
              },
              perPage: {
                type: "number",
                description: "Results per page (default: 30, max: 100).",
              },
              page: {
                type: "number",
                description: "Page number (default: 1).",
              },
            },
            required: [],
          },
          source: "mcp" as const,
          mcpServer: `builtin:github:${cfg.connectionId}`,
          tags: ["github", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const { owner, repo } = ownerRepo(args);
          if (!owner || !repo) return "Error: repository owner and name are required (set on connection or pass repo=\"owner/repo\").";

          const state = String(args["state"] ?? "open");
          const perPage = Math.min(Number(args["perPage"] ?? 30), 100);
          const page = Number(args["page"] ?? 1);

          const data = await client.get(
            `/repos/${owner}/${repo}/pulls?state=${state}&per_page=${perPage}&page=${page}`,
          );
          return safe(data);
        },
      },

      // ── github_get_pr_files ────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_GET_PR_FILES,
          description:
            "List files changed in a pull request. Returns filename, status, additions, deletions.",
          inputSchema: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repository (\"owner/repo\" or just \"repo\")." },
              prNumber: { type: "number", description: "Pull request number." },
            },
            required: ["prNumber"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:github:${cfg.connectionId}`,
          tags: ["github", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const { owner, repo } = ownerRepo(args);
          const prNumber = Number(args["prNumber"]);
          if (!owner || !repo) return "Error: repository required.";
          if (!prNumber) return "Error: prNumber is required.";

          const data = await client.get(`/repos/${owner}/${repo}/pulls/${prNumber}/files`);
          return safe(data);
        },
      },

      // ── github_get_pr_diff ─────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_GET_PR_DIFF,
          description:
            "Get the raw unified diff for a pull request.",
          inputSchema: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repository (\"owner/repo\")." },
              prNumber: { type: "number", description: "Pull request number." },
            },
            required: ["prNumber"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:github:${cfg.connectionId}`,
          tags: ["github", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const { owner, repo } = ownerRepo(args);
          const prNumber = Number(args["prNumber"]);
          if (!owner || !repo) return "Error: repository required.";
          if (!prNumber) return "Error: prNumber is required.";

          // GitHub diff requires Accept: application/vnd.github.diff
          const host = String(cfg.config["host"] ?? "https://api.github.com");
          const token = cfg.secrets["token"] ?? cfg.secrets["githubToken"] ?? "";
          const url = `${host}/repos/${owner}/${repo}/pulls/${prNumber}`;

          const fetchRes = await fetch(url, {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github.diff",
              "X-GitHub-Api-Version": "2022-11-28",
            },
          });

          if (!fetchRes.ok) {
            const text = await fetchRes.text().catch(() => "");
            return redactSecrets(`Error ${fetchRes.status}: ${text.slice(0, 200)}`, cfg.secrets);
          }

          const diff = await fetchRes.text();
          return redactSecrets(diff, cfg.secrets);
        },
      },

      // ── github_post_comment ────────────────────────────────────────────────
      {
        definition: {
          name: TOOL_POST_COMMENT,
          description:
            "Post a comment on a GitHub pull request or issue. " +
            "Returns the created comment URL.",
          inputSchema: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repository (\"owner/repo\")." },
              issueNumber: {
                type: "number",
                description: "PR or issue number to comment on.",
              },
              body: { type: "string", description: "Comment body (Markdown supported)." },
            },
            required: ["issueNumber", "body"],
          },
          source: "mcp" as const,
          mcpServer: `builtin:github:${cfg.connectionId}`,
          tags: ["github", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const { owner, repo } = ownerRepo(args);
          const issueNumber = Number(args["issueNumber"]);
          const body = String(args["body"] ?? "").trim();

          if (!owner || !repo) return "Error: repository required.";
          if (!issueNumber) return "Error: issueNumber is required.";
          if (!body) return "Error: comment body is required.";

          const data = await client.post(
            `/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
            { body },
          );

          const result = data as Record<string, unknown>;
          return redactSecrets(
            `Comment posted: ${String(result?.["html_url"] ?? "(no URL)")}`,
            cfg.secrets,
          );
        },
      },

      // ── github_list_workflows ──────────────────────────────────────────────
      {
        definition: {
          name: TOOL_LIST_WORKFLOWS,
          description:
            "List recent workflow runs for a GitHub repository. " +
            "Returns run ID, name, status, conclusion, and URL.",
          inputSchema: {
            type: "object",
            properties: {
              repo: { type: "string", description: "Repository (\"owner/repo\")." },
              branch: {
                type: "string",
                description: "Filter by branch name.",
              },
              status: {
                type: "string",
                enum: ["queued", "in_progress", "completed", "waiting", "requested", "pending"],
                description: "Filter by workflow run status.",
              },
              perPage: {
                type: "number",
                description: "Results per page (default: 10, max: 30).",
              },
            },
            required: [],
          },
          source: "mcp" as const,
          mcpServer: `builtin:github:${cfg.connectionId}`,
          tags: ["github", `connection:${cfg.connectionId}`],
        },
        execute: async (args) => {
          const { owner, repo } = ownerRepo(args);
          if (!owner || !repo) return "Error: repository required.";

          const perPage = Math.min(Number(args["perPage"] ?? 10), 30);
          const params = new URLSearchParams({ per_page: String(perPage) });
          if (args["branch"]) params.set("branch", String(args["branch"]));
          if (args["status"]) params.set("status", String(args["status"]));

          const data = await client.get(
            `/repos/${owner}/${repo}/actions/runs?${params.toString()}`,
          );
          return safe(data);
        },
      },
    ];
  }
}

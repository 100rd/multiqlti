import { z } from "zod";

export const ConfigSchema = z.object({
  server: z.object({
    port: z.number().int().min(1).max(65535).default(5000),
    nodeEnv: z.enum(["development", "production", "test"]).default("development"),
  }).default({}),
  database: z.object({
    url: z.preprocess(
      (v) => (v === "" ? undefined : v),
      z.string().url().optional(),
    ),
  }).default({}),
  auth: z.object({
    jwtSecret: z.string().min(32).optional(),
    sessionTtlDays: z.number().int().min(1).max(365).default(7),
    bcryptRounds: z.number().int().min(10).max(14).default(12),
    oauth: z.object({
      github: z.object({
        enabled: z.boolean().default(false),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        allowedOrgs: z.array(z.string()).default([]),
      }).default({}),
      gitlab: z.object({
        enabled: z.boolean().default(false),
        clientId: z.string().optional(),
        clientSecret: z.string().optional(),
        baseUrl: z.string().default("https://gitlab.com"),
        allowedGroups: z.array(z.string()).default([]),
      }).default({}),
      autoRegister: z.boolean().default(true),
      defaultRole: z.enum(["user", "maintainer", "admin"]).default("user"),
    }).default({}),
  }).default({}),
  providers: z.object({
    anthropic: z.object({
      apiKey: z.string().optional(),
      // "cli" (default) routes Claude through the local `claude` CLI
      // subscription (0 API tokens). "api" uses the paid Anthropic API and
      // requires apiKey — opt-in only.
      mode: z.enum(["cli", "api"]).default("cli"),
    }).default({}),
    /**
     * Cloud Gemini API (billed). Kept optional for backward compatibility but
     * hidden by default — Antigravity (below) is the preferred local,
     * subscription-backed replacement (issue #348). Only registered when an
     * apiKey is explicitly present AND Antigravity is disabled.
     */
    google: z.object({ apiKey: z.string().optional() }).default({}),
    /**
     * Local Antigravity CLI provider (subscription-backed, no Gemini API
     * tokens). Enabled by default; the gateway registers it under the
     * "antigravity" provider key and mirrors it onto "google" so existing
     * Gemini-routed models run through the local CLI.
     */
    antigravity: z.object({
      enabled: z.boolean().default(true),
      binPath: z.string().optional(),
      model: z.string().optional(),
      timeoutMs: z.coerce.number().int().positive().optional(),
    }).default({}),
    xai: z.object({ apiKey: z.string().optional() }).default({}),
    vllm: z.object({ endpoint: z.string().url().optional() }).default({}),
    ollama: z.object({ endpoint: z.string().url().optional() }).default({}),
    lmstudio: z.object({ endpoint: z.string().url().optional() }).default({}),
    tavily: z.object({ apiKey: z.string().optional() }).default({}),
  }).default({}),
  features: z.object({
    sandbox: z.object({
      enabled: z.boolean().default(false),
      maxConcurrent: z.number().int().min(1).max(20).default(3),
      defaultTimeoutSeconds: z.number().int().min(10).max(600).default(120),
    }).default({}),
    privacy: z.object({
      enabled: z.boolean().default(true),
    }).default({}),
    maintenance: z.object({
      enabled: z.boolean().default(false),
      cronSchedule: z.string().default("0 2 * * *"),
    }).default({}),
  }).default({}),
  federation: z.object({
    enabled: z.boolean().default(false),
    instanceId: z.string().default(""),
    instanceName: z.string().default(""),
    clusterSecret: z.string().default(""),
    listenPort: z.number().int().min(1).max(65535).default(5001),
    peers: z.array(z.string()).default([]),
    encryption: z.object({
      enabled: z.boolean().default(false),
      rotationIntervalHours: z.number().int().min(0).max(720).default(24),
    }).default({}),
  }).default({}),
  encryption: z.object({
    key: z.string().min(32).optional(),
  }).default({}),
  /**
   * Memory / retrieval backend selection (memory-architecture ADR, Track A).
   *
   * `retrieval.backend` selects the world-knowledge retrieval path:
   *   - "local"        — existing pgvector RAG (default, fallback).
   *   - "omniscience"  — Omniscience MCP `search` tool.
   *
   * Nothing changes by default: the backend is "local" unless explicitly
   * switched. When "omniscience" is selected the Retriever calls Omniscience
   * and falls back to local pgvector on any error.
   *
   * The Omniscience auth token is NEVER stored in config — it is read at
   * call time from the OMNISCIENCE_TOKEN environment variable (the var name
   * is configurable via `tokenEnv`).
   */
  memory: z.object({
    retrieval: z.object({
      backend: z.enum(["local", "omniscience"]).default("local"),
      omniscience: z.object({
        /** MCP transport used to reach Omniscience. */
        transport: z.enum(["stdio", "streamable-http"]).default("stdio"),
        /** Command to spawn the Omniscience MCP server (stdio transport). */
        command: z.string().optional(),
        /** Arguments for the stdio command. */
        args: z.array(z.string()).default([]),
        /** Endpoint URL for the streamable-http transport. */
        endpoint: z.preprocess(
          (v) => (v === "" ? undefined : v),
          z.string().url().optional(),
        ),
        /**
         * Name of the environment variable that holds the Omniscience auth
         * token (scopes: search, sources:read). The token value itself is
         * never persisted in config. Defaults to OMNISCIENCE_TOKEN.
         */
        tokenEnv: z.string().default("OMNISCIENCE_TOKEN"),
        /**
         * Default retrieval strategy passed to Omniscience `search`. The
         * contract accepts structural/keyword/auto and downgrades unknown
         * strategies to "hybrid" in v0.1 (we preserve the contract).
         */
        retrievalStrategy: z
          .enum(["hybrid", "structural", "keyword", "auto"])
          .default("hybrid"),
        /** Request timeout in milliseconds. */
        timeoutMs: z.coerce.number().int().positive().default(15_000),
        /**
         * Morning News Board internal feed (Security H3). Explicit opt-in,
         * SEPARATE from selecting the Omniscience RAG backend: enabling the
         * backend for other features must NOT silently turn on the board feed.
         * When true (and backend === "omniscience"), the board surfaces ONE
         * shared Omniscience workspace to ALL board users across ALL multiqlti
         * workspaces (single shared OMNISCIENCE_TOKEN). Default FALSE.
         */
        board: z.object({ enabled: z.boolean().default(false) }).default({}),
      }).default({}),
    }).default({}),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

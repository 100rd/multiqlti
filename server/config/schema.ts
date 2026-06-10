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
  /**
   * Pipeline stage streaming (streaming-stage-execution). Replaces the blocking
   * 120s wall-clock cap on the stage LLM path with an idle + overall timeout
   * model, bounds output, and gates WS progress emission. Bounds (.min/.max)
   * are enforced at load so a misconfig can NEVER disable the overall cap or
   * set an absurd buffer (Security M1).
   */
  pipeline: z.object({
    streaming: z.object({
      /** Kill-switch: false → BaseTeam uses the old blocking complete/completeWithTools path. */
      enabled: z.boolean().default(true),
      /** Idle (inactivity) timeout; reset on each chunk. 1s..10min. */
      idleTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
      /** Overall wall-clock cap; never reset by chunks. 10s..1h. */
      overallTimeoutMs: z.coerce.number().int().min(10_000).max(3_600_000).default(600_000),
      /** Cumulative output byte cap. 64KiB..64MiB (default 8MiB). */
      maxOutputBytes: z.coerce.number().int().min(65_536).max(67_108_864).default(8_388_608),
      /** WS stage:progress coalescing flush interval. 50ms..5s. */
      wsProgressFlushMs: z.coerce.number().int().min(50).max(5_000).default(250),
    }).default({}),
    /**
     * Opt-in streaming for the ORCHESTRATOR debate turns (debate-streaming-
     * termination). When enabled, DebateRunner routes each turn through
     * gateway.completeStreaming so "end of reasoning" is the stream's terminal
     * event, not a per-turn wall-clock — a long PRODUCTIVE Opus turn survives
     * (idle timer resets per delta) while a STALLED turn trips idleTimeoutMs.
     * SDLC presets never pass through DebateRunner, so they are unaffected.
     * Bounds (.min/.max) are enforced at load so a misconfig can NEVER disable
     * the per-turn overall cap; the overallTimeoutMs floor (10s) and default
     * (300s) keep it >= the old 90s so a real Opus reasoning turn is not
     * regressed (Risk R1).
     */
    debateStreaming: z.object({
      /** Kill-switch: false → debate turns use the blocking complete() path. */
      enabled: z.boolean().default(true),
      /** Idle (inactivity) timeout per turn; reset on each delta. 1s..10min. */
      idleTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(60_000),
      /** Overall wall-clock backstop per turn (NOT per-chunk). 10s..1h (5min default). */
      overallTimeoutMs: z.coerce.number().int().min(10_000).max(3_600_000).default(300_000),
      /** Cumulative output byte cap per turn. 64KiB..64MiB (default 8MiB). */
      maxOutputBytes: z.coerce.number().int().min(65_536).max(67_108_864).default(8_388_608),
    }).default({}),
    /**
     * Debate-research orchestrator (additive 3rd run mode). Kill-switch default
     * FALSE. Every cap is bounded at load (Security C2/H2/L1 substrate); the
     * engine re-clamps each at runtime (defense-in-depth, never trust config
     * alone). A misconfig can NEVER disable the overall cap or the token ceiling.
     */
    orchestrator: z.object({
      /** Kill-switch: false → POST /api/runs/orchestrator returns 503. */
      enabled: z.boolean().default(false),
      /** Max steps in a plan. 1..20. */
      maxSteps: z.coerce.number().int().min(1).max(20).default(8),
      /** Max debate rounds per debate step. 1..5 (matches validateDebateStrategy). */
      maxDebateRounds: z.coerce.number().int().min(1).max(5).default(3),
      /** Max research sources fanned out per research step. 1..50. */
      maxResearchSources: z.coerce.number().int().min(1).max(50).default(12),
      /** Max concurrent research fetches. 1..10. */
      maxResearchConcurrency: z.coerce.number().int().min(1).max(10).default(4),
      /** Per-source byte cap into synthesis (H2). 4KiB..1MiB. */
      maxResearchSourceBytes: z.coerce.number().int().min(4096).max(1_048_576).default(262_144),
      /** Aggregate research byte cap into one synthesis prompt (H2). 4KiB..64MiB. */
      maxResearchTotalBytes: z.coerce.number().int().min(4096).max(67_108_864).default(1_048_576),
      /** Token ceiling checked BEFORE each LLM call (C2). 1000..2M. */
      maxTotalTokens: z.coerce.number().int().min(1000).max(2_000_000).default(400_000),
      /** Wall-clock cap for the whole run. 10s..1h (30min default). */
      overallTimeoutMs: z.coerce.number().int().min(10_000).max(3_600_000).default(1_800_000),
      /** Per-step persisted output byte cap (storage DoS). 4KiB..1MiB. */
      stepOutputMaxBytes: z.coerce.number().int().min(4096).max(1_048_576).default(100_000),
      /** Per-Gemini-debate-turn timeout (Lead Q1). 1s..10min (90s default). */
      geminiTurnTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(90_000),
      /**
       * Dry-streak patience: stop the debate after K consecutive rounds with no
       * NEW argument (novelty-based early termination). 1..5. Re-clamped HARD at
       * runtime in resolveCaps (defense-in-depth). Novelty can only SHORTEN; the
       * round hard-cap + token budget + abort remain absolute backstops.
       */
      debateNoveltyPatience: z.coerce.number().int().min(1).max(5).default(1),
    }).default({}),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

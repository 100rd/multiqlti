import { z } from "zod";

/**
 * Default model slug for direct_llm task-group tasks created WITHOUT an explicit
 * model. Must be a REAL, active subscription-CLI slug — NEVER "mock". A "mock"
 * default makes task groups "complete" instantly with canned garbage at cost 0
 * (fix/task-group-real-model-execution); kept in sync with the pipeline defaults
 * re-pointed off the disabled local models in PR #363 (claude-sonnet). Used as
 * the zod default for `pipeline.taskGroups.defaultModel` below so the orchestrator
 * resolves a working model when a task has no `modelSlug`.
 */
export const DEFAULT_TASK_MODEL = "claude-sonnet";

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
    /**
     * Shared min-rounds floor for the unified adaptive-stability deliberation
     * engine (debate + /consensus). A stability/consensus stop can NEVER fire
     * before this many rounds — the structural ANTI-PREMATURE-convergence
     * guarantee. resolveCaps re-clamps it to [2, hardCap] at runtime.
     */
    deliberation: z.object({
      /** Min rounds before any stability/consensus stop can fire. 2..5. */
      minRounds: z.coerce.number().int().min(2).max(5).default(2),
    }).default({}),
    /**
     * The /consensus run mode (decision VERDICT via blind verdict → independent
     * voters → adjudication → 4-condition AND). Kill-switch default FALSE. Every
     * cap is bounded at load; the engine re-clamps each at runtime
     * (defense-in-depth, never trust config alone).
     */
    consensus: z.object({
      /** Kill-switch: false → POST /api/runs/consensus returns 503. */
      enabled: z.boolean().default(false),
      /** Max consensus rounds before "unresolved". 1..5 (matches HARD cap). */
      maxRounds: z.coerce.number().int().min(1).max(5).default(3),
      /** Independent external voters per round (ensemble 5-7). */
      voterCount: z.coerce.number().int().min(5).max(7).default(5),
      /** Token ceiling for the whole cycle (C2). 1000..2M. */
      maxTotalTokens: z.coerce.number().int().min(1000).max(2_000_000).default(400_000),
      /** Wall-clock cap for the whole cycle. 10s..1h (30min default). */
      overallTimeoutMs: z.coerce.number().int().min(10_000).max(3_600_000).default(1_800_000),
      /** Per-voter / per-turn timeout. 1s..10min (90s default). */
      voterTimeoutMs: z.coerce.number().int().min(1_000).max(600_000).default(90_000),
    }).default({}),
    /**
     * Task-group (multi-task) execution. `defaultModel` is the slug applied to a
     * `direct_llm` task created WITHOUT an explicit `modelSlug`. It MUST resolve
     * to a real, active model — NEVER "mock" — otherwise the group "completes"
     * instantly with the MockProvider canned stub at cost 0
     * (fix/task-group-real-model-execution). Defaults to the same working
     * subscription CLI the pipeline defaults use (PR #363).
     */
    taskGroups: z.object({
      /** Real default model for model-less direct_llm tasks. NEVER "mock". */
      defaultModel: z.string().min(1).default(DEFAULT_TASK_MODEL),
      /**
       * Soft cost cap (R3/SF-3): max iterations a single group may run. `0` =
       * unlimited (the local single-user MVP default; re-runs are deliberate
       * clicks). When >0, `POST /:id/start` returns 409 once the cap is reached.
       */
      maxIterationsPerGroup: z.number().int().min(0).default(0),
      /**
       * Overall wall-clock cap (ms) for a direct_llm task's gateway call, which
       * runs via the STREAMING path (deltas drained incrementally). The provider
       * CLIs default to 120s, far too tight for a strong model (Opus) doing
       * extended-thinking over a large dependency-output context (a debate round
       * that sees prior rounds can think ~100s silently before emitting). Default
       * 10 min; raise for deeper chains. 10s..30min.
       */
      taskTimeoutMs: z.coerce.number().int().min(10_000).max(1_800_000).default(600_000),
    }).default({}),
    /**
     * Consilium loop (design doc §8): the auto-versioned closed loop that
     * re-runs a consilium group, builds a diff-context per round (A2), and
     * decides convergence. Kill-switch default FALSE. Every numeric cap is
     * bounded at load via `z.coerce.number().int().min/.max` — a NaN from a bad
     * env/yaml value fails `.int()` and aborts load rather than silently
     * defaulting (Security M-5). `allowedRepoPaths` is the fail-closed allowlist
     * the diff-context builder re-validates against every round (Security H-1).
     */
    consiliumLoop: z.object({
      /** Kill-switch: false → the loop controller/routes stay disabled (Phase B). */
      enabled: z.boolean().default(false),
      /** Hard round cap (design §1). 1..6 (6 default). */
      maxRounds: z.coerce.number().int().min(1).max(6).default(6),
      /** Backstop poller interval for non-terminal loops. 1s..60s. */
      pollIntervalMs: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
      /** Hard byte cap on the per-round unified diff (A2 bound). 1KiB..2MB. */
      maxDiffBytes: z.coerce.number().int().min(1_024).max(2_000_000).default(200_000),
      /**
       * Fail-closed repo allowlist. Empty ⇒ no repo path is permitted (the
       * diff-context builder throws). config.yaml only — arrays are not
       * env-mapped (matches the federation.peers / omniscience.args pattern).
       */
      allowedRepoPaths: z.array(z.string()).default([]),
      /** Default DEV pipeline used for the loop's DEV handoff step (Phase B). */
      devPipelineId: z.string().optional(),
      /**
       * Hard wall-clock timeout PER action-point SDLC coder run (ms). The SDLC
       * executor runs the agentic coder once per action point sequentially in one
       * worktree, so this bounds a SINGLE action point, not the whole round.
       * 60s..30min; default 20min (large architectural P0s need headroom — a too
       * small cap discards real work on timeout). NaN/out-of-range fails load.
       */
      sdlcTimeoutMs: z.coerce.number().int().min(60_000).max(1_800_000).default(1_200_000),
      /**
       * Stage 1 (design §6): the intent→archetype PLANNER — a single OUT-OF-BAND
       * lightweight model call (NOT a DAG task, NOT an FSM state) that proposes one
       * of a fixed enum of archetypes for a verdict-terminal loop. The whole planner
       * surface is ALSO gated by the parent `consiliumLoop.enabled` kill-switch
       * (the routes are only registered then), so this is a second, finer toggle.
       */
      planner: z.object({
        /** Finer kill-switch: false → POST /:id/plan is inert (the override
         *  PATCH /:id/archetype, which makes no model call, stays available). */
        enabled: z.boolean().default(true),
        /**
         * The model slug the planner calls via the SAME gateway path direct_llm
         * tasks use. Defaults to the task system's default model — NEVER "mock"
         * (a mock model would "decide" an archetype from canned garbage at cost 0).
         */
        model: z.string().min(1).default(DEFAULT_TASK_MODEL),
      }).default({}),
      /**
       * Stage 2a (design §3.C/§4): the SKILLED, archetype-branched implement
       * (develop) phase. When `enabled` is FALSE the loop runs TODAY'S single
       * unskilled coder per action point (byte-for-byte unchanged). When TRUE the
       * SDLC executor selects an ordered SKILLED step set from the loop's Stage-1
       * archetype (e.g. repo-assessment → test-author → coder) and scopes each
       * coder invocation by the step's capability. This is a strict SUPERSET of
       * the develop phase: Stage 2a executes NOTHING new (no test run, no FSM
       * change) — the per-criterion sandboxed verification/fix-loop is Stage 2b and
       * is deliberately NOT configured here (so verification can never execute).
       */
      implement: z.object({
        /** Kill-switch: false → today's unskilled coder path; true → the skilled
         *  path. Defaults FALSE (opt-in). Also gated by the parent
         *  `consiliumLoop.enabled` (the loop only runs at all when that is true). */
        enabled: z.boolean().default(false),
        /**
         * Stage 2b (design §3.C/§5/§10-2b): the per-criterion SANDBOXED VERIFICATION
         * + bounded code→test→fix loop — the ONLY surface that EXECUTES repo code (the
         * test command) in the isolated worktree. It has its OWN kill-switch, default
         * FALSE, so Stage 2b ships INERT: with it false the develop phase is EXACTLY
         * Stage 2a (skilled coder, NO test run, nothing executed). An operator flips it
         * on ONLY after the security review decides the env-allowlist + timeout +
         * no-shell + worktree confinement is sufficient (vs. requiring a container/
         * namespace sandbox — features.sandbox). Also gated by the parent
         * `consiliumLoop.enabled` AND `implement.enabled`.
         */
        verification: z.object({
          /** Kill-switch: false (default) → no test ever runs (Stage-2a behavior). */
          enabled: z.boolean().default(false),
        }).default({}),
        /**
         * MED-2 (fail-closed enable-gate): operator acknowledgement that the
         * configured repos are TRUSTED to run their own test command on the host with
         * ambient filesystem + outbound network (NO container/namespace boundary).
         * `verification.enabled` is HONORED only when EITHER the platform container
         * sandbox (`features.sandbox.enabled`) is on OR this ack is true — otherwise
         * verification is force-disabled (degrades to Stage-2a) with a load-time
         * warning. Default false ⇒ enabling verification on an untrusted repo without a
         * sandbox is a no-op, not a host-exec foot-gun. See `effectiveVerificationEnabled`.
         */
        trustedRepoAck: z.boolean().default(false),
        /**
         * Bounded code→test→fix budget: how many times the coder may be re-invoked
         * with the test-failure summary (after the initial implement) before the loop
         * stops on green or budget. 1..10; default 3. Hard cap bounds develop time.
         */
        maxFixIterations: z.coerce.number().int().min(1).max(10).default(3),
        /**
         * Repo test command (operator override). null (default) ⇒ auto-detect from
         * the worktree's package.json `scripts.test`. SECURITY: the ONLY places a
         * test command may come from are this config value and the repo's own
         * package.json — NEVER untrusted action-point / criterion text. Run via
         * no-shell argv (whitespace-tokenized), so no shell metacharacter applies.
         */
        testCommand: z.string().nullable().default(null),
        /**
         * Hard wall-clock timeout for a SINGLE test run (ms) → SIGKILL on expiry.
         * 10s..30min; default 5min. Bounded/clamped so a wedged test process (the
         * #422 lesson) is always reaped.
         */
        testRunTimeoutMs: z.coerce.number().int().min(10_000).max(1_800_000).default(300_000),
      }).default({}),
    }).default({}),
  }).default({}),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

/**
 * MED-2 — the SINGLE source of truth for whether Stage-2b per-criterion verification
 * may ACTUALLY execute repo code. `verification.enabled` is the operator's intent, but
 * it is HONORED only when the test process is sandboxed OR the operator has explicitly
 * acked trusted-repo host execution:
 *
 *   effective = verification.enabled
 *               && (features.sandbox.enabled === true   // contained: safe by isolation
 *                   || implement.trustedRepoAck === true) // operator owns the repo trust
 *
 * Fail-closed: when `verification.enabled` is true but NEITHER gate is set, this
 * returns FALSE (the develop phase degrades to the Stage-2a skilled coder, NO test
 * runs). Callers SHOULD log a one-line warning in that case (see the controller). We
 * never hard-throw — a hopeful `verification.enabled` must not break config load.
 */
export function effectiveVerificationEnabled(config: AppConfig): boolean {
  const impl = config.pipeline.consiliumLoop.implement;
  if (!impl.verification.enabled) return false; // short-circuit: never reads features.
  return config.features?.sandbox?.enabled === true || impl.trustedRepoAck === true;
}

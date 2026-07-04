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
    /**
     * T1 trigger retarget (loop-triggers.md §4.5): the kill-switch for a schedule
     * trigger's NEW loop-firing behavior. Default FALSE ⇒ a scheduled fire records
     * `lastTriggeredAt` but launches NO consilium loop — a running server never
     * silently starts firing loops. Turn on explicitly to activate schedule→loop.
     *
     * This gate does NOT touch the pre-existing file_change → consilium-review
     * binding (the "one live binding" prototype), which stays gated only by
     * `pipeline.consiliumLoop.enabled`. It also does not affect trigger CRUD — the
     * "Add Trigger" UI works regardless; only the automated FIRING of loops from a
     * schedule is gated here.
     */
    triggers: z.object({
      enabled: z.boolean().default(false),
      /**
       * github-trigger-polling: a LOCAL daemon behind NAT can NEVER receive a
       * GitHub webhook (GitHub's servers cannot POST to localhost / a private LAN
       * IP), so an enabled github_event trigger silently never fires. This
       * kill-switch turns on a POLLER that PULLS from GitHub via the `gh` CLI
       * (works behind NAT, no public endpoint) and fires matching triggers through
       * the SAME dispatch path the webhook receiver uses.
       *
       * Default FALSE ⇒ no polling; back-compatible. Polling ALSO requires the
       * `enabled` master switch above (a poll that fires a loop is gated by it) —
       * with the master switch off the poller idles without consuming watermarks.
       * `intervalSec` bounds GitHub traffic (min 60s so a misconfig cannot hammer
       * the API; max 1h).
       */
      githubPolling: z.object({
        enabled: z.boolean().default(false),
        intervalSec: z.number().int().min(60).max(3600).default(300),
      }).default({}),
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
      /**
       * OPTION A (codegraph research): a scoped, READ-ONLY "repository map" preamble
       * injected into the REVIEW input. For the files each round's diff TOUCHES, a
       * compact `file → exported symbols + 1-hop importers` map is built from the
       * EXISTING workspace symbol index (`workspace_symbols`) — never a new
       * dependency, never a write. It improves debater/judge comprehension of
       * structural claims (fewer rounds). Hard byte-bounded + secret-redacted.
       * Default OFF ⇒ BYTE-IDENTICAL: no map section is emitted and the review input
       * is unchanged. Also gated (like every enhancement here) under the parent
       * `consiliumLoop.enabled`.
       */
      repoMap: z.object({
        /** Kill-switch: false (default) → no map section (byte-identical off). */
        enabled: z.boolean().default(false),
        /**
         * Hard byte cap on the assembled map body (~4 bytes/token ⇒ ≈1500 tokens at
         * the 6KiB default). Entries are ranked by importer count and the least-
         * referenced files are dropped FIRST to fit. 512B..200KB.
         */
        maxRepoMapBytes: z.coerce.number().int().min(512).max(200_000).default(6_000),
      }).default({}),
      /**
       * Hard wall-clock timeout PER action-point SDLC coder run (ms). The SDLC
       * executor runs the agentic coder once per action point sequentially in one
       * worktree, so this bounds a SINGLE action point, not the whole round.
       * 60s..30min; default 20min (large architectural P0s need headroom — a too
       * small cap discards real work on timeout). NaN/out-of-range fails load.
       */
      sdlcTimeoutMs: z.coerce.number().int().min(60_000).max(1_800_000).default(1_200_000),
      /**
       * Bug #7 — stranded-REVIEW recovery threshold. A review round runs in the
       * in-process consilium workers; if they die (crash / server restart) the
       * iteration's task_executions stay `running` forever and the loop sits in
       * `reviewing` with zero LLM activity, with NO recovery (unlike develop's
       * redriveStranded). When the current review iteration has made NO PROGRESS —
       * no new llm_requests, no task-execution status change, iteration unsettled —
       * for longer than this, the controller treats the review as stranded and
       * re-launches it (see `reviewMaxRedrives`). Detection is NO-PROGRESS based
       * (NOT wall-clock since start), so a slow-but-live review is never touched.
       * 1min..24h; default 15min. Set very HIGH ⇒ recovery is effectively OFF
       * (today's behavior — the loop waits forever, as before).
       */
      reviewStallTimeoutMs: z.coerce.number().int().min(60_000).max(86_400_000).default(900_000),
      /**
       * Bug #7 — bounded auto re-launches for a stranded review round before giving
       * up. On a detected stall the round is re-launched with a FRESH iteration for
       * the SAME round number (the loop stays `reviewing`, just gets a live worker
       * again); only after this many exhausted re-launches does the loop fall back
       * to `failed` via the existing `review_failed` event — failure is the last
       * resort, not the first move. 0 ⇒ never re-launch (fail on first detected
       * stall). 0..20; default 3.
       */
      reviewMaxRedrives: z.coerce.number().int().min(0).max(20).default(3),
      /**
       * Judge timeout resilience (fix: bounded retry with model fallback for
       * judge timeouts). In a consilium dispute the JUDGE task receives the FULL
       * debate context — the largest-context call of the round — and can hit the
       * gateway wall-clock cap (observed: latency ≈ 600_000ms, 0 output tokens),
       * which FAILS the judge task_execution, cancels its dependents, fails the
       * task_group_iteration, and drives the loop to FAILED.
       *
       * When `enabled`, a direct_llm LLM-stage task whose gateway call ends in a
       * TIMEOUT (throw) or an EMPTY (0-token) completion is retried EXACTLY ONCE;
       * on the retry an optional `fallbackModel` overrides the slug. Bounded to a
       * SINGLE retry — no backoff/exponential machinery, so no retry storms. The
       * LLM completion is a pure gateway call (no outbox/webhook side effect per
       * attempt), so a retry cannot double-charge a business action.
       *
       * Default FALSE ⇒ INERT: exactly one attempt and any throw/empty propagates
       * unchanged (byte-identical to today). The FSM/reducer failure path when the
       * retry is disabled OR exhausted is untouched — the loop still fails cleanly.
       */
      judgeRetry: z.object({
        /** Kill-switch: false → single attempt, today's failure path (inert). */
        enabled: z.boolean().default(false),
        /**
         * Optional model slug used ONLY on the single retry attempt (e.g. a
         * faster/cheaper model that fits the large judge context under the cap).
         * Omitted ⇒ the retry re-uses the task's own model. min(1) when present
         * so an empty string is rejected rather than silently blanking the slug.
         */
        fallbackModel: z.string().min(1).optional(),
      }).default({}),
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
        /**
         * Stage C (design §9 "Stage 7"): acceptance-criterion QA. A MECHANICAL, no-LLM lint
         * over each AP's `acceptanceCriterion` at generation time (right after the planner
         * normalizes methods): a criterion that is absent/empty, lacks the "When … Then …"
         * shape, or — for a `test-run` criterion — is too thin to name a concrete observable
         * signal is flagged `weakCriterion` and DEMOTED to the `judge` method, so it can
         * NEVER converge as "tests green" on a vacuous DoD (Goodhart guard, §5). When ON it
         * ALSO extends the re-assess prior-findings block so the judge must, for each item it
         * confirms CLOSED, state whether the DoD itself was ADEQUATE and re-open a corrected
         * criterion if not — riding the EXISTING re-assess judge call (no extra model call).
         * The routing effect (demotion) bites only when `implement.perCriterionMethod` is also
         * on (the executor routes on method); standalone it still surfaces `weakCriterion`.
         * Kill-switch default FALSE ⇒ BYTE-IDENTICAL off: no lint, no flag, no demotion, and
         * the prior-findings wording is unchanged. Gated by the parent `consiliumLoop.enabled`.
         */
        criteriaQa: z.object({
          /** Kill-switch: false (default) → no criterion lint / demotion / adequacy re-check. */
          enabled: z.boolean().default(false),
        }).default({}),
      }).default({}),
      /**
       * "Magic mode" instruction authoring (POST /api/consilium-reviews/reformulate-
       * instruction): a single OUT-OF-BAND gateway call that turns an operator's rough
       * "what I want" into a proposed engineer instruction, which the operator then
       * REVIEWS and EDITS before it becomes the review's engineerInstruction. It is a
       * pre-submit aid, never a hidden transform, and touches NO fs/git. The endpoint
       * is registered only inside the parent `consiliumLoop.enabled` block; this is the
       * finer toggle. Uses the SAME gateway path (completeStreaming) direct_llm/planner
       * use, on an opus-tier model by default (the framing benefits from a capable model).
       */
      reformulate: z.object({
        /** Finer kill-switch: false → the reformulate endpoint returns 409 (manual mode still works). */
        enabled: z.boolean().default(true),
        /**
         * The model slug the reformulator calls. Defaults to an opus-tier slug — the
         * instruction framing is a low-volume, quality-sensitive one-shot. Must be a
         * REAL, active subscription-CLI slug (NEVER "mock").
         */
        model: z.string().min(1).default("claude-opus"),
      }).default({}),
      /**
       * Single-verifier confirmation review (re-review rounds). Controls the
       * OPERATOR-LEVEL default for `consilium_loops.review_mode`: when `enabled` is
       * true, a loop created WITHOUT an explicit `reviewMode` runs its re-review
       * rounds (round > 1) as ONE fresh, independent verifier that CONFIRMS whether
       * the written code closed the prior findings — instead of re-running the full
       * 2-debater+judge panel. Round 1 ALWAYS runs the full preset DAG. An EXPLICIT
       * per-loop `reviewMode` always wins over this default. Default FALSE ⇒
       * BYTE-IDENTICAL: with no explicit per-loop mode every round is the full
       * dispute, exactly as before. Gated (like every enhancement here) under the
       * parent `consiliumLoop.enabled`.
       */
      verifyReview: z.object({
        /** Kill-switch: false (default) → the operator default stays 'full-dispute'
         *  (byte-identical). An explicit per-loop reviewMode='single-verifier' still
         *  works regardless of this switch. */
        enabled: z.boolean().default(false),
        /**
         * The model the SINGLE verifier task runs on (a `direct_llm` task). Opus-tier
         * by default — the confirmation is a low-volume, quality-sensitive one-shot.
         * SECURITY (fail-closed at load): SAME safe-slug regex as `implement.coderModel`
         * — alphanumeric FIRST char, then `[A-Za-z0-9._-]` — so a config value can never
         * be flag-like or a shell metacharacter; it can ONLY ever be a model id. A value
         * that fails ABORTS config load rather than silently defaulting. NEVER "mock".
         */
        model: z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
            "verifyReview.model must be a safe model slug (alphanumeric start; [A-Za-z0-9._-])",
          )
          .default("claude-opus"),
      }).default({}),
      /**
       * §3E verify-before-merge: move the CONFIRMATION re-review BEFORE the human ship
       * gate. When `enabled` (default FALSE ⇒ byte-identical to today), after the develop
       * close-out the loop (1) integrates its BASE branch INTO the round branch — so the
       * PR is "base + our changes", the realistic landing state — and (2) runs the
       * confirmation review AUTOMATICALLY (no human gate to START it). A converged
       * confirmation lands at `awaiting_merge` where the human's ONLY job is the FINAL ship
       * of already-confirmed code (the `merge_approved` event then terminates the loop with
       * NO second review). A non-converged confirmation re-develops (bounded by maxRounds).
       * Default FALSE keeps today's `awaiting_merge → merge_approved → round-2 review` flow
       * BYTE-IDENTICAL. Gated (like every enhancement here) under the parent
       * `consiliumLoop.enabled`.
       */
      verifyBeforeMerge: z.object({
        /** Kill-switch: false (default) → today's human-triggered confirmation flow
         *  (byte-identical). true → confirm against the main-integrated branch BEFORE
         *  the human ship gate. */
        enabled: z.boolean().default(false),
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
         * OPTIONAL operator-pinned model for the agentic SDLC coder (the local
         * `claude` CLI that implements action points). Absent (default) ⇒ the coder
         * spawns with NO `--model` flag and uses the CLI's OWN default model —
         * byte-for-byte today's behavior. When SET, EVERY coder invocation of a
         * round (initial per-AP coder, verify→fix iterations, final-state fix coder)
         * adds `--model <slug>`.
         *
         * SECURITY (fail-closed at load): the coder passes this as a SEPARATE argv
         * element (arg-array, no shell), but it is STILL constrained to a safe slug
         * so a config value can never be flag-like, whitespaced, or a shell
         * metacharacter — it can ONLY ever be a model id. The task specified
         * `^[a-zA-Z0-9._-]+$`; this is tightened to require an alphanumeric FIRST
         * char (a strict subset) so a value can never even look like a flag
         * (`-p`, `--dangerously-...`). A value that fails ABORTS config load rather
         * than silently defaulting; the argv seam (`buildCoderArgs`) re-validates
         * with the SAME slug as an independent second layer. min(1) rejects empty.
         * NOTE: this is a claude-CLI model slug (e.g. "sonnet"); the coder path is
         * claude-CLI-specific — see the PR for why the Gemini/Antigravity CLI cannot
         * serve as an agentic coder today.
         */
        coderModel: z
          .string()
          .min(1)
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
            "coderModel must be a safe model slug (alphanumeric start; [A-Za-z0-9._-])",
          )
          .optional(),
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
        /**
         * Stage B (design §5 + §9 "Stage 6"): PER-CRITERION verification method routing.
         * The judge proposes and the planner assigns a method PER action point; the
         * executor then routes each AP by its method instead of forcing every criterion
         * through the test-run harness:
         *   - `manual-ops` → NOT sent to the coder; SURFACED for a human (never green).
         *   - `judge` → coder implements, then a VERIFIER model judges the diff against
         *     the criterion (no test run).
         *   - `test-run` → today's per-criterion sandboxed test path (unchanged).
         * Kill-switch default FALSE ⇒ BYTE-IDENTICAL off: the executor ignores every AP's
         * method and the planner never normalizes. Gated by the parent `consiliumLoop
         * .enabled` AND `implement.enabled`; the `judge` route additionally needs the
         * planner gateway, the `test-run` route the SAME sandbox gate as `verification`.
         */
        perCriterionMethod: z.object({
          /** Kill-switch: false (default) → no method routing (byte-identical develop). */
          enabled: z.boolean().default(false),
          /**
           * The model slug the `judge`-method VERIFIER calls via the SAME gateway path
           * the planner/direct_llm use (no tools, completion only). Defaults to the task
           * system's default model — NEVER "mock" (a mock would rubber-stamp a criterion).
           */
          judgeModel: z.string().min(1).default(DEFAULT_TASK_MODEL),
        }).default({}),
        /**
         * Stage B (design §5): OPTIONAL lint/format command folded into the coder's green.
         * When SET (a non-empty command) AND per-criterion verification is enabled, after a
         * test-run PASSES for an action point the executor runs this command; a lint/format
         * failure counts as RED and enters the SAME bounded code→test→fix loop (the fix
         * prompt states lint/format failed + includes the output). Also run once in final
         * verification. UNSET (null, default) ⇒ ZERO change. SECURITY: config-sourced, the
         * SAME trust as `testCommand` — run via no-shell argv (whitespace-tokenized), never
         * from untrusted action-point/criterion text; a shell-metachar in it is NOT
         * interpreted. Timeout reuses `testRunTimeoutMs`; spawn-failure (ENOENT/EACCES) is
         * NOT-RUN and a wall-clock kill is NOT-ADJUDICATED (same conventions as testCommand).
         */
        lintCommand: z.string().nullable().default(null),
        /**
         * PER-REPO command overrides. A map keyed by the loop's `repoPath` (the SAME
         * absolute path strings operators put in `allowedRepoPaths`). The GLOBAL
         * `testCommand` / `lintCommand` / `testRunTimeoutMs` / `coderModel` above run the
         * same command for EVERY repo — wrong when a loop targets repos with different
         * toolchains (a Python repo needs `uv run pytest`, a Node repo `npm test`). At
         * DISPATCH the controller resolves the EFFECTIVE command set for the loop's repo
         * (`resolveImplementForRepo`): a per-repo field OVERRIDES the sibling global key;
         * an ABSENT field falls back to the global key; NO entry at all ⇒ byte-for-byte
         * today's global behavior. Additive + backward-compatible — the global keys stay
         * the default/fallback and are NEVER removed.
         *
         * MATCHING (`selectPerRepoOverride`, pure/lexical — no fs): EXACT repoPath key
         * first, else the LONGEST configured key that is a path-boundary prefix of the
         * loop's repoPath (a parent-dir entry can cover a whole tree). Keys are NOT
         * required to be in `allowedRepoPaths` — an entry for a non-allowlisted repo is
         * harmless dead config: the allowlist is still enforced INDEPENDENTLY at dispatch
         * (`assertAllowedRepoPath`), so a per-repo override can never widen repo access.
         *
         * SECURITY: identical trust to the global keys — config-sourced ONLY (never
         * action-point/criterion text), each field re-validated with the SAME schema
         * (coderModel safe-slug with an alphanumeric first char so it can never look like
         * a flag; timeout clamped 10s..30min), and run downstream via no-shell argv. An
         * unknown field on an entry is stripped by zod. Absent (default {}) ⇒ ZERO change.
         */
        perRepo: z
          .record(
            z.string(),
            z.object({
              /** Per-repo test command; null ⇒ auto-detect from package.json. Absent ⇒ inherit global `testCommand`. */
              testCommand: z.string().nullable().optional(),
              /** Per-repo lint/format command; null ⇒ no lint run. Absent ⇒ inherit global `lintCommand`. */
              lintCommand: z.string().nullable().optional(),
              /** Per-repo single-test-run timeout (ms), same clamp as the global. Absent ⇒ inherit global `testRunTimeoutMs`. */
              testRunTimeoutMs: z.coerce.number().int().min(10_000).max(1_800_000).optional(),
              /** Per-repo coder model slug (same safe-slug guard as the global). Absent ⇒ inherit global `coderModel`. */
              coderModel: z
                .string()
                .min(1)
                .regex(
                  /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
                  "perRepo.coderModel must be a safe model slug (alphanumeric start; [A-Za-z0-9._-])",
                )
                .optional(),
            }),
          )
          .default({}),
        /**
         * Stage 3 (design §3.C/§6): the RESEARCH archetype implement path — deep web
         * research → synthesize → a structured, web-evidence-verified REPORT (NOT code,
         * NOT a Draft PR). When `enabled` is FALSE (default) a `research` loop's close-out
         * returns an INERT no-PR result and NEVER falls through to the coder (the
         * anti-footgun branch). Sibling to `verification` — a THIRD, finer kill-switch on
         * top of the parent `consiliumLoop.enabled` AND `implement.enabled`. UNLIKE
         * verification it needs no sandbox gate (web_search is read-only + a fixed
         * Tavily/DDG endpoint — no host exec, no SSRF). Ships inert; enable after
         * observation (§7) to control Tavily/token cost.
         */
        research: z.object({
          /** Kill-switch: false (default) → research close-out is inert (no-PR + never
           *  the coder). true → runResearchHandoff runs the web-read research pipeline. */
          enabled: z.boolean().default(false),
          /**
           * Bounded re-research budget: how many times the runner may re-run research
           * when P0-criterion claims are still uncited by the web-evidence verifier,
           * before it stops (flagged) or budget. 1..10; default 3. Hard cap + a
           * whole-run wall-clock deadline bound research time/cost.
           */
          maxResearchIterations: z.coerce.number().int().min(1).max(10).default(3),
          /**
           * The model slug the research/synthesize/verify steps call via the gateway's
           * completeWithTools (web_search) loop. Defaults to the task system's default
           * model — NEVER "mock".
           */
          model: z.string().min(1).default(DEFAULT_TASK_MODEL),
        }).default({}),
        /**
         * Stage A (design §3D CONVERGE): FINAL-STATE re-verification. Action points are
         * implemented SEQUENTIALLY in ONE shared worktree and Stage-2b per-criterion
         * verification runs at the TIME each AP is implemented — so a LATER AP can regress
         * what an EARLIER AP's tests verified, and NOTHING re-checks the FINAL combined
         * worktree before the Draft PR opens. When `enabled` (default FALSE) AND the
         * Stage-2b sandbox gate is ALREADY satisfied (`effectiveVerificationEnabled` —
         * final verification obeys the SAME host-exec gate as per-AP test runs), the
         * executor runs the test suite ONCE against the final state after the last AP and
         * before the PR, then a bounded fix loop. A failure is RECORDED (round testSummary
         * + execution trace + PR body) but NEVER blocks PR creation (same never-throw
         * contract as the per-AP path). Ships INERT: with it false the develop phase is
         * byte-for-byte unchanged. Gated by the parent `consiliumLoop.enabled`,
         * `implement.enabled`, AND the verification sandbox gate.
         */
        finalVerification: z.object({
          /** Kill-switch: false (default) → no final re-verification runs (INERT). */
          enabled: z.boolean().default(false),
          /**
           * Bounded FINAL code→test→fix budget: how many times the coder may be re-invoked
           * with the final-state test-failure summary before the loop stops (on green or
           * budget). 0..3; default 1. 0 ⇒ verify-only (record the regression, attempt no
           * fix). Kept small — this is a convergence BACKSTOP, not the main per-AP fix
           * budget (`maxFixIterations`). NaN/out-of-range fails load (Security M-5).
           */
          maxFinalFixIterations: z.coerce.number().int().min(0).max(3).default(1),
        }).default({}),
        /**
         * Parallel-develop (design §4 "development = controller + N coders for N features"):
         * run a round's action points CONCURRENTLY in DEPENDENCY-AWARE WAVES instead of
         * sequentially in one shared worktree. The JUDGE declares the dependency edges
         * (`ap.dependsOn`, from the dispute); the planner (`buildWaveSchedule`) validates them,
         * breaks cycles, and topologically sorts the round into waves. Each wave's APs run in
         * their OWN isolated worktree branched off the ROUND's integration branch (the merged
         * result of all prior waves), bounded by `maxConcurrency`; after a wave, each AP's
         * branch is merged back SEQUENTIALLY (clean merge → proceed; conflict → the AP is
         * re-run on the integrated tree). The final PR opens from the integration branch and
         * the SAME Stage-A final verification runs on the merged tree (the cross-AP safety net).
         *
         * Kill-switch DEFAULT FALSE ⇒ BYTE-IDENTICAL off: the executor takes today's sequential
         * single-worktree path and never reads any `ap.dependsOn`. Gated by the parent
         * `consiliumLoop.enabled` AND `implement.enabled`. Independent of verification — it
         * changes only HOW the round's coders are fanned out, not WHAT each AP does.
         */
        parallel: z.object({
          /** Kill-switch: false (default) → today's sequential develop (byte-identical). */
          enabled: z.boolean().default(false),
          /**
           * Max action points executing CONCURRENTLY within one wave (worktree fan-out
           * ceiling — adversarial risk e: bounds disk + CPU + coder processes). 1..8;
           * default 3. 1 ⇒ still wave-ordered but one-at-a-time. NaN/out-of-range fails load.
           */
          maxConcurrency: z.coerce.number().int().min(1).max(8).default(3),
        }).default({}),
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

/** The `consiliumLoop.implement` config block (source of the global keys + `perRepo`). */
type ImplementConfig = AppConfig["pipeline"]["consiliumLoop"]["implement"];

/**
 * The EFFECTIVE implement command set for a SINGLE loop's repo, after folding any
 * per-repo override over the global implement keys. Shape mirrors exactly the four
 * fields the controller threads into the SDLC request, keeping their existing types
 * so a threaded value is byte-identical to reading the global key directly.
 */
export interface EffectiveImplementCommands {
  /** Operator test-command override; null ⇒ the executor auto-detects from package.json. */
  testCommand: string | null;
  /** Optional lint/format command; null ⇒ no lint run. */
  lintCommand: string | null;
  /** Hard per-run test timeout (ms), already clamped by the schema. */
  testRunTimeoutMs: number;
  /** Operator-pinned coder model slug; undefined ⇒ the coder CLI's own default model. */
  coderModel: string | undefined;
}

/** Strip trailing slashes for path-boundary comparison (never touches a bare "/"). */
function stripTrailingSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/**
 * Select the per-repo override entry that applies to `repoPath`: EXACT key match
 * first, else the LONGEST configured key that is a path-boundary prefix of `repoPath`
 * (so a parent-dir entry covers a whole tree, and the more specific key wins on ties).
 * Pure + lexical — no fs, no realpath — because operators key `perRepo` with the SAME
 * absolute path strings they use for `allowedRepoPaths`. Returns undefined when no key
 * matches ⇒ the caller falls back to the global keys (today's behavior).
 */
export function selectPerRepoOverride(
  repoPath: string,
  perRepo: ImplementConfig["perRepo"] | undefined,
): ImplementConfig["perRepo"][string] | undefined {
  if (!perRepo) return undefined;
  // Exact key match (raw first, then trailing-slash-normalized) wins outright.
  if (Object.prototype.hasOwnProperty.call(perRepo, repoPath)) return perRepo[repoPath];
  const target = stripTrailingSlash(repoPath);
  let best: string | undefined;
  let bestLen = -1;
  for (const key of Object.keys(perRepo)) {
    const k = stripTrailingSlash(key);
    if (k === target) return perRepo[key]; // exact after normalization
    // Path-boundary prefix: target is strictly nested under k (never a substring match).
    if (target.startsWith(k + "/") && k.length > bestLen) {
      best = key;
      bestLen = k.length;
    }
  }
  return best !== undefined ? perRepo[best] : undefined;
}

/**
 * Resolve the EFFECTIVE implement command set for a loop's `repoPath`. Precedence per
 * field: the matched per-repo override value → else the global implement key → else
 * today's default. `undefined` on an override field means "inherit the global"; an
 * explicit `null` (testCommand/lintCommand) means "no command" and DOES override.
 *
 * BACKWARD-COMPAT CONTRACT: when no per-repo entry matches (or `perRepo` is empty),
 * the result is byte-identical to reading the global keys directly — so a config with
 * no `perRepo` produces exactly today's SDLC request.
 */
export function resolveImplementForRepo(
  repoPath: string,
  implement: ImplementConfig,
): EffectiveImplementCommands {
  const base: EffectiveImplementCommands = {
    testCommand: implement.testCommand,
    lintCommand: implement.lintCommand ?? null,
    testRunTimeoutMs: implement.testRunTimeoutMs,
    coderModel: implement.coderModel,
  };
  const o = selectPerRepoOverride(repoPath, implement.perRepo);
  if (!o) return base;
  return {
    testCommand: o.testCommand !== undefined ? o.testCommand : base.testCommand,
    lintCommand: o.lintCommand !== undefined ? o.lintCommand : base.lintCommand,
    testRunTimeoutMs: o.testRunTimeoutMs !== undefined ? o.testRunTimeoutMs : base.testRunTimeoutMs,
    coderModel: o.coderModel !== undefined ? o.coderModel : base.coderModel,
  };
}

import type { Express, Router } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { Gateway } from "./gateway/index";
import { reconcileModelCatalog } from "./gateway/catalog-sync";
import { WsManager } from "./ws/manager";
import { registerModelRoutes } from "./routes/models";
import { registerChatRoutes } from "./routes/chat";
import { registerGatewayRoutes } from "./routes/gateway";
import { registerPrivacyRoutes } from "./routes/privacy";
import { registerStatsRoutes } from "./routes/stats";
import { registerTelemetryRoutes } from "./routes/telemetry";
import { registerLessonRoutes } from "./routes/lessons";
import { registerToolRoutes } from "./routes/tools";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerAuthRoutes } from "./routes/auth";
import { registerSandboxRoutes } from "./routes/sandbox";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSpecializationRoutes } from "./routes/specialization";
import { registerSkillRoutes } from "./routes/skills";
import { registerActivityRoutes } from "./routes/activity";
import { registerTriggerRoutes } from "./routes/triggers";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerHealthRoutes } from "./routes/health";
import { registerLmStudioRoutes } from "./routes/lmstudio";
import { TriggerService } from "./services/trigger-service";
import { CronScheduler } from "./services/cron-scheduler";
import { FileWatcherService } from "./services/file-watcher";
import { GitHubPoller } from "./services/github-poller";
import { GithubIssuesPoller } from "./services/consilium/trackers/github-issues-poller";
import { JiraIssuesPoller } from "./services/consilium/trackers/jira-issues-poller";
import { GitlabIssuesPoller } from "./services/consilium/trackers/gitlab-issues-poller";
import { BitbucketIssuesPoller } from "./services/consilium/trackers/bitbucket-issues-poller";
import { LinearIssuesPoller } from "./services/consilium/trackers/linear-issues-poller";
import { AzureIssuesPoller } from "./services/consilium/trackers/azure-issues-poller";
import { ClickUpIssuesPoller } from "./services/consilium/trackers/clickup-issues-poller";
import { TrackerWritebackObserver } from "./services/consilium/trackers/writeback-observer";
import { GithubCommandPoller } from "./services/consilium/trackers/github-command-poller";
import { ExperienceDistillerObserver } from "./services/consilium/experience/experience-distiller-observer";
import { ExperienceConsolidatorObserver } from "./services/consilium/experience/experience-consolidator-observer";
import { SkillProposerObserver } from "./services/consilium/experience/skill-proposer-observer";
import { registerSkillProposalRoutes } from "./routes/skill-proposals";
import { buildSynthPrompt, parseSynthOutput } from "./services/consilium/trackers/issue-spec";
import { DEFAULT_TASK_MODEL } from "./config/schema";
import { stopRateLimitCleanup } from "./services/webhook-handler";
import { requireAuth } from "./auth/middleware";
import { requireProject } from "./middleware/project";
import { DEFAULT_MODELS } from "@shared/constants";
import { projects } from "@shared/schema";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { log } from "./index";
import { registerArgoCdSettingsRoutes, autoConnectArgoCdFromEnv } from "./routes/argocd-settings";
import { registerTaskGroupRoutes } from "./routes/task-groups";
import { registerTaskGroupResolveRoute } from "./routes/task-group-resolve";
import { registerConsiliumLoopRoutes } from "./routes/consilium-loops";
import { registerConsiliumReviewRoutes } from "./routes/consilium-reviews";
import { registerConsultRoutes } from "./routes/consult";
import { WorkspaceManager } from "./workspace/manager";
import { registerStandingRoleRoutes } from "./routes/standing-roles";
import { createConsiliumReview } from "./services/consilium/review-factory";
import { maybeLaunchConsiliumReview, maybeLaunchGitHubReview, maybeLaunchGitLabReview, maybeLaunchRoleWake, resolveSpecWatchConfig, deriveRepoRoot, launchTicketReview } from "./services/consilium/trigger-dispatch";
import { ConsiliumLoopController, ConsiliumLoopPoller } from "./services/consilium/consilium-loop-controller";
import {
  writeSpecStatusRemote,
  specStatusForTerminalLoop,
  type SpecStatusValue,
} from "./services/consilium/spec-status-writer";
import { registerModelSkillBindingRoutes } from "./routes/model-skill-bindings";
import { registerTaskTraceRoutes } from "./routes/task-traces";
import { registerTaskIterationRoutes } from "./routes/task-iterations";
import { registerTrackerRoutes } from "./routes/tracker";
import { registerCredentialRoutes } from "./routes/credentials";
import { expireStaleLeases } from "./credentials/db-crypto-provider";
import { TaskOrchestrator } from "./services/task-orchestrator";
import { TaskTracer } from "./services/task-tracer";
import { TaskSplitter } from "./services/task-splitter";
import { TrackerSyncService } from "./services/tracker-sync";
import { RemoteAgentManager } from "./remote-agents/remote-agent-manager";
import { registerRemoteAgentRoutes } from "./routes/remote-agents";
import { registerFederationRoutes, registerCRDTRoutes, registerConfigConflictRoutes, registerConfigSyncStatusRoute } from "./routes/federation";
import { registerConnectionRoutes } from "./routes/connections";
import { registerConnectionsYamlRoutes } from "./routes/connections-yaml";
import { registerInventoryRoutes } from "./routes/inventory";
import { registerWorkspaceTraceRoutes } from "./routes/workspace-traces";
import { registerCostRoutes } from "./routes/costs";
import { registerWorkspaceToolRoutes } from "./routes/workspace-tools";
import { registerMcpRoutes } from "./routes/mcp";
import { registerKnowledgeRoutes } from "./routes/knowledge";
import { registerPracticeCardRoutes } from "./routes/practice-cards";
import { buildPracticeCardDeps } from "./knowledge/practice-card-deps";
import { initRefreshScheduler, getRefreshScheduler } from "./knowledge/refresh-scheduler";
import { configLoader as appConfigLoader } from "./config/loader";
import { seedExampleTerraformCards, resolveFirstAdminUserId } from "./knowledge/seed-terraform-cards";
import { SessionSharingService } from "./federation/session-sharing";
import { InMemoryConflictStore } from "./federation/config-conflict";
import { ConflictResolutionService } from "./federation/conflict-resolution";
import { getFederationManager } from "./federation/manager-state";
import { runAsSystem, runAsProject } from "./context";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Initialize core systems
  // Pass storage so WsManager.subscribe can enforce per-run ownership (IDOR fix).
  const wsManager = new WsManager(httpServer, storage);
  const gateway = new Gateway(storage);

  // Register public routes (no auth required) — must come before requireAuth middleware
  registerHealthRoutes(app);

  // Register auth routes (public routes included)
  registerAuthRoutes(app);
  const projectRoutes = (await import("./routes/projects")).default;
  app.use("/api/projects", projectRoutes);

  // Register protected route groups — all require authentication.
  //
  // Project-scoped routes (requireAuth + requireProject):
  //   requireProject reads x-project-id, validates owner/member, sets ALS context.
  //   Keep /api/projects, auth, health, /api/teams, /api/sandbox, /api/federation public
  //   (i.e. requireAuth only or no auth) because they must work without a project context.
  //
  // UNCERTAIN routes that were scoped conservatively (per ADR-001 §3.1b "when unsure, scope it"):
  //   /api/models    — models have optional projectId; global catalog seeded without project
  //   /api/gateway   — uses project-specific provider keys after PR-0c
  //   /api/lessons   — workspace-scoped (workspaceId), not directly project-scoped
  //   /api/lmstudio  — local server config; import creates project-scoped models

  // ── Project-scoped (requireAuth + requireProject) ──────────────────────────
  app.use("/api/activity", requireAuth, requireProject);
  app.use("/api/models", requireAuth, requireProject);         // UNCERTAIN — see note above
  app.use("/api/gateway", requireAuth, requireProject);        // UNCERTAIN — see note above
  app.use("/api/settings", requireAuth, requireProject);
  app.use("/api/workspaces", requireAuth, requireProject);
  app.use("/api/chat", requireAuth, requireProject);
  app.use("/api/questions", requireAuth, requireProject);
  app.use("/api/stats", requireAuth, requireProject);
  app.use("/api/privacy", requireAuth, requireProject);
  app.use("/api/lessons", requireAuth, requireProject);        // UNCERTAIN — see note above
  app.use("/api/tools", requireAuth, requireProject);
  app.use("/api/mcp", requireAuth, requireProject);
  app.use("/api/providers", requireAuth, requireProject);
  app.use("/api/specialization-profiles", requireAuth, requireProject);
  app.use("/api/skills", requireAuth, requireProject);
  app.use("/api/triggers", requireAuth, requireProject);
  app.use("/api/task-groups", requireAuth, requireProject);
  app.use("/api/consilium-loops", requireAuth, requireProject);
  app.use("/api/pr-queue", requireAuth, requireProject);
  // NEW prefix (Stage D — trust telemetry). Read-only, project-scoped. This mount
  // is LOAD-BEARING: without it getLoops() has no project context (500) and the
  // route is unauthenticated (the /api/pr-queue class of bug). Do not drop it.
  app.use("/api/telemetry", requireAuth, requireProject);
  app.use("/api/consilium-reviews", requireAuth, requireProject);
  app.use("/api/consult", requireAuth, requireProject);
  // DREAM-4 (experience-plane-dream §5/§9): Experience → SKILL.md feedback proposals review
  // surface. Project-scoped — the mount carries auth (the /api/pr-queue 401 lesson); the
  // routes register inside the experiencePlane.skillFeedback.enabled kill-switch. The PATCH
  // (the human/CODEOWNERS gate) is additionally requireRole(maintainer/admin) in-route.
  app.use("/api/skill-proposals", requireAuth, requireProject);
  // ROLE-1 (standing-role.md §3/§8): StandingRole CRUD + manual wake. Project-scoped
  // — the mount carries auth (the /api/pr-queue 401 lesson); the routes register
  // inside the consiliumLoop.enabled kill-switch (wake reuses the review factory).
  app.use("/api/roles", requireAuth, requireProject);
  app.use("/api/lmstudio", requireAuth, requireProject);       // UNCERTAIN — see note above
  app.use("/api/tracker-connections", requireAuth, requireProject);
  app.use("/api/remote-agents", requireAuth, requireProject);
  app.use("/api/credentials", requireAuth, requireProject);
  // /api/workspaces/:id/knowledge is already covered by /api/workspaces above;
  // keep this explicit mount for clarity and so the middleware fires even if the
  // /api/workspaces mount is ever narrowed.
  app.use("/api/workspaces/:id/knowledge", requireAuth, requireProject);

  // ── Auth-only (requireAuth, no requireProject) ─────────────────────────────
  // /api/teams — returns global SDLC team constants, not project data
  app.use("/api/teams", requireAuth);
  // /api/sandbox — Docker execution utility, no project-specific data
  app.use("/api/sandbox", requireAuth);
  // /api/federation — cross-instance infrastructure, inherently cross-project
  app.use("/api/federation", requireAuth);

  // Register route implementations
  registerModelRoutes(app, storage);
  registerChatRoutes(app, storage, gateway, wsManager);
  registerGatewayRoutes(app, gateway);
  registerPrivacyRoutes(app);
  registerStatsRoutes(app, storage);
  registerTelemetryRoutes(app, storage);
  registerLessonRoutes(app, storage);
  registerToolRoutes(app, storage);
  registerWorkspaceRoutes(app, gateway, wsManager, storage);
  registerConnectionRoutes(app, storage);
  registerConnectionsYamlRoutes(app, storage);
  registerInventoryRoutes(app, storage);
  registerWorkspaceTraceRoutes(app, storage);
  registerCostRoutes(app, storage);
  registerWorkspaceToolRoutes(app, storage);
  registerMcpRoutes(app as unknown as Router, storage);
  registerKnowledgeRoutes(app as unknown as Router, storage);  // Bug #309: was imported but not called; #358: workspace-scoped
  const knowledgeRefreshScheduler = initRefreshScheduler(storage);
  registerPracticeCardRoutes(
    app as unknown as Router,
    storage,
    buildPracticeCardDeps({
      triggerNow: (workspaceId, trigger) => knowledgeRefreshScheduler.triggerNow(workspaceId, trigger),
    }),
  );

  registerSandboxRoutes(app as unknown as Router);
  registerSettingsRoutes(app as unknown as Router, gateway);
  registerSpecializationRoutes(app, storage);
  registerModelSkillBindingRoutes(app, storage);
  registerSkillRoutes(app, storage);
  registerArgoCdSettingsRoutes(app as unknown as Router, storage);
  registerLmStudioRoutes(app as unknown as Router, storage, gateway);

  // Phase 8.9 — Remote Agent CRUD routes
  let remoteAgentManager: RemoteAgentManager | null = null;
  try {
    remoteAgentManager = new RemoteAgentManager();
    await remoteAgentManager.initialize();
    log("[remote-agents] Remote agent manager initialized", "remote-agents");
  } catch (e) {
    log(`[remote-agents] Remote agent subsystem disabled: ${(e as Error).message}`, "remote-agents");
    remoteAgentManager = null;
  }
  registerRemoteAgentRoutes(app as unknown as Router, remoteAgentManager);

  // Task Orchestrator + Tracer
  const taskTracer = new TaskTracer(storage, wsManager);
  const taskOrchestrator = new TaskOrchestrator(storage, wsManager, gateway);
  taskOrchestrator.setTracer(taskTracer);
  registerTaskGroupRoutes(app, storage, taskOrchestrator);
  registerTaskGroupResolveRoute(app);
  registerTaskIterationRoutes(app as unknown as Router, storage);

  // Consilium Loop (Phase B — auto-versioned FSM). KILL-SWITCH default FALSE:
  // the controller + routes + poller are only wired when explicitly enabled, so
  // a normal boot is fully inert. Mirrors the cron-scheduler bootstrap below.
  let consiliumLoopPoller: ConsiliumLoopPoller | null = null;
  // DREAM-1: the Experience-plane distiller observer (read-only, post-loop). KILL-SWITCH
  // default FALSE ⇒ never constructed (byte-identical). Stopped in the cleanup below.
  let experienceDistillerObserver: ExperienceDistillerObserver | null = null;
  // DREAM-3: the Experience-plane consolidator (scheduled dedup/decay/successDelta). Its
  // OWN kill-switch (consolidate.enabled), default FALSE ⇒ never constructed (byte-identical:
  // the store just accumulates + is read). Stopped in the cleanup below.
  let experienceConsolidatorObserver: ExperienceConsolidatorObserver | null = null;
  // DREAM-4: the Experience → SKILL.md feedback proposer (repeatedly-verified patterns →
  // PROPOSED SKILL.md patches into the ADR-0002 trust envelope as `unverified`). Its OWN
  // kill-switch (skillFeedback.enabled), default FALSE ⇒ never constructed (byte-identical:
  // no proposal ever opened). Stopped in the cleanup below.
  let skillProposerObserver: SkillProposerObserver | null = null;
  // Hoisted to the registerRoutes scope (was a block-local const) so the
  // file-change `fireTrigger` closure below can launch consilium reviews via the
  // SAME controller. Stays null when the kill-switch is off — fireTrigger then
  // treats a consilium_review action as an inert no-op (logs + skips).
  let consiliumLoopController: ConsiliumLoopController | null = null;
  // SPEC-2 (spec-as-task.md §4): the ONE spec-status write seam, GATED behind
  // spec-watch. BOTH lifecycle flips route through here — the launch flip
  // (`ready → in-progress`, via the trigger dispatch) and the terminal flip
  // (`in-progress → blocked`, via the loop controller) — so the kill-switch is
  // enforced in a SINGLE place and the write is BEST-EFFORT + never-throw. When
  // spec-watch is OFF, this returns immediately: no `gh` call, no commit, byte-
  // identical to before. It commits REMOTELY (never the operator's local tree).
  const flipSpecStatus = async (args: {
    specPath: string;
    specRepoPath: string;
    from: SpecStatusValue;
    to: SpecStatusValue;
    reason?: string;
  }): Promise<void> => {
    if (!resolveSpecWatchConfig(appConfigLoader.get()).enabled) return; // kill-switch OFF ⇒ no write.
    const res = await writeSpecStatusRemote(
      { log: (m) => log(m, "triggers") },
      { specRepoPath: args.specRepoPath, specPath: args.specPath, expectedFrom: args.from, to: args.to, reason: args.reason },
    );
    if (!res.ok) {
      log(`[spec-status] ${args.from}->${args.to} not written for ${args.specPath}: ${res.reason}`, "triggers");
    }
  };
  if (appConfigLoader.get().pipeline.consiliumLoop.enabled) {
    consiliumLoopController = new ConsiliumLoopController({
      storage,
      taskOrchestrator,
      config: () => appConfigLoader.get(),
      // Stage 1 (§6): the OUT-OF-BAND intent→archetype planner calls the model via
      // the SAME gateway path direct_llm tasks use. Structurally satisfies
      // PlannerGateway; the planner is also gated by consiliumLoop.planner.enabled.
      gateway,
      // §14.4: the DEVELOPING→AWAITING_MERGE close-out runs the SDLC executor
      // (isolated worktree + agentic coder + Draft PR) by default — no manager
      // seam needed here. Push/PR go through pr-wrapper (B-3/H-6/H-7/M-6/M-7).
      //
      // SPEC-2 (§4): on a SPEC-FIRED loop reaching a TERMINAL state, flip the spec's
      // `status:`. `converged` leaves it `in-progress` (the code PR is the next gate,
      // spec→done comes from the merge — reconcileSpecStatusOnPrMerge); a stalled
      // terminal (`failed`/`stopped_cap`/`escalated`/`cancelled`) → `blocked` so it
      // does NOT re-fire the watch trigger (only `ready` fires). CAS-guarded on
      // `in-progress`, so a spec a human already moved is never clobbered.
      onSpecLoopTerminal: async (loop, terminalState) => {
        const specPath = loop.triggerProvenance?.spec?.specPath;
        if (!specPath) return;
        const target = specStatusForTerminalLoop(terminalState);
        if (!target) return; // converged / non-terminal → leave in-progress.
        const specRepoPath = deriveRepoRoot(specPath);
        if (!specRepoPath) return;
        await flipSpecStatus({ specPath, specRepoPath, from: "in-progress", to: target.to, reason: target.reason });
      },
    });
    registerConsiliumLoopRoutes(
      app,
      storage,
      consiliumLoopController,
      () => appConfigLoader.get(),
      taskOrchestrator,
    );
    // POST /api/consilium-reviews — the UI "New consilium review" button. Same
    // factory + same fail-closed allowlist as the trigger path. Registered ONLY
    // inside the kill-switch block (inert otherwise), mounted behind
    // requireAuth + requireProject above.
    registerConsiliumReviewRoutes(app, {
      storage,
      orchestrator: taskOrchestrator,
      controller: consiliumLoopController,
      config: () => appConfigLoader.get(),
      // "Magic mode" reformulate endpoint uses the SAME gateway path (completeStreaming)
      // direct_llm/planner use. Gated by consiliumLoop.reformulate.enabled in the route.
      gateway,
    });
    // Consult — standalone multi-model Q&A. Registered inside the SAME kill-switch
    // (its step-3 handoff reuses the `createConsiliumReview` factory), given the same
    // review deps + the gateway (answer/debate) + wsManager (repo → workspace).
    const consultWorkspaceManager = new WorkspaceManager();
    registerConsultRoutes(app, {
      storage,
      gateway,
      reviewDeps: {
        storage,
        orchestrator: taskOrchestrator,
        controller: consiliumLoopController,
        config: () => appConfigLoader.get(),
        gateway,
      },
      connectWorkspace: (repoPath: string) =>
        consultWorkspaceManager.connectLocal(repoPath),
    });
    // ROLE-1 — StandingRole CRUD + manual wake. Registered inside the SAME kill-switch
    // (inert otherwise) and given the SAME deps as the review routes: wake reuses the
    // `createConsiliumReview` factory (no reimplemented loop creation; dispatch untouched).
    registerStandingRoleRoutes(app, {
      storage,
      orchestrator: taskOrchestrator,
      controller: consiliumLoopController,
      config: () => appConfigLoader.get(),
      gateway,
    });
    // NOTE: the standalone POST /api/task-groups/:groupId/execute-sdlc surface was
    // REMOVED — "execute a verdict's action points" is now the consilium loop's own
    // visible DEVELOPING phase, re-openable on a terminal loop via
    // POST /api/consilium-loops/:id/develop (registered above). It runs the SAME
    // `runSdlcHandoff` executor; nothing else feeds it.
    consiliumLoopPoller = new ConsiliumLoopPoller(
      consiliumLoopController,
      storage,
      appConfigLoader.get().pipeline.consiliumLoop.pollIntervalMs,
    );
    consiliumLoopPoller.start();
    log("[consilium-loop] enabled — controller + poller started", "consilium-loop");
  }

  // DREAM-1 — Experience-plane distiller (WRITE side). When the kill-switch is on, a
  // background READ-ONLY observer sweeps TERMINAL consilium loops (across all projects)
  // and distils each one's already-persisted trail into verification-grounded items in
  // `experience_items`. It NEVER touches the loop controller (observe-only, like TRACK-2)
  // and is idempotent (a loop distilled once). No read path yet (DREAM-2). Default OFF ⇒
  // NOT constructed ⇒ byte-identical (no distiller, no rows).
  if (appConfigLoader.get().pipeline.consiliumLoop.experiencePlane.enabled) {
    experienceDistillerObserver = new ExperienceDistillerObserver({
      // Cross-project reads/writes run under ONE system context per pass (runAsSystem
      // audits the access; getLoops/getLoopRounds then return all projects' rows).
      runInSystem: (fn) => runAsSystem("experience-distiller", fn),
      getLoops: () => storage.getLoops(),
      getLoopRounds: (loopId) => storage.getLoopRounds(loopId),
      getExperienceItemsBySourceLoop: (loopId) => storage.getExperienceItemsBySourceLoop(loopId),
      createExperienceItems: (items) => storage.createExperienceItems(items),
      config: () => appConfigLoader.get(),
      log: (m: string) => log(m, "experience-distiller"),
    });
    experienceDistillerObserver.start();
    log("[experience-distiller] enabled — post-loop distiller observer started", "experience-distiller");
  }

  // DREAM-3 — Experience-plane CONSOLIDATION (the "global profile", §4/§6). When its
  // OWN kill-switch is on, a background, SCHEDULED consolidator re-reads a bounded window
  // of recent items and MERGES duplicates, DECAYS stale `verified` items to `observed`
  // (written back — the store self-corrects, §6), flags verified↔refuted CONTRADICTIONS
  // (keeps both, fresher-verified leads), and recomputes `successDelta` from any reuse
  // signal. It NEVER touches the loop controller (off the hot path, like DREAM-1) and
  // writes ONLY to `experience_items` (never state, never SKILL.md — DREAM-4 owns that).
  // Default OFF ⇒ NOT constructed ⇒ byte-identical (no merge/decay; the store accumulates).
  if (appConfigLoader.get().pipeline.consiliumLoop.experiencePlane.consolidate.enabled) {
    experienceConsolidatorObserver = new ExperienceConsolidatorObserver({
      // Cross-project reads/writes run under ONE system context per pass (runAsSystem
      // audits the access; listExperienceItems then returns all projects' rows and the
      // update/delete resolve cross-project — merges never cross projects: the pure
      // consolidator keys groups by projectId).
      runInSystem: (fn) => runAsSystem("experience-consolidator", fn),
      listExperienceItems: (limit) => storage.listExperienceItems(limit),
      updateExperienceItem: (id, patch) => storage.updateExperienceItem(id, patch),
      deleteExperienceItems: (ids) => storage.deleteExperienceItems(ids),
      config: () => appConfigLoader.get(),
      log: (m: string) => log(m, "experience-consolidator"),
    });
    experienceConsolidatorObserver.start();
    log("[experience-consolidator] enabled — scheduled consolidation observer started", "experience-consolidator");
  }

  // DREAM-4 — Experience → SKILL.md FEEDBACK (§5 Experience ≠ Skill / §9). When its OWN
  // kill-switch is on, a background, SCHEDULED proposer re-reads recent Experience items and,
  // for a pattern REPEATEDLY `verified` across >= minVerifiedLoops independent loops with a
  // positive MEASURED successDelta on a skill-mapped scope, opens ONE PROPOSED SKILL.md patch
  // into the ADR-0002 trust envelope as `unverified`. PROPOSE-ONLY: it writes ONLY the
  // `skill_proposals` table — it NEVER edits a SKILL.md, graduates a patch, writes
  // experience_items, or touches the state graph. Every forward status move is a human/
  // CODEOWNERS decision via the review routes (registered here, PATCH gated maintainer/admin).
  // Default OFF ⇒ NOT constructed + routes NOT registered ⇒ byte-identical (no proposals).
  if (appConfigLoader.get().pipeline.consiliumLoop.experiencePlane.skillFeedback.enabled) {
    skillProposerObserver = new SkillProposerObserver({
      // Cross-project reads/writes run under ONE system context per pass (runAsSystem audits
      // the access; listExperienceItems returns all projects' rows; the insert resolves
      // cross-project — the pure proposer keys candidates by projectId).
      runInSystem: (fn) => runAsSystem("skill-proposer", fn),
      listExperienceItems: (limit) => storage.listExperienceItems(limit),
      listSkillProposalDedupKeys: () => storage.listSkillProposalDedupKeys(),
      createSkillProposals: (items) => storage.createSkillProposals(items),
      getSkillIdByName: (name) => storage.getSkillIdByName(name),
      config: () => appConfigLoader.get(),
      log: (m: string) => log(m, "skill-proposer"),
    });
    skillProposerObserver.start();
    // The human/CODEOWNERS review gate — list + PATCH-status. Registered ONLY inside the
    // kill-switch (inert otherwise), mounted behind requireAuth + requireProject above.
    registerSkillProposalRoutes(app, storage);
    log("[skill-proposer] enabled — scheduled skill-feedback proposer + review routes started", "skill-proposer");
  }

  // Live Activity observability lens (read-only, owner/admin-scoped, metadata-only).
  // Registered AFTER the task orchestrator so task-groups can join the live snapshot
  // (and the History tab).
  registerActivityRoutes(app, storage, {
    taskOrchestrator,
  });
  registerTaskTraceRoutes(app, storage);

  // Tracker Integration
  const taskSplitter = new TaskSplitter(gateway);
  const trackerSync = new TrackerSyncService(storage);
  registerTrackerRoutes(app, storage, taskSplitter, trackerSync, taskOrchestrator);

  // ADR-001 Phase 1 — Credential broker read-only UI endpoints
  registerCredentialRoutes(app);

  // ADR-001 Wave-2: credential lease sweeper — runs every 60s as system context.
  // Marks leases with expiresAt < now() as expired regardless of backend state.
  const leaseSweeper = setInterval(async () => {
    try {
      const count = await runAsSystem("lease-sweeper", () => expireStaleLeases());
      if (count > 0) {
        log(`[credential-broker] sweeper expired ${count} stale lease(s)`, "sweeper");
      }
    } catch (e) {
      log(`[credential-broker] sweeper error: ${(e as Error).message}`, "sweeper");
    }
  }, 60_000);

  // Phase 6.3 — Trigger subsystem
  let triggerService: TriggerService | null = null;
  let webhookRoutesRegistered = false;
  let cronScheduler: CronScheduler | null = null;
  let fileWatcherService: FileWatcherService | null = null;
  let githubPoller: GitHubPoller | null = null;
  let githubIssuesPoller: GithubIssuesPoller | null = null;
  let jiraIssuesPoller: JiraIssuesPoller | null = null;
  let gitlabIssuesPoller: GitlabIssuesPoller | null = null;
  let bitbucketIssuesPoller: BitbucketIssuesPoller | null = null;
  let linearIssuesPoller: LinearIssuesPoller | null = null;
  let azureIssuesPoller: AzureIssuesPoller | null = null;
  let clickupIssuesPoller: ClickUpIssuesPoller | null = null;
  let trackerWritebackObserver: TrackerWritebackObserver | null = null;
  let githubCommandPoller: GithubCommandPoller | null = null;

  try {
    triggerService = new TriggerService(storage);

    // fireTrigger is called from background contexts (cron, file watcher, GitHub events)
    // where no project ALS context is established. runAsSystem audits the access and
    // allows withProject to operate cross-project (no project filter applied in system
    // context). getPipeline validates the pipeline still exists; updateTrigger records
    // the last-fired timestamp. Both operate cross-project in system context.
    const fireTrigger = async (
      trigger: import("@shared/schema").TriggerRow,
      payload: unknown,
    ): Promise<import("./services/consilium/trigger-dispatch").TriggerFireResult> => {
      return runAsSystem("fire-trigger", async () => {
        // T1 RETARGET: a trigger fires a CONSILIUM LOOP (loop template in config),
        // not a (deleted) pipeline run. pipelineId is now NULLABLE — a loop-template
        // trigger has none. We NO LONGER gate on a pipeline lookup (that made every
        // pipeline-less trigger a permanent no-op). ALWAYS record lastTriggeredAt
        // first — for EVERY trigger type, action or not — so a fire is diagnosable
        // even when the dispatch below suppresses/skips.
        await storage.updateTrigger(trigger.id, { lastTriggeredAt: new Date() });
        log(`[triggers] Fired trigger ${trigger.id} (type ${trigger.type})`, "triggers");

        // ROLE-2: is this the BACKING trigger of a Standing Role's concern? (config
        // carries `roleConcern`). A role wake is a NEW autonomous behaviour → it is
        // gated by the SAME master switch as schedule/github below, regardless of the
        // underlying trigger class (so a role-bound file_change also requires the
        // switch — default-off until an operator both defines a concern AND flips it).
        const roleBinding = (trigger.config as { roleConcern?: unknown } | null)?.roleConcern;

        // T1 KILL-SWITCH (loop-triggers.md §4.5): a SCHEDULE / GITHUB_EVENT trigger, or
        // ANY role-bound trigger (ROLE-2), only fires a loop when
        // `features.triggers.enabled` is on — a running server never silently starts
        // firing scheduled / github-event / role-wake loops. The pre-existing NON-role
        // file_change binding is NOT gated here (it stays under consiliumLoop.enabled),
        // so the one live prototype binding is unchanged.
        if (
          (trigger.type === "schedule" ||
            trigger.type === "github_event" ||
            trigger.type === "gitlab_event" ||
            roleBinding) &&
          !appConfigLoader.get().features.triggers.enabled
        ) {
          log(`[triggers] ${trigger.type} trigger ${trigger.id} not fired — features.triggers.enabled is off`, "triggers");
          return "recorded" as const;
        }

        // gitlab_event has its OWN opt-in flag on top of the master switch above —
        // a brand-new externally-reachable endpoint (/api/gitlab-events) defaults to
        // off even once features.triggers.enabled is flipped on, so an operator must
        // explicitly enable GitLab event triggers.
        if (
          trigger.type === "gitlab_event" &&
          !appConfigLoader.get().features.triggers.gitlabEvents?.enabled
        ) {
          log(`[triggers] gitlab_event trigger ${trigger.id} not fired — features.triggers.gitlabEvents.enabled is off`, "triggers");
          return "recorded" as const;
        }

        // ── Loop-template dispatch ───────────────────────────────────────────────
        // github_event ⇒ event→review mapping (PR head diff / post-merge review) via
        // maybeLaunchGitHubReview. Everything else: ABSENT action ⇒ record-only no-op
        // (back-compat for webhook / action-less triggers); present + consilium_review
        // ⇒ launch via the SAME factory the HTTP route uses. BOTH paths share the
        // dedup/owner/factory core: untrusted payload strings reach ONLY the factory's
        // sanitized objective seam (engineerInstruction / objectiveExtra); repoPath is
        // re-validated against the fail-closed allowlist + the project's workspaces
        // INSIDE the factory. `reviewDeps: null` (kill-switch off) ⇒ skipped. The launch
        // runs under runAsProject so all rows stay project-scoped.
        const dispatchDeps = {
          reviewDeps: consiliumLoopController
            ? {
                storage,
                orchestrator: taskOrchestrator,
                controller: consiliumLoopController,
                config: () => appConfigLoader.get(),
              }
            : null,
          createReview: createConsiliumReview,
          runInProject: runAsProject,
          // FK FIX: a trigger-launched review has no req.user; task_groups.created_by
          // is an FK to users.id, so the old literal "system" violated the FK. Resolve
          // the PROJECT OWNER (projects.ownerId, notNull). Run under runAsSystem so the
          // lookup is NOT project-scoped away (fireTrigger is a cross-project system ctx).
          resolveOwnerId: (projectId: string) =>
            runAsSystem("resolve-trigger-owner", async () => {
              const [row] = await db
                .select({ ownerId: projects.ownerId })
                .from(projects)
                .where(eq(projects.id, projectId));
              return row?.ownerId ?? null;
            }),
          // WRITE-on-fire (bug fix): when a loop is ACTUALLY created, record the fire
          // on the trigger row (lastFiredAt + firedCount). Runs in THIS runAsSystem
          // context (cross-project), mirroring the suppressed-count write below —
          // fireTrigger is a background/system ctx with no request project scope.
          recordFire: (triggerId: string, firedAt: Date) =>
            storage.incrementTriggerFired(triggerId, firedAt),
          // SPEC-1 (spec-as-task.md §3): the spec-watch config, master-gated HERE so
          // the dispatch sees ONE boolean. `resolveSpecWatchConfig` folds the master
          // trigger switch (features.triggers.enabled) AND the spec-watch kill-switch —
          // either off ⇒ the spec pre-check is skipped and the file_change dispatch is
          // byte-identical. The parent consiliumLoop.enabled gate is enforced downstream
          // (reviewDeps null). The fold lives in one tested helper (see its unit test).
          specWatch: () => resolveSpecWatchConfig(appConfigLoader.get()),
          // SPEC-2 (§4): flip a just-launched spec `ready → in-progress`. The shared
          // `flipSpecStatus` helper is spec-watch-gated + best-effort + never-throw, so
          // a status-commit hiccup can never turn a real loop launch into a failure. The
          // dispatch only calls it on a genuine `launched` (not dedup/skip), from inside
          // the spec path (which itself runs only when spec-watch is enabled).
          flipSpecStatus,
          log: (m: string) => log(m, "triggers"),
        };

        // ROLE-2: a role-bound trigger WAKES the role (compose the loop from the role)
        // instead of the legacy action — a single new seam that reuses the SAME
        // dedup/owner/factory core. A trigger with NO role binding is byte-identical to
        // before (the roleBinding branch is never taken).
        const result = roleBinding
          ? await maybeLaunchRoleWake(dispatchDeps, trigger, payload)
          : trigger.type === "github_event"
            ? await maybeLaunchGitHubReview(dispatchDeps, trigger, payload)
            : trigger.type === "gitlab_event"
              ? await maybeLaunchGitLabReview(dispatchDeps, trigger, payload)
              : await maybeLaunchConsiliumReview(dispatchDeps, trigger, payload);

        // T1 policy rail (§4): a fire suppressed by a rail bumps the trigger's
        // suppressed counter (surfaced on the triggers page) instead of blindly
        // creating a second active loop. ROLE-2 adds the per-role budget/cascade rails
        // alongside dedup — all three count as suppressed.
        if (result === "skipped-dedup" || result === "skipped-budget" || result === "skipped-cascade") {
          await storage.incrementTriggerSuppressed(trigger.id);
        }
        // The github POLLER reads this result to decide whether to advance its
        // watermark (it holds on "skipped-dedup" → retries next cycle). Other
        // callers (cron / file watcher / webhook receiver) ignore the return.
        return result;
      });
    };

    // VETO-1 fix: pass storage as third argument so routes can look up pipeline ownership
    registerTriggerRoutes(app, triggerService, storage);
    registerWebhookRoutes(app, storage, triggerService, fireTrigger);
    webhookRoutesRegistered = true;

    // Use getAllEnabledTriggersByType (cross-project, system-context) wrapped in
    // runAsSystem so the scheduler can load triggers across ALL projects at bootstrap.
    cronScheduler = new CronScheduler({
      getEnabledTriggersByType: (type) =>
        runAsSystem("cron-scheduler-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
      fireTrigger,
    });
    await cronScheduler.bootstrap();

    // Active Knowledge Base — weekly practice-card refresh (cadence; no auto-commit).
    await knowledgeRefreshScheduler.start();

    fileWatcherService = new FileWatcherService({
      getEnabledTriggersByType: (type) =>
        runAsSystem("file-watcher-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
      fireTrigger,
    });
    await fileWatcherService.bootstrap();

    // github-trigger-polling: a LOCAL daemon behind NAT can NEVER receive a GitHub
    // webhook, so an enabled github_event trigger silently never fires. When the
    // kill-switch (features.triggers.githubPolling.enabled) is on, the poller PULLS
    // from GitHub via the `gh` CLI and fires matching triggers through the SAME
    // `fireTrigger` seam the webhook receiver uses. Default OFF → not constructed.
    if (appConfigLoader.get().features.triggers.githubPolling.enabled) {
      githubPoller = new GitHubPoller({
        // The ONLY cross-project read — under runAsSystem (unscopedSystemQuery).
        getEnabledTriggersByType: (type) =>
          runAsSystem("github-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        // Per-trigger storage runs INSIDE runAsProject(trigger.projectId) below
        // (project isolation) — these deps are plain; the poller owns the context.
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        fireTrigger,
        config: () => appConfigLoader.get(),
        log: (m: string) => log(m, "github-poller"),
      });
      githubPoller.start();
    }

    // TRACK-1 (github-issues -> committed spec PR). When the tracker kill-switch is
    // on, a poller PULLS a repo's ISSUES via `gh` and, for each labelled + spec-ready
    // issue, opens a committed-spec PR (SPEC-1's spec-watch fires the loop on merge)
    // + a pickup comment. It NEVER fires a loop itself and never mutates the
    // operator's working tree (all writes go through `gh api`). Default OFF -> not
    // constructed. Also folded under the master features.triggers.enabled at poll time.
    if (appConfigLoader.get().features.triggers.tracker.enabled) {
      githubIssuesPoller = new GithubIssuesPoller({
        // The ONLY cross-project read — under runAsSystem (unscopedSystemQuery).
        getEnabledTriggersByType: (type) =>
          runAsSystem("tracker-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        // Per-trigger storage runs INSIDE runAsProject(trigger.projectId).
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        // TRACK-6 (standing-role.md §5): project-scoped role load so a tracker trigger
        // bound to a Standing Role's concern STAMPS the role's name + skills into the
        // crystallised spec (undefined roleConcern ⇒ no stamp — byte-identical TRACK-1).
        getStandingRole: (id) => storage.getStandingRole(id),
        // Gateway-backed synthesiser for FREE-FORM issues (no spec-shaped body). Any
        // error degrades to no-criteria (never throws into the poll loop) -> the poller
        // posts an ask-for-criteria comment instead of opening a spec PR.
        synthesizer: {
          synthesize: async (issue) => {
            try {
              const { system, user } = buildSynthPrompt(issue);
              const res = await gateway.completeStreaming(
                {
                  modelSlug: DEFAULT_TASK_MODEL,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.2,
                  maxTokens: 2048,
                },
                undefined,
                undefined,
                { overallTimeoutMs: 60_000 },
              );
              return parseSynthOutput(res.content);
            } catch {
              return { criteria: [] };
            }
          },
        },
        log: (m: string) => log(m, "tracker-poller"),
      });
      githubIssuesPoller.start();

      // TRACK-3 (jira -> committed spec PR). The Jira analogue of the github-issues
      // poller: a JQL poll of a Jira project's labelled issues, each crystallised into
      // a committed-spec PR (in the TARGET git repo — Jira has no git) + a Jira pickup
      // comment. Shares the SAME kill-switch (features.triggers.tracker.enabled) and the
      // SAME crystallise pipeline (spec-intake) as github; only the Jira dialect differs.
      // The Jira token is read from JIRA_EMAIL/JIRA_API_TOKEN at call time (fail-closed).
      // A jira-tracker trigger is a no-op here until its `tracker: "jira"` config exists.
      jiraIssuesPoller = new JiraIssuesPoller({
        getEnabledTriggersByType: (type) =>
          runAsSystem("jira-tracker-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        // Gateway-backed synthesiser for FREE-FORM tickets — connector-agnostic
        // (title+body only). Any error degrades to no-criteria (never throws into the
        // poll loop) -> the poller posts an ask-for-criteria comment instead of a PR.
        synthesizer: {
          synthesize: async (ticket) => {
            try {
              const { system, user } = buildSynthPrompt({ number: 0, title: ticket.title, body: ticket.body });
              const res = await gateway.completeStreaming(
                {
                  modelSlug: DEFAULT_TASK_MODEL,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.2,
                  maxTokens: 2048,
                },
                undefined,
                undefined,
                { overallTimeoutMs: 60_000 },
              );
              return parseSynthOutput(res.content);
            } catch {
              return { criteria: [] };
            }
          },
        },
        // ADR-004 Block A: direct intake — the ticket IS the task. Launch through the
        // SAME dedup/owner/T6 core every trigger path uses (launchTicketReview →
        // launchReviewWithDedup): per-ticket dedup anchor, provenance source={jira,key},
        // review-only (maxRounds=1). Only fires for `intakeMode: "direct"` triggers.
        launchDirect: (trigger, args) =>
          launchTicketReview(
            {
              reviewDeps: consiliumLoopController
                ? {
                    storage,
                    orchestrator: taskOrchestrator,
                    controller: consiliumLoopController,
                    config: () => appConfigLoader.get(),
                  }
                : null,
              createReview: createConsiliumReview,
              runInProject: runAsProject,
              resolveOwnerId: (projectId: string) =>
                runAsSystem("resolve-trigger-owner", async () => {
                  const [row] = await db
                    .select({ ownerId: projects.ownerId })
                    .from(projects)
                    .where(eq(projects.id, projectId));
                  return row?.ownerId ?? null;
                }),
              recordFire: (triggerId: string, firedAt: Date) =>
                storage.incrementTriggerFired(triggerId, firedAt),
              log: (m: string) => log(m, "jira-tracker-poller"),
            },
            trigger,
            args,
          ),
        log: (m: string) => log(m, "jira-tracker-poller"),
      });
      jiraIssuesPoller.start();

      // TRACK-4 (gitlab -> committed spec PR). The GitLab analogue of the jira poller: a
      // REST poll of a GitLab project's labelled issues, each crystallised into a
      // committed-spec PR (in the TARGET git repo — the spec PR still opens via `gh`) + a
      // GitLab pickup note. Shares the SAME kill-switch (features.triggers.tracker.enabled)
      // and the SAME crystallise pipeline (spec-intake) as github/jira; only the GitLab
      // dialect differs. The GitLab PAT is read from GITLAB_TOKEN at call time (fail-closed).
      // A gitlab-tracker trigger is a no-op here until its `tracker: "gitlab"` config exists.
      gitlabIssuesPoller = new GitlabIssuesPoller({
        getEnabledTriggersByType: (type) =>
          runAsSystem("gitlab-tracker-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        synthesizer: {
          synthesize: async (ticket) => {
            try {
              const { system, user } = buildSynthPrompt({ number: 0, title: ticket.title, body: ticket.body });
              const res = await gateway.completeStreaming(
                {
                  modelSlug: DEFAULT_TASK_MODEL,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.2,
                  maxTokens: 2048,
                },
                undefined,
                undefined,
                { overallTimeoutMs: 60_000 },
              );
              return parseSynthOutput(res.content);
            } catch {
              return { criteria: [] };
            }
          },
        },
        log: (m: string) => log(m, "gitlab-tracker-poller"),
      });
      gitlabIssuesPoller.start();

      // TRACK-4 (bitbucket -> committed spec PR). The Bitbucket Cloud analogue: a BBQL
      // poll of a repo's issue tracker (the consent `filter.label` matches the issue
      // COMPONENT), each crystallised into a committed-spec PR + a Bitbucket pickup
      // comment. Same kill-switch + crystallise pipeline as github/jira/gitlab; only the
      // Bitbucket dialect differs. The app password is read from BITBUCKET_USERNAME/
      // BITBUCKET_APP_PASSWORD at call time (fail-closed). A no-op until a
      // `tracker: "bitbucket"` config exists.
      bitbucketIssuesPoller = new BitbucketIssuesPoller({
        getEnabledTriggersByType: (type) =>
          runAsSystem("bitbucket-tracker-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        synthesizer: {
          synthesize: async (ticket) => {
            try {
              const { system, user } = buildSynthPrompt({ number: 0, title: ticket.title, body: ticket.body });
              const res = await gateway.completeStreaming(
                {
                  modelSlug: DEFAULT_TASK_MODEL,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.2,
                  maxTokens: 2048,
                },
                undefined,
                undefined,
                { overallTimeoutMs: 60_000 },
              );
              return parseSynthOutput(res.content);
            } catch {
              return { criteria: [] };
            }
          },
        },
        log: (m: string) => log(m, "bitbucket-tracker-poller"),
      });
      bitbucketIssuesPoller.start();
      // TRACK-5 (linear / azure / clickup -> committed spec PR). Each is the same spec
      // PRODUCER + ticket UPDATER as github/jira — a labelled/tagged ticket becomes a
      // committed-spec PR (in the TARGET git repo) + a pickup comment, firing NO loop
      // itself. They share the SAME kill-switch (features.triggers.tracker.enabled) and
      // the SAME crystallise pipeline; only the watch/read/write-back dialect differs
      // (Linear GraphQL / Azure WIQL / ClickUp REST). Tokens are read from LINEAR_API_KEY
      // / AZURE_DEVOPS_PAT / CLICKUP_API_TOKEN at call time (fail-closed). A trigger is a
      // no-op in each poller until its `tracker: "<kind>"` config exists. The synthesiser
      // is connector-agnostic (title+body only), so all three share ONE instance.
      const track5Synthesizer = {
        synthesize: async (ticket: { title: string; body: string }) => {
          try {
            const { system, user } = buildSynthPrompt({ number: 0, title: ticket.title, body: ticket.body });
            const res = await gateway.completeStreaming(
              {
                modelSlug: DEFAULT_TASK_MODEL,
                messages: [
                  { role: "system", content: system },
                  { role: "user", content: user },
                ],
                temperature: 0.2,
                maxTokens: 2048,
              },
              undefined,
              undefined,
              { overallTimeoutMs: 60_000 },
            );
            return parseSynthOutput(res.content);
          } catch {
            return { criteria: [] };
          }
        },
      };
      const track5CommonDeps = {
        getEnabledTriggersByType: (type: "tracker_event") =>
          runAsSystem("track5-tracker-poller-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        runInProject: runAsProject,
        getTrigger: (id: string) => storage.getTrigger(id),
        updateTrigger: (id: string, updates: Partial<import("@shared/schema").TriggerRow>) =>
          storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        synthesizer: track5Synthesizer,
      };

      linearIssuesPoller = new LinearIssuesPoller({
        ...track5CommonDeps,
        log: (m: string) => log(m, "linear-tracker-poller"),
      });
      linearIssuesPoller.start();

      azureIssuesPoller = new AzureIssuesPoller({
        ...track5CommonDeps,
        log: (m: string) => log(m, "azure-tracker-poller"),
      });
      azureIssuesPoller.start();

      clickupIssuesPoller = new ClickUpIssuesPoller({
        ...track5CommonDeps,
        log: (m: string) => log(m, "clickup-tracker-poller"),
      });
      clickupIssuesPoller.start();
    }

    // TRACK-2 (full write-back lifecycle). When the write-back sub-switch is on (and
    // the tracker switch above), a READ-ONLY observer polls consilium loops that
    // trace back to a tracker issue (join = the loop's `triggerProvenance.spec.source`)
    // and comments each lifecycle transition (start / verdict / PR / terminal) back on
    // the ORIGIN issue. It NEVER touches the loop controller (SPEC-2's zone) — it only
    // READS loop state via `storage.getLoops` (the Triggers page's own path) and writes
    // COMMENTS via `gh`. Default OFF -> not constructed (TRACK-1 pickup byte-identical).
    if (
      appConfigLoader.get().features.triggers.tracker.enabled &&
      appConfigLoader.get().features.triggers.tracker.writeback.enabled
    ) {
      trackerWritebackObserver = new TrackerWritebackObserver({
        // The ONLY cross-project read — under runAsSystem (unscopedSystemQuery).
        getEnabledTriggersByType: (type) =>
          runAsSystem("tracker-writeback-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        // Per-trigger loop reads run INSIDE runAsProject(trigger.projectId).
        runInProject: runAsProject,
        getLoops: () => storage.getLoops(),
        config: () => appConfigLoader.get(),
        log: (m: string) => log(m, "tracker-writeback"),
      });
      trackerWritebackObserver.start();
    }

    // TRACK-6 (task-tracker-triggers.md §8). When the commands sub-switch is on (and the
    // tracker switch), a command poller scans a repo's recent ISSUE COMMENTS for /spec
    // (force intake), /approve (mark the spec PR ready), and /stop (cancel the ticket's
    // active loop) — acting ONLY on comments authored by the ticket assignee or a repo
    // maintainer (verified via the `gh` API, fail-closed). Default OFF -> not constructed
    // (TRACK-1..5 byte-identical — no comment is ever acted on). The /stop path reaches
    // the loop controller's `cancel`; /spec reuses the SHARED github crystallise dialect.
    if (
      appConfigLoader.get().features.triggers.tracker.enabled &&
      appConfigLoader.get().features.triggers.tracker.commands.enabled &&
      consiliumLoopController
    ) {
      // Capture a non-null const so the /stop closure keeps the narrowing (a `let` is
      // not narrowed inside a closure).
      const loopControllerForCommands = consiliumLoopController;
      githubCommandPoller = new GithubCommandPoller({
        // The ONLY cross-project read — under runAsSystem (unscopedSystemQuery).
        getEnabledTriggersByType: (type) =>
          runAsSystem("tracker-command-bootstrap", () => storage.getAllEnabledTriggersByType(type)),
        // Per-trigger storage + loop reads run INSIDE runAsProject(trigger.projectId).
        runInProject: runAsProject,
        getTrigger: (id) => storage.getTrigger(id),
        updateTrigger: (id, updates) => storage.updateTrigger(id, updates),
        config: () => appConfigLoader.get(),
        allowedRepoPaths: () => appConfigLoader.get().pipeline.consiliumLoop.allowedRepoPaths,
        // TRACK-6: project-scoped role load for the /spec role stamp (same as intake).
        getStandingRole: (id) => storage.getStandingRole(id),
        // Reuse the intake poller's gateway-backed synthesiser for free-form issues on /spec.
        synthesizer: {
          synthesize: async (issue) => {
            try {
              const { system, user } = buildSynthPrompt(issue);
              const res = await gateway.completeStreaming(
                {
                  modelSlug: DEFAULT_TASK_MODEL,
                  messages: [
                    { role: "system", content: system },
                    { role: "user", content: user },
                  ],
                  temperature: 0.2,
                  maxTokens: 2048,
                },
                undefined,
                undefined,
                { overallTimeoutMs: 60_000 },
              );
              return parseSynthOutput(res.content);
            } catch {
              return { criteria: [] };
            }
          },
        },
        getLoops: () => storage.getLoops(),
        // /stop cancels via the loop controller (the SAME cancel the UI/API uses).
        cancelLoop: (loopId, opts) => loopControllerForCommands.cancel(loopId, opts),
        log: (m: string) => log(m, "tracker-commands"),
      });
      githubCommandPoller.start();
    }

    log("[triggers] Trigger subsystem started", "triggers");
  } catch (e) {
    // TriggerCrypto throws if TRIGGER_SECRET_KEY is absent — subsystem is disabled.
    // Register stub routes so the UI receives JSON instead of Express's HTML 404.
    log(`[triggers] Trigger subsystem disabled: ${(e as Error).message}`, "triggers");
    app.get("/api/triggers", (_req, res) => {
      res.status(503).json({ error: "Trigger subsystem is disabled (TRIGGER_SECRET_KEY not configured)", disabled: true });
    });
    app.use("/api/triggers/:id", (_req, res) => {
      res.status(503).json({ error: "Trigger subsystem is disabled (TRIGGER_SECRET_KEY not configured)", disabled: true });
    });
  }

  // Bug #311: Register webhook routes after trigger subsystem setup.
  // /api/github-events does not require TRIGGER_SECRET_KEY so must always be mounted.
  // When trigger subsystem is disabled, registerWebhookRoutes stubs are still needed
  // to avoid 404 on /api/github-events. Register with a no-op fireTrigger callback.
  if (!webhookRoutesRegistered) {
    const noOpFire = async () => { /* triggers disabled */ };
    registerWebhookRoutes(app, storage, {} as TriggerService, noOpFire);
  }

  // Federation services (issue #224)
  let sessionSharing: SessionSharingService | null = null;
  const fm = getFederationManager();
  if (fm && fm.isEnabled()) {
    const instanceId = fm.getPeers().length > 0 ? "local" : "primary";
    try {
      sessionSharing = new SessionSharingService(fm, storage, instanceId);
      log("[federation] Session sharing service initialized", "federation");
    } catch (e) {
      log(`[federation] Session sharing disabled: ${(e as Error).message}`, "federation");
    }
  }
  // Bug #312: ConflictResolutionService works without federation (manages in-memory state).
  // Always initialize so that session validation runs before the service-availability check.
  const conflictResolution = new ConflictResolutionService(null);
  registerFederationRoutes({
    app: app as unknown as Router,
    sessionSharing,
    federationManager: fm,
    conflictResolution,
  });
  // Bug #310: Register CRDT routes — returns 503 gracefully when crdtPeerSync is null.
  registerCRDTRoutes(app as unknown as Router, null);
  // Issue #323: Config-sync conflict management API
  const conflictStore = new InMemoryConflictStore();
  app.use("/api/federation/config-conflicts", requireAuth);
  registerConfigConflictRoutes(app as unknown as Router, conflictStore);
  // Issue #324: Config-sync aggregated status API
  app.use("/api/federation/config-sync", requireAuth);
  registerConfigSyncStatusRoute(app as unknown as Router, fm, conflictStore);

  // Graceful shutdown
  httpServer.on("close", async () => {
    // ADR-001 Wave-2: clear the credential lease sweeper first.
    clearInterval(leaseSweeper);
    cronScheduler?.stopAll();
    consiliumLoopPoller?.stop();
    experienceDistillerObserver?.stop();
    experienceConsolidatorObserver?.stop();
    skillProposerObserver?.stop();
    fileWatcherService?.stopAll();
    githubPoller?.stop();
    githubIssuesPoller?.stop();
    jiraIssuesPoller?.stop();
    gitlabIssuesPoller?.stop();
    bitbucketIssuesPoller?.stop();
    linearIssuesPoller?.stop();
    azureIssuesPoller?.stop();
    clickupIssuesPoller?.stop();
    trackerWritebackObserver?.stop();
    githubCommandPoller?.stop();
    getRefreshScheduler()?.stop();
    stopRateLimitCleanup();
    await remoteAgentManager?.shutdown();
  });

  // Phase 6.10 — ArgoCD auto-connect from env vars (if configured)
  await autoConnectArgoCdFromEnv();

  // Seed default models. getModels() is an unscoped global select; createModel()
  // uses withProjectInsert which sets projectId=null in system context (global row).
  await runAsSystem("startup-seed-default-models", async () => {
    const existingModels = await storage.getModels();
    if (existingModels.length === 0) {
      for (const model of DEFAULT_MODELS) {
        await storage.createModel(model);
      }
      log(`Seeded ${DEFAULT_MODELS.length} default models`);
    }
  });

  // Reconcile the DB model catalog to the LIVE discovered models so every
  // DB-catalog consumer (Workspace, pipeline, manager, dashboard, settings)
  // only sees the real subscription-CLI models. Best-effort, never blocks boot.
  try {
    await runAsSystem("startup-reconcile-model-catalog", async () => {
      const recon = await reconcileModelCatalog(storage, gateway);
      log(`Reconciled model catalog: ${recon.upserted} upserted, ${recon.deactivated} deactivated`);
    });
  } catch (e) {
    log(`Model catalog reconcile skipped: ${(e as Error).message}`);
  }

  // Active Knowledge Base — optional example dataset (off by default; opt in via
  // KB_SEED_EXAMPLE=true). Idempotent; projection is best-effort.
  if (process.env.KB_SEED_EXAMPLE === "true") {
    try {
      await runAsSystem("startup-seed-kb-example", async () => {
        const seed = await seedExampleTerraformCards(storage, { resolveAdminUserId: resolveFirstAdminUserId });
        log(
          `Seeded example Terraform cards: ${seed.created} created, ${seed.alreadyPresent} already present ` +
            `(workspace ${seed.workspaceId}; projection ${seed.projectionSkipped ? "skipped" : "ok"})`,
        );
      });
    } catch (e) {
      log(`Knowledge example seed skipped: ${(e as Error).message}`);
    }
  }

  // Global pending questions endpoint (protected by /api/questions middleware above)
  app.get("/api/questions/pending", async (_req, res) => {
    res.json(await storage.getPendingQuestions());
  });

  return httpServer;
}

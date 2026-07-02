import type { Express, Router } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { Gateway } from "./gateway/index";
import { reconcileModelCatalog, reconcileExistingPipelineStages } from "./gateway/catalog-sync";
import { TeamRegistry } from "./teams/registry";
import { PipelineController } from "./controller/pipeline-controller";
import { WsManager } from "./ws/manager";
import { registerModelRoutes } from "./routes/models";
import { registerPipelineRoutes } from "./routes/pipelines";
import { registerRunRoutes } from "./routes/runs";
import { registerChatRoutes } from "./routes/chat";
import { registerGatewayRoutes } from "./routes/gateway";
import { registerStrategyRoutes } from "./routes/strategies";
import { registerPrivacyRoutes } from "./routes/privacy";
import { registerStatsRoutes } from "./routes/stats";
import { registerMemoryRoutes } from "./routes/memory";
import { registerLessonRoutes } from "./routes/lessons";
import { registerToolRoutes } from "./routes/tools";
import { registerWorkspaceRoutes } from "./routes/workspaces";
import { registerAuthRoutes } from "./routes/auth";
import { registerSandboxRoutes } from "./routes/sandbox";
import { registerSettingsRoutes } from "./routes/settings";
import { registerSpecializationRoutes } from "./routes/specialization";
import { registerContourObservabilityRoutes } from "./routes/observability";
import { registerSkillRoutes } from "./routes/skills";
import { registerGuardrailRoutes } from "./routes/guardrails";
import { registerDelegationRoutes } from "./routes/delegations";
import { DelegationService } from "./pipeline/delegation-service";
import { ManagerAgent } from "./pipeline/manager-agent";
import { registerActivityRoutes } from "./routes/activity";
import { registerDAGRoutes } from "./routes/dag";
import { registerTraceRoutes } from "./routes/traces";
import { registerTriggerRoutes } from "./routes/triggers";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerHealthRoutes } from "./routes/health";
import { registerLmStudioRoutes } from "./routes/lmstudio";
import { TriggerService } from "./services/trigger-service";
import { CronScheduler } from "./services/cron-scheduler";
import { FileWatcherService } from "./services/file-watcher";
import { stopRateLimitCleanup } from "./services/webhook-handler";
import { requireAuth } from "./auth/middleware";
import { requireProject } from "./middleware/project";
import { tracer } from "./tracing/tracer";
import { DEFAULT_MODELS, DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import { CONSILIUM_LOOP_TERMINAL_STATES, projects } from "@shared/schema";
import { eq } from "drizzle-orm";
import { db } from "./db";
import { log } from "./index";
import { registerArgoCdSettingsRoutes, autoConnectArgoCdFromEnv } from "./routes/argocd-settings";
import { registerTaskGroupRoutes } from "./routes/task-groups";
import { registerTaskGroupResolveRoute } from "./routes/task-group-resolve";
import { registerConsiliumLoopRoutes } from "./routes/consilium-loops";
import { registerConsiliumReviewRoutes } from "./routes/consilium-reviews";
import { createConsiliumReview } from "./services/consilium/review-factory";
import { maybeLaunchConsiliumReview } from "./services/consilium/trigger-dispatch";
import { ConsiliumLoopController, ConsiliumLoopPoller } from "./services/consilium/consilium-loop-controller";
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
import { MemoryFederationService } from "./federation/memory-federation";
import { PipelineSyncService } from "./federation/pipeline-sync";
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
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const delegationService = new DelegationService(storage, teamRegistry, wsManager, gateway);
  const managerAgent = new ManagerAgent(storage, teamRegistry, wsManager, gateway, delegationService);
  const controller = new PipelineController(storage, teamRegistry, wsManager, gateway, delegationService, managerAgent, tracer, undefined);

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
  //   /api/traces    — indirectly scoped via runId → pipelineRuns.projectId
  //   /api/lmstudio  — local server config; import creates project-scoped models

  // ── Project-scoped (requireAuth + requireProject) ──────────────────────────
  app.use("/api/pipelines", requireAuth, requireProject);
  app.use("/api/runs", requireAuth, requireProject);
  app.use("/api/activity", requireAuth, requireProject);
  app.use("/api/models", requireAuth, requireProject);         // UNCERTAIN — see note above
  app.use("/api/gateway", requireAuth, requireProject);        // UNCERTAIN — see note above
  app.use("/api/settings", requireAuth, requireProject);
  app.use("/api/workspaces", requireAuth, requireProject);
  app.use("/api/chat", requireAuth, requireProject);
  app.use("/api/questions", requireAuth, requireProject);
  app.use("/api/stats", requireAuth, requireProject);
  app.use("/api/strategies", requireAuth, requireProject);
  app.use("/api/privacy", requireAuth, requireProject);
  app.use("/api/memory", requireAuth, requireProject);
  app.use("/api/memories", requireAuth, requireProject);
  app.use("/api/lessons", requireAuth, requireProject);        // UNCERTAIN — see note above
  app.use("/api/tools", requireAuth, requireProject);
  app.use("/api/mcp", requireAuth, requireProject);
  app.use("/api/providers", requireAuth, requireProject);
  app.use("/api/specialization-profiles", requireAuth, requireProject);
  app.use("/api/skills", requireAuth, requireProject);
  app.use("/api/guardrails", requireAuth, requireProject);
  app.use("/api/triggers", requireAuth, requireProject);
  app.use("/api/traces", requireAuth, requireProject);         // UNCERTAIN — see note above
  app.use("/api/task-groups", requireAuth, requireProject);
  app.use("/api/consilium-loops", requireAuth, requireProject);
  app.use("/api/consilium-reviews", requireAuth, requireProject);
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
  app.use("/api/observability", requireAuth);

  // /api/pipeline-run-stats — was entirely unprotected (bug); add both guards now.
  // This inline endpoint reads pipeline runs (project-scoped data).
  app.use("/api/pipeline-run-stats", requireAuth, requireProject);
  // Register route implementations
  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage, gateway);
  registerRunRoutes(app, storage, controller);
  registerChatRoutes(app, storage, gateway, wsManager);
  registerGatewayRoutes(app, gateway);
  registerStrategyRoutes(app, storage);
  registerPrivacyRoutes(app);
  registerStatsRoutes(app, storage);
  registerMemoryRoutes(app, storage);
  registerLessonRoutes(app, storage);
  registerToolRoutes(app, storage);
  registerWorkspaceRoutes(app, gateway, wsManager, storage);
  registerConnectionRoutes(app, storage);
  registerContourObservabilityRoutes(app);
  registerConnectionsYamlRoutes(app, storage);
  registerInventoryRoutes(app, storage);
  registerWorkspaceTraceRoutes(app, storage);
  registerCostRoutes(app, storage);
  registerWorkspaceToolRoutes(app, storage);
  registerMcpRoutes(app as unknown as Router, storage, controller);
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
  registerGuardrailRoutes(app, storage, gateway);
  registerDelegationRoutes(app, storage);
  registerDAGRoutes(app, storage);
  registerTraceRoutes(app, storage);
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
  const taskOrchestrator = new TaskOrchestrator(storage, wsManager, controller, gateway);
  taskOrchestrator.setTracer(taskTracer);
  registerTaskGroupRoutes(app, storage, taskOrchestrator);
  registerTaskGroupResolveRoute(app);
  registerTaskIterationRoutes(app as unknown as Router, storage);

  // Consilium Loop (Phase B — auto-versioned FSM). KILL-SWITCH default FALSE:
  // the controller + routes + poller are only wired when explicitly enabled, so
  // a normal boot is fully inert. Mirrors the cron-scheduler bootstrap below.
  let consiliumLoopPoller: ConsiliumLoopPoller | null = null;
  // Hoisted to the registerRoutes scope (was a block-local const) so the
  // file-change `fireTrigger` closure below can launch consilium reviews via the
  // SAME controller. Stays null when the kill-switch is off — fireTrigger then
  // treats a consilium_review action as an inert no-op (logs + skips).
  let consiliumLoopController: ConsiliumLoopController | null = null;
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
    });
    registerConsiliumLoopRoutes(app, storage, consiliumLoopController, () => appConfigLoader.get());
    // POST /api/consilium-reviews — the UI "New consilium review" button. Same
    // factory + same fail-closed allowlist as the trigger path. Registered ONLY
    // inside the kill-switch block (inert otherwise), mounted behind
    // requireAuth + requireProject above.
    registerConsiliumReviewRoutes(app, {
      storage,
      orchestrator: taskOrchestrator,
      controller: consiliumLoopController,
      config: () => appConfigLoader.get(),
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

  // Live Activity observability lens (read-only, owner/admin-scoped, metadata-only).
  // Registered AFTER the task orchestrator so task-groups can join the live snapshot
  // (and the History tab).
  registerActivityRoutes(app, storage, {
    pipelineController: controller,
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

  try {
    triggerService = new TriggerService(storage);

    // fireTrigger is called from background contexts (cron, file watcher, GitHub events)
    // where no project ALS context is established. runAsSystem audits the access and
    // allows withProject to operate cross-project (no project filter applied in system
    // context). getPipeline validates the pipeline still exists; updateTrigger records
    // the last-fired timestamp. Both operate cross-project in system context.
    const fireTrigger = async (trigger: import("@shared/schema").TriggerRow, payload: unknown): Promise<void> => {
      await runAsSystem("fire-trigger", async () => {
        const pipeline = await storage.getPipeline(trigger.pipelineId);
        if (!pipeline) {
          // pipelineId is NOT NULL in the schema; a consilium_review action does
          // not USE the pipeline, but a dangling pipelineId still means a broken
          // trigger config — keep the historical record-only no-op (no fire).
          log(`[triggers] Pipeline not found for trigger ${trigger.id}`, "triggers");
          return;
        }
        // ALWAYS record lastTriggeredAt — for EVERY trigger type, action or not.
        await storage.updateTrigger(trigger.id, { lastTriggeredAt: new Date() });
        log(`[triggers] Fired trigger ${trigger.id} for pipeline ${pipeline.id}`, "triggers");

        // ── Action dispatch (file_change triggers only) ─────────────────────────
        // ABSENT action ⇒ the record-only no-op above (back-compat for webhook /
        // schedule / github / plain file_change triggers). Present + consilium_review
        // ⇒ launch via the SAME factory the HTTP route uses. The changed-file path +
        // watchPath are UNTRUSTED → they reach ONLY objectiveExtra, which the factory
        // control-strips + clamps. repoPath is re-validated against the fail-closed
        // allowlist INSIDE the factory. The launch runs under runAsProject so all
        // rows stay project-scoped. `reviewDeps: null` (kill-switch off) ⇒ skipped.
        await maybeLaunchConsiliumReview(
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
            log: (m) => log(m, "triggers"),
          },
          trigger,
          payload,
        );
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

    log("[triggers] Trigger subsystem started", "triggers");
  } catch (e) {
    // TriggerCrypto throws if TRIGGER_SECRET_KEY is absent — subsystem is disabled.
    // Register stub routes so the UI receives JSON instead of Express's HTML 404.
    log(`[triggers] Trigger subsystem disabled: ${(e as Error).message}`, "triggers");
    app.get("/api/triggers", (_req, res) => {
      res.status(503).json({ error: "Trigger subsystem is disabled (TRIGGER_SECRET_KEY not configured)", disabled: true });
    });
    app.get("/api/pipelines/:pipelineId/triggers", (_req, res) => {
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

  // Federation services (issues #224 + #225)
  let sessionSharing: SessionSharingService | null = null;
  let memoryFederation: MemoryFederationService | null = null;
  let pipelineSync: PipelineSyncService | null = null;
  const fm = getFederationManager();
  if (fm && fm.isEnabled()) {
    const instanceId = fm.getPeers().length > 0 ? "local" : "primary";
    try {
      sessionSharing = new SessionSharingService(fm, storage, instanceId);
      log("[federation] Session sharing service initialized", "federation");
    } catch (e) {
      log(`[federation] Session sharing disabled: ${(e as Error).message}`, "federation");
    }
    try {
      memoryFederation = new MemoryFederationService(fm, storage, instanceId, instanceId);
      log("[federation] Memory federation service initialized", "federation");
    } catch (e) {
      log(`[federation] Memory federation disabled: ${(e as Error).message}`, "federation");
    }
    try {
      pipelineSync = new PipelineSyncService(fm, storage, instanceId);
      log("[federation] Pipeline sync service initialized", "federation");
    } catch (e) {
      log(`[federation] Pipeline sync disabled: ${(e as Error).message}`, "federation");
    }
  }
  // Bug #312: ConflictResolutionService works without federation (manages in-memory state).
  // Always initialize so that session validation runs before the service-availability check.
  const conflictResolution = new ConflictResolutionService(null);
  registerFederationRoutes(app as unknown as Router, sessionSharing, fm, memoryFederation, pipelineSync, storage, undefined, conflictResolution);
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
    fileWatcherService?.stopAll();
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

  // Best-effort: re-point any EXISTING pipeline stage that still references a now
  // inactive/dead model slug onto a working default. Never throws / never blocks boot.
  try {
    await runAsSystem("startup-reconcile-pipeline-stages", async () => {
      const stageRecon = await reconcileExistingPipelineStages(storage);
      if (stageRecon.stagesRepointed > 0) {
        log(
          `Re-pointed dead pipeline stages: ${stageRecon.stagesRepointed} stages across ${stageRecon.pipelinesUpdated} pipelines`,
        );
      }
    });
  } catch (e) {
    log(`Pipeline stage reconcile skipped: ${(e as Error).message}`);
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

  // Seed default pipeline template. getPipelines() reads cross-project
  // under the system context; createPipeline() uses withProjectInsert which sets
  // projectId=null (a global template visible to every project).
  await runAsSystem("startup-seed-default-pipeline", async () => {
    const existingPipelines = await storage.getPipelines();
    if (existingPipelines.length === 0) {
      await storage.createPipeline({
        name: "Full SDLC Pipeline",
        description:
          "Complete software development lifecycle: Planning → Architecture → Development → Testing → Code Review → Deployment → Monitoring",
        stages: DEFAULT_PIPELINE_STAGES,
        isTemplate: true,
      });
      log("Seeded default SDLC pipeline template");
    }
  });

  // Global pending questions endpoint (protected by /api/questions middleware above)
  app.get("/api/questions/pending", async (_req, res) => {
    const pending = await storage.getPendingQuestions();
    if (pending.length === 0) {
      res.json(pending);
      return;
    }
    // Enrich each question with the pipeline it belongs to (question → run →
    // pipeline) so the UI can say WHICH pipeline is waiting, not just a count.
    const [runs, pipelines] = await Promise.all([
      storage.getPipelineRuns(),
      storage.getPipelines(),
    ]);
    const runToPipeline = new Map(runs.map((r) => [r.id, r.pipelineId]));
    const pipelineName = new Map(pipelines.map((p) => [p.id, p.name]));
    const enriched = pending.map((q) => {
      const pid = q.runId ? runToPipeline.get(q.runId) : undefined;
      return {
        ...q,
        pipelineId: pid ?? null,
        pipelineName: pid ? pipelineName.get(pid) ?? null : null,
      };
    });
    res.json(enriched);
  });

  // Per-pipeline run-status counts for the Pipelines list (succeeded / failed /
  // running / queued), so each pipeline card can show its run health at a glance.
  app.get("/api/pipeline-run-stats", async (_req, res) => {
    const runs = await storage.getPipelineRuns();
    const stats: Record<
      string,
      { succeeded: number; failed: number; running: number; queued: number; total: number }
    > = {};
    for (const r of runs) {
      const s = (stats[r.pipelineId] ??= {
        succeeded: 0,
        failed: 0,
        running: 0,
        queued: 0,
        total: 0,
      });
      s.total++;
      if (r.status === "completed") s.succeeded++;
      else if (r.status === "failed") s.failed++;
      else if (r.status === "running") s.running++;
      else if (r.status === "pending" || r.status === "paused") s.queued++;
      // "cancelled" counts only toward total.
    }
    res.json(stats);
  });

  // Stats summary endpoint (protected by /api/stats middleware above —
  // requireAuth + requireProject, so every storage read is project-scoped via
  // the request ALS context). Surfaces the home dashboard's headline counts:
  // active models, task groups, and consilium loops for the CURRENT project.
  app.get("/api/stats/summary", async (_req, res) => {
    const [allModels, allGroups, allLoops] = await Promise.all([
      storage.getModels(),
      storage.getTaskGroups(),
      storage.getLoops(),
    ]);

    const modelsConfigured = allModels.filter((m) => m.isActive).length;

    // Task groups: total + how many are currently running. "Running" is read
    // from the LATEST ITERATION's status (the authoritative run state — the
    // same source the /api/task-groups list route uses), not the task
    // definitions which stay blocked/ready. One latest-iteration read per
    // group — bounded by the project's group count, no executions fetch.
    const taskGroupsTotal = allGroups.length;
    const latestIterations = await Promise.all(
      allGroups.map((g) => storage.getLatestIteration(g.id)),
    );
    const taskGroupsActive = latestIterations.filter(
      (it) => it?.status === "running",
    ).length;

    // Consilium loops: total + non-terminal (still ticking). Terminal set is
    // the shared source of truth (converged/stopped_cap/escalated/failed/
    // cancelled).
    const consiliumLoopsTotal = allLoops.length;
    const consiliumLoopsActive = allLoops.filter(
      (l) =>
        !CONSILIUM_LOOP_TERMINAL_STATES.includes(
          l.state as (typeof CONSILIUM_LOOP_TERMINAL_STATES)[number],
        ),
    ).length;

    // Consilium loops: 24h status breakdown. Bucket each loop by a coarse status
    // derived from its FSM `state`, counting ONLY loops whose relevant timestamp
    // falls in the last 24h: completedAt for terminal loops (the moment they
    // settled), updatedAt for still-active ones (their last tick). Buckets:
    //   passed   = converged
    //   broke    = failed + escalated
    //   stopped  = stopped_cap + cancelled
    //   waiting  = awaiting_merge   (the human merge gate)
    //   running  = pending + building_context + reviewing + deciding + developing
    // Reuses the same single `allLoops` read above — no extra fetch, bounded by
    // the project's loop count and project-scoped via the request ALS context.
    const DAY_MS = 24 * 60 * 60 * 1000;
    const since = Date.now() - DAY_MS;
    const LOOP_STATE_BUCKET: Record<
      string,
      "passed" | "broke" | "stopped" | "waiting" | "running"
    > = {
      converged: "passed",
      failed: "broke",
      escalated: "broke",
      stopped_cap: "stopped",
      cancelled: "stopped",
      awaiting_merge: "waiting",
      pending: "running",
      building_context: "running",
      reviewing: "running",
      deciding: "running",
      developing: "running",
    };
    const loops24h = {
      passed: 0,
      broke: 0,
      stopped: 0,
      waiting: 0,
      running: 0,
      total: 0,
    };
    for (const l of allLoops) {
      const isTerminal = CONSILIUM_LOOP_TERMINAL_STATES.includes(
        l.state as (typeof CONSILIUM_LOOP_TERMINAL_STATES)[number],
      );
      // Terminal loops carry completedAt; fall back to updatedAt if (defensively)
      // unset. Active loops are dated by their last tick (updatedAt).
      const ts = isTerminal ? (l.completedAt ?? l.updatedAt) : l.updatedAt;
      if (!ts) continue;
      if (new Date(ts).getTime() < since) continue;
      const bucket = LOOP_STATE_BUCKET[l.state];
      if (!bucket) continue;
      loops24h[bucket] += 1;
      loops24h.total += 1;
    }

    res.json({
      modelsConfigured,
      taskGroupsTotal,
      taskGroupsActive,
      consiliumLoopsTotal,
      consiliumLoopsActive,
      loops24h,
    });
  });

  return httpServer;
}

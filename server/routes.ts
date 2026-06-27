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
import { registerMaintenanceRoutes } from "./routes/maintenance";
import { registerSpecializationRoutes } from "./routes/specialization";
import { registerSkillRoutes } from "./routes/skills";
import { registerGuardrailRoutes } from "./routes/guardrails";
import { registerDelegationRoutes } from "./routes/delegations";
import { DelegationService } from "./pipeline/delegation-service";
import { ManagerAgent } from "./pipeline/manager-agent";
import { buildOrchestratorAgent } from "./orchestrator/build-agent";
import { registerOrchestratorRoutes } from "./routes/orchestrator";
import { registerConsensusRoutes } from "./routes/consensus";
import { registerActivityRoutes } from "./routes/activity";
import { ConsensusController } from "./consensus/consensus-controller";
import { registerDAGRoutes } from "./routes/dag";
import { registerTraceRoutes } from "./routes/traces";
import { registerTriggerRoutes } from "./routes/triggers";
import { registerWebhookRoutes } from "./routes/webhooks";
import { registerHealthRoutes } from "./routes/health";
import { registerLibraryRoutes } from "./routes/library";
import { registerLmStudioRoutes } from "./routes/lmstudio";
import { TriggerService } from "./services/trigger-service";
import { CronScheduler } from "./services/cron-scheduler";
import { FileWatcherService } from "./services/file-watcher";
import { stopRateLimitCleanup } from "./services/webhook-handler";
import { BUILTIN_SKILLS } from "./skills/builtin";
import { requireAuth } from "./auth/middleware";
import { requireProject } from "./middleware/project";
import { tracer } from "./tracing/tracer";
import { DEFAULT_MODELS, DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import { log } from "./index";
import { registerArgoCdSettingsRoutes, autoConnectArgoCdFromEnv } from "./routes/argocd-settings";
import { registerTaskGroupRoutes } from "./routes/task-groups";
import { registerConsiliumLoopRoutes } from "./routes/consilium-loops";
import { ConsiliumLoopController, ConsiliumLoopPoller } from "./services/consilium/consilium-loop-controller";
import { WorkspaceManager } from "./workspace/manager";
import { registerSkillTeamRoutes } from "./routes/skill-teams";
import { registerModelSkillBindingRoutes } from "./routes/model-skill-bindings";
import { registerGitSkillSourceRoutes } from "./routes/git-skill-sources";
import { registerTaskTraceRoutes } from "./routes/task-traces";
import { registerTaskIterationRoutes } from "./routes/task-iterations";
import { registerTaskTemplateRoutes } from "./routes/task-templates";
import { registerTrackerRoutes } from "./routes/tracker";
import { TaskOrchestrator } from "./services/task-orchestrator";
import { TaskTracer } from "./services/task-tracer";
import { TaskSplitter } from "./services/task-splitter";
import { TrackerSyncService } from "./services/tracker-sync";
import { RemoteAgentManager } from "./remote-agents/remote-agent-manager";
import { registerRemoteAgentRoutes } from "./routes/remote-agents";
import { registerSkillMarketRoutes } from "./routes/skill-market";
import { RegistryManager } from "./skill-market/registry-manager";
import { McpRegistryAdapter } from "./skill-market/adapters/mcp-registry-adapter";
import { SkillUpdateChecker } from "./skill-market/update-checker";
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
import { registerNewsRoutes } from "./routes/news";
import { BriefScheduler } from "./news/brief-scheduler";
import { generateBrief } from "./news/brief-generator";
import { buildNewsLiveDeps, bindGeneratorDeps } from "./news/news-deps";
import { configLoader as appConfigLoader } from "./config/loader";
import { seedExampleTerraformCards, resolveFirstAdminUserId } from "./knowledge/seed-terraform-cards";
import { SessionSharingService } from "./federation/session-sharing";
import { InMemoryConflictStore } from "./federation/config-conflict";
import { ConflictResolutionService } from "./federation/conflict-resolution";
import { MemoryFederationService } from "./federation/memory-federation";
import { PipelineSyncService } from "./federation/pipeline-sync";
import { getFederationManager } from "./federation/manager-state";

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
  const orchestratorAgent = buildOrchestratorAgent(storage, gateway, wsManager);
  const controller = new PipelineController(storage, teamRegistry, wsManager, gateway, delegationService, managerAgent, tracer, undefined, orchestratorAgent);
  const consensusController = new ConsensusController(storage, gateway, {
    claudeModelSlug: process.env.CONSENSUS_CLAUDE_MODEL ?? "claude-opus",
  });

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
  //   /api/skill-market — external registry; install creates project-scoped skills

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
  app.use("/api/maintenance", requireAuth, requireProject);
  app.use("/api/specialization-profiles", requireAuth, requireProject);
  app.use("/api/skills", requireAuth, requireProject);
  app.use("/api/guardrails", requireAuth, requireProject);
  app.use("/api/triggers", requireAuth, requireProject);
  app.use("/api/traces", requireAuth, requireProject);         // UNCERTAIN — see note above
  app.use("/api/task-groups", requireAuth, requireProject);
  app.use("/api/consilium-loops", requireAuth, requireProject);
  app.use("/api/task-templates", requireAuth, requireProject);
  app.use("/api/library", requireAuth, requireProject);
  app.use("/api/lmstudio", requireAuth, requireProject);       // UNCERTAIN — see note above
  app.use("/api/skill-teams", requireAuth, requireProject);
  app.use("/api/tracker-connections", requireAuth, requireProject);
  app.use("/api/remote-agents", requireAuth, requireProject);
  app.use("/api/skill-market", requireAuth, requireProject);   // UNCERTAIN — see note above
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

  // /api/pipeline-run-stats — was entirely unprotected (bug); add both guards now.
  // This inline endpoint reads pipeline runs (project-scoped data).
  app.use("/api/pipeline-run-stats", requireAuth, requireProject);

  // Register route implementations
  registerModelRoutes(app, storage);
  registerPipelineRoutes(app, storage, gateway);
  registerOrchestratorRoutes(app, storage, controller);
  registerConsensusRoutes(app, storage, consensusController);
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

  // Morning News Board (morning-news-board-mvp.md) — LAZY-on-first-GET, no cron.
  // Live deps degrade gracefully when backend=local (boardProvider=null →
  // internalDegraded). The Omniscience token stays env-only inside news-deps.
  const newsLive = await buildNewsLiveDeps(appConfigLoader.get(), gateway);
  const briefScheduler = new BriefScheduler(storage, (params) =>
    generateBrief(bindGeneratorDeps(storage, newsLive.deps), params),
  );
  registerNewsRoutes(app as unknown as Router, storage, { scheduler: briefScheduler });
  registerSandboxRoutes(app as unknown as Router);
  registerSettingsRoutes(app as unknown as Router, gateway);
  registerMaintenanceRoutes(app as unknown as Router);
  registerSpecializationRoutes(app, storage);
  registerModelSkillBindingRoutes(app, storage);
  registerSkillRoutes(app, storage);
  registerGuardrailRoutes(app, storage, gateway);
  registerDelegationRoutes(app, storage);
  registerDAGRoutes(app, storage);
  registerTraceRoutes(app, storage);
  registerArgoCdSettingsRoutes(app as unknown as Router, storage);
  registerLibraryRoutes(app as unknown as Router);
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

  // Phase 9.5 + 9.8 — Skill Market unified search + update checker
  let registryManager: RegistryManager | null = null;
  let skillUpdateChecker: SkillUpdateChecker | null = null;
  try {
    registryManager = new RegistryManager();
    registryManager.register(new McpRegistryAdapter());
    log("[skill-market] Registry manager initialized with MCP adapter", "skill-market");

    // Phase 9.8 — background update checker
    skillUpdateChecker = new SkillUpdateChecker(registryManager);
    skillUpdateChecker.start();
    log("[skill-market] Update checker started", "skill-market");
  } catch (e) {
    log(`[skill-market] Skill market subsystem disabled: ${(e as Error).message}`, "skill-market");
    registryManager = null;
    skillUpdateChecker = null;
  }
  registerSkillMarketRoutes(app as unknown as Router, registryManager, skillUpdateChecker);

  // Task Orchestrator + Tracer
  const taskTracer = new TaskTracer(storage, wsManager);
  const taskOrchestrator = new TaskOrchestrator(storage, wsManager, controller, gateway);
  taskOrchestrator.setTracer(taskTracer);
  registerTaskGroupRoutes(app, storage, taskOrchestrator);
  registerTaskIterationRoutes(app as unknown as Router, storage);
  registerTaskTemplateRoutes(app as unknown as Router, storage);

  // Consilium Loop (Phase B — auto-versioned FSM). KILL-SWITCH default FALSE:
  // the controller + routes + poller are only wired when explicitly enabled, so
  // a normal boot is fully inert. Mirrors the cron-scheduler bootstrap below.
  let consiliumLoopPoller: ConsiliumLoopPoller | null = null;
  if (appConfigLoader.get().pipeline.consiliumLoop.enabled) {
    const consiliumLoopController = new ConsiliumLoopController({
      storage,
      taskOrchestrator,
      config: () => appConfigLoader.get(),
      // §14.2/D.5: the WorkspaceManager seam the DEV close-out drives (branch +
      // write the bounded `.md` artifact); push/PR go through pr-wrapper (D.4).
      closeoutManager: new WorkspaceManager(),
    });
    registerConsiliumLoopRoutes(app, storage, consiliumLoopController, () => appConfigLoader.get());
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
  // (and the History tab) as the fifth mode. Model slugs mirror buildOrchestratorAgent
  // + the consensus controller wiring.
  registerActivityRoutes(app, storage, {
    pipelineController: controller,
    consensusController,
    taskOrchestrator,
    orchestratorModels: {
      planModelSlug: process.env.ORCHESTRATOR_PLAN_MODEL ?? "claude-opus",
      synthesizeModelSlug: process.env.ORCHESTRATOR_PLAN_MODEL ?? "claude-opus",
      proposerModelSlug: process.env.ORCHESTRATOR_PLAN_MODEL ?? "claude-opus",
      criticModelSlug: process.env.ORCHESTRATOR_CRITIC_MODEL ?? "gemini-flash",
      judgeModelSlug: process.env.ORCHESTRATOR_PLAN_MODEL ?? "claude-opus",
    },
    consensusClaudeModelSlug: process.env.CONSENSUS_CLAUDE_MODEL ?? "claude-opus",
  });
  registerSkillTeamRoutes(app, storage);
  registerGitSkillSourceRoutes(app);
  registerTaskTraceRoutes(app, storage);

  // Tracker Integration
  const taskSplitter = new TaskSplitter(gateway);
  const trackerSync = new TrackerSyncService(storage);
  registerTrackerRoutes(app, storage, taskSplitter, trackerSync, taskOrchestrator);

  // Phase 6.3 — Trigger subsystem
  let triggerService: TriggerService | null = null;
  let webhookRoutesRegistered = false;
  let cronScheduler: CronScheduler | null = null;
  let fileWatcherService: FileWatcherService | null = null;

  try {
    triggerService = new TriggerService(storage);

    const fireTrigger = async (trigger: import("@shared/schema").TriggerRow, payload: unknown): Promise<void> => {
      // Fire the trigger by starting a pipeline run
      const pipeline = await storage.getPipeline(trigger.pipelineId);
      if (!pipeline) {
        log(`[triggers] Pipeline not found for trigger ${trigger.id}`, "triggers");
        return;
      }
      await storage.updateTrigger(trigger.id, { lastTriggeredAt: new Date() });
      log(`[triggers] Fired trigger ${trigger.id} for pipeline ${pipeline.id}`, "triggers");
    };

    // VETO-1 fix: pass storage as third argument so routes can look up pipeline ownership
    registerTriggerRoutes(app, triggerService, storage);
    registerWebhookRoutes(app, storage, triggerService, fireTrigger);
    webhookRoutesRegistered = true;

    cronScheduler = new CronScheduler({
      getEnabledTriggersByType: (type) => storage.getEnabledTriggersByType(type),
      fireTrigger,
    });
    await cronScheduler.bootstrap();

    // Active Knowledge Base — weekly practice-card refresh (cadence; no auto-commit).
    await knowledgeRefreshScheduler.start();

    fileWatcherService = new FileWatcherService({
      getEnabledTriggersByType: (type) => storage.getEnabledTriggersByType(type),
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
    cronScheduler?.stopAll();
    consiliumLoopPoller?.stop();
    fileWatcherService?.stopAll();
    getRefreshScheduler()?.stop();
    await newsLive.close();
    stopRateLimitCleanup();
    await remoteAgentManager?.shutdown();
    skillUpdateChecker?.stop();
  });

  // Phase 6.10 — ArgoCD auto-connect from env vars (if configured)
  await autoConnectArgoCdFromEnv();

  // Seed built-in skills (idempotent — checks each by ID)
  for (const skill of BUILTIN_SKILLS) {
    const existing = await storage.getSkill(skill.id as string);
    if (!existing) {
      await storage.createSkill(skill);
    }
  }

  // Seed default models
  const existingModels = await storage.getModels();
  if (existingModels.length === 0) {
    for (const model of DEFAULT_MODELS) {
      await storage.createModel(model);
    }
    log(`Seeded ${DEFAULT_MODELS.length} default models`);
  }

  // Reconcile the DB model catalog to the LIVE discovered models so every
  // DB-catalog consumer (Workspace, pipeline, manager, dashboard, settings)
  // only sees the real subscription-CLI models. Best-effort, never blocks boot.
  try {
    const recon = await reconcileModelCatalog(storage, gateway);
    log(`Reconciled model catalog: ${recon.upserted} upserted, ${recon.deactivated} deactivated`);
  } catch (e) {
    log(`Model catalog reconcile skipped: ${(e as Error).message}`);
  }

  // Best-effort: re-point any EXISTING pipeline stage that still references a now
  // inactive/dead model slug onto a working default. Never throws / never blocks boot.
  try {
    const stageRecon = await reconcileExistingPipelineStages(storage);
    if (stageRecon.stagesRepointed > 0) {
      log(
        `Re-pointed dead pipeline stages: ${stageRecon.stagesRepointed} stages across ${stageRecon.pipelinesUpdated} pipelines`,
      );
    }
  } catch (e) {
    log(`Pipeline stage reconcile skipped: ${(e as Error).message}`);
  }

  // Active Knowledge Base — optional example dataset (off by default; opt in via
  // KB_SEED_EXAMPLE=true). Idempotent; projection is best-effort.
  if (process.env.KB_SEED_EXAMPLE === "true") {
    try {
      const seed = await seedExampleTerraformCards(storage, { resolveAdminUserId: resolveFirstAdminUserId });
      log(
        `Seeded example Terraform cards: ${seed.created} created, ${seed.alreadyPresent} already present ` +
          `(workspace ${seed.workspaceId}; projection ${seed.projectionSkipped ? "skipped" : "ok"})`,
      );
    } catch (e) {
      log(`Knowledge example seed skipped: ${(e as Error).message}`);
    }
  }

  // Seed default pipeline template
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

  // Stats summary endpoint (protected by /api/stats middleware above)
  app.get("/api/stats/summary", async (_req, res) => {
    const [allRuns, allPipelines, allModels] = await Promise.all([
      storage.getPipelineRuns(),
      storage.getPipelines(),
      storage.getModels(),
    ]);

    const totalRuns = allRuns.length;
    const activePipelines = allPipelines.filter((p) => !p.isTemplate).length;
    const modelsConfigured = allModels.filter((m) => m.isActive).length;

    const now = Date.now();
    const dayMs = 86_400_000;
    const runsLast7Days: number[] = Array.from({ length: 7 }, (_, offset) => {
      const dayStart = now - (6 - offset) * dayMs;
      const dayEnd = dayStart + dayMs;
      return allRuns.filter((r) => {
        const ts = r.startedAt ? new Date(r.startedAt).getTime() : 0;
        return ts >= dayStart && ts < dayEnd;
      }).length;
    });

    res.json({ totalRuns, activePipelines, modelsConfigured, runsLast7Days });
  });

  return httpServer;
}

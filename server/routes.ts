import type { Express, Router } from "express";
import type { Server } from "http";
import { storage } from "./storage";
import { Gateway } from "./gateway/index";
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
import { tracer } from "./tracing/tracer";
import { DEFAULT_MODELS, DEFAULT_PIPELINE_STAGES } from "@shared/constants";
import { log } from "./index";
import { registerArgoCdSettingsRoutes, autoConnectArgoCdFromEnv } from "./routes/argocd-settings";
import { registerTaskGroupRoutes } from "./routes/task-groups";
import { registerSkillTeamRoutes } from "./routes/skill-teams";
import { registerModelSkillBindingRoutes } from "./routes/model-skill-bindings";
import { registerGitSkillSourceRoutes } from "./routes/git-skill-sources";
import { registerTaskTraceRoutes } from "./routes/task-traces";
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
import { registerFederationRoutes } from "./routes/federation";
import { registerConnectionRoutes } from "./routes/connections";
import { registerInventoryRoutes } from "./routes/inventory";
import { registerMcpRoutes } from "./routes/mcp";
import { SessionSharingService } from "./federation/session-sharing";
import { MemoryFederationService } from "./federation/memory-federation";
import { PipelineSyncService } from "./federation/pipeline-sync";
import { getFederationManager } from "./federation/manager-state";

export async function registerRoutes(
  httpServer: Server,
  app: Express,
): Promise<Server> {
  // Initialize core systems
  const wsManager = new WsManager(httpServer);
  const gateway = new Gateway(storage);
  const teamRegistry = new TeamRegistry(gateway, wsManager);
  const delegationService = new DelegationService(storage, teamRegistry, wsManager, gateway);
  const managerAgent = new ManagerAgent(storage, teamRegistry, wsManager, gateway, delegationService);
  const controller = new PipelineController(storage, teamRegistry, wsManager, gateway, delegationService, managerAgent, tracer);

  // Register public routes (no auth required) — must come before requireAuth middleware
  registerHealthRoutes(app);

  // Register auth routes (public routes included)
  registerAuthRoutes(app);

  // Register protected route groups — all require authentication
  app.use("/api/pipelines", requireAuth);
  app.use("/api/runs", requireAuth);
  app.use("/api/models", requireAuth);
  app.use("/api/gateway", requireAuth);
  app.use("/api/settings", requireAuth);
  app.use("/api/workspaces", requireAuth);
  app.use("/api/chat", requireAuth);
  app.use("/api/questions", requireAuth);
  app.use("/api/stats", requireAuth);
  app.use("/api/strategies", requireAuth);
  app.use("/api/privacy", requireAuth);
  app.use("/api/memory", requireAuth);
  app.use("/api/memories", requireAuth);
  app.use("/api/tools", requireAuth);
  app.use("/api/mcp", requireAuth);
  app.use("/api/providers", requireAuth);
  app.use("/api/teams", requireAuth);
  app.use("/api/sandbox", requireAuth);
  app.use("/api/maintenance", requireAuth);
  app.use("/api/specialization-profiles", requireAuth);
  app.use("/api/skills", requireAuth);
  app.use("/api/guardrails", requireAuth);
  app.use("/api/triggers", requireAuth);
  app.use("/api/traces", requireAuth);
  app.use("/api/task-groups", requireAuth);
  app.use("/api/library", requireAuth);
  app.use("/api/lmstudio", requireAuth);
  app.use("/api/skill-teams", requireAuth);
  app.use("/api/tracker-connections", requireAuth);
  app.use("/api/remote-agents", requireAuth);
  app.use("/api/skill-market", requireAuth);
  app.use("/api/federation", requireAuth);

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
  registerToolRoutes(app, storage);
  registerWorkspaceRoutes(app, gateway, wsManager, storage);
  registerConnectionRoutes(app, storage);
  registerInventoryRoutes(app, storage);
  registerMcpRoutes(app as unknown as Router, storage, controller);
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
  registerSkillTeamRoutes(app, storage);
  registerGitSkillSourceRoutes(app);
  registerTaskTraceRoutes(app, storage);

  // Tracker Integration
  const taskSplitter = new TaskSplitter(gateway);
  const trackerSync = new TrackerSyncService(storage);
  registerTrackerRoutes(app, storage, taskSplitter, trackerSync, taskOrchestrator);

  // Phase 6.3 — Trigger subsystem
  let triggerService: TriggerService | null = null;
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

    cronScheduler = new CronScheduler({
      getEnabledTriggersByType: (type) => storage.getEnabledTriggersByType(type),
      fireTrigger,
    });
    await cronScheduler.bootstrap();

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
  registerFederationRoutes(app as unknown as Router, sessionSharing, fm, memoryFederation, pipelineSync, storage);

  // Graceful shutdown
  httpServer.on("close", async () => {
    cronScheduler?.stopAll();
    fileWatcherService?.stopAll();
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
    res.json(pending);
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

/**
 * Test app factory for the /api/task-groups routes over MemStorage + a real
 * TaskOrchestrator with inert collaborators (no CLI/network/real DB/WS server).
 *
 * Mirrors test-consensus-app: an injectable authenticated user (id/role), a
 * header to force the unauth path, and the ability to seed groups owned by other
 * users so the owner/admin/ownerless authz paths are exercised. The orchestrator
 * is constructed with no-op WS + pipeline-controller + gateway doubles because
 * the route tests never drive real task execution — they exercise authz, edit
 * guards, and the edit orchestration.
 */
import express from "express";
import type { Router } from "express";
import { MemStorage } from "../../server/storage.js";
import { TaskOrchestrator } from "../../server/services/task-orchestrator.js";
import { registerTaskGroupRoutes } from "../../server/routes/task-groups.js";
import { registerTaskIterationRoutes } from "../../server/routes/task-iterations.js";
import { registerTaskTemplateRoutes } from "../../server/routes/task-templates.js";
import { registerTaskTraceRoutes } from "../../server/routes/task-traces.js";
import type { WsManager } from "../../server/ws/manager.js";
import type { PipelineController } from "../../server/controller/pipeline-controller.js";
import type { Gateway } from "../../server/gateway/index.js";
import type { User, UserRole } from "../../shared/types.js";

export interface TaskGroupTestAppOptions {
  role?: UserRole;
  userId?: string;
  /** When true, the user session carries no id (drives the 401 path). */
  noUserId?: boolean;
}

export interface TaskGroupTestApp {
  app: express.Express;
  storage: MemStorage;
  orchestrator: TaskOrchestrator;
  userId: string;
}

/** No-op WS manager — broadcasts go nowhere in the route tests. */
function makeWsManager(): WsManager {
  return { broadcastToRun: () => {} } as unknown as WsManager;
}

/** Inert pipeline controller — never invoked by the authz/edit route tests. */
function makePipelineController(): PipelineController {
  return {} as unknown as PipelineController;
}

/** Inert gateway — never invoked by the authz/edit route tests. */
function makeGateway(): Gateway {
  return {} as unknown as Gateway;
}

export function createTaskGroupTestApp(opts: TaskGroupTestAppOptions = {}): TaskGroupTestApp {
  const role: UserRole = opts.role ?? "user";
  const userId = opts.userId ?? "test-user-id";

  const storage = new MemStorage();
  const orchestrator = new TaskOrchestrator(
    storage,
    makeWsManager(),
    makePipelineController(),
    makeGateway(),
  );

  const user: User = {
    id: opts.noUserId ? (undefined as unknown as string) : userId,
    email: "tg@example.com",
    name: "Task Group User",
    isActive: true,
    role,
    lastLoginAt: null,
    createdAt: new Date(0),
  };

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (req.headers["x-test-unauth"] === "1") {
      req.user = undefined as never;
    } else {
      req.user = user;
    }
    next();
  });

  registerTaskGroupRoutes(app as unknown as Router, storage, orchestrator);
  registerTaskIterationRoutes(app as unknown as Router, storage);
  registerTaskTemplateRoutes(app as unknown as Router, storage);
  registerTaskTraceRoutes(app as unknown as import("express").Express, storage);

  return { app, storage, orchestrator, userId };
}

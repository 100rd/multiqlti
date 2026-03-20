import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage.js";
import type { TaskSplitter } from "../services/task-splitter.js";
import type { TrackerSyncService } from "../services/tracker-sync.js";
import type { TaskOrchestrator } from "../services/task-orchestrator.js";
import { validateBody } from "../middleware/validate.js";
import { TRACKER_PROVIDERS } from "@shared/schema";

// ─── Validation Schemas ─────────────────────────────────────────────────────

const CreateTrackerConnectionSchema = z.object({
  taskGroupId: z.string().min(1).max(200),
  provider: z.enum(TRACKER_PROVIDERS),
  issueUrl: z.string().url().max(2000),
  issueKey: z.string().min(1).max(200),
  projectKey: z.string().max(200).nullable().optional(),
  syncComments: z.boolean().optional(),
  syncSubtasks: z.boolean().optional(),
  apiToken: z.string().max(2000).nullable().optional(),
  baseUrl: z.string().url().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});

const SplitPreviewSchema = z.object({
  storyText: z.string().min(1).max(50000),
  modelSlug: z.string().min(1).max(100),
});

const SubmitWorkSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().min(1).max(5000),
  storyText: z.string().min(1).max(50000),
  modelSlug: z.string().min(1).max(100),
  trackerUrl: z.string().url().max(2000).optional(),
  trackerProvider: z.enum(TRACKER_PROVIDERS).optional(),
  trackerIssueKey: z.string().max(200).optional(),
  trackerApiToken: z.string().max(2000).optional(),
  trackerBaseUrl: z.string().url().max(2000).optional(),
});

// ─── Route Registration ─────────────────────────────────────────────────────

export function registerTrackerRoutes(
  router: Router,
  storage: IStorage,
  taskSplitter: TaskSplitter,
  trackerSync: TrackerSyncService,
  orchestrator: TaskOrchestrator,
) {
  // Create a tracker connection
  router.post(
    "/api/tracker-connections",
    validateBody(CreateTrackerConnectionSchema),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof CreateTrackerConnectionSchema>;
        const conn = await storage.createTrackerConnection(body);
        res.status(201).json(conn);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    },
  );

  // List tracker connections for a task group
  router.get("/api/tracker-connections/:groupId", async (req, res) => {
    try {
      const conns = await storage.getTrackerConnectionsByGroup(req.params.groupId);
      res.json(conns);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Delete a tracker connection
  router.delete("/api/tracker-connections/:id", async (req, res) => {
    try {
      await storage.deleteTrackerConnection(req.params.id);
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // LLM split preview — returns the split plan without creating anything
  router.post(
    "/api/task-groups/split-preview",
    validateBody(SplitPreviewSchema),
    async (req, res) => {
      try {
        const { storyText, modelSlug } = req.body as z.infer<typeof SplitPreviewSchema>;
        const tasks = await taskSplitter.split(storyText, modelSlug);
        res.json({ tasks });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    },
  );

  // Full flow: split + create group + optionally connect tracker
  router.post(
    "/api/task-groups/submit-work",
    validateBody(SubmitWorkSchema),
    async (req, res) => {
      try {
        const body = req.body as z.infer<typeof SubmitWorkSchema>;
        const userId = (req as unknown as { user?: { id: string } }).user?.id;

        // Step 1: LLM split
        const splitTasks = await taskSplitter.split(body.storyText, body.modelSlug);

        // Step 2: Create task group with split tasks
        const result = await orchestrator.createTaskGroup({
          name: body.name,
          description: body.description,
          input: body.storyText,
          createdBy: userId,
          tasks: splitTasks.map((t, i) => ({
            name: t.name,
            description: `${t.description}\n\n**Conditions of Done:**\n${t.conditionsOfDone.map((c) => `- ${c}`).join("\n")}\n\n**Tests:**\n${t.tests.map((te) => `- ${te}`).join("\n")}`,
            executionMode: "direct_llm" as const,
            dependsOn: t.dependsOn,
            sortOrder: i,
          })),
        });

        // Step 3: Optionally create tracker connection
        let trackerConnection = null;
        if (body.trackerUrl && body.trackerProvider && body.trackerIssueKey) {
          trackerConnection = await storage.createTrackerConnection({
            taskGroupId: result.group.id,
            provider: body.trackerProvider,
            issueUrl: body.trackerUrl,
            issueKey: body.trackerIssueKey,
            apiToken: body.trackerApiToken ?? null,
            baseUrl: body.trackerBaseUrl ?? null,
          });

          // Sync comment to tracker about the new task group
          await trackerSync.syncComment(
            result.group.id,
            `Task group "${body.name}" created with ${splitTasks.length} sub-tasks via multiqlti.`,
          );
        }

        res.status(201).json({
          group: result.group,
          tasks: result.tasks,
          trackerConnection,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: message });
      }
    },
  );
}

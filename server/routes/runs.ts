import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";
import { generateMarkdownReport, generateZipExport } from "../services/export-service";
import { ephemeralVarStore } from "../run-variables/store";
import { validateBody } from "../middleware/validate.js";

/** Mask the password portion of a connection string like postgres://user:pass@host/db */
function maskUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.password) url.password = "***";
    return url.toString();
  } catch {
    return value;
  }
}

const CreateRunSchema = z.object({
  pipelineId: z.string().min(1, "pipelineId is required").max(100),
  input: z.string().min(1, "input must be a non-empty string").max(50000),
  variables: z.record(z.string().max(10000))
    .refine(
      (v) => Object.keys(v).length <= 50,
      { message: "variables must have at most 50 keys" }
    )
    .refine(
      (v) => Object.keys(v).every((k) => k.length <= 200),
      { message: "variable key names must be at most 200 characters" }
    )
    .optional(),
});

const AnswerQuestionSchema = z.object({
  answer: z.string().min(1, "answer is required").max(10000),
});

const ApproveStageSchema = z.object({
  approvedBy: z.string().max(200).optional(),
});

const RejectStageSchema = z.object({
  reason: z.string().max(500).optional(),
});

const ExportFormatSchema = z.enum(["markdown", "zip"]);

export function registerRunRoutes(
  router: Router,
  storage: IStorage,
  controller: PipelineController,
) {
  router.get("/api/runs", async (req, res) => {
    const pipelineId = req.query.pipelineId as string | undefined;
    const runs = await storage.getPipelineRuns(pipelineId);
    res.json(runs);
  });

  // ─── Run Comparison — MUST be registered before /:id ────────────────────────

  router.get("/api/runs/compare", async (req, res) => {
    const raw = req.query.runIds as string | undefined;
    if (!raw) {
      return res.status(400).json({ error: "runIds query parameter is required" });
    }
    const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
    if (ids.length !== 2) {
      return res.status(400).json({ error: "Exactly two runIds must be provided" });
    }
    const [id1, id2] = ids;

    const [run1, run2] = await Promise.all([
      storage.getPipelineRun(id1),
      storage.getPipelineRun(id2),
    ]);

    if (!run1) return res.status(404).json({ error: `Run not found: ${id1}` });
    if (!run2) return res.status(404).json({ error: `Run not found: ${id2}` });

    // Must belong to the same pipeline
    if (run1.pipelineId !== run2.pipelineId) {
      return res.status(400).json({ error: "Runs must belong to the same pipeline" });
    }

    // Ownership check: each run must have been triggered by the requesting user (unless admin)
    const userId = req.user?.id;
    const isAdmin = req.user?.role === "admin";
    if (!isAdmin) {
      if (run1.triggeredBy && run1.triggeredBy !== userId) {
        return res.status(403).json({ error: "Access denied for run " + id1 });
      }
      if (run2.triggeredBy && run2.triggeredBy !== userId) {
        return res.status(403).json({ error: "Access denied for run " + id2 });
      }
    }

    const [stages1, stages2] = await Promise.all([
      storage.getStageExecutions(id1),
      storage.getStageExecutions(id2),
    ]);

    res.json({
      runs: [
        { ...run1, stages: stages1 },
        { ...run2, stages: stages2 },
      ],
    });
  });

  router.get("/api/runs/:id", async (req, res) => {
    const run = await storage.getPipelineRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const stages = await storage.getStageExecutions(run.id);
    const questions = await storage.getQuestions(run.id);
    res.json({ ...run, stages, questions });
  });

  router.post("/api/runs", validateBody(CreateRunSchema), async (req, res) => {
    const { pipelineId, input, variables } = req.body as z.infer<typeof CreateRunSchema>;
    try {
      const triggeredBy = req.user?.id;
      const run = await controller.startRun(pipelineId, input, variables, triggeredBy);
      res.status(201).json(run);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ── Ephemeral run variable management ────────────────────────────────────────

  router.get("/api/runs/:id/variables", (req, res) => {
    const state = ephemeralVarStore.getState(req.params.id);
    if (!state) return res.status(404).json({ error: "No variables for this run" });

    // Mask secret-looking values (anything containing '@' or '://' in the value)
    const maskedVars: Record<string, string> = {};
    for (const [k, v] of Object.entries(state.variables)) {
      maskedVars[k] = v.includes("://") ? maskUrl(v) : v;
    }

    res.json({ ...state, variables: maskedVars });
  });

  router.delete("/api/runs/:id/variables", (req, res) => {
    const cleared = ephemeralVarStore.clearManually(req.params.id);
    if (!cleared) return res.status(404).json({ error: "No variables to clear" });
    res.json({ cleared: true });
  });

  router.post("/api/runs/:id/cancel", async (req, res) => {
    try {
      await controller.cancelRun(req.params.id);
      res.json({ message: "Run cancelled" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.get("/api/runs/:id/stages", async (req, res) => {
    const stages = await storage.getStageExecutions(req.params.id);
    res.json(stages);
  });

  router.get("/api/runs/:id/questions", async (req, res) => {
    const questions = await storage.getQuestions(req.params.id);
    res.json(questions);
  });

  router.post("/api/runs/:id/questions/:qid/answer", validateBody(AnswerQuestionSchema), async (req, res) => {
    const { answer } = req.body as z.infer<typeof AnswerQuestionSchema>;
    try {
      await controller.answerQuestion(req.params.qid as string, answer);
      res.json({ message: "Question answered" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/questions/:qid/dismiss", async (req, res) => {
    try {
      await controller.dismissQuestion(req.params.qid as string);
      res.json({ message: "Question dismissed" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ─── Approval Gates ────────────────────────────────────────────────────────

  router.post("/api/runs/:id/stages/:stageIndex/approve", validateBody(ApproveStageSchema), async (req, res) => {
    const stageIndex = parseInt(req.params.stageIndex as string, 10);
    if (isNaN(stageIndex) || stageIndex < 0) {
      return res.status(400).json({ error: "Invalid stageIndex" });
    }

    const { approvedBy } = req.body as z.infer<typeof ApproveStageSchema>;
    try {
      await controller.approveStage(req.params.id as string, stageIndex, approvedBy);
      res.json({ message: "Stage approved" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/stages/:stageIndex/reject", validateBody(RejectStageSchema), async (req, res) => {
    const stageIndex = parseInt(req.params.stageIndex as string, 10);
    if (isNaN(stageIndex) || stageIndex < 0) {
      return res.status(400).json({ error: "Invalid stageIndex" });
    }

    const { reason } = req.body as z.infer<typeof RejectStageSchema>;
    try {
      await controller.rejectStage(req.params.id as string, stageIndex, reason);
      res.json({ message: "Stage rejected" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ─── Export ───────────────────────────────────────────────────────────────

  router.get("/api/runs/:id/export", async (req, res) => {
    const formatResult = ExportFormatSchema.safeParse(req.query.format);
    if (!formatResult.success) {
      return res.status(400).json({ error: "format must be 'markdown' or 'zip'" });
    }
    const format = formatResult.data;

    const run = await storage.getPipelineRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const pipeline = await storage.getPipeline(run.pipelineId);
    if (!pipeline) return res.status(404).json({ error: "Pipeline not found" });

    const stages = await storage.getStageExecutions(run.id);
    const runSlug = run.id.slice(0, 8);

    if (format === "markdown") {
      const markdown = generateMarkdownReport(run, stages, pipeline);
      res.setHeader("Content-Type", "text/markdown; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="run-${runSlug}-report.md"`);
      res.send(markdown);
      return;
    }

    // ZIP
    const zipBuffer = generateZipExport(run, stages, pipeline);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="run-${runSlug}-export.zip"`);
    res.setHeader("Content-Length", zipBuffer.length);
    res.send(zipBuffer);
  });
}

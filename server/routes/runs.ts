import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";
import { generateMarkdownReport, generateZipExport } from "../services/export-service";
import { ephemeralVarStore } from "../run-variables/store";

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
  pipelineId: z.string().min(1, "pipelineId is required"),
  input: z.string().min(1, "input must be a non-empty string"),
  variables: z.record(z.string()).optional(),
});

const AnswerQuestionSchema = z.object({
  answer: z.string().min(1, "answer is required"),
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

  router.get("/api/runs/:id", async (req, res) => {
    const run = await storage.getPipelineRun(req.params.id);
    if (!run) return res.status(404).json({ error: "Run not found" });

    const stages = await storage.getStageExecutions(run.id);
    const questions = await storage.getQuestions(run.id);
    res.json({ ...run, stages, questions });
  });

  router.post("/api/runs", async (req, res) => {
    const result = CreateRunSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.message });
    }

    const { pipelineId, input, variables } = result.data;
    try {
      const run = await controller.startRun(pipelineId, input, variables);
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

  router.post("/api/runs/:id/questions/:qid/answer", async (req, res) => {
    const result = AnswerQuestionSchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.message });
    }

    try {
      await controller.answerQuestion(req.params.qid, result.data.answer);
      res.json({ message: "Question answered" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/questions/:qid/dismiss", async (req, res) => {
    try {
      await controller.dismissQuestion(req.params.qid);
      res.json({ message: "Question dismissed" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // ─── Approval Gates ────────────────────────────────────────────────────────

  router.post("/api/runs/:id/stages/:stageIndex/approve", async (req, res) => {
    const stageIndex = parseInt(req.params.stageIndex, 10);
    if (isNaN(stageIndex) || stageIndex < 0) {
      return res.status(400).json({ error: "Invalid stageIndex" });
    }

    const parsed = ApproveStageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    try {
      await controller.approveStage(req.params.id, stageIndex, parsed.data.approvedBy);
      res.json({ message: "Stage approved" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/stages/:stageIndex/reject", async (req, res) => {
    const stageIndex = parseInt(req.params.stageIndex, 10);
    if (isNaN(stageIndex) || stageIndex < 0) {
      return res.status(400).json({ error: "Invalid stageIndex" });
    }

    const parsed = RejectStageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.message });
    }

    try {
      await controller.rejectStage(req.params.id, stageIndex, parsed.data.reason);
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

import { Router } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";

const CreateRunSchema = z.object({
  pipelineId: z.string().min(1, "pipelineId is required"),
  input: z.string().min(1, "input must be a non-empty string"),
});

const AnswerQuestionSchema = z.object({
  answer: z.string().min(1, "answer is required"),
});

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

    const { pipelineId, input } = result.data;
    try {
      const run = await controller.startRun(pipelineId, input);
      res.status(201).json(run);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
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
}

import { Router } from "express";
import type { IStorage } from "../storage";
import type { PipelineController } from "../controller/pipeline-controller";

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
    if (!run) return res.status(404).json({ message: "Run not found" });

    const stages = await storage.getStageExecutions(run.id);
    const questions = await storage.getQuestions(run.id);
    res.json({ ...run, stages, questions });
  });

  router.post("/api/runs", async (req, res) => {
    const { pipelineId, input } = req.body;
    if (!pipelineId || !input) {
      return res
        .status(400)
        .json({ message: "pipelineId and input are required" });
    }

    try {
      const run = await controller.startRun(pipelineId, input);
      res.status(201).json(run);
    } catch (e) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/cancel", async (req, res) => {
    try {
      await controller.cancelRun(req.params.id);
      res.json({ message: "Run cancelled" });
    } catch (e) {
      res.status(400).json({ message: (e as Error).message });
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
    const { answer } = req.body;
    if (!answer) {
      return res.status(400).json({ message: "answer is required" });
    }

    try {
      await controller.answerQuestion(req.params.qid, answer);
      res.json({ message: "Question answered" });
    } catch (e) {
      res.status(400).json({ message: (e as Error).message });
    }
  });

  router.post("/api/runs/:id/questions/:qid/dismiss", async (req, res) => {
    try {
      await controller.dismissQuestion(req.params.qid);
      res.json({ message: "Question dismissed" });
    } catch (e) {
      res.status(400).json({ message: (e as Error).message });
    }
  });
}

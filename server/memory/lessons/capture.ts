import type { InsertLesson, Lesson, StageExecution } from "@shared/schema";
import { deriveStageLesson, type LessonRunContext } from "./derive.js";

/** Narrow storage surface the capture service needs (avoids import cycles). */
export interface LessonWriter {
  createLesson(lesson: InsertLesson): Promise<Lesson>;
}

/** Optional sink for capture failures; defaults to a no-op (never throws). */
export type CaptureErrorSink = (error: unknown) => void;

/**
 * Persists lessons derived from stage/run outcomes. Every method is defensive:
 * a failure inside capture is swallowed (routed to the error sink) and NEVER
 * propagates into the pipeline run path — agent-experience capture must not be
 * able to break a run.
 */
export class LessonCaptureService {
  constructor(
    private readonly storage: LessonWriter,
    private readonly onError: CaptureErrorSink = () => {},
  ) {}

  /**
   * Derive and persist a lesson for a single stage outcome. Returns the stored
   * lesson, or null when nothing was captured (no signal, or a swallowed error).
   */
  async captureStage(
    stage: Readonly<StageExecution>,
    ctx: Readonly<LessonRunContext>,
  ): Promise<Lesson | null> {
    try {
      const insert = deriveStageLesson(stage, ctx);
      if (insert == null) return null;
      return await this.storage.createLesson(insert);
    } catch (error) {
      this.onError(error);
      return null;
    }
  }

  /** Capture lessons for many stages; failures per-stage are isolated. */
  async captureStages(
    stages: readonly StageExecution[],
    ctx: Readonly<LessonRunContext>,
  ): Promise<void> {
    await Promise.all(stages.map((s) => this.captureStage(s, ctx)));
  }
}

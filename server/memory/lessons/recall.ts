import type { Lesson } from "@shared/schema";
import {
  LESSON_RECALL_DEFAULT_LIMIT,
  LESSON_RECALL_MAX_LIMIT,
  type LessonRecallFilter,
} from "./types.js";

/** Narrow storage surface the recall service needs (avoids import cycles). */
export interface LessonReader {
  recallLessons(filter: LessonRecallFilter): Promise<Lesson[]>;
}

/** Planning context offered by the planning stage when asking for lessons. */
export interface PlanningContext {
  readonly workspaceId?: string | null;
  readonly teamId?: string | null;
}

function clampLimit(limit?: number): number {
  if (limit == null || !Number.isFinite(limit) || limit <= 0) {
    return LESSON_RECALL_DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(limit), LESSON_RECALL_MAX_LIMIT);
}

/**
 * Recalls relevant prior lessons for a planning context. v1 ranks purely by
 * recency under a workspace+team filter; semantic ranking is a deliberate v2
 * (memory-architecture ADR, Track B). Defensive: a storage failure yields an
 * empty list rather than breaking planning.
 */
export class LessonRecallService {
  constructor(private readonly storage: LessonReader) {}

  /** Lessons most relevant to the given planning context, recency-ranked. */
  async recallForPlanning(
    ctx: Readonly<PlanningContext>,
    limit?: number,
  ): Promise<Lesson[]> {
    const filter: LessonRecallFilter = {
      workspaceId: ctx.workspaceId ?? undefined,
      teamId: ctx.teamId ?? undefined,
      limit: clampLimit(limit),
    };
    try {
      return await this.storage.recallLessons(filter);
    } catch {
      return [];
    }
  }
}

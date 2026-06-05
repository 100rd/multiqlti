import type { Lesson } from "@shared/schema";

/**
 * Filter for recalling prior lessons at planning time. All fields are optional;
 * an empty filter returns the most recent lessons across the install. Recall
 * starts simple (workspace + team + outcome + recency); semantic ranking is a
 * deliberate v2 (see memory-architecture ADR, Track B).
 */
export interface LessonRecallFilter {
  readonly workspaceId?: string | null;
  readonly teamId?: string | null;
  readonly outcome?: Lesson["outcome"];
  /** Max number of lessons to return, most recent first. */
  readonly limit?: number;
}

/** Default and hard caps for recall, to keep planning prompts bounded. */
export const LESSON_RECALL_DEFAULT_LIMIT = 10;
export const LESSON_RECALL_MAX_LIMIT = 50;

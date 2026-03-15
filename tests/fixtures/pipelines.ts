import type { Pipeline } from "../../shared/schema.js";

/**
 * Sample pipeline fixture — mirrors the seeded "Full SDLC Pipeline".
 * Stages use "mock" model slug so Gateway always falls back to MockProvider.
 */
export const SDLC_PIPELINE_FIXTURE: Omit<Pipeline, "id" | "createdAt" | "updatedAt"> = {
  name: "Full SDLC Pipeline",
  description:
    "Complete software development lifecycle: Planning → Architecture → Development → Testing → Code Review → Deployment → Monitoring",
  stages: [
    { teamId: "planning", modelSlug: "mock", enabled: true },
    { teamId: "architecture", modelSlug: "mock", enabled: true },
    { teamId: "development", modelSlug: "mock", enabled: true },
    { teamId: "testing", modelSlug: "mock", enabled: true },
    { teamId: "code_review", modelSlug: "mock", enabled: true },
    { teamId: "deployment", modelSlug: "mock", enabled: true },
    { teamId: "monitoring", modelSlug: "mock", enabled: true },
  ],
  createdBy: null,
  isTemplate: false,
};

export const MINIMAL_PIPELINE_FIXTURE: Omit<Pipeline, "id" | "createdAt" | "updatedAt"> = {
  name: "Minimal Pipeline",
  description: "Single-stage pipeline for fast tests",
  stages: [
    { teamId: "planning", modelSlug: "mock", enabled: true },
  ],
  createdBy: null,
  isTemplate: false,
};

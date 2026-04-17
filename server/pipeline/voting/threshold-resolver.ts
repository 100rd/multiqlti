// server/pipeline/voting/threshold-resolver.ts
// Resolves the effective consensus threshold for a Voting execution strategy.
//
// Three modes:
//  • static      — uses the fixed value from config (legacy path, always available)
//  • task_signal — looks up the first matching signal rule; falls back to the
//                  configured default
//  • confidence  — adjusts the base threshold based on aggregated candidate
//                  confidence scores within configured floor/ceiling bounds

import type {
  VotingThresholdConfig,
  TaskSignalThresholdConfig,
  ConfidenceThresholdConfig,
  TaskSignalBag,
} from "@shared/types";
import { hasSignal } from "./task-signals.js";

// ─── Threshold Resolver ───────────────────────────────────────────────────────

/**
 * Resolve the effective voting threshold given a threshold configuration, an
 * optional signal bag, and optional aggregated confidence.
 *
 * @param config     Threshold configuration (static / task_signal / confidence).
 * @param signals    Signal bag from the current pipeline run.  Required for
 *                   `task_signal` mode; ignored otherwise.
 * @param aggregatedConfidence  Aggregated confidence score (0–1) from candidate
 *                              models.  Required for `confidence` mode; ignored
 *                              otherwise.
 * @returns Effective threshold value in [0, 1].
 */
export function resolveThreshold(
  config: VotingThresholdConfig,
  signals?: TaskSignalBag,
  aggregatedConfidence?: number,
): number {
  switch (config.mode) {
    case "static":
      return clamp(config.value, 0, 1);

    case "task_signal":
      return resolveTaskSignalThreshold(config, signals);

    case "confidence":
      return resolveConfidenceThreshold(config, aggregatedConfidence);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

function resolveTaskSignalThreshold(
  config: TaskSignalThresholdConfig,
  signals?: TaskSignalBag,
): number {
  if (!signals || signals.signals.length === 0) {
    return clamp(config.default, 0, 1);
  }

  for (const rule of config.rules) {
    if (hasSignal(signals, rule.signal)) {
      return clamp(rule.threshold, 0, 1);
    }
  }

  return clamp(config.default, 0, 1);
}

function resolveConfidenceThreshold(
  config: ConfidenceThresholdConfig,
  aggregatedConfidence?: number,
): number {
  const floor = clamp(config.floor, 0, 1);
  const ceiling = clamp(config.ceiling, 0, 1);
  const base = clamp(config.base, floor, ceiling);

  if (aggregatedConfidence === undefined) {
    // No confidence available — use base threshold
    return base;
  }

  const conf = clamp(aggregatedConfidence, 0, 1);

  // High confidence → ease the threshold (lower required agreement);
  // Low confidence → tighten the threshold (require higher agreement).
  //
  // Formula: threshold = base - (conf - 0.5) * sensitivity
  //   conf = 1.0 → threshold decreases by sensitivity/2
  //   conf = 0.5 → threshold stays at base
  //   conf = 0.0 → threshold increases by sensitivity/2
  const sensitivity = config.sensitivity ?? 0.2;
  const adjusted = base - (conf - 0.5) * sensitivity;

  return clamp(adjusted, floor, ceiling);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

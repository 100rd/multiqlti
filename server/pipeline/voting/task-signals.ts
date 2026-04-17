// server/pipeline/voting/task-signals.ts
// Collects and normalises task signals from pipeline input and upstream stage outputs.
// Signals flow into the threshold resolver when the voting strategy is in `task_signal` mode.

import type { TaskSignal, TaskSignalBag } from "@shared/types";

// ─── Signal keys the system recognises ───────────────────────────────────────

/** Well-known signal constants.  Users may also emit arbitrary string signals. */
export const KNOWN_SIGNALS = {
  HIGH_RISK: "signal:high_risk",
  LOW_STAKES: "signal:low_stakes",
  REQUIRES_CONSENSUS: "signal:requires_consensus",
  FAST_PATH: "signal:fast_path",
} as const;

// ─── Signal collector ─────────────────────────────────────────────────────────

/**
 * Build a `TaskSignalBag` from:
 *  1. The pipeline's `tags[]` (each tag becomes a plain signal)
 *  2. An explicit `risk_level` field
 *  3. Upstream-stage signals already accumulated into the bag
 *
 * Order: tags → riskLevel → upstream — later entries do NOT override earlier
 * ones; they accumulate.
 */
export function collectSignals(params: {
  tags?: string[];
  riskLevel?: "low" | "medium" | "high" | "critical";
  upstreamSignals?: TaskSignal[];
}): TaskSignalBag {
  const signals: TaskSignal[] = [];
  const seen = new Set<string>();

  const add = (sig: TaskSignal): void => {
    if (!seen.has(sig.key)) {
      seen.add(sig.key);
      signals.push(sig);
    }
  };

  // Tags → plain signals
  for (const tag of params.tags ?? []) {
    add({ key: tag, source: "tag" });
  }

  // risk_level → canonical signals
  if (params.riskLevel) {
    if (params.riskLevel === "high" || params.riskLevel === "critical") {
      add({ key: KNOWN_SIGNALS.HIGH_RISK, source: "risk_level", value: params.riskLevel });
    } else if (params.riskLevel === "low") {
      add({ key: KNOWN_SIGNALS.LOW_STAKES, source: "risk_level", value: params.riskLevel });
    }
  }

  // Upstream signals emitted by prior stages
  for (const sig of params.upstreamSignals ?? []) {
    add(sig);
  }

  return { signals };
}

/**
 * Check whether a specific signal key is present in a bag.
 */
export function hasSignal(bag: TaskSignalBag, key: string): boolean {
  return bag.signals.some((s) => s.key === key);
}

/**
 * Return the first signal matching key, or undefined.
 */
export function getSignal(bag: TaskSignalBag, key: string): TaskSignal | undefined {
  return bag.signals.find((s) => s.key === key);
}

/**
 * Merge two bags — left wins on duplicate keys.
 */
export function mergeSignalBags(left: TaskSignalBag, right: TaskSignalBag): TaskSignalBag {
  const seen = new Set(left.signals.map((s) => s.key));
  const merged = [...left.signals];
  for (const sig of right.signals) {
    if (!seen.has(sig.key)) {
      seen.add(sig.key);
      merged.push(sig);
    }
  }
  return { signals: merged };
}

/**
 * GroundingStep — optional, flag-gated grounding via the existing
 * OmniscienceBoardProvider (blast-radius / source-stats).
 *
 * It NEVER blocks the run:
 *   - flag off               → { grounded: false }, no call;
 *   - no caller constructable → { grounded: false };
 *   - transport/board error  → { grounded: false } (non-fatal, logged-style).
 *
 * The caller is injected (callerFactory) so tests use mock-omniscience-board and
 * production wires the real workspace-scoped OmniscienceToolCaller. Any returned
 * evidence is treated as untrusted DATA by downstream steps (C3 framing happens
 * where it enters a prompt, not here).
 */
import { OmniscienceBoardProvider } from "../memory/omniscience-board-provider.js";
import type { OmniscienceToolCaller } from "../memory/omniscience-provider.js";

export interface GroundingStepConfig {
  /** memory.retrieval.omniscience.board.enabled (resolved by the caller). */
  enabled: boolean;
  /** Builds the workspace-scoped tool caller, or null when unavailable. */
  callerFactory: () => OmniscienceToolCaller | null;
}

export interface GroundingRunInput {
  query: string;
  entityId?: string;
  signal: AbortSignal;
}

export interface GroundingResult {
  grounded: boolean;
  evidence?: unknown;
}

export class GroundingStep {
  constructor(private readonly config: GroundingStepConfig) {}

  async run(input: GroundingRunInput): Promise<GroundingResult> {
    if (!this.config.enabled) return { grounded: false };

    let caller: OmniscienceToolCaller | null;
    try {
      caller = this.config.callerFactory();
    } catch {
      return { grounded: false };
    }
    if (!caller) return { grounded: false };

    const provider = new OmniscienceBoardProvider(caller);

    try {
      // Prefer a blast-radius query when an entity is known; this is the most
      // useful "what does changing X break" grounding signal.
      if (input.entityId) {
        const blast = await provider.blastRadius({ entityId: input.entityId });
        return { grounded: true, evidence: { blastRadius: blast } };
      }
      // No entity → we cannot ground structurally; degrade rather than block.
      return { grounded: false };
    } catch {
      // Board unreachable / malformed / forbidden: non-fatal degrade.
      return { grounded: false };
    }
  }
}

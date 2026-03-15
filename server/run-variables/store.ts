import type { RunVariableState } from "@shared/types";

/**
 * In-memory store for ephemeral run variables.
 *
 * Security contract:
 * - Variables are NEVER written to the database.
 * - On run success they are cleared immediately (status → "cleared").
 * - On run failure/cancellation they are preserved until the user explicitly clears
 *   them or the process restarts.
 * - The store never survives a process restart — callers must re-supply vars on retry.
 */
export class EphemeralVarStore {
  private store = new Map<string, RunVariableState>();

  set(runId: string, variables: Record<string, string>): void {
    this.store.set(runId, {
      runId,
      variables,
      status: "active",
      createdAt: new Date(),
      clearedAt: null,
    });
  }

  get(runId: string): Record<string, string> | null {
    const entry = this.store.get(runId);
    if (!entry || entry.status !== "active") return null;
    return entry.variables;
  }

  getState(runId: string): RunVariableState | null {
    return this.store.get(runId) ?? null;
  }

  /** Called on successful run completion. Variables are cleared from memory. */
  clearOnSuccess(runId: string): void {
    const entry = this.store.get(runId);
    if (!entry) return;
    // Overwrite sensitive data before removing
    for (const key of Object.keys(entry.variables)) {
      entry.variables[key] = "";
    }
    this.store.delete(runId);
  }

  /** Called on run failure/cancellation. Variables are preserved for retry. */
  preserveOnFailure(runId: string, reason: string): void {
    const entry = this.store.get(runId);
    if (!entry) return;
    entry.status = "preserved";
    entry.preserveReason = reason;
  }

  /** Explicit user-triggered clear (e.g. "Clear & dismiss" button). */
  clearManually(runId: string): boolean {
    const entry = this.store.get(runId);
    if (!entry) return false;
    for (const key of Object.keys(entry.variables)) {
      entry.variables[key] = "";
    }
    this.store.delete(runId);
    return true;
  }

  hasPreserved(runId: string): boolean {
    const entry = this.store.get(runId);
    return entry?.status === "preserved";
  }
}

export const ephemeralVarStore = new EphemeralVarStore();

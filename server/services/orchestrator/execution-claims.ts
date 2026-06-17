/**
 * Per-iteration execution-claim registry (Task Groups v2 — C1 fix).
 *
 * The orchestrator runs single-process but is `await`-interleaved: when two
 * dependency completions race, both `onTaskCompleted` continuations can read a
 * fan-in/join node as `blocked`-with-all-deps-done and each try to launch it,
 * double-running the join (duplicate real-model spend; the 2nd completion
 * overwrites the 1st). This registry makes the blocked→ready→running claim
 * ATOMIC: `claim(iterationId, executionId)` returns true for exactly the first
 * caller in a tick and false thereafter, with NO `await` between the check and
 * the mark. Callers must skip any execution they could not claim.
 *
 * In-memory + single-process is sufficient (no DB lock): the orchestrator owns
 * the only writer. Scoped per iteration so re-runs start with a clean slate.
 */
export class ExecutionClaims {
  /** iterationId → set of execution ids already claimed (launched) this run. */
  private readonly claimed = new Map<string, Set<string>>();

  /**
   * Atomically claim `executionId` within `iterationId`. Synchronous — no
   * `await` inside — so the read-then-mark cannot be interleaved. Returns true
   * iff this call is the first to claim it; false if already claimed.
   */
  claim(iterationId: string, executionId: string): boolean {
    let set = this.claimed.get(iterationId);
    if (!set) {
      set = new Set<string>();
      this.claimed.set(iterationId, set);
    }
    if (set.has(executionId)) return false;
    set.add(executionId);
    return true;
  }

  /** Whether `executionId` has already been claimed in `iterationId`. */
  isClaimed(iterationId: string, executionId: string): boolean {
    return this.claimed.get(iterationId)?.has(executionId) ?? false;
  }

  /** Drop a claim so a deliberate re-run (retryTask) can re-launch it. */
  release(iterationId: string, executionId: string): void {
    this.claimed.get(iterationId)?.delete(executionId);
  }

  /** Forget an iteration's claims once it settles (bounded memory). */
  clear(iterationId: string): void {
    this.claimed.delete(iterationId);
  }
}

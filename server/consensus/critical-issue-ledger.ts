/**
 * Critical-issue ledger — the PURE structural state behind the consensus
 * "all critical issues closed" condition (one of the 4-condition AND).
 *
 * Lifecycle of an issue keyed by a stable `key`:
 *   - raise(key, ...)         → OPEN (idempotent: re-raising an OPEN issue is a
 *                               no-op; re-raising a CLOSED issue REOPENS it);
 *   - fix(key, round)         → CLOSED (resolution: "fixed");
 *   - dismiss(key, j, round)  → CLOSED only if `j` is a non-empty trimmed
 *                               justification; otherwise the issue STAYS OPEN
 *                               (fail-closed, MF-3 defense-in-depth).
 *
 * `allClosed()` is true iff there are no OPEN issues. The ledger never throws and
 * never mutates its input arrays — `applyAdjudication` returns a NEW ledger.
 *
 * The engine derives the consensus stability signal ONLY from this structural
 * state (+ counted external verdicts), NEVER from parsed untrusted text (MF-4).
 */
import type { DismissalInput } from "./verdict-schema";

export type IssueStatus = "open" | "closed";
export type IssueResolution = "fixed" | "dismissed";

export interface LedgerIssue {
  readonly key: string;
  readonly raisedBy: string;
  readonly summary: string;
  readonly status: IssueStatus;
  readonly resolution: IssueResolution | null;
  readonly dismissalJustification: string | null;
  readonly openedRound: number;
  readonly closedRound: number | null;
}

/** A voter-raised issue to fold into the ledger this round. */
export interface RaisedIssue {
  readonly key: string;
  readonly raisedBy: string;
  readonly summary: string;
}

/**
 * An immutable critical-issue ledger. All mutators return a NEW ledger; the
 * underlying map is never shared or mutated in place.
 */
export class CriticalIssueLedger {
  private constructor(private readonly issues: ReadonlyMap<string, LedgerIssue>) {}

  static empty(): CriticalIssueLedger {
    return new CriticalIssueLedger(new Map());
  }

  /** Snapshot of all issues (insertion order). */
  list(): readonly LedgerIssue[] {
    return Array.from(this.issues.values());
  }

  get(key: string): LedgerIssue | undefined {
    return this.issues.get(key);
  }

  /** True iff no issue is OPEN. */
  allClosed(): boolean {
    for (const issue of this.issues.values()) {
      if (issue.status === "open") return false;
    }
    return true;
  }

  hasOpen(): boolean {
    return !this.allClosed();
  }

  private withIssue(key: string, next: LedgerIssue): CriticalIssueLedger {
    const map = new Map(this.issues);
    map.set(key, next);
    return new CriticalIssueLedger(map);
  }

  /**
   * Raise an issue. If it does not exist, open it at `round`. If it exists and is
   * CLOSED, REOPEN it (a re-raised concern resets allClosed()). If it exists and
   * is already OPEN, no-op (keep the original openedRound + raisedBy).
   */
  raise(issue: RaisedIssue, round: number): CriticalIssueLedger {
    const existing = this.issues.get(issue.key);
    if (existing && existing.status === "open") return this;
    return this.withIssue(issue.key, {
      key: issue.key,
      raisedBy: existing?.raisedBy ?? issue.raisedBy,
      summary: issue.summary,
      status: "open",
      resolution: null,
      dismissalJustification: null,
      openedRound: existing?.openedRound ?? round,
      closedRound: null,
    });
  }

  /** Fold all this round's raised issues into the ledger. */
  raiseMany(raised: readonly RaisedIssue[], round: number): CriticalIssueLedger {
    let ledger: CriticalIssueLedger = this;
    for (const r of raised) ledger = ledger.raise(r, round);
    return ledger;
  }

  /** Close an issue as fixed by a plan edit. No-op if the issue is unknown. */
  fix(key: string, round: number): CriticalIssueLedger {
    const existing = this.issues.get(key);
    if (!existing) return this;
    return this.withIssue(key, {
      ...existing,
      status: "closed",
      resolution: "fixed",
      dismissalJustification: null,
      closedRound: round,
    });
  }

  /**
   * Dismiss an issue WITH a written justification. Fails CLOSED: a blank /
   * whitespace-only / empty justification leaves the issue OPEN (MF-3). No-op if
   * the issue is unknown.
   */
  dismiss(key: string, justification: string, round: number): CriticalIssueLedger {
    const existing = this.issues.get(key);
    if (!existing) return this;
    if (typeof justification !== "string" || justification.trim().length === 0) {
      // Fail-closed: a dismissal without justification does NOT close the issue.
      return this;
    }
    return this.withIssue(key, {
      ...existing,
      status: "closed",
      resolution: "dismissed",
      dismissalJustification: justification.trim(),
      closedRound: round,
    });
  }

  /**
   * Apply an adjudication round: raise new issues, then fix the `fixed[]` keys,
   * then dismiss the `dismissals[]` (each already carries a non-empty
   * justification per the parsed AdjudicationSchema, but dismiss() re-checks).
   * Returns a NEW ledger.
   */
  applyAdjudication(
    newlyRaised: readonly RaisedIssue[],
    fixed: readonly string[],
    dismissals: readonly DismissalInput[],
    round: number,
  ): CriticalIssueLedger {
    let ledger = this.raiseMany(newlyRaised, round);
    for (const key of fixed) ledger = ledger.fix(key, round);
    for (const d of dismissals) {
      ledger = ledger.dismiss(d.issue_key, d.dismissal_justification, round);
    }
    return ledger;
  }
}

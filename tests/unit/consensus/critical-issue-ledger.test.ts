/**
 * Unit tests for the pure CriticalIssueLedger (QA Section 8). Open/closed
 * lifecycle, allClosed(), fail-closed dismissal (MF-3), re-raise reopens,
 * immutability.
 *
 * Invoked by vitest unit project (vitest.config.ts include tests/unit/**).
 */
import { describe, it, expect } from "vitest";
import { CriticalIssueLedger } from "../../../server/consensus/critical-issue-ledger.js";

const issue = (key: string, summary = "s") => ({ key, raisedBy: "voter-1", summary });

describe("CriticalIssueLedger — lifecycle", () => {
  it("T-LEDG-1 a raised issue is OPEN until fixed or justified-dismissed", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1);
    expect(l.get("k1")?.status).toBe("open");
    expect(l.allClosed()).toBe(false);
  });

  it("T-LEDG-2 allClosed() is false while any issue is open", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).raise(issue("k2"), 1).fix("k1", 2);
    expect(l.allClosed()).toBe(false);
  });

  it("an empty ledger is allClosed()", () => {
    expect(CriticalIssueLedger.empty().allClosed()).toBe(true);
  });

  it("fix closes an issue with resolution 'fixed'", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).fix("k1", 2);
    expect(l.get("k1")?.status).toBe("closed");
    expect(l.get("k1")?.resolution).toBe("fixed");
    expect(l.get("k1")?.closedRound).toBe(2);
    expect(l.allClosed()).toBe(true);
  });
});

describe("CriticalIssueLedger — dismissal fail-closed (MF-3)", () => {
  it("T-LEDG-3 dismiss WITH justification closes the issue", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).dismiss("k1", "out of scope", 2);
    expect(l.get("k1")?.status).toBe("closed");
    expect(l.get("k1")?.resolution).toBe("dismissed");
    expect(l.get("k1")?.dismissalJustification).toBe("out of scope");
  });

  it("T-LEDG-4 dismiss WITHOUT justification leaves the issue OPEN (fail-closed)", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).dismiss("k1", "", 2);
    expect(l.get("k1")?.status).toBe("open");
    expect(l.allClosed()).toBe(false);
  });

  it("dismiss with whitespace-only justification leaves the issue OPEN", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).dismiss("k1", "  \n\t ", 2);
    expect(l.get("k1")?.status).toBe("open");
  });

  it("dismiss trims the stored justification", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).dismiss("k1", "  reason  ", 2);
    expect(l.get("k1")?.dismissalJustification).toBe("reason");
  });
});

describe("CriticalIssueLedger — raise idempotency + re-open", () => {
  it("re-raising an OPEN issue is a no-op (keeps openedRound)", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).raise(issue("k1", "newsummary"), 3);
    expect(l.get("k1")?.openedRound).toBe(1);
  });

  it("T-LEDG-8 re-raising a CLOSED issue REOPENS it (allClosed resets)", () => {
    const l = CriticalIssueLedger.empty().raise(issue("k1"), 1).fix("k1", 2).raise(issue("k1"), 3);
    expect(l.get("k1")?.status).toBe("open");
    expect(l.get("k1")?.resolution).toBeNull();
    expect(l.allClosed()).toBe(false);
  });

  it("fix/dismiss on an unknown key is a no-op", () => {
    const l = CriticalIssueLedger.empty().fix("nope", 1).dismiss("nope", "j", 1);
    expect(l.list()).toHaveLength(0);
  });
});

describe("CriticalIssueLedger — applyAdjudication + immutability", () => {
  it("raises new issues, fixes some, dismisses others (with justification) in one apply", () => {
    const l = CriticalIssueLedger.empty()
      .raise(issue("existing"), 1)
      .applyAdjudication(
        [issue("new1"), issue("new2")],
        ["existing"],
        [{ issue_key: "new2", dismissal_justification: "duplicate of new1" }],
        2,
      );
    expect(l.get("existing")?.status).toBe("closed");
    expect(l.get("new1")?.status).toBe("open");
    expect(l.get("new2")?.status).toBe("closed");
    expect(l.allClosed()).toBe(false); // new1 still open
  });

  it("is immutable — mutators return a new ledger, the original is unchanged", () => {
    const base = CriticalIssueLedger.empty().raise(issue("k1"), 1);
    const fixed = base.fix("k1", 2);
    expect(base.get("k1")?.status).toBe("open");
    expect(fixed.get("k1")?.status).toBe("closed");
  });
});

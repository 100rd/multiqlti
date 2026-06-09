/**
 * Unit tests for the pure practice-card review-state machine and supersession.
 *
 * Legal transitions:
 *   pending_verification --verify(pass)--> pending_review
 *   pending_verification --verify(fail|needs_changes)--> rejected
 *   pending_review       --review(accept)--> accepted (status=active)
 *   pending_review       --review(reject)--> rejected
 * Everything else is illegal and must throw InvalidTransitionError.
 * Only an accept may set status='active'.
 */
import { describe, it, expect } from "vitest";
import {
  transitionReviewState,
  applySupersession,
  InvalidTransitionError,
} from "../../../server/knowledge/practice-card-service";

describe("transitionReviewState — legal transitions", () => {
  it("verify pass: pending_verification -> pending_review (no status change)", () => {
    const r = transitionReviewState("pending_verification", { kind: "verify", verdict: "pass" });
    expect(r.reviewState).toBe("pending_review");
    expect(r.setActive).toBe(false);
  });

  it("verify fail: pending_verification -> rejected", () => {
    const r = transitionReviewState("pending_verification", { kind: "verify", verdict: "fail" });
    expect(r.reviewState).toBe("rejected");
    expect(r.setActive).toBe(false);
  });

  it("verify needs_changes: pending_verification -> rejected", () => {
    const r = transitionReviewState("pending_verification", { kind: "verify", verdict: "needs_changes" });
    expect(r.reviewState).toBe("rejected");
  });

  it("review accept: pending_review -> accepted + setActive", () => {
    const r = transitionReviewState("pending_review", { kind: "review", decision: "accept" });
    expect(r.reviewState).toBe("accepted");
    expect(r.setActive).toBe(true);
  });

  it("review reject: pending_review -> rejected", () => {
    const r = transitionReviewState("pending_review", { kind: "review", decision: "reject" });
    expect(r.reviewState).toBe("rejected");
    expect(r.setActive).toBe(false);
  });
});

describe("transitionReviewState — illegal transitions", () => {
  it("cannot verify a card already in pending_review", () => {
    expect(() =>
      transitionReviewState("pending_review", { kind: "verify", verdict: "pass" }),
    ).toThrow(InvalidTransitionError);
  });

  it("cannot review a card still pending_verification", () => {
    expect(() =>
      transitionReviewState("pending_verification", { kind: "review", decision: "accept" }),
    ).toThrow(InvalidTransitionError);
  });

  it("cannot transition out of accepted", () => {
    expect(() =>
      transitionReviewState("accepted", { kind: "review", decision: "reject" }),
    ).toThrow(InvalidTransitionError);
  });

  it("cannot transition out of rejected", () => {
    expect(() =>
      transitionReviewState("rejected", { kind: "verify", verdict: "pass" }),
    ).toThrow(InvalidTransitionError);
  });
});

describe("applySupersession", () => {
  it("links the accepted card and superseded cards reciprocally", () => {
    const result = applySupersession("card-new", ["card-old-1", "card-old-2"]);
    expect(result.acceptedSupersedes).toEqual(["card-old-1", "card-old-2"]);
    expect(result.supersededUpdates).toEqual([
      { id: "card-old-1", status: "superseded", supersededBy: ["card-new"] },
      { id: "card-old-2", status: "superseded", supersededBy: ["card-new"] },
    ]);
  });

  it("ignores empty supersedes list", () => {
    const result = applySupersession("card-new", []);
    expect(result.acceptedSupersedes).toEqual([]);
    expect(result.supersededUpdates).toEqual([]);
  });

  it("rejects self-supersession", () => {
    expect(() => applySupersession("card-new", ["card-new"])).toThrow(InvalidTransitionError);
  });

  it("de-duplicates the supersedes list", () => {
    const result = applySupersession("card-new", ["card-old", "card-old"]);
    expect(result.acceptedSupersedes).toEqual(["card-old"]);
    expect(result.supersededUpdates).toHaveLength(1);
  });
});

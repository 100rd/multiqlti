# ADR-004: One MR per task — ticket-direct intake, spec as input, MR as result

- **Status**: accepted (Block A implemented; Blocks B/C planned)
- **Date**: 2026-07-18
- **Owners**: factory intake (Track-3/5), consilium loop delivery

## Context

The Track-3/5 tracker intake crystallised every matched ticket into a **committed-spec
PR/MR** (`docs/specs/jira-<KEY>-….md`); merging that spec fired the SPEC-1 spec-watch,
which launched the loop, which later opened a **second** MR with the implementation.
Live use against a real Jira/GitLab project (PDO-850, 2026-07-18) surfaced the problem:

1. **Two MRs per task** — a spec-only MR carries no work product, yet demands a review
   and a merge, and permanently deposits `docs/specs/*` files into the target repo.
2. **Wrong MR semantics for the host forge.** In the team's GitLab workflow an MR is a
   FINISHED piece of work (code written and tested, ready for full human review); an
   unfinished one is a Draft. A spec is neither — it is the task definition
   (condition-of-done), i.e. an *input*, not a deliverable.

## Decision

Adopt these invariants for factory intake and delivery:

1. **An MR is a result, never an input.** Exactly ONE MR exists per task — the
   implementation MR the loop produces. It opens as **Draft** while the loop works
   (Block B) and is marked ready only when code + tests + the loop's internal review
   have converged. A spec-only PR/MR is never created.
2. **A spec is the task definition.** It arrives via one of two equal intake sources:
   - **a tracker ticket** (Jira/GitLab/…): consent label + explicit acceptance
     criteria in the ticket (or synthesised criteria approved in the ticket);
   - **a spec file in the repo** (`docs/specs/**`, SPEC-1): committed by a HUMAN
     through the team's normal flow — that commit *is* the scope approval.
   Both normalise into the same task shape `{source, title, problem, scope, criteria,
   repo}` and the same launch core (`launchReviewWithDedup`).
3. **Scope approval moves to the source.** Ticket path: the consent label (plus, when
   criteria were synthesised, a human `criteria-ok` signal — Block C) replaces the old
   "merge the spec PR" gate. Repo-spec path: unchanged (the human commit is the gate).
4. **T6 stands.** Any automatically-fired launch is review-only (`maxRounds: 1`);
   escalation to DEVELOPING remains a human action. A future dark-factory profile
   (omnius) may relax this behind an explicit per-trigger opt-in — never by default.
5. **Claim protocol (Block C).** Multiple engines (multiqlti, omnius) watch the same
   sources; the claim marker in the ticket + the per-ticket dedup anchor
   (`ticket:<kind>:<key>`) form the mutex — first claimer works, others skip.

## Block A (implemented here)

`TrackerEventTriggerConfig.intakeMode: "spec-pr" | "direct"` (default `"spec-pr"`,
byte-identical for existing triggers). In `"direct"` mode the Jira poller skips
crystallisation entirely and calls `launchTicketReview` → `launchReviewWithDedup`:

- dedup anchor `ticket:jira:<KEY>` rides the spec-dedup seam (one active loop per
  ticket, not per repo);
- provenance `spec.source = {kind: "jira", ref, url}` — write-back can join later;
- the objective is built by the SAME `buildSpecInstruction` (DoD-first, byte-clamped)
  the spec-watch path uses;
- tickets without criteria (after synthesis) get the need-criteria comment and are
  retried on edit — no watermark;
- `"launched"` → pickup comment + optional transition + watermark;
  `"skipped-dedup"` → watermark only; `"failed"`/`"skipped"` → retry next cycle.

## Consequences

- The target repo history contains only real work (implementation MRs); no
  `docs/specs/*` deposits from tickets. Repo-resident specs remain fully supported
  for teams that author them deliberately.
- The old spec-PR path stays the default until operators opt triggers into
  `"direct"`; Track-5 connectors (Azure/Linear/ClickUp/…) can adopt the same seam
  incrementally.
- Blocks B (Draft-first implementation MR + ready flip on convergence) and C
  (claim marker + `criteria-ok` approval signal) complete the pipeline; until B
  lands, a direct-intake loop still opens its implementation MR at delivery time
  (non-Draft), which is acceptable for review-only launches.

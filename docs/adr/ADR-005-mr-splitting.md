# ADR-005: Splitting a large verdict into several small, well-sized MRs

- **Status**: accepted (Phase 1 implemented; Phases 2–3 proposed)
- **Date**: 2026-07-29
- **Context anchor**: PDO-819 develop round shipped ALL 6 action points in one MR
  (~100 changed files across many components) — the operator closed it as
  unreviewable. ADR-004 fixed *what* an MR is (a result); this ADR fixes *how big*
  one may be.

## Problem

A develop round implements the WHOLE verdict in one branch → one MR. A verdict
routinely carries 5–10 heavyweight action points across priority tiers (P0..P3),
so the single MR grows beyond human review capacity. The loop's value collapses
exactly at its human gate.

## Decision

An MR must be a REVIEWABLE unit. The loop reaches the full verdict through
multiple small MRs, using its own round mechanism as the splitter.

### Phase 1 — tier-per-round (implemented)

`develop(loopId, { scope })` with `scope: "top"` filters the verdict to the
HIGHEST priority tier still present (P0 → P1 → P2 → P3 → unprioritized;
`filterDevScope`, pure + unit-tested). Flow:

```
verdict (2×P0 + 3×P1 + 2×P2)
  → develop scope:"top"  → MR₁ = the 2 P0s   → review → merge
  → next review round (auto) → verdict = remainder
  → develop scope:"top"  → MR₂ = the 3 P1s   → review → merge
  → …until convergence
```

The UI's "Hand off to SDLC" opens a chooser — "Only <tier> (n) — small MR" vs
"All action points (m)" — whenever the top tier is a strict subset. Sequential by
design: each tier waits for the previous merge, which keeps every MR based on
reviewed, merged code (no stacked-conflict class).

### Phase 2 — stacked MRs in one round (proposed)

For operators who want the whole verdict IN FLIGHT at once: the executor splits
the verdict into tier chunks, builds them in one worktree lineage, and pushes a
BRANCH STACK — MR₁ (P0 → main), MR₂ (P1 → branch₁), MR₃ (P2 → branch₂) — reviewed
and merged bottom-up (Graphite-style). Requires FSM surgery: `prRef` becomes a
stack, `awaiting_merge` gates each level, partial-merge states. Deliberately a
separate change; Phase 1 covers the need sequentially.

### Phase 3 — size-aware grouping ("правильно оценена")

Priority is a proxy; the real budget is blast radius. The planner estimates the
files each action point touches (repo-map assisted) and groups APs into MR-sized
chunks under a byte/file budget (e.g. ≤20 files per MR), splitting a tier or
merging small tiers as needed. The verdict then presents estimated MR sizes
BEFORE the operator commits to a scope.

## Consequences

- Phase 1 changes no FSM semantics: absent scope stays byte-identical; each round
  still produces exactly one MR, only its contents narrow.
- Multi-round convergence takes more wall-clock (review+merge per tier) — the
  accepted cost of reviewability.
- Phases 2–3 are additive follow-ups; nothing in Phase 1 blocks them.

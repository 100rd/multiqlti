# SPEC: The Experience plane — "Dream" distillation

> Status: **spec / design** — the concrete mechanism for the Experience plane named as
> homeless in [knowledge-planes.md §4](knowledge-planes.md). Pattern origin: the QoderWake
> "Waker" architecture's *Memory Dream* (a background summariser that compresses raw sessions
> into compact facts + a global profile). This spec ADOPTS the pattern and **grounds it in our
> verification**: an experience item earns trust from a *measured outcome*, never from an
> agent's own opinion. Aligned to the platform canon in `100rd/genai-enablement`
> (ADR-0002 skills, ADR-0003 quality-gated Done, Omniscience ADR-0015 experience-out-of-scope).
> Humans own decisions; L4 never L5.

## 0. One-paragraph summary

Every consilium loop leaves a rich raw trail (dispute outputs, verdicts, per-criterion
verification, the single-verifier's confirm/refute, execution traces, trust telemetry). Today
that trail is write-only — it powers observability, then dies. The **Dream** is a background,
scheduled, LLM-driven process that reads those raw sessions and distils them into small,
structured, provenance-and-freshness-bearing **Experience items** in a store separate from
Omniscience (state) and from the SKILL.md registry (capability). The planner reads relevant
Experience items when it builds a loop's plan, so the factory stops starting cold. Crucially,
an item is only marked `verified` if our *independent* verification (tests / single-verifier /
human merge) confirmed the thing it summarises — the Dream distils, it does not decide truth.

## 1. Why a distiller, and why grounded

- **Context overflow (Waker's original motivation):** raw sessions are enormous; you cannot feed
  a loop its full history. You feed it *distilled* facts.
- **The homeless plane (ours):** knowledge-planes.md §4 said the Experience plane has no home and
  no distillation mechanism. The Dream is that mechanism.
- **The grounding difference (the load-bearing divergence from Waker):** Waker rolls a skill back
  when it "got worse" — a subjective, self-reported judgment, i.e. exactly the reward-hacking /
  Goodhart risk. We already built the antidote this cycle: independent per-criterion
  verification, a fresh single-verifier (REFUTE-by-default), the grounding-ratio metric, and the
  human merge gate. **The Dream inherits that ground truth.** An Experience item's confidence is a
  function of *how it was verified*, not of any agent asserting it worked.

## 2. What the Dream reads (raw sessions → evidence)

Per loop, keyed by `(repo, archetype, round)`, the Dream reads only already-persisted data
(read-only; it never mutates state or code):

| Source | What it yields |
|---|---|
| `consilium_loop_rounds.open_action_points` / verdict | the problems + their acceptance criteria (DoD) |
| `execution_trace` (per criterion) | method (test-run/judge/manual-ops/…), ran, passed, `passedAtFinal`, `timedOut`, `weakCriterion`, fix-iteration count |
| single-verifier round output | per-AP `closed/still-open/regressed` + justification (the independent confirmation) |
| dispute executions | how debaters framed the problem; disagreements the judge resolved |
| trust telemetry | grounding ratio, method mix, planner archetype proposed-vs-overridden |
| git integration branch | the actual diff/commits that closed (or failed to close) each AP |
| final state | converged / stopped_cap / escalated + `openRemainder` |

The **diff + the independent verdict together** are the ground truth: "this change, verified by
*this* method, did/did not close *this* criterion on *this* repo."

## 3. The Experience item (output schema)

The Dream emits compact items, not prose. Proposed shape (jsonb; no new heavy entity — a table
or an Omniscience-adjacent partition, §7):

```
ExperienceItem {
  id
  scope:        { repo, archetype, criterionClass }   // where it applies
  claim:        string            // ONE distilled fact/pattern, e.g.
                                  // "coverage-gate criteria on <repo> close by adding
                                  //  --cov-fail-under to pyproject + a CI gate, not per-test edits"
  evidence:     { loopId, round, apTitle, diffRef }[]  // links back to raw sessions (auditable)
  verification: { method, outcome, groundingRatioAtTime } // HOW it was confirmed — the grounding
  confidence:   'verified' | 'observed' | 'refuted'   // verified ⇐ independent confirmation only
  successDelta: number | null     // measured effect if this pattern was reused (ADR-0002 R2)
  provenance:   { createdAt, dreamRunId, sourceLoops[] }
  freshness:    { lastConfirmedAt, decayPolicy }      // §6
  relatedComponents: string[]     // links into Omniscience state (state ≠ experience; §5)
}
```

`confidence` is the crux: **`verified` requires that our independent verification (test-run pass,
single-verifier `closed`, human merge) confirmed the underlying result.** A pattern the coder
*believes* worked but that the verifier refuted becomes `refuted` — a negative lesson, equally
valuable and equally stored.

## 4. When the Dream runs

- **Post-loop (incremental):** on a loop reaching a terminal state (converged/stopped_cap/…),
  distil that loop into item candidates. Cheap, timely.
- **Scheduled (consolidating):** a periodic pass (a trigger/cron over the daemon, like
  Waker — and like our triggers→loops) re-reads recent items, merges duplicates, decays stale
  ones, recomputes `successDelta` from any reuse. This is the "global profile" consolidation.
- **Never on the hot path:** the Dream must not block a running loop; it is background, and a loop
  never *waits* on it. If the Dream is down, loops run cold (today's behaviour) — safe degrade.

## 5. Boundaries (why this is a plane, not a dumping ground)

Per knowledge-planes.md §3, the Dream writes ONLY to the Experience plane and must not blur:
- **Experience ≠ State.** It links to Omniscience components (`relatedComponents`) but never writes
  the state graph; Omniscience stays the source of "what is now" (ADR-0015).
- **Experience ≠ Skill.** The Dream may *propose* a SKILL.md patch (ADR-0002 R2) when a pattern is
  repeatedly `verified` — but the patch enters the trust envelope (unverified→verified→deprecated)
  and graduates only on measured `successDelta`, never because the Dream said so. The patch path
  is CODEOWNERS-gated (human owns the decision).
- **Experience ≠ Repo facts.** "This repo uses uv" is a *fact* (the repo profile). "Coverage gates
  here close via pyproject" is a *pattern with an outcome* — an Experience item. Facts are static;
  items carry verification + freshness.

## 6. Freshness, decay, self-correction (anti-Goodhart)

The failure mode of any learned memory is a stale "best solution" that keeps being applied after
it stopped working. Defences:
- Every item carries `lastConfirmedAt` + a `decayPolicy`. An item unconfirmed for N reuses or T
  time drops from `verified` to `observed` (still shown, but weighted down at planning).
- **Reuse re-grounds it:** when the planner applies an item and the resulting loop's independent
  verification passes, `lastConfirmedAt` refreshes and `successDelta` updates; if it fails, the
  item is demoted / flagged `refuted`. So the plane *self-corrects from outcomes*, not from age
  alone — the same ground-truth loop that keeps the factory honest keeps its memory honest.
- Contradiction handling: two items with opposite outcomes on the same `scope` → keep both,
  surface the conflict at planning ("this worked here / failed there"), let the fresher-verified
  one lead. Never silently overwrite.

## 7. Where it physically lives (the open question, narrowed)

Options, in preference order:
1. **A store beside Omniscience, linked to it** — Experience items reference Omniscience entity ids
   (`relatedComponents`), so "why did X happen" (state) and "how we solved X, verified" (experience)
   are one query apart but two planes. Best fit for the four-plane model; needs the cross-repo ADR.
2. **A multiqlti-local table** (fastest to ship; proving-ground first, then graduate to a shared
   plane per the ADR-0002 "iterate in multiqlti → graduate to omnius/canon" pattern).
3. Reuse `memories`/`lessons` (already exist, unread) as the substrate — but only if the read path
   (§8) is built at the same time; a store without a reader is worthless.

Recommendation: ship (2) in multiqlti behind a kill-switch, propose (1) as a genai-enablement ADR.

## 8. The read path (or none of this matters)

The single discipline that separates a real Experience plane from another dead `lessons` table:
**every write has a read.** The read point is the **planner** (`plan()`), at loop entry, alongside
skill selection and repo facts (knowledge-planes.md §2). The planner queries Experience items by
`scope = (this repo, this archetype, the criterion classes in the verdict)`, ranks by
`confidence × freshness`, and injects the top-K as a "prior experience" preamble — fenced/clamped
like all untrusted-ish context, byte-bounded like the repo-map. It biases the plan (archetype,
methods, which fixes to try first) without dictating it. Off (kill-switch) ⇒ loops run cold,
byte-identical to today.

## 9. Staging (each shippable, inert-by-default, kill-switched)

- **DREAM-0** — this spec.
- **DREAM-1 — write:** post-loop incremental distiller → Experience items (multiqlti-local table).
  No read yet; just accumulate + inspect quality. `experiencePlane.enabled` default off.
- **DREAM-2 — read:** planner reads top-K items at plan time (the closed loop). Measure whether
  cold-start rounds drop.
- **DREAM-3 — consolidate:** scheduled pass (dedup/decay/successDelta), the "global profile".
- **DREAM-4 — skill feedback:** repeatedly-verified patterns propose SKILL.md patches into the
  ADR-0002 trust envelope (human/CODEOWNERS-gated, success-delta graduation).
- **DREAM-5 — graduate:** genai-enablement ADR for the cross-repo Experience plane beside
  Omniscience; omnius consumes it.

## 10. Contrast with Waker (for the record)

| | Waker Dream | Our Dream |
|---|---|---|
| Distils raw sessions → compact facts | ✅ | ✅ (same core idea) |
| Home | per-waker local `.versions/` profile | separate Experience plane, four-plane-scoped |
| Truth source | self-reported "got better/worse" | **independent verification** (tests / single-verifier / merge) |
| Skill self-edit | git commit + subjective rollback | ADR-0002 trust envelope + **success-delta** graduation |
| Cross-repo / shared | no (isolated) | yes (planned, beside Omniscience) |

Waker showed how an agent learns fast; grounding it in our verification is how the learning stays
honest. That is the whole difference, and it is deliberate.

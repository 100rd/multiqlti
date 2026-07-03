# Design: Knowledge planes — how an agent assembles a complete picture before acting

> Status: **design note / evolving**, written from multiqlti (the proving ground) but
> **aligned to the platform canon** in `100rd/genai-enablement` (the coordination hub):
> the glossary (`docs/platform-glossary.md`), ADR-0002 (skills registry), ADR-0003
> (unified SDLC standard), and Omniscience ADR-0015 (experience out of scope).
> This note proposes a shared model; the cross-repo version should graduate to a
> genai-enablement ADR. Humans own decisions; agents do the work (L4, never L5).

## 1. Why "memory" is the wrong single word

"Memory" collapses four *different* kinds of knowledge that live in different places, change
at different rates, and are read at different moments. Conflating them is how such systems
rot — a repo-specific fact leaks into a generic skill and the skill starts lying; a stale
"best solution" keeps being applied after it stopped working (Goodhart on memory). So we
name **four planes**, with hard boundaries.

| Plane | Holds | Nature | Canonical home | Read at |
|---|---|---|---|---|
| **State** (Omniscience) | platform objects, relations, "why it is what it is now" | current, operational | Omniscience graph (bitemporal, MCP) | diagnosis, blast-radius, context |
| **Experience** ("quadrant") | decisions + outcomes — how a problem was solved, how it connects | accumulated, cross-run, provenance-bound | *(no home yet — see §4)* | **planning** |
| **Skill** | generic capability — "how we develop in Go / Terraform" | slow, repo-agnostic, curated | genai-enablement SKILL.md registry (ADR-0002) | agent gets a skill for the work type |
| **Repo facts** | concrete grounding of one repo — "this repo uses uv; tests = verify_mvp.py" | factual, per-repo | Omniscience (ingests code/IaC/CI) + a local repo profile | agent on entering a repo |

## 2. The composition — assembling the full picture at planning

The operator's framing (2026-07): an agent entering a loop does **not** start cold. The
planner assembles all four:

```
task → planner →
  select SKILL(s) for the work type      generic: "this is Go development" → golang-dev SKILL.md
  + read REPO FACTS                       specific: "here it's uv, tests run so, conventions X"
  + query EXPERIENCE (quadrant)           "we solved this class before by …; it connects to component Y"
  + consult STATE (Omniscience)           "current platform state / blast radius"
= a complete picture BEFORE the agent acts
```

Skill = *how in general*; repo facts = *how exactly here*; experience = *how we solved it and
what it touches*; state = *what is true right now*. None substitutes for another.

## 3. Boundaries that must not blur

1. **Skill ≠ repo facts.** Skill: "idiomatic Go tests." Repo facts: "*this* Go repo runs
   `go test ./...` with *these* fixtures." A repo fact inside a skill makes the skill wrong on
   the next repo.
2. **Repo facts ≠ experience.** Facts are static ("uv"). Experience is a decision + outcome
   with provenance and freshness ("when we hit a coverage-gate criterion, *this* approach
   passed *on this repo* at *this time*").
3. **Experience ≠ state.** Experience is the history of *actions and why they were chosen*.
   Omniscience is the *state* those actions produced. Per Omniscience ADR-0015, experience is
   deliberately **out of** the state graph — the quadrant is a separate plane by decision, not
   omission.
4. **Scope / visibility.** Experience is cross-repo (multiqlti + omnius). A loop over one
   project must not read another tenant's decisions without a boundary — same fail-closed
   posture as Omniscience's workspace-scoped tokens.

## 4. Where the Experience plane lives (the open question)

Omniscience won't hold it (ADR-0015). Today its fragments are scattered and mostly write-only:
- multiqlti: a `lessons` table (unread by the loop), `memories`, and — post-2026-07 —
  **trust telemetry** (grounding ratio, planner track record) which is the *raw material* of
  experience (outcomes of decisions), and `execution_trace` (what each loop did).
- omnius: the `accumulated-lesson` skill type.
- ADR-0002 R2 already routes *some* experience INTO skills: agents improve a SKILL.md from
  lessons, trust-gated by the success-delta lifecycle. So the Experience plane is partly a
  **feeder of the Skill plane**, not only a standalone store.

> **Concrete mechanism:** the distillation is specified in [experience-plane-dream.md](experience-plane-dream.md) (the "Dream" — a grounded adaptation of QoderWake's Memory Dream).

**The discipline that makes it real (or it's just another unread `lessons` table):** every
experience item needs *two ends* — a **write trigger** (on loop close-out: what was tried, the
verdict, what the verifier confirmed/refuted) and a **read point** (the planner's prompt build,
§2). Memory without a reader changes no behavior. And every item carries provenance + freshness
so a stale "best solution" is re-evaluated, not blindly re-applied.

## 5. How this session's work already sits on these planes

- **Repo facts:** per-repo `testCommand` map, the review-context `repo-map` (from
  `workspace_symbols`) — the beginning of a per-repo profile.
- **Experience (raw):** `execution_trace` + trust telemetry record outcomes; not yet
  distilled or read back.
- **State:** Omniscience is the intended memory backend (behind a flag today).
- **Skill:** the thin `test-author/coder/research` catalog is the *selection* mechanism;
  ADR-0002's rich SKILL.md registry is the destination.

And the quality-gated Done we built this session (per-criterion verification, single-verifier,
verify-before-merge) is the **precondition** for a trustworthy Experience plane: you can only
learn "this solution worked" if "worked" is a grounded verdict (ADR-0003), not process-done.

## 6. Build order (highest value / lowest risk first; no code in this note)

1. **Repo profile** — unify `testCommand` + repo-map + accumulated facts into one growing
   per-repo object, read at loop entry. Foundation exists.
2. **Close the Experience→planner loop** — feed trust telemetry back into archetype/skill
   selection ("on this repo, repo-assessment confirmed 90%"). Not a new entity — a read point.
3. **Rich skills via ADR-0002** — SKILL.md registry consumed by the planner; the experience
   lifecycle (unverified→verified→deprecated) improves them.
4. **Experience plane / quadrant** — a queryable decisions+outcomes store, built through the
   Omniscience *approach* (graph) but as a **separate plane**, linked to but not merged with
   the state graph. This is the cross-repo piece that most wants a genai-enablement ADR.

## 7. Open questions

- Physical home + schema of the Experience plane (graph partition? a store beside Omniscience?
  a genai-enablement-governed artifact?).
- How much experience feeds skills (ADR-0002 R2) vs stays a standalone planner input.
- Freshness/TTL and provenance model for experience so it self-corrects.
- Tenant-visibility boundaries on cross-repo experience.

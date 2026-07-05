# SPEC: Spec-as-Task — a committed spec/ADR is the unit of work

> Status: **spec / design**. The factory's **execution substrate**: the durable, version-controlled
> unit of work is a **committed spec** (under `docs/specs/`) or **ADR** (under `docs/adr/`), not a
> raw chat message or a raw ticket. A default repo-watch trigger fires a consilium loop when a new
> *ready* spec/ADR lands. Every other intake — a Jira ticket, a GitHub issue, a human idea — is
> funnelled **through** a committed spec first. This is the single execution route.
> Companion to [task-tracker-triggers.md](task-tracker-triggers.md) (the tracker intake that
> *produces* specs), [loop-triggers.md](loop-triggers.md), [loop-consolidation.md](loop-consolidation.md)
> (the spec = the "task envelope"/intent I1), and [standing-role.md](standing-role.md). Aligned to
> the platform canon in `100rd/genai-enablement` (ADR-0003 quality-gated Done). **Humans own decisions;
> L4 never L5** — and here the human owns TWO gates: approve the *spec* (what to build) and merge the
> *code PR* (ship it).

## 1. Why the spec is the unit (not the ticket, not the chat)

- **Intent must be crystallised before expensive execution.** A raw ticket ("fix the flaky login")
  is under-specified; a loop that runs on it guesses. A spec pins the problem, scope, and
  **acceptance criteria** — which become the loop's verification criteria (ADR-0003 Done).
- **Version-controlled, reviewable, durable.** A spec is a file in git: diffable, PR-reviewable,
  attributable, and permanent. The task queue is the repo history, not an ephemeral message bus.
- **One execution route.** Tickets (via connectors), ADRs, and human ideas all converge on
  "a committed spec under `docs/specs|adr/`". The loop only ever consumes a spec — it never parses a
  ticket directly. This keeps the loop's input uniform and the intake pluggable.
- **Two human gates, cleanly separated.** The human approves the **spec** (the *what* — via the spec
  PR) and later merges the **code PR** (the *how/ship*). The factory automates only the work between
  them. Strong L4.

## 2. The spec artifact (schema)

A spec is a Markdown file with YAML frontmatter, under `docs/specs/<slug>.md` (or an ADR under
`docs/adr/NNNN-<slug>.md`). Minimal contract the watch-trigger and planner rely on:

```yaml
---
title:   "Short imperative title"
status:  draft | ready | in-progress | done   # only `ready` fires a loop (the consent gate)
source:  { kind: human | jira | github | gitlab | bitbucket | linear | azure, ref?, url? }  # provenance
repo:    <target repo path/slug>               # where the work lands (defaults to the spec's own repo)
role?:   <standing-role name>                  # optional: which Role owns this (skills+persona)
skills?: [ ... ]                               # optional explicit skill set (else derived from role/repo)
acceptanceCriteria:                            # the DoD → the loop's verification criteria (ADR-0003)
  - "<criterion, each testable/verifiable>"
---

## Problem            # what's wrong / the goal
## Scope              # in scope
## Out of scope       # explicitly excluded (bounds blast radius)
## Notes              # context, links, constraints
```

Rules: `acceptanceCriteria` is REQUIRED for `status: ready` (no criteria ⇒ not ready — a loop has
nothing to verify against). `source` is REQUIRED (auditability — where did this task come from).
An **ADR** is a spec whose `acceptanceCriteria` are "the decision is implemented + …"; a new ADR
under `docs/adr/` that implies work is a task too.

## 3. The watch trigger (spec/ADR → loop)

A **default, per-repo** `file_change` trigger (loop-triggers.md) watches `docs/specs/**` and
`docs/adr/**` on the default branch. It is the standard on-by-default intake (behind the master
`triggers.enabled` switch); a repo opts a path in via config.

- **Fires when:** a spec/ADR file is added or transitions to `status: ready` on the default branch
  (i.e. after its spec PR merges — §4). A `draft` spec never fires.
- **Maps to a loop:** `engineerInstruction` = the spec body (fenced); verification criteria =
  `acceptanceCriteria`; `repoPath` = `repo`; `skillIds` = `skills`/`role`. Provenance records the
  spec path + commit + `source`.
- **Rails (loop-triggers §4):** **dedup — one active loop per spec** (keyed by spec path); budget per
  repo/day; `cascadeDepth` (a loop that writes a new spec can't recurse past the cap); kill-switches
  per repo/path/class. On `status: ready → in-progress` the trigger marks the spec so re-runs don't
  double-fire.
- **Convergence:** a human writing `docs/specs/foo.md` and a connector committing the same file are
  indistinguishable to this trigger — one route, one set of rails.

## 4. The spec lifecycle (the two-gate flow)

```
intent (ticket / ADR / human idea)
   │  → normalise/synthesise into a spec file (status: draft)
   ▼
docs/specs/<slug>.md  →  SPEC PR  →  human reviews the INTENT  →  merge (status flips to ready)   [GATE 1: the WHAT]
   │  watch trigger fires
   ▼
consilium loop: assess → plan → develop → verify (criteria = acceptanceCriteria)
   │
   ▼
CODE PR (references the spec)  →  human reviews & merges                                            [GATE 2: ship]
   │  on merge: spec status → done (a small follow-up commit or the code PR flips it)
   ▼
write-back to the origin (if `source` is a ticket — see task-tracker-triggers.md §C)
```

**Default = spec PR (human approves intent before the factory builds).** For trusted, low-stakes
flows an operator may allow **auto-commit** of the spec to the default branch (skips gate 1) — a
per-repo/per-role policy, off by default. Even then gate 2 (the code PR merge) always stands.

## 5. Boundaries & safety

- **Only `ready` fires.** Drafts, WIP, and specs without `acceptanceCriteria` are inert. The
  ready-transition (a merged spec PR, or an explicit marker) is the consent that this intent is
  approved to execute.
- **The spec is reviewed intent.** Because it lands via a PR (default), a human has seen the *what*.
  Untrusted-origin text (a synthesised spec from a public ticket) is still fenced when it enters any
  prompt, and the spec PR is where a human sanity-checks it before it can fire.
- **Scope is bounded by the spec.** `Out of scope` + `acceptanceCriteria` constrain the loop; the
  loop verifies against the criteria and does not wander.
- **No silent drift.** The spec's `status` is the single source of truth for "is this being worked /
  done"; the loop updates it, never a hidden state.

## 6. Relationship to the rest

- **loop-consolidation:** the spec IS the intent/"task envelope" (I1); `acceptanceCriteria` are the
  criteria the per-criterion verification methods evaluate.
- **ADR-0003 (quality-gated Done):** Done = all `acceptanceCriteria` verified — the spec makes the
  gate explicit and per-task.
- **Standing Role:** a Role can own a `docs/specs/` path (its inbox); its skills/persona apply to
  every spec there; the Dream accumulates experience per (role, spec-class).
- **task-tracker-triggers:** connectors are *spec producers* — they turn a ticket into a committed
  spec (and write back to the ticket). They never fire loops directly.
- **Experience/Dream:** a completed spec + its verified outcome is prime Dream input (claim + DoD +
  evidence).

## 7. Staging (each shippable, inert-by-default, kill-switched)

- **SPEC-0** — this doc + the spec schema fixed.
- **SPEC-1 — watch:** the `docs/specs|adr` file_change trigger → loop, ready-gated, dedup, provenance.
  Human-authored specs only (no connectors yet). Proves the substrate.
- **SPEC-2 — status lifecycle:** the trigger flips `draft→ready→in-progress→done`; the code PR merge
  closes the spec; re-run discipline.
- **SPEC-3 — auto-commit policy:** the trusted per-repo/role option to skip gate 1.
- **SPEC-4 — ADR intake:** treat new `docs/adr/` entries as tasks (with the "implement the decision"
  criteria shape).
- **SPEC-5 — graduate:** a genai-enablement ADR making "committed spec = unit of work" a cross-repo
  contract; omnius consumes it for governed intake.

## 8. Open questions

- Spec vs ADR: same trigger, or distinct criteria-shapes/rails per kind?
- Where the spec status lives when the loop is mid-flight (frontmatter vs a sidecar vs loop state) —
  frontmatter is human-visible but churns the file; pick one.
- Multi-repo specs: a spec in repo A targeting repo B (`repo:` field) — cross-repo rails + auth.
- Spec supersession: a new spec that replaces an old one (`supersedes:`), and how the watch handles it.

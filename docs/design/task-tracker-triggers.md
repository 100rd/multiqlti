# SPEC: Task-tracker integrations & triggers — a ticket becomes a spec becomes a loop

> Status: **spec / design** (v2). The factory's **inbound front door**: a ticket created in a tracker
> (Jira, GitHub / GitLab / Bitbucket Issues, **Linear**, **Azure DevOps**) is turned into a
> **committed spec** (per [spec-as-task.md](spec-as-task.md)), the spec fires a consilium loop, and
> the loop **writes back to the origin ticket** at every step. Connectors are *spec producers +
> ticket updaters* — they never fire loops directly; the committed spec does (one execution route).
> Extends [loop-triggers.md](loop-triggers.md) (a new source class), composes with
> [spec-as-task.md](spec-as-task.md), [standing-role.md](standing-role.md),
> [knowledge-planes.md](knowledge-planes.md), and the [Dream](experience-plane-dream.md). Aligned to
> the platform canon in `100rd/genai-enablement`. **Humans own decisions; L4 never L5** — a ticket
> triggers the WORK; a human approves the spec (the *what*) and merges the PR (the *ship*), which
> closes the ticket.

## 1. The shape of the idea (v2 — spec-first)

```
  Jira / GitHub Issue / GitLab / Bitbucket / Linear / Azure DevOps
        │  a ticket is created / labeled / assigned
        ▼
   Tracker Connector ── synthesise/normalise ──►  docs/specs/<slug>.md  (status: draft, source: <tracker>)
        │  (+ comment back on the ticket: "picked up → spec at <link>")   │  SPEC PR → human approves the WHAT
        │                                                                  ▼  (status: ready on merge)
        │                                            spec-as-task watch trigger fires
        │                                                                  ▼
        │                                            Consilium Loop  (criteria = acceptanceCriteria)
        │◄─────────── write-back at every step ──────────────  Draft CODE PR (references spec + ticket)
        ▼
   human merges the code PR  ──►  ticket auto-closes ("Closes #N" / transition) + spec status → done
```

The ticket is the **raw intent**; the **committed spec** is the crystallised, reviewed intent (the
"task envelope"); the loop is execution; the PR is the artifact; the human merge ships it and closes
the ticket. We add an inbound source and a **spec-first gate**, not an autonomy tier.

## 2. Part A — Integrations (the six connectors)

A **Tracker Connector** is a small, uniform adapter per system doing three things: **watch** (learn of
new/changed tickets), **read** (fetch a ticket's fields), **write-back** (comment / transition /
link). All six reduce to the same interface; only the API dialect differs.

| Tracker | Watch | Read | Write-back | Auth |
|---|---|---|---|---|
| **Jira** | webhook (issue_created/updated) **or** JQL poll (`search?jql=…updated>…`) | REST `/issue/{key}` | transition, `/comment`, remote link | API token / OAuth, per-site |
| **GitHub Issues** | webhook (issues.opened/labeled) **or** `gh issue list` poll | `gh api /repos/…/issues/{n}` | comment, label, close-on-PR | `gh` / PAT / GitHub App |
| **GitLab Issues** | webhook (Issue Hook) **or** `/issues?updated_after=` poll | `/projects/:id/issues/:iid` | note, label, `Closes #iid` | PAT / project token |
| **Bitbucket Issues** | webhook **or** `/issues?q=updated_on>` poll | `/repositories/…/issues/{id}` | comment, state, PR link | app password / OAuth |
| **Linear** | webhook (Issue events) **or** GraphQL poll (`issues(filter:{updatedAt})`) | GraphQL `issue(id)` | GraphQL `commentCreate`, state update, attachment link | API key / OAuth |
| **Azure DevOps** | Service Hook (workitem.created/updated) **or** WIQL poll | REST `/wit/workitems/{id}` | `/comments`, state field, PR link (artifact) | PAT / Entra OAuth |

**Reuse — do not rebuild:** watching is exactly the trigger runtime we built. Webhooks land on the
existing `/api/webhooks/:triggerId` receiver (HMAC-verified, `runAsSystem`-scoped, per #494); when the
tracker is behind NAT / can't reach us, the **polling mode (#492)** applies verbatim — a tracker poll
is `gh issue list` / a JQL / WIQL / GraphQL query on an interval with a per-trigger watermark. So Part
A is mostly **six adapters over one existing watch spine + one spec-writer.**

**Auth & secrets:** every connector holds a scoped API token from a secret manager (never committed),
fail-closed. A connector for one tracker site/project cannot read another's — workspace-scoped, same
posture as Omniscience tokens.

## 3. Part B — The spec-first gate (ticket → committed spec)

A **Tracker Trigger** (`tracker_event` type) does NOT launch a loop. It produces a **committed spec**
and hands off to the spec-as-task watch trigger. This is the load-bearing v2 change.

### 3.1 Filters — which tickets become specs (never *all* of them)
An explicit predicate gates intake so the factory doesn't swallow every ticket:
- **Label / tag:** Jira label `agent`, GitHub label `agent-run`, Linear label, Azure tag. **Recommended default** — opt-in per ticket.
- **Project / board / area-path / team:** all tickets in a named project/board/area.
- **Assignee:** tickets assigned to a designated "agent" user.
- **Query:** a saved JQL / WIQL / GraphQL filter / issue query (most expressive).
- **Event kind:** created | labeled | assigned | commented-with-command (`/spec`, `/run`).

### 3.2 Ticket → spec (the crystallisation step)
The connector reads the ticket and produces a spec file (spec-as-task.md §2):
- **If the ticket is already spec-shaped** (has structured acceptance criteria / a template) →
  **normalise** it into the spec schema (map fields → frontmatter + sections). No LLM guessing.
- **Else** → **synthesise** a spec: an LLM (magic-mode reformulation, #465) turns title + body into
  `Problem / Scope / Out of scope / acceptanceCriteria`. Untrusted ticket text is fenced/clamped
  (github-event-map discipline) before it enters the prompt.
- **Frontmatter:** `title` (from the ticket), `source: { kind:<tracker>, ref:<key>, url:<link> }`
  (REQUIRED — this is what write-back keys off), `repo` (resolved §3.4), `role`/`skills` (from the
  trigger's Standing Role or template), `status: draft`.
- **acceptanceCriteria are REQUIRED.** If the ticket gives none and synthesis can't infer testable
  ones, the connector posts a comment back asking the human to add them, and does NOT proceed — a
  spec without a DoD is not `ready`.

### 3.3 Committing the spec (the WHAT gate)
- **Default:** the connector opens a **spec PR** adding `docs/specs/<slug>.md` (status: draft). A human
  reviews the *intent*; on merge the status flips to `ready` and the spec-as-task watch trigger fires
  the loop. Two clean gates (spec merge = the *what*; code PR merge = ship).
- **Trusted option:** a per-repo/per-Role policy may **auto-commit** the spec to the default branch as
  `ready` (skips the spec PR), for low-stakes flows. Gate 2 (code PR) always stands.
- The connector records the spec commit on the ticket (§4) so the human sees "your ticket became this
  spec."

### 3.4 Ticket → repo resolution
`repo` comes from, in order: an explicit connector config map (`Jira project ACME → repo X`); a field
on the ticket (a `repo:` label / custom field); else the tracker project's default repo. Ambiguous /
absent ⇒ the connector comments on the ticket asking for the repo and does NOT create a spec.

### 3.5 Rails (loop-triggers §4, applied at intake)
- **Dedup:** one spec per ticket (keyed by tracker+ticket id); a ticket edited 5× updates the same
  spec, never spawns 5. Downstream, one loop per spec (spec-as-task §3).
- **Budget:** max tracker-born specs per project/day + global cap; over budget ⇒ `suppressed:budget`
  + a ticket comment, never silent.
- **Human confirm:** the spec PR IS the confirm by default; a per-trigger flag can additionally require
  an `/approve` comment before even creating the spec (highest-stakes projects).
- **cascadeDepth:** a tracker-born spec is depth 0; a loop may not open tickets that trigger further
  specs beyond the §4.4 cap.
- **Kill-switches:** per connector, per trigger, per class (`triggers.tracker.enabled`), all default
  OFF.

## 4. Part C — Write-back is MANDATORY (the loop keeps the ticket a live record)

**Non-negotiable in v2:** wherever a task *came from a ticket*, the factory **writes back to that
ticket** at every meaningful transition. The ticket's `source` frontmatter on the spec carries the
origin so the loop (and its terminal write-back) always knows where to report. Write-back is idempotent
(dedup comments by spec/loop id) and best-effort (a tracker outage never breaks the loop — it degrades
to no comment, like the PR-queue GitHub degrade).

| When | Write-back to the origin ticket |
|---|---|
| **Spec created** | comment "🤖 picked up by the factory — spec at `<spec PR/commit link>`"; optionally transition To Do → In Progress. **This is the "wrote where it took the task from" requirement.** |
| **Spec approved (ready)** | comment "intent approved, work starting — loop `<link>`". |
| **Develop / verdict** | optional progress comment (action points, per-criterion results) — the ticket becomes the human-readable status the operator already watches. |
| **Code PR opened** | comment the Draft PR link; add a remote link (Jira/Azure artifact) / `Closes #N` (GitHub/GitLab). |
| **Terminal** | `converged` → "ready for review, PR `<link>`"; `stopped_cap`/`failed` → the status-explanation (#486) as a comment so a human knows why + what remains. |
| **Human merges code PR** | `Closes #N` / smart-commit auto-closes the ticket (GitHub/GitLab) or the connector transitions it (Jira/Azure/Linear/Bitbucket); spec status → done. |

The human's merge is the single act that both ships and resolves; the factory never auto-transitions to
Done independently of a merged PR.

## 5. Composition — Standing Role on a tracker

A **Standing Role** whose *concern* is a tracker project turns this into a durable digital employee:

```
StandingRole "backend-dev"
  skills:  [ python-dev, api-design, test-authoring ]
  concerns: [ { tracker: jira, project: ACME, filter: { label: "agent" },
                repoPath: <service-repo>, focus: "implement the ticket" } ]
```

Every ACME ticket labeled `agent` wakes the backend-dev Role → the connector writes a spec (with the
Role's skills/persona baked into frontmatter) → the spec fires a loop → PR closes the ticket. The
**Dream** teaches *this Role on this project* ("tickets of type X here close by pattern Y, verified").
The tracker is the role's inbox; the spec is the crystallised task; the loop is its work; the human
merge is the decision. This is the operator's *independent execution of tasks* — from primitives we
already have plus these connectors.

## 6. Boundaries & safety (unchanged posture, new surface)

- **Untrusted input:** a ticket title/body is attacker-influenced (anyone may file one) — fenced/clamped
  before any prompt, exactly like a PR title. A ticket cannot inject tool access or scope; it only
  seeds the spec's objective, and the **spec PR is where a human sanity-checks it** before it can fire.
- **The label gate is consent to intake; the spec PR is consent to execute.** Firing on *labeled* (not
  merely *created*) means a human opted this ticket in; the spec PR merge means a human approved the
  *what*. "Auto-commit ready specs" is the high-trust setting.
- **Human still merges.** The ticket triggers work; a human merges the code PR, which closes the ticket.
  No ticket ever auto-ships code. L4, never L5.
- **Scoping:** a connector/trigger binds one tracker project ↔ one repo; cross-project needs explicit
  config. Tokens scoped, fail-closed.

## 7. Staging (each shippable, inert-by-default, kill-switched)

- **TRACK-0** — this spec + [spec-as-task.md](spec-as-task.md) (the substrate; ship SPEC-1 first).
- **TRACK-1 — GitHub Issues → spec** (cheapest: `gh` seam + polling #492): `tracker_event` type,
  label-filtered, ticket→spec synthesis, spec PR, mandatory PR-link + status write-back. Proves the
  spine on one connector, riding the spec-as-task watch.
- **TRACK-2 — full write-back lifecycle:** all rows of §4 (start/verdict/terminal/close) + transitions.
- **TRACK-3 — Jira connector** (webhook + JQL; the org-standard tracker).
- **TRACK-4 — GitLab + Bitbucket connectors.**
- **TRACK-5 — Linear + Azure DevOps connectors** (GraphQL / WIQL dialects).
- **TRACK-6 — Standing Role on a tracker** + `/spec`,`/approve` comment commands.
- **TRACK-7 — graduate:** a genai-enablement ADR for the cross-repo tracker-connector + spec contract;
  omnius consumes it for org-scale governed intake.

## 8. Resolved design decisions (was §8 open questions)

- **Ticket→repo:** config map → ticket field → project default, in that order; ambiguous ⇒ ask on the
  ticket, don't guess (§3.4).
- **How much progress to mirror:** start/PR/terminal are mandatory; per-verdict progress is opt-in per
  trigger (signal vs noise).
- **Command-in-comment:** `/spec` (force intake), `/approve` (approve the spec), `/stop` (cancel the
  loop) — authorised to ticket assignees/maintainers only; the connector verifies the commenter's role
  via the tracker API before acting.
- **Two-way sync mid-flight:** a ticket edited while its loop runs updates the SPEC (a new spec commit);
  the running loop picks up the change on its next round (like PR `synchronize`), never mid-round.
- **State vs execution boundary:** the *fact* a ticket exists and its status is Omniscience state; the
  *act of executing it* is a multiqlti trigger; the crystallised intent is a committed spec. Three
  planes, one flow.

## 9. Still open

- Spec supersession when a ticket is reopened after `done` (new spec vs revive).
- Cross-tracker dedup (the same work filed in both Jira and GitHub) — key on repo+title similarity?
- Bulk intake (a sprint of 30 tickets) → 30 spec PRs vs one batched spec-PR with a human triage step.

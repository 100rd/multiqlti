# SPEC: Task-tracker integrations & triggers — a ticket becomes a loop

> Status: **spec / design**. This is the factory's **inbound front door**: a ticket created in
> a tracker (Jira, GitHub / GitLab / Bitbucket Issues) becomes a consilium loop, runs the full
> cycle (assess → plan → develop → verify → PR), and the resulting PR closes the ticket. Turns
> multiqlti from "an engineer runs a loop by hand" into "work arrives as tickets and is executed."
> Extends [loop-triggers.md](loop-triggers.md) (a new trigger source class) and composes with
> [standing-role.md](standing-role.md), the [knowledge-planes](knowledge-planes.md) and the
> [Dream](experience-plane-dream.md). Aligned to the platform canon in `100rd/genai-enablement`.
> **Humans own decisions; L4 never L5** — a ticket triggers the WORK; a human still merges the PR
> and thereby closes the ticket.

## 1. The shape of the idea

```
  Jira / GitHub Issue / GitLab Issue / Bitbucket Issue
        │  a ticket is created / labeled / assigned  (by the operator or anyone)
        ▼
   Tracker Trigger  ──maps ticket → loop template──►  Consilium Loop
        │                                                 │  assess → plan → develop → verify
        │                                                 ▼
        │◄──────── loop updates the ticket ──────  Draft PR (references the ticket)
        │          (status, PR link, comments)
        ▼
   human merges the PR  ──►  ticket auto-closes (PR "Closes #N" / Jira smart-commit)
```

The ticket is the **intent** (loop-consolidation §A/ADR-0003 I1 "task envelope"); the loop is the
execution; the PR is the artifact; the merge is the human decision that ships it and closes the
ticket. Nothing about our safety model changes — we add an inbound source, not an autonomy tier.

## 2. Part A — Integrations (the connectors)

A **Tracker Connector** is a small, uniform adapter per system. It does three things: **watch**
(learn of new/changed tickets), **read** (fetch a ticket's fields), **write-back** (update status
/ comment / link). All four trackers reduce to the same connector interface; only the API dialect
differs.

| Tracker | Watch | Read | Write-back | Auth |
|---|---|---|---|---|
| **Jira** | webhook (issue_created/updated) **or** JQL poll (`search?jql=…updated>…`) | REST `/issue/{key}` | transition, `/comment`, remote link | API token / OAuth, per-site |
| **GitHub Issues** | webhook (issues.opened/labeled) **or** `gh issue list` poll | `gh api /repos/…/issues/{n}` | comment, label, close-on-PR | `gh` / PAT / GitHub App |
| **GitLab Issues** | webhook (Issue Hook) **or** `/issues?updated_after=` poll | `/projects/:id/issues/:iid` | note, label, `Closes #iid` | PAT / project token |
| **Bitbucket Issues** | webhook **or** `/issues?q=updated_on>` poll | `/repositories/…/issues/{id}` | comment, state, PR link | app password / OAuth |

**Reuse — do not rebuild:** watching is exactly the trigger runtime we just built. Webhooks land on
the existing `/api/webhooks/:triggerId` receiver (HMAC-verified, `runAsSystem`-scoped); when the
tracker is behind NAT/unreachable from the internet, the **polling mode (#492)** applies verbatim —
a tracker poll is `gh issue list` / a JQL search on an interval with a per-trigger watermark. So
Part A is mostly **N connector adapters over one existing watch/fire spine.**

**Auth & secrets:** every connector holds a scoped API token, sourced from a secret manager (never
committed), fail-closed. A connector for one tracker site/project cannot read another's — same
workspace-scoped posture as Omniscience tokens.

## 3. Part B — Triggers (reacting to tracker events)

A **Tracker Trigger** is a new `TriggerType` (`tracker_event`) in the loop-triggers model
(source → filter → loop template → policy). It binds a connector + a filter to a loop template.

### 3.1 Filters — which tickets become loops (never *all* of them)
A firing is gated by an explicit predicate so the factory doesn't swallow every ticket:
- **Label / tag:** e.g. Jira label `agent` or `dark-factory`, GitHub label `agent-run`. **Recommended default** — opt-in per ticket.
- **Project / board / component:** all tickets in a named project or component.
- **Assignee:** tickets assigned to a designated "agent" user.
- **Query:** a saved JQL / issue query (the most expressive).
- **Event kind:** created | labeled | assigned | commented-with-command (`/run`).

### 3.2 Ticket → loop mapping (the intent translation)
The connector reads the ticket and composes the loop:
- **`engineerInstruction`** = the ticket **title + body**, control-stripped + fenced (untrusted
  text — same discipline as a PR title). Optionally run **magic-mode reformulation** (#465) first:
  turn a rough ticket into a well-formed engineer instruction, and (optionally) post the proposed
  instruction back as a ticket comment for the human to confirm before the loop proceeds — keeping
  the human in the intent loop.
- **`repoPath`** = resolved from the ticket's project → repo mapping (a connector config: "Jira
  project ACME → repo X"). Absent/ambiguous → no-op with a comment asking for the repo.
- **`skillIds` / preset / reviewMode / maxRounds** = from the trigger's loop template, or from a
  **Standing Role** the trigger names (§5).
- **provenance** = the loop records the ticket (tracker, key, url) — shown on the launch passport;
  the PR back-references it.

### 3.3 Rails (loop-triggers §4, applied to tickets)
- **Dedup:** **one active loop per ticket** (keyed by tracker+ticket id) — a ticket edited 5×
  doesn't spawn 5 loops; the existing loop picks up the latest on its next round.
- **Budget:** max tracker-born loops per project/day + global cap; over budget ⇒ `suppressed:budget`
  + a ticket comment, never silent.
- **Human confirm option:** a per-trigger flag to require a human `/approve` comment (or the
  magic-mode confirm) before the loop starts — for higher-stakes projects.
- **cascadeDepth:** a tracker-born loop is depth 0; it may not itself open new tickets that trigger
  further loops beyond the §4.4 cap.
- **Kill-switches:** per connector, per trigger, per class (`triggers.tracker.enabled`), all default
  OFF. No ticket fires a loop on a running server until an operator enables it.

## 4. Part C — Write-back (the loop talks to the ticket)

The loop is not fire-and-forget; it keeps the ticket a live record (bidirectional):
- **On start:** comment "🤖 picked up by the factory — loop <link>", optionally transition the
  ticket (To Do → In Progress).
- **On verdict / develop:** optional progress comment (the action points found, per-criterion
  results) — the ticket becomes the human-readable status the operator already watches.
- **On PR open:** comment the Draft PR link; add a remote link (Jira) / `Closes #N` (GitHub/GitLab).
- **On terminal:** `converged` → "ready for review, PR <link>"; `stopped_cap`/`failed` → the
  status-explanation (#486) as a comment so a human knows why and what remains.
- **On human merge:** the PR's `Closes #N` / smart-commit **auto-closes the ticket** — the human's
  merge is the single act that both ships and resolves. (We do not auto-transition to Done; the
  merge does, through the tracker's own PR-link mechanism.)

Write-back is idempotent (dedup comments by loop id) and best-effort (a tracker outage never breaks
the loop — it degrades to no comment, like the PR-queue GitHub degrade).

## 5. Composition — this is where Standing Role clicks

A **Standing Role** (standing-role.md) whose *concern* is a tracker project turns this into a durable
digital employee:

```
StandingRole "backend-dev"
  skills:  [ python-dev, api-design, test-authoring ]
  concerns: [ { tracker: jira, project: ACME, filter: { label: "agent" },
                repoPath: <service-repo>, focus: "implement the ticket" } ]
```

Every ACME ticket labeled `agent` wakes the backend-dev Role → spawns a loop with its skills +
persona → runs the full cycle → PR closes the ticket. Over time the **Dream** teaches *this Role on
this project*: "tickets of type X here close by pattern Y (verified)". The tracker is the role's
inbox; the loop is its work; the PR is its output; the human merge is the decision. This is the
operator's vision — *independent execution of tasks* — expressed entirely in primitives we already
have plus these connectors.

## 6. Boundaries & safety (unchanged posture, new surface)

- **Untrusted input:** a ticket title/body is attacker-influenced text (anyone may file a ticket) —
  fenced/clamped before it enters any prompt, exactly like a PR title (github-event-map discipline).
  A ticket cannot inject tool access or scope; it only supplies the objective.
- **The label gate is the consent:** firing on *labeled* (not merely *created*) means a human (or a
  policy) opted this ticket into the factory. "Fire on any created ticket" is available but is the
  high-trust setting.
- **Human still merges:** the ticket triggers the work; a human reviews and merges the PR, which
  closes the ticket. No ticket ever auto-ships code. L4, never L5.
- **Scoping:** a connector/trigger is bound to one tracker project ↔ one repo; cross-project firing
  needs explicit config. Tokens are scoped and fail-closed.

## 7. Staging (each shippable, inert-by-default, kill-switched)

- **TRACK-0** — this spec.
- **TRACK-1 — GitHub Issues first** (we already have the `gh` seam + polling #492): `tracker_event`
  type, label-filtered, ticket→loop mapping, minimal write-back (PR-link comment). Proves the spine
  on the cheapest connector.
- **TRACK-2 — write-back & lifecycle:** start/verdict/terminal comments + transitions + status
  explanations to the ticket.
- **TRACK-3 — Jira connector** (webhook + JQL poll; the org-standard tracker).
- **TRACK-4 — GitLab & Bitbucket connectors** (same interface, different dialect).
- **TRACK-5 — Standing Role on a tracker project** (§5) + magic-mode intent confirmation in-ticket.
- **TRACK-6 — graduate:** a genai-enablement ADR for the cross-repo tracker-connector contract;
  omnius consumes it for org-scale governed intake.

## 8. Open questions

- Ticket→repo resolution: config map vs a field on the ticket vs inferred from the project.
- How much loop progress to mirror into the ticket (signal vs noise for the human).
- Command-in-comment (`/run`, `/approve`, `/stop`) as a control channel — scope + auth of who may command.
- Two-way sync conflicts: the ticket edited mid-loop — pick up on next round (like PR synchronize) vs ignore.
- Whether the connector layer should be shared with Omniscience's ingestion (it already ingests
  chat/alerts) — trackers as another Omniscience source vs a multiqlti-local connector. Likely: state
  (the ticket exists, its status) is Omniscience; the *act of executing it* is a multiqlti trigger.

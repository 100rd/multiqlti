# Design: Loop Triggers — signals in, PRs out

> Status: **approved direction / staged**. The operator selected the trigger classes to build
> (2026-07-03). This document fixes the model and the guardrails BEFORE implementation.
> Companion to [loop-consolidation.md](loop-consolidation.md) — the Loop is the one unit of
> work; a trigger is the one way work *starts* without a human.

## 1. What exists today

- `TriggerType = webhook | schedule | github_event | file_change` with `TriggerService`
  (CRUD, secret encryption, `/api/webhooks/:triggerId` synthesis) and runtimes
  (`cron-scheduler.ts`, `file-watcher.ts`). These are **pipeline-era**: firings target
  pipeline runs, an entity that has left the product surface.
- One live binding: the file-change trigger (spec change in a watched repo → consilium
  review). It is the prototype of the whole idea and stays.

**The arc = retarget triggers at loops.** A trigger firing creates a *consilium loop* via the
same factory the UI/API use (preset + repoPath + engineerInstruction + maxRounds), never a
bare pipeline/task-group.

## 2. The model

A trigger is a persisted binding: **source → filter → loop template → policy**.

```
source   : webhook (HMAC) | github_event | schedule (cron) | file_change (glob)
filter   : event predicate (repo, branch, event kind, path glob, label, severity)
template : preset + repoPath + engineerInstruction (with ${event} interpolation)
           + maxRounds + skillIds (instruction extensions)
policy   : dedup | debounce | budget | cascadeDepth   (§4 — hard rails)
```

Every fired loop carries **trigger provenance** (trigger id + event digest) shown on the
loop's Launch passport. A trigger's history (fired / suppressed-by-policy / failed) is
queryable — silence must be diagnosable.

## 3. Approved trigger classes and their mappings

### 3.1 Git-native (highest leverage — Stage T1)
| Event | Loop template |
|---|---|
| PR opened/updated | `diff-pr-review` on the PR head (review other people's PRs) |
| push/merge to main | post-merge validation review (external merges are unreviewed today) |
| CI red on main | investigate-fix loop; the failed job log rides the instruction |
| Dependabot/CVE alert | upgrade loop: bump → suite → PR |
| tag/release | release-validation review |

One GitHub webhook receiver (HMAC-verified per trigger secret), event→binding fan-out.

### 3.2 Operational runtime signals (Stage T5 after the infra archetype)
The omnius "ground truth from outside" invariant: monitoring/SLO-burn alert → investigate
loop; error-tracker spike → bug-fix loop with the stack trace as work item; ArgoCD
degraded / k8s events → deploy-verify loop. Generic inbound: `webhook` type with a
templated instruction — an alertmanager/Sentry webhook is just a POST with a JSON body
interpolated into the instruction. **Blocked on the infra archetype (§6).**

### 3.3 Knowledge changes (Stage T2)
Generalize the file trigger: ADR/spec glob change → conformance review of the code against
the spec; upstream dependency release (watched via schedule polling release feeds) →
research loop "what does X.Y give/break us".

### 3.4 Cascades — loop-generated triggers (Stage T4, the risky ones)
Approved as "risky but the most interesting". Each is a *binding on loop lifecycle events*:
- `converged-with-remainder` → auto-develop the remainder (finding #5's open question);
- verdict carrying deferred P3s → a scheduled "revisit in N weeks" loop;
- merge of the loop's own PR → validation loop;
- change in a shared SDK repo → loops in dependent repos (cross-repo fan-out).

## 4. Hard rails (non-negotiable, enforced in code, all default-conservative)

1. **Dedup**: one ACTIVE loop per (repo, trigger-kind). A firing that would duplicate is
   recorded `suppressed:dedup`, never queued blindly.
2. **Debounce** per trigger (file/PR-update storms collapse to the trailing edge).
3. **Budget**: max trigger-born loops per repo per day + global cap; over budget ⇒
   `suppressed:budget` + surfaced on the triggers page. LLM cost is real money.
4. **Cascade depth**: every loop carries `cascadeDepth` (human/API/webhook-born = 0).
   A loop-lifecycle trigger may only fire for source loops with depth 0, producing depth 1.
   **Depth ≥ 1 never triggers further loops.** Raising the limit is a config change with
   its own kill-switch, not a code default.
5. **Kill-switches**: per trigger binding (`enabled`) + per class
   (`triggers.githubEvents.enabled`, `triggers.cascades.enabled`, …) — all default OFF.
6. **Provenance**: no anonymous loops. Passport shows trigger + event; suppressions are
   visible.
7. **Webhook trust**: HMAC signature per trigger secret; event payloads are UNTRUSTED text —
   fenced/clamped before entering any instruction (same discipline as diff-context).

## 5. Staging

- **T0** — this document.
- **T1** — GitHub receiver + PR-opened / CI-red / push-to-main bindings, policies §4 items
  1–3+5–7, provenance on the passport. (Dependabot/tag mappings ride the same receiver later.)
- **T2** — knowledge triggers: spec-glob generalization of file_change; scheduled
  release-watch → research loop.
- **T3** — scheduled loops UX (cron → loop template) + deferred-P3 revisit binding.
- **T4** — cascades behind `triggers.cascades.enabled`: remainder auto-develop,
  own-PR-merged validation, cross-repo fan-out; cascadeDepth rail from §4.4.
- **T5** — operational signals, after the infra archetype ships (§6).

## 6. The infra archetype (unblocks §3.2) — scoped separately

Approved for build. Per loop-consolidation §6: `(research) → spec → code → deploy-verify`,
where **deploy-verify** is the one skill touching a live environment: ephemeral env
(kind/k3d for k8s work), creds scoped to that env from a secret manager, the skill's green =
"deployed, running, no error events", **prod-apply never without explicit human approval**
(existing apply-gates hold). Verification method `live-deploy-smoke` (already in the §5
method table) becomes real. This is its own design+build arc (INFRA-1…n) and will get its
own doc section before code; T5 bindings depend on it.

## 7. Open questions

- Where trigger-born loops take their `skillIds` from (per-binding template vs global default).
- Cross-repo fan-out mapping source (dependency manifest vs explicit binding list) — start
  with explicit bindings, no auto-discovery.
- Whether CI-red events should debounce per workflow or per commit.

# SPEC: Standing Role ("Waker") — a persistent role that spawns ephemeral loops

> Status: **spec / design**. Pattern origin: QoderWake's *Waker* — an isolated digital
> employee (persona + skills + memory + workspace) that wakes on triggers. This spec maps that
> abstraction onto our existing primitives (triggers → loops, skills = ADR-0002 SKILL.md,
> the Experience plane / Dream) as a **composition + identity layer**, not a new engine.
> Companion to [knowledge-planes.md](knowledge-planes.md) and
> [experience-plane-dream.md](experience-plane-dream.md). Aligned to the platform canon in
> `100rd/genai-enablement`. Humans own decisions; L4 never L5.

## 0. The idea in one paragraph

Today an operator wires a **trigger**, a **loop template** (preset + repoPath + instruction),
and **skillIds** separately, every time. A **Standing Role** bundles those once into a named,
persistent identity — e.g. *"the DevOps reviewer"* — that you then **point at concerns**
(this IaC repo's Terraform, that service's k8s). It stands watch: its triggers wake it, each
wake spawns an **ephemeral loop** as its work-instance, and it accumulates **role-scoped
experience** (via the Dream) so it gets better at its beat over time. The Role persists; its
loops are disposable. Nothing new runs the work — a Role is a saved composition + an identity
that memory and triggers attach to.

## 1. Why this abstraction (and why it's not a new engine)

- **Operator ergonomics:** define *"a DevOps reviewer"* once (its skills, its review criteria,
  its persona), reuse it across many concerns. No re-wiring triggers + instructions each time.
- **Experience gets a scope:** the Dream (experience-plane-dream.md) needs a `scope` to key items.
  A Standing Role is the natural scope — *"as the DevOps reviewer on this repo, these Terraform
  patterns are verified"*. Role + concern is a far better memory key than a bare repo.
- **It's composition, not a rebuild:** every mechanical part already exists — triggers→loops
  (#467), skills-extend-instruction (#461), per-repo config (#475), reviewMode (#483). The Role is
  the missing *noun* that ties them together and gives experience/identity somewhere to live.

## 2. The lifecycle bridge (persistent Role ↔ ephemeral Loop)

The tension: our **Loop is ephemeral** (task in → PR out → done); a **Waker is persistent** (a
standing employee). Resolution — mirror Waker's own daemon/session split:

```
Standing Role  (persistent definition + identity + accumulated experience)
      │  a bound trigger fires (schedule / github event / knowledge change)
      ▼
   spawns → Consilium Loop  (ephemeral work-instance: assess → plan → develop → verify → PR)
      │  loop reaches terminal
      ▼
   Dream distils the loop → Experience items scoped to (this Role, this concern)
      │  next wake
      ▼
   the Role's planner reads its OWN prior experience → starts warm, not cold
```

The Role lives across many loops; each loop is disposable; the through-line is the Role's
identity (skills + standing instruction) and its growing experience.

## 3. Anatomy of a Standing Role

```
StandingRole {
  id, name                       // "devops-reviewer"
  persona                        // standing instruction / tone / constraints (grounds every wake)
  skills:        SkillRef[]      // ADR-0002 SKILL.md set = the role's capability (e.g. terraform-dev, cis-review)
  loopTemplate:  { preset, maxRounds, reviewMode, verificationDefaults }  // how its loops run
  concerns:      Concern[]       // WHAT it watches (below) — a role is pointed at ≥1 concern
  policy:        { dedup, budget, cascadeDepth, enabled }  // the trigger rails (loop-triggers.md §4)
  experienceScope: (role, concern)   // the Dream's key for this role's memory
}

Concern {
  repoPath                       // the target (allowlisted)
  trigger:  { type: github_event|schedule|knowledge_change, filter }  // WHEN it wakes
  focus:    string               // "new Terraform module versions" — folded into the wake instruction
}
```

A wake composes the loop's `engineerInstruction` = `persona + concern.focus + ${event}`, with
`skillIds = role.skills`, `reviewMode = template.reviewMode`, on `concern.repoPath` — i.e. exactly
today's `POST /api/consilium-reviews` payload, assembled from the Role instead of by hand.

## 4. Worked example — the operator's DevOps/Terraform Waker

> *"a Waker with a devops role that checks new Terraform module versions in my IaC repo"*

```
StandingRole "devops-reviewer"
  persona:  "You are a senior DevOps reviewer. Prioritise CIS/security, cost, and
             breaking-change surface. Flag operational items honestly; do not force
             non-code fixes into code."
  skills:   [ terraform-dev, cis-compliance-review, blast-radius ]   // ADR-0002 SKILL.md
  loopTemplate: { preset: diff-pr-review, maxRounds: 3, reviewMode: single-verifier }
  concerns: [
    { repoPath: <iac-repo>,
      trigger: { type: github_event, filter: { event: pull_request|push,
                                               path: "modules/**/*.tf", ref: default } },
      focus:   "a new or changed Terraform module version" }
  ]
  policy: { dedup: per(repo,role), budget: N/day, cascadeDepth: 0, enabled: true }
```

A module PR lands → the github trigger fires → the Role wakes → spawns a `diff-pr-review` loop on
the IaC repo with the devops skills + persona + "review this new module version…" → parallel
develop / verify → single-verifier confirms independently → Draft PR / findings. Over time the
Dream teaches *this* Role: *"CIS finding X on Terraform modules here closes by pattern Y (verified
3×)"* — so its future reviews start warm. **Every mechanical piece exists today; this SPEC is the
identity + composition that makes it "a DevOps employee" instead of a hand-wired trigger.**

## 5. Where each piece already lives

| Role part | Existing primitive |
|---|---|
| wake on a concern | triggers → loops (#467), github-event HMAC (#471) |
| capability (skills) | ADR-0002 SKILL.md; skillIds-extend-instruction (#461) |
| how its loops run | reviewMode (#483), per-repo config (#475), verify-before-merge, parallel |
| its memory | Experience plane / Dream (experience-plane-dream.md), keyed by (role, concern) |
| the rails | loop-triggers.md §4 (dedup, budget, cascadeDepth, kill-switches) |
| the missing noun | **the StandingRole record itself** (this SPEC) |

## 6. Boundaries & safety

- **A Role is a definition, not a running process.** It does not hold a live agent or a live
  session; it holds config + identity + a pointer to its experience. Its only runtime footprint is
  the ephemeral loops it spawns — which already have all our isolation (worktree, capability
  ceilings, human merge gate). No new long-lived privileged process.
- **Role experience is scoped and fail-closed.** A Role reads only its own `(role, concern)`
  experience; cross-role/cross-tenant reads need an explicit boundary (same posture as Omniscience
  workspace tokens). A DevOps role must not silently inherit a Security role's lessons.
- **Rails are per-Role.** Budget/dedup/cascade from loop-triggers.md §4 bind at the Role level so a
  misfiring concern can't spawn unbounded loops. `cascadeDepth` still caps Role-spawned-by-Role.
- **Humans own the Role.** Creating/enabling a Role, editing its persona/skills, and merging its
  loops' PRs are human/CODEOWNERS acts. The Role automates the *work*, never the *decision* (L4).

## 7. Relationship to the four planes

A Standing Role is the **subject** that composes the planes at wake time (knowledge-planes.md §2):
its **skills** (generic capability) + the concern's **repo facts** + its **experience** (role-scoped
Dream) + **Omniscience state** → the full picture, now *personalised to a standing role* rather than
assembled anew each loop. The Role is what makes "the agent gets a skill and looks at repo history
and prior solutions" (the operator's framing) a *durable identity* instead of a per-run assembly.

## 8. Staging (each shippable, inert-by-default, kill-switched)

- **ROLE-0** — this spec.
- **ROLE-1 — the record:** a `StandingRole` entity (name + persona + skills + loopTemplate) and a
  UI to define one. No triggers yet — you can manually "wake" a Role (spawn a loop from it).
- **ROLE-2 — concerns/triggers:** bind triggers to a Role's concerns; a firing wakes the Role →
  spawns its loop. Reuses triggers→loops; the Role supplies the template.
- **ROLE-3 — role-scoped experience:** the Dream keys items by (role, concern); the Role's planner
  reads its own prior experience → warm starts. Depends on DREAM-1/2.
- **ROLE-4 — role library / graduation:** named Roles become shareable; proven Roles (and their
  skill sets) graduate toward omnius per the ADR-0002 proving-ground→canon path. Cross-repo Role
  definitions want a genai-enablement ADR.

## 9. Open questions

- Role vs preset: is `loopTemplate.preset` enough, or do some Roles need their own dispute shape?
- One Role, many concerns vs one-Role-per-concern — where the experience scope bites.
- How a Role's persona interacts with per-skill system prompts (ADR-0002) without double-instructing.
- Whether Roles should be first-class in Omniscience's state graph (a Role IS a platform object) —
  probably yes, as state; its *experience* stays a separate plane (ADR-0015).

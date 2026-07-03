/**
 * Canonical judge-prompt delta for the consilium loop (A1).
 *
 * Appended to a judge task's `description` so the judge ALSO emits a
 * machine-readable `output.convergence` object alongside the existing
 * `verdict / pros / cons / action_points`. The loop's `readConvergence` trusts
 * this object when present and otherwise derives convergence from
 * `action_points`, so an unmodified judge keeps working — but a judge that
 * follows these instructions gives the FSM an authoritative signal.
 *
 * In English to match the product's user-facing judge descriptions / verdict UI.
 */
export const JUDGE_CONVERGENCE_INSTRUCTIONS = `
## Convergence signal

In addition to the verdict / pros / cons / action_points fields, add a
\`convergence\` object to \`output\`:

\`\`\`json
"convergence": {
  "converged": false,
  "open_p0": 3,
  "open_action_points": [
    {
      "title": "...",
      "priority": "P0",
      "effort": "...",
      "rationale": "...",
      "tradeoff": "...",
      "acceptanceCriterion": "When <condition>, then <verifiable result>",
      "verificationMethod": "test-run"
    }
  ]
}
\`\`\`

Rules:
- \`converged\` is \`true\` if and only if no action point with priority \`P0\`
  remains. Otherwise it is \`false\`.
- \`open_p0\` — the number of still-open action points with priority \`P0\`.
- \`open_action_points\` — the full list of ALL still-open (unresolved) action
  points; list every one, without abbreviating.
- Priorities: P0 (blocks convergence) > P1 > P2 > P3.
- OPTIONALLY, for each action point add an \`acceptanceCriterion\` field
  (exactly this camelCase key) — ONE concrete, verifiable
  "When … then …" statement (definition of done): the observable condition by
  which one can unambiguously confirm the item is closed. If no verifiable
  criterion can be stated, simply omit the field (the verdict stays valid
  without it).
- OPTIONALLY, for each action point add a \`verificationMethod\` field (exactly
  this camelCase key) naming HOW the item's criterion is verified — the ground
  truth. Choose EXACTLY ONE of:
    - \`test-run\` — a code/repo change whose criterion is confirmed by the
      repo's automated tests (unit/integration). This is the default for code.
    - \`judge\` — a non-mechanical criterion no test asserts (a design property,
      a doc/readme quality, a naming/UX judgement); a verifier model confirms the
      diff meets the criterion.
    - \`manual-ops\` — an OPERATIONAL action OUTSIDE the repo that no code change
      can verify (rotate a leaked secret, revoke a key, file a ticket, change a
      cloud setting). The pipeline can only SURFACE these for a human; it can
      NEVER close them. Use this whenever the action is not a source change.
  Omit the field when unsure (the planner assigns a default from the task type).
- OPTIONALLY, for each action point add a \`dependsOn\` field (exactly this
  camelCase key): an array naming the OTHER action points that must be COMPLETED
  before this one can be worked. Reference each by its 1-based position in the
  \`open_action_points\` list (a number, e.g. \`[1, 3]\`) or by its exact
  \`title\`. Declare a dependency ONLY when a later fix GENUINELY requires an
  earlier one's result — e.g. an action point that "confirms CI is green" depends
  on the fixes it verifies. The DEFAULT is NO dependency: independent action
  points (which is most of them) are run in PARALLEL, so leave \`dependsOn\` absent
  unless the ordering is real. Do NOT invent ordering to be safe — a false
  dependency needlessly serializes the work.
`.trim();

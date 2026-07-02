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
      "acceptanceCriterion": "When <condition>, then <verifiable result>"
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
`.trim();

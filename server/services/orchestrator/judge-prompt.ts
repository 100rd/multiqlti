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
 * Kept in Russian to match the existing judge task descriptions / verdict UI.
 */
export const JUDGE_CONVERGENCE_INSTRUCTIONS = `
## Сигнал сходимости (convergence)

Дополнительно к полям verdict / pros / cons / action_points добавь в \`output\`
объект \`convergence\`:

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
      "acceptanceCriterion": "Когда <условие>, тогда <проверяемый результат>"
    }
  ]
}
\`\`\`

Правила:
- \`converged\` равно \`true\` тогда и только тогда, когда НЕ осталось ни одного
  action point с приоритетом \`P0\`. Иначе — \`false\`.
- \`open_p0\` — количество ещё открытых action points с приоритетом \`P0\`.
- \`open_action_points\` — полный список ВСЕХ ещё открытых (нерешённых) action
  points; перечисли каждый, не сокращая.
- Приоритеты: P0 (блокирует сходимость) > P1 > P2 > P3.
- НЕОБЯЗАТЕЛЬНО для каждого action point добавь поле \`acceptanceCriterion\`
  (именно такой camelCase-ключ) — ОДНУ конкретную, проверяемую формулировку
  «Когда … тогда …» (definition of done): по какому наблюдаемому условию можно
  однозначно убедиться, что пункт закрыт. Если сформулировать проверяемый
  критерий нельзя — просто опусти поле (verdict остаётся валидным без него).
`.trim();

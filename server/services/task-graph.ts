/**
 * Pure DAG validation for task-group dependency graphs.
 *
 * `dependsOn` stores task IDs within the same group. Edits (PATCH task, POST
 * task, DELETE task) can introduce dangling refs, self-deps, or cycles — the
 * orchestrator's runtime unblock logic assumes a valid DAG, so this enforces the
 * invariant the runtime already relies on, BEFORE any persist.
 *
 * Stateless and storage-free so it is trivially unit-testable.
 *
 * Callers: server/routes/task-groups.ts (PATCH/POST/DELETE task handlers).
 */

export interface TaskGraphNode {
  id: string;
  dependsOn: string[];
}

export type TaskGraphResult = { ok: true } | { ok: false; reason: string };

/**
 * Validate that `tasks` form a valid DAG:
 *   - every dependsOn id must reference a task in the set (no dangling refs);
 *   - no task may depend on itself;
 *   - no cycles.
 * Returns `{ ok: true }` for any valid DAG (including the empty graph), else
 * `{ ok: false, reason }` with a non-sensitive, id-only reason.
 */
export function validateTaskGraph(tasks: ReadonlyArray<TaskGraphNode>): TaskGraphResult {
  const ids = new Set(tasks.map((t) => t.id));

  // Dangling + self-dep checks first (cheap, precise).
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (dep === t.id) {
        return { ok: false, reason: `Task ${t.id} cannot depend on itself` };
      }
      if (!ids.has(dep)) {
        return { ok: false, reason: `Task ${t.id} depends on unknown task ${dep}` };
      }
    }
  }

  // Cycle detection via iterative DFS with white/grey/black coloring.
  const adjacency = new Map<string, string[]>();
  for (const t of tasks) adjacency.set(t.id, t.dependsOn);

  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of ids) color.set(id, WHITE);

  const stack: Array<{ id: string; iter: Iterator<string> }> = [];

  for (const start of ids) {
    if (color.get(start) !== WHITE) continue;
    color.set(start, GREY);
    stack.push({ id: start, iter: (adjacency.get(start) ?? [])[Symbol.iterator]() });

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const next = frame.iter.next();
      if (next.done) {
        color.set(frame.id, BLACK);
        stack.pop();
        continue;
      }
      const dep = next.value;
      const depColor = color.get(dep) ?? WHITE;
      if (depColor === GREY) {
        return { ok: false, reason: `Dependency cycle detected involving task ${dep}` };
      }
      if (depColor === WHITE) {
        color.set(dep, GREY);
        stack.push({ id: dep, iter: (adjacency.get(dep) ?? [])[Symbol.iterator]() });
      }
    }
  }

  return { ok: true };
}

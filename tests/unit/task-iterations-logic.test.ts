/**
 * Unit tests for the Task Groups v2 iteration-list shaping + run/edit gating
 * (frontend). Like task-form.test.ts / activity-ui.test.ts, these exercise the
 * PURE helpers behind the TaskGroup Iterations panel without a DOM renderer (the
 * repo has no jsdom) — they import from @/lib/task-iterations (no React):
 *   - appendIterationPage (keyset fold, de-dupe by number, newest-first),
 *   - isIterationRunning / isRunEnabled / isEditEnabled gating,
 *   - runButtonLabel ("Run" vs "Run again"),
 *   - startErrorMessage (409 running/cap vs 400 no-ready-tasks),
 *   - buildIterationsQuery (limit clamp + cursor).
 */
import { describe, it, expect } from "vitest";
import {
  appendIterationPage,
  emptyIterationListState,
  hasMoreIterations,
  buildIterationsQuery,
  isIterationRunning,
  isRunEnabled,
  isEditEnabled,
  runButtonLabel,
  startErrorMessage,
  type IterationSummary,
  type IterationListPage,
} from "@/lib/task-iterations";

function iteration(overrides: Partial<IterationSummary> = {}): IterationSummary {
  return {
    iterationNumber: overrides.iterationNumber ?? 1,
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? "2026-06-16T10:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-06-16T10:00:05.000Z",
    durationMs: overrides.durationMs ?? 5000,
    completedCount: overrides.completedCount ?? 3,
    taskCount: overrides.taskCount ?? 3,
    ...(overrides.triggeredBy !== undefined ? { triggeredBy: overrides.triggeredBy } : {}),
  };
}

function page(items: IterationSummary[], nextCursor: string | null = null): IterationListPage {
  return { items, nextCursor };
}

// ─── appendIterationPage (keyset fold) ──────────────────────────────────────────

describe("appendIterationPage", () => {
  it("replaces the list on the first page and keeps newest-first order", () => {
    const next = appendIterationPage(
      emptyIterationListState(),
      page([iteration({ iterationNumber: 2 }), iteration({ iterationNumber: 3 })], "c1"),
      true,
    );
    expect(next.items.map((i) => i.iterationNumber)).toEqual([3, 2]);
    expect(next.nextCursor).toBe("c1");
  });

  it("appends subsequent pages (cursor present) below the existing rows", () => {
    const first = appendIterationPage(emptyIterationListState(), page([iteration({ iterationNumber: 5 })], "c1"), true);
    const second = appendIterationPage(first, page([iteration({ iterationNumber: 4 })], null), false);
    expect(second.items.map((i) => i.iterationNumber)).toEqual([5, 4]);
    expect(second.nextCursor).toBeNull();
  });

  it("de-dupes by iterationNumber across a keyset boundary / refetched first page", () => {
    const first = appendIterationPage(emptyIterationListState(), page([iteration({ iterationNumber: 3 }), iteration({ iterationNumber: 2 })], "c1"), true);
    const second = appendIterationPage(first, page([iteration({ iterationNumber: 2 }), iteration({ iterationNumber: 1 })], null), false);
    expect(second.items.map((i) => i.iterationNumber)).toEqual([3, 2, 1]);
  });

  it("does not mutate the previous state", () => {
    const prev = appendIterationPage(emptyIterationListState(), page([iteration({ iterationNumber: 1 })], "c1"), true);
    const len = prev.items.length;
    appendIterationPage(prev, page([iteration({ iterationNumber: 2 })], null), false);
    expect(prev.items).toHaveLength(len);
  });

  it("hasMoreIterations follows nextCursor", () => {
    expect(hasMoreIterations({ items: [], nextCursor: "c" })).toBe(true);
    expect(hasMoreIterations({ items: [], nextCursor: null })).toBe(false);
  });
});

// ─── run/edit gating ────────────────────────────────────────────────────────────

describe("isIterationRunning", () => {
  it("is false for an empty list (no iterations yet)", () => {
    expect(isIterationRunning([])).toBe(false);
  });

  it("is true when the latest (first) iteration is running", () => {
    expect(isIterationRunning([iteration({ iterationNumber: 2, status: "running", completedAt: null })])).toBe(true);
  });

  it("is false when the latest iteration is terminal", () => {
    for (const s of ["completed", "failed", "cancelled"]) {
      expect(isIterationRunning([iteration({ status: s })])).toBe(false);
    }
  });

  it("honours a live group status of 'running' even before the list refreshes", () => {
    expect(isIterationRunning([iteration({ status: "completed" })], "running")).toBe(true);
  });

  it("uses the LATEST (first) row, not an older running one", () => {
    const list = [iteration({ iterationNumber: 2, status: "completed" }), iteration({ iterationNumber: 1, status: "running" })];
    expect(isIterationRunning(list)).toBe(false);
  });
});

describe("isRunEnabled / isEditEnabled", () => {
  it("both enabled when nothing is running (incl. between runs)", () => {
    const list = [iteration({ status: "completed" })];
    expect(isRunEnabled(list)).toBe(true);
    expect(isEditEnabled(list)).toBe(true);
  });

  it("both disabled while an iteration is running", () => {
    const list = [iteration({ status: "running", completedAt: null })];
    expect(isRunEnabled(list)).toBe(false);
    expect(isEditEnabled(list)).toBe(false);
  });

  it("both enabled for a brand-new group with no iterations", () => {
    expect(isRunEnabled([])).toBe(true);
    expect(isEditEnabled([])).toBe(true);
  });

  it("a live running status disables both even if the list looks terminal", () => {
    const list = [iteration({ status: "completed" })];
    expect(isRunEnabled(list, "running")).toBe(false);
    expect(isEditEnabled(list, "running")).toBe(false);
  });
});

describe("runButtonLabel", () => {
  it("is 'Run' before any iteration exists", () => {
    expect(runButtonLabel([])).toBe("Run");
  });

  it("is 'Run again' once at least one iteration is recorded", () => {
    expect(runButtonLabel([iteration()])).toBe("Run again");
    expect(runButtonLabel([iteration({ iterationNumber: 2 }), iteration({ iterationNumber: 1 })])).toBe("Run again");
  });
});

// ─── startErrorMessage (toast text) ─────────────────────────────────────────────

describe("startErrorMessage", () => {
  it("409 → already running by default", () => {
    expect(startErrorMessage(409)).toMatch(/already running/i);
  });

  it("409 with a cap message → iteration cap reached", () => {
    expect(startErrorMessage(409, "iteration cap reached")).toMatch(/cap/i);
  });

  it("409 surfaces a non-cap server message verbatim", () => {
    expect(startErrorMessage(409, "An iteration is already running")).toBe(
      "An iteration is already running",
    );
  });

  it("400 → no ready tasks", () => {
    expect(startErrorMessage(400)).toMatch(/no ready tasks/i);
  });

  it("other statuses fall back to a generic message", () => {
    expect(startErrorMessage(500)).toMatch(/failed to start/i);
  });
});

// ─── buildIterationsQuery ────────────────────────────────────────────────────────

describe("buildIterationsQuery", () => {
  it("clamps the limit to ≤100 and includes the cursor", () => {
    expect(buildIterationsQuery({ limit: 500, cursor: "abc" })).toBe("?limit=100&cursor=abc");
  });

  it("floors the lower bound to ≥1", () => {
    expect(buildIterationsQuery({ limit: 0 })).toBe("?limit=1");
  });

  it("omits the cursor when absent and returns '' when empty", () => {
    expect(buildIterationsQuery({ limit: 20 })).toBe("?limit=20");
    expect(buildIterationsQuery({})).toBe("");
  });
});

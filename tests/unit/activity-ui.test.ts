/**
 * Unit tests for the Live Activity UI logic (frontend).
 *
 * Like orchestrator-ui.test.ts / news-ui.test.ts, these exercise the PURE
 * helpers that back the page + hook — the multi-run merge-by-runId reducer that
 * folds live WS deltas onto the polled snapshot, the mode grouping, the
 * ownership-scoped subscription id set, the live-pulse predicate, and the model
 * display helper — without a DOM renderer (the repo has no jsdom).
 */
import { describe, it, expect } from "vitest";
import {
  mergeWsEvent,
  groupByMode,
  groupHistoryByMode,
  snapshotRunIds,
  isLiveNow,
  displayModel,
  appendHistoryPage,
  emptyHistoryState,
  hasMoreHistory,
  historyRowKey,
  buildHistoryQuery,
  ACTIVITY_MODE_ORDER,
  LIVE_PULSE_WINDOW_MS,
  type LiveActivityRun,
} from "@/lib/activity";
import type {
  ActivityRun,
  ActivityMode,
  WsEvent,
  ActivityHistoryRow,
  ActivityHistoryPage,
} from "@shared/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NOW = 1_000_000;

function makeRun(overrides: Partial<ActivityRun> = {}): LiveActivityRun {
  return {
    runId: "run-1",
    mode: "pipeline",
    title: "Build feature",
    status: "running",
    workspaceId: null,
    startedAt: null,
    currentUnit: {
      label: "Stage 1",
      agent: "backend",
      modelSlug: "claude-opus",
      status: "running",
    },
    ...overrides,
  };
}

function ev(
  type: WsEvent["type"],
  runId: string | undefined,
  payload: Record<string, unknown> = {},
): WsEvent {
  return { type, runId, payload, timestamp: "2026-06-11T00:00:00.000Z" };
}

// ─── mergeWsEvent: the multi-run merge-by-runId reducer ─────────────────────────

describe("mergeWsEvent — keying by runId", () => {
  it("merges a stage:progress delta onto ONLY the matching run", () => {
    const rows = [makeRun({ runId: "a" }), makeRun({ runId: "b" })];
    const next = mergeWsEvent(
      rows,
      ev("stage:progress", "b", { teamId: "qa", modelSlug: "gpt-x" }),
      NOW,
    );

    // 'a' is untouched (same reference), 'b' is updated.
    expect(next[0]).toBe(rows[0]);
    expect(next[1].currentUnit?.modelSlug).toBe("gpt-x");
    expect(next[1].lastDeltaAt).toBe(NOW);
  });

  it("returns the SAME array reference when the runId is not in the snapshot", () => {
    const rows = [makeRun({ runId: "a" })];
    const next = mergeWsEvent(rows, ev("stage:progress", "ghost", {}), NOW);
    expect(next).toBe(rows);
  });

  it("ignores events without a runId", () => {
    const rows = [makeRun({ runId: "a" })];
    expect(mergeWsEvent(rows, ev("stage:progress", undefined, {}), NOW)).toBe(rows);
  });

  it("ignores non-live event types (passes the array through unchanged)", () => {
    const rows = [makeRun({ runId: "a" })];
    expect(mergeWsEvent(rows, ev("pipeline:completed", "a", {}), NOW)).toBe(rows);
    expect(mergeWsEvent(rows, ev("chat:message", "a", {}), NOW)).toBe(rows);
  });

  it("does not mutate the input row or array", () => {
    const rows = [makeRun({ runId: "a" })];
    const before = JSON.stringify(rows);
    mergeWsEvent(rows, ev("stage:progress", "a", { modelSlug: "z" }), NOW);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("mergeWsEvent — stage:progress", () => {
  it("refreshes the model and marks the unit running, keeping the label", () => {
    const rows = [makeRun({ runId: "a" })];
    const next = mergeWsEvent(
      rows,
      ev("stage:progress", "a", { modelSlug: "new-model" }),
      NOW,
    );
    expect(next[0].currentUnit).toMatchObject({
      label: "Stage 1",
      agent: "backend",
      modelSlug: "new-model",
      status: "running",
    });
  });

  it("keeps the prior model when the payload omits modelSlug", () => {
    const rows = [makeRun({ runId: "a" })];
    const next = mergeWsEvent(rows, ev("stage:progress", "a", {}), NOW);
    expect(next[0].currentUnit?.modelSlug).toBe("claude-opus");
  });
});

describe("mergeWsEvent — manager:decision", () => {
  it("re-attributes the agent to the payload teamId and refreshes the model", () => {
    const rows = [makeRun({ runId: "a", mode: "manager" })];
    const next = mergeWsEvent(
      rows,
      ev("manager:decision", "a", { teamId: "frontend", modelSlug: "m" }),
      NOW,
    );
    expect(next[0].currentUnit).toMatchObject({
      agent: "frontend",
      modelSlug: "m",
      status: "running",
    });
  });
});

// ─── groupByMode ────────────────────────────────────────────────────────────────

describe("groupByMode", () => {
  it("groups in the fixed mode order and omits empty modes", () => {
    const rows = [
      makeRun({ runId: "m1", mode: "manager" }),
      makeRun({ runId: "p1", mode: "pipeline" }),
      makeRun({ runId: "p2", mode: "pipeline" }),
    ];
    const groups = groupByMode(rows);
    expect(groups.map((g) => g.mode)).toEqual(["pipeline", "manager"]);
    expect(groups[0].runs).toHaveLength(2);
    expect(groups[1].runs).toHaveLength(1);
  });

  it("returns [] for no rows (drives the empty state)", () => {
    expect(groupByMode([])).toEqual([]);
  });

  it("covers all contract modes in ACTIVITY_MODE_ORDER", () => {
    const modes: ActivityMode[] = [
      "pipeline",
      "manager",
      "task_group",
    ];
    expect([...ACTIVITY_MODE_ORDER].sort()).toEqual([...modes].sort());
  });
});

// ─── snapshotRunIds (ownership-scoped subscription set) ──────────────────────────

describe("snapshotRunIds", () => {
  it("returns exactly the snapshot runIds (never derived/guessed)", () => {
    const rows = [makeRun({ runId: "a" }), makeRun({ runId: "b" })];
    expect(snapshotRunIds(rows)).toEqual(["a", "b"]);
  });

  it("is empty for an empty snapshot", () => {
    expect(snapshotRunIds([])).toEqual([]);
  });
});

// ─── isLiveNow (live pulse) ─────────────────────────────────────────────────────

describe("isLiveNow", () => {
  it("is false when no WS delta has ever landed", () => {
    expect(isLiveNow(makeRun(), NOW)).toBe(false);
  });

  it("is true within the freshness window and false past it", () => {
    const row = makeRun({ runId: "a" });
    const live = mergeWsEvent([row], ev("stage:progress", "a", {}), NOW)[0];
    expect(isLiveNow(live, NOW)).toBe(true);
    expect(isLiveNow(live, NOW + LIVE_PULSE_WINDOW_MS)).toBe(true);
    expect(isLiveNow(live, NOW + LIVE_PULSE_WINDOW_MS + 1)).toBe(false);
  });
});

// ─── displayModel ────────────────────────────────────────────────────────────────

describe("displayModel", () => {
  it("shows the slug when present", () => {
    expect(displayModel("claude-opus")).toBe("claude-opus");
  });

  it("shows an em-dash for null / undefined / empty", () => {
    expect(displayModel(null)).toBe("—");
    expect(displayModel(undefined)).toBe("—");
    expect(displayModel("")).toBe("—");
  });
});

// ─── Admin-only owner column (presence of ownerId) ───────────────────────────────
// The page renders the Owner column iff isAdmin; the data contract is that
// ownerId is present only for admins. These assert the row data the column reads.

describe("ownerId attribution (admin-only column data)", () => {
  it("carries ownerId on admin rows", () => {
    const row = makeRun({ runId: "a", ownerId: "user-42" });
    expect(row.ownerId).toBe("user-42");
  });

  it("is absent/undefined on non-admin rows", () => {
    const row = makeRun({ runId: "a" });
    expect(row.ownerId).toBeUndefined();
  });
});

// ─── task_group: live merge + grouping ──────────────────────────────────────────
// A task_group active row appears in BOTH the snapshot grouping AND folds its
// own WS deltas (runId = groupId). These cover the task_group branch added to
// mergeWsEvent / groupByMode.

describe("mergeWsEvent — task_group deltas (runId = groupId)", () => {
  it("task:started updates the unit name/team/model and marks running", () => {
    const rows = [makeRun({ runId: "g1", mode: "task_group" })];
    const next = mergeWsEvent(
      rows,
      ev("task:started", "g1", { name: "Summarise", teamId: "research", modelSlug: "gpt-x" }),
      NOW,
    );
    expect(next[0].currentUnit).toEqual({
      label: "Summarise",
      agent: "research",
      modelSlug: "gpt-x",
      status: "running",
    });
    expect(next[0].lastDeltaAt).toBe(NOW);
  });

  it("task:completed / task:failed set the matching unit status", () => {
    const rows = [makeRun({ runId: "g1", mode: "task_group" })];
    const done = mergeWsEvent(rows, ev("task:completed", "g1", { name: "A" }), NOW);
    expect(done[0].currentUnit?.status).toBe("completed");
    const failed = mergeWsEvent(rows, ev("task:failed", "g1", { name: "A" }), NOW);
    expect(failed[0].currentUnit?.status).toBe("failed");
  });

  it("taskgroup:progress keeps the prior unit but still pulses live", () => {
    const rows = [makeRun({ runId: "g1", mode: "task_group" })];
    const next = mergeWsEvent(rows, ev("taskgroup:progress", "g1", { completed: 2, running: 1 }), NOW);
    expect(next[0].currentUnit).toEqual(rows[0].currentUnit);
    expect(next[0].lastDeltaAt).toBe(NOW);
    expect(isLiveNow(next[0], NOW)).toBe(true);
  });

  it("ignores a task_group delta for an unknown groupId", () => {
    const rows = [makeRun({ runId: "g1", mode: "task_group" })];
    expect(mergeWsEvent(rows, ev("task:started", "ghost", { name: "X" }), NOW)).toBe(rows);
  });

  it("does not mutate the input on a task_group delta", () => {
    const rows = [makeRun({ runId: "g1", mode: "task_group" })];
    const before = JSON.stringify(rows);
    mergeWsEvent(rows, ev("task:started", "g1", { name: "Y" }), NOW);
    expect(JSON.stringify(rows)).toBe(before);
  });
});

describe("groupByMode — task_group", () => {
  it("places task_group rows in their own group, after manager", () => {
    const rows = [
      makeRun({ runId: "g1", mode: "task_group" }),
      makeRun({ runId: "p1", mode: "pipeline" }),
    ];
    const groups = groupByMode(rows);
    expect(groups.map((g) => g.mode)).toEqual(["pipeline", "task_group"]);
    expect(groups[1].label).toBe("Task groups");
  });
});

// ─── Activity History: cursor / merge helpers ───────────────────────────────────

function historyRow(overrides: Partial<ActivityHistoryRow> = {}): ActivityHistoryRow {
  return {
    runId: overrides.runId ?? "r1",
    mode: overrides.mode ?? "pipeline",
    title: overrides.title ?? "Pipeline run",
    status: overrides.status ?? "completed",
    startedAt: overrides.startedAt ?? "2026-06-16T10:00:00.000Z",
    completedAt: overrides.completedAt ?? "2026-06-16T10:01:00.000Z",
    currentUnit: overrides.currentUnit ?? null,
    workspaceId: overrides.workspaceId ?? null,
    ...(overrides.ownerId !== undefined ? { ownerId: overrides.ownerId } : {}),
  };
}

function page(
  items: ActivityHistoryRow[],
  nextCursor: string | null,
  isAdmin = false,
): ActivityHistoryPage {
  return { items, nextCursor, isAdmin };
}

describe("appendHistoryPage", () => {
  it("first page (isFirstPage=true) REPLACES the list and sets cursor/admin", () => {
    const prev = { items: [historyRow({ runId: "stale" })], nextCursor: "c0", isAdmin: false };
    const next = appendHistoryPage(prev, page([historyRow({ runId: "r1" })], "c1", true), true);
    expect(next.items.map((r) => r.runId)).toEqual(["r1"]);
    expect(next.nextCursor).toBe("c1");
    expect(next.isAdmin).toBe(true);
  });

  it("subsequent page APPENDS onto the accumulated items", () => {
    const first = appendHistoryPage(
      emptyHistoryState(),
      page([historyRow({ runId: "r1" })], "c1"),
      true,
    );
    const second = appendHistoryPage(
      first,
      page([historyRow({ runId: "r2" })], null),
      false,
    );
    expect(second.items.map((r) => r.runId)).toEqual(["r1", "r2"]);
    expect(second.nextCursor).toBeNull();
  });

  it("de-dupes by mode:runId across a keyset boundary", () => {
    const first = appendHistoryPage(
      emptyHistoryState(),
      page([historyRow({ runId: "r1" }), historyRow({ runId: "r2" })], "c1"),
      true,
    );
    // r2 reappears at the boundary of the next page → must not duplicate.
    const second = appendHistoryPage(
      first,
      page([historyRow({ runId: "r2" }), historyRow({ runId: "r3" })], null),
      false,
    );
    expect(second.items.map((r) => r.runId)).toEqual(["r1", "r2", "r3"]);
  });

  it("keys de-dupe by mode too: same runId in two modes is kept", () => {
    const next = appendHistoryPage(
      emptyHistoryState(),
      page(
        [
          historyRow({ runId: "x", mode: "pipeline" }),
          historyRow({ runId: "x", mode: "task_group" }),
        ],
        null,
      ),
      true,
    );
    expect(next.items).toHaveLength(2);
  });

  it("does not mutate the prev state", () => {
    const prev = appendHistoryPage(emptyHistoryState(), page([historyRow({ runId: "r1" })], "c1"), true);
    const before = JSON.stringify(prev);
    appendHistoryPage(prev, page([historyRow({ runId: "r2" })], null), false);
    expect(JSON.stringify(prev)).toBe(before);
  });
});

describe("historyRowKey", () => {
  it("combines mode and runId (groupId for task_group)", () => {
    expect(historyRowKey(historyRow({ mode: "task_group", runId: "g1" }))).toBe("task_group:g1");
  });
});

describe("hasMoreHistory", () => {
  it("is true when a cursor remains, false at the end", () => {
    expect(hasMoreHistory({ items: [], nextCursor: "c1", isAdmin: false })).toBe(true);
    expect(hasMoreHistory({ items: [], nextCursor: null, isAdmin: false })).toBe(false);
  });
});

describe("buildHistoryQuery", () => {
  it("clamps limit to the ≤100 server ceiling and emits cursor/mode", () => {
    expect(buildHistoryQuery({ limit: 250, cursor: "abc", mode: "task_group" })).toBe(
      "?limit=100&cursor=abc&mode=task_group",
    );
  });

  it("floors a positive limit and never goes below 1", () => {
    expect(buildHistoryQuery({ limit: 0 })).toBe("?limit=1");
  });

  it("omits cursor/mode when absent and url-encodes the cursor", () => {
    expect(buildHistoryQuery({ limit: 25, cursor: null, mode: null })).toBe("?limit=25");
    expect(buildHistoryQuery({ limit: 25, cursor: "a b/c=" })).toContain("cursor=a+b%2Fc%3D");
  });

  it("is empty when no params are given", () => {
    expect(buildHistoryQuery({})).toBe("");
  });
});

describe("groupHistoryByMode", () => {
  it("groups in the fixed mode order and omits empty modes", () => {
    const rows = [
      historyRow({ runId: "g1", mode: "task_group" }),
      historyRow({ runId: "p1", mode: "pipeline" }),
      historyRow({ runId: "p2", mode: "pipeline" }),
    ];
    const groups = groupHistoryByMode(rows);
    expect(groups.map((g) => g.mode)).toEqual(["pipeline", "task_group"]);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[1].rows).toHaveLength(1);
  });

  it("returns [] for no rows (drives the empty state)", () => {
    expect(groupHistoryByMode([])).toEqual([]);
  });
});

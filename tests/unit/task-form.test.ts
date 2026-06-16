/**
 * Unit tests for the shared task-group form logic (frontend) + the timeline
 * helper. Like activity-ui.test.ts / orchestrator-ui.test.ts, these exercise the
 * PURE helpers behind CreateTaskGroup + TaskGroup edit mode without a DOM
 * renderer (the repo has no jsdom) — they import from task-form-logic (no React)
 * and timeline (no React):
 *   - the status gating (isGroupEditable / isGroupRelabelOnly),
 *   - the task add/remove/dependsOn-by-id reducers,
 *   - validate() with the requireInput/requireTasks options,
 *   - buildTimeline() ordering + durations.
 */
import { describe, it, expect } from "vitest";
import {
  emptyTask,
  isGroupEditable,
  isGroupRelabelOnly,
  toggleDependency,
  setTaskModel,
  DEFAULT_MODEL_OPTION,
  addTaskToList,
  removeTaskFromList,
  updateTaskInList,
  validate,
  hasErrors,
  type TaskDraft,
} from "@/components/task-groups/task-form-logic";
import {
  buildTimeline,
  taskDurationMs,
  isTimelineComplete,
  timelineSpanMs,
  formatDuration,
  type TimelineTaskInput,
} from "@/components/task-groups/timeline";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function task(overrides: Partial<TaskDraft> = {}): TaskDraft {
  return {
    id: overrides.id ?? "t1",
    name: overrides.name ?? "Task",
    description: overrides.description ?? "Do a thing",
    executionMode: overrides.executionMode ?? "direct_llm",
    dependsOn: overrides.dependsOn ?? [],
    modelSlug: overrides.modelSlug ?? null,
  };
}

// ─── isGroupEditable / isGroupRelabelOnly (the gating) ──────────────────────────

describe("isGroupEditable", () => {
  it("allows full edit ONLY when pending", () => {
    expect(isGroupEditable("pending")).toBe(true);
  });

  it("blocks full edit for running and terminal states", () => {
    for (const s of ["running", "ready", "blocked", "completed", "failed", "cancelled"]) {
      expect(isGroupEditable(s)).toBe(false);
    }
  });
});

describe("isGroupRelabelOnly", () => {
  it("is true for the three terminal states", () => {
    expect(isGroupRelabelOnly("completed")).toBe(true);
    expect(isGroupRelabelOnly("failed")).toBe(true);
    expect(isGroupRelabelOnly("cancelled")).toBe(true);
  });

  it("is false for pending / running / intermediate", () => {
    for (const s of ["pending", "running", "ready", "blocked"]) {
      expect(isGroupRelabelOnly(s)).toBe(false);
    }
  });

  it("pending is editable but NOT relabel-only; running is neither", () => {
    expect(isGroupEditable("pending") && !isGroupRelabelOnly("pending")).toBe(true);
    expect(!isGroupEditable("running") && !isGroupRelabelOnly("running")).toBe(true);
  });
});

// ─── toggleDependency (dependsOn by id) ─────────────────────────────────────────

describe("toggleDependency", () => {
  it("adds an id when absent and removes it when present (immutably)", () => {
    const t = task({ dependsOn: [] });
    const added = toggleDependency(t, "dep-1");
    expect(added.dependsOn).toEqual(["dep-1"]);
    expect(t.dependsOn).toEqual([]); // original untouched

    const removed = toggleDependency(added, "dep-1");
    expect(removed.dependsOn).toEqual([]);
  });

  it("keeps other deps when toggling one", () => {
    const t = task({ dependsOn: ["a", "b"] });
    expect(toggleDependency(t, "a").dependsOn).toEqual(["b"]);
    expect(toggleDependency(t, "c").dependsOn).toEqual(["a", "b", "c"]);
  });
});

// ─── per-task model (setTaskModel + emptyTask default + reducer preservation) ───

describe("emptyTask", () => {
  it("starts with no pinned model (null → server default, never mock)", () => {
    expect(emptyTask().modelSlug).toBeNull();
  });
});

describe("setTaskModel", () => {
  it("pins an explicit slug immutably", () => {
    const t = task({ modelSlug: null });
    const next = setTaskModel(t, "claude-sonnet");
    expect(next.modelSlug).toBe("claude-sonnet");
    expect(t.modelSlug).toBeNull(); // original untouched
  });

  it("clears the pin back to null on the DEFAULT_MODEL_OPTION sentinel", () => {
    const t = task({ modelSlug: "claude-opus" });
    expect(setTaskModel(t, DEFAULT_MODEL_OPTION).modelSlug).toBeNull();
  });

  it("treats an empty slug as 'unset' (null, never coerced to mock)", () => {
    const t = task({ modelSlug: "claude-haiku" });
    expect(setTaskModel(t, "").modelSlug).toBeNull();
  });

  it("preserves all other task fields", () => {
    const t = task({ id: "x", name: "N", dependsOn: ["d1"] });
    const next = setTaskModel(t, "claude-sonnet");
    expect(next.id).toBe("x");
    expect(next.name).toBe("N");
    expect(next.dependsOn).toEqual(["d1"]);
  });
});

describe("reducers preserve modelSlug", () => {
  it("addTaskToList keeps existing pins and adds an unpinned task", () => {
    const list = [task({ id: "a", modelSlug: "claude-opus" })];
    const next = addTaskToList(list);
    expect(next[0].modelSlug).toBe("claude-opus");
    expect(next[1].modelSlug).toBeNull();
  });

  it("updateTaskInList carries the updated task's pinned model", () => {
    const list = [task({ id: "a", modelSlug: null }), task({ id: "b" })];
    const next = updateTaskInList(list, "a", setTaskModel(list[0], "claude-sonnet"));
    expect(next[0].modelSlug).toBe("claude-sonnet");
    expect(next[1].modelSlug).toBeNull();
  });

  it("toggleDependency does not disturb the pinned model", () => {
    const t = task({ modelSlug: "claude-sonnet", dependsOn: [] });
    expect(toggleDependency(t, "d1").modelSlug).toBe("claude-sonnet");
  });

  it("removeTaskFromList preserves surviving siblings' pins", () => {
    const list = [
      task({ id: "a", modelSlug: "claude-opus" }),
      task({ id: "b", modelSlug: "claude-haiku", dependsOn: ["a"] }),
    ];
    const next = removeTaskFromList(list, "a");
    expect(next).toHaveLength(1);
    expect(next[0].modelSlug).toBe("claude-haiku");
  });
});

// ─── add / update / remove reducers ─────────────────────────────────────────────

describe("addTaskToList", () => {
  it("appends a fresh empty task without mutating the input", () => {
    const list = [task({ id: "a" })];
    const next = addTaskToList(list);
    expect(next).toHaveLength(2);
    expect(list).toHaveLength(1);
    expect(next[1].name).toBe("");
    expect(next[1].dependsOn).toEqual([]);
  });
});

describe("updateTaskInList", () => {
  it("replaces the matching task by id only", () => {
    const list = [task({ id: "a", name: "A" }), task({ id: "b", name: "B" })];
    const next = updateTaskInList(list, "b", { ...list[1], name: "B2" });
    expect(next[0]).toBe(list[0]); // untouched ref
    expect(next[1].name).toBe("B2");
  });
});

describe("removeTaskFromList — strips the removed id from siblings' dependsOn", () => {
  it("removes the task AND its id from every sibling (mirrors the server)", () => {
    const list = [
      task({ id: "a" }),
      task({ id: "b", dependsOn: ["a"] }),
      task({ id: "c", dependsOn: ["a", "b"] }),
    ];
    const next = removeTaskFromList(list, "a");
    expect(next.map((t) => t.id)).toEqual(["b", "c"]);
    expect(next[0].dependsOn).toEqual([]); // 'a' stripped from b
    expect(next[1].dependsOn).toEqual(["b"]); // 'a' stripped from c, 'b' kept
  });

  it("does not mutate the input list or its tasks", () => {
    const list = [task({ id: "a" }), task({ id: "b", dependsOn: ["a"] })];
    const before = JSON.stringify(list);
    removeTaskFromList(list, "a");
    expect(JSON.stringify(list)).toBe(before);
  });

  it("is a no-op-shaped result when the id is absent (still strips nothing)", () => {
    const list = [task({ id: "a", dependsOn: ["x"] })];
    const next = removeTaskFromList(list, "missing");
    expect(next.map((t) => t.id)).toEqual(["a"]);
    expect(next[0].dependsOn).toEqual(["x"]);
  });
});

// ─── validate + hasErrors ───────────────────────────────────────────────────────

describe("validate", () => {
  const goodGroup = { name: "G", description: "D", input: "I" };

  it("passes a complete pending group (input + tasks required)", () => {
    const errors = validate(goodGroup, [task()]);
    expect(hasErrors(errors)).toBe(false);
  });

  it("flags missing group name/description/input", () => {
    const errors = validate({ name: "", description: "", input: "" }, [task()]);
    expect(errors.name).toBeTruthy();
    expect(errors.description).toBeTruthy();
    expect(errors.input).toBeTruthy();
    expect(hasErrors(errors)).toBe(true);
  });

  it("flags an empty task list and per-task name/description", () => {
    expect(validate(goodGroup, []).tasks).toBeTruthy();
    const errors = validate(goodGroup, [task({ id: "z", name: "", description: "" })]);
    expect(errors.taskErrors?.z?.name).toBeTruthy();
    expect(errors.taskErrors?.z?.description).toBeTruthy();
  });

  it("relabel mode (requireInput/requireTasks=false) ignores input + tasks", () => {
    // terminal relabel: only name/description matter; empty input + no tasks OK.
    const errors = validate({ name: "G", description: "D", input: "" }, [], {
      requireInput: false,
      requireTasks: false,
    });
    expect(hasErrors(errors)).toBe(false);
  });

  it("relabel mode still flags a blank name", () => {
    const errors = validate({ name: "", description: "D", input: "" }, [], {
      requireInput: false,
      requireTasks: false,
    });
    expect(errors.name).toBeTruthy();
    expect(errors.input).toBeUndefined();
    expect(errors.tasks).toBeUndefined();
  });
});

// ─── emptyTask ──────────────────────────────────────────────────────────────────

describe("emptyTask", () => {
  it("produces a unique-id blank direct_llm task", () => {
    const a = emptyTask();
    const b = emptyTask();
    expect(a.id).not.toBe(b.id);
    expect(a.executionMode).toBe("direct_llm");
    expect(a.dependsOn).toEqual([]);
  });
});

// ─── buildTimeline + duration helpers ───────────────────────────────────────────

function ttask(overrides: Partial<TimelineTaskInput> = {}): TimelineTaskInput {
  return {
    id: overrides.id ?? "t",
    name: overrides.name ?? "Task",
    status: overrides.status ?? "pending",
    executionMode: overrides.executionMode,
    modelSlug: overrides.modelSlug,
    teamId: overrides.teamId,
    sortOrder: overrides.sortOrder,
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
  };
}

describe("taskDurationMs", () => {
  it("computes start→end in ms", () => {
    expect(
      taskDurationMs(
        ttask({
          startedAt: "2026-06-16T10:00:00.000Z",
          completedAt: "2026-06-16T10:00:05.000Z",
        }),
      ),
    ).toBe(5000);
  });

  it("is null when either timestamp is missing", () => {
    expect(taskDurationMs(ttask({ startedAt: "2026-06-16T10:00:00.000Z" }))).toBeNull();
    expect(taskDurationMs(ttask({ completedAt: "2026-06-16T10:00:00.000Z" }))).toBeNull();
    expect(taskDurationMs(ttask())).toBeNull();
  });

  it("is null for a negative (clock-skew) duration", () => {
    expect(
      taskDurationMs(
        ttask({
          startedAt: "2026-06-16T10:00:05.000Z",
          completedAt: "2026-06-16T10:00:00.000Z",
        }),
      ),
    ).toBeNull();
  });
});

describe("buildTimeline", () => {
  it("orders started tasks by startedAt, then unstarted by sortOrder", () => {
    const tasks = [
      ttask({ id: "late", status: "completed", startedAt: "2026-06-16T10:00:10.000Z" }),
      ttask({ id: "p2", status: "pending", sortOrder: 5 }),
      ttask({ id: "early", status: "completed", startedAt: "2026-06-16T10:00:01.000Z" }),
      ttask({ id: "p1", status: "pending", sortOrder: 1 }),
    ];
    const tl = buildTimeline(tasks);
    expect(tl.map((e) => e.id)).toEqual(["early", "late", "p1", "p2"]);
  });

  it("does not mutate the input array", () => {
    const tasks = [
      ttask({ id: "b", startedAt: "2026-06-16T10:00:02.000Z" }),
      ttask({ id: "a", startedAt: "2026-06-16T10:00:01.000Z" }),
    ];
    const ids = tasks.map((t) => t.id);
    buildTimeline(tasks);
    expect(tasks.map((t) => t.id)).toEqual(ids);
  });

  it("carries metadata and computes per-task duration + hasRun", () => {
    const tl = buildTimeline([
      ttask({
        id: "x",
        status: "completed",
        executionMode: "pipeline_run",
        modelSlug: "claude-opus",
        teamId: "frontend",
        startedAt: "2026-06-16T10:00:00.000Z",
        completedAt: "2026-06-16T10:00:03.000Z",
      }),
      ttask({ id: "y", status: "pending" }),
    ]);
    const x = tl.find((e) => e.id === "x")!;
    expect(x).toMatchObject({
      executionMode: "pipeline_run",
      modelSlug: "claude-opus",
      teamId: "frontend",
      durationMs: 3000,
      hasRun: true,
    });
    const y = tl.find((e) => e.id === "y")!;
    expect(y.hasRun).toBe(false);
    expect(y.durationMs).toBeNull();
  });

  it("returns [] for no tasks (drives the empty state)", () => {
    expect(buildTimeline([])).toEqual([]);
  });
});

describe("isTimelineComplete", () => {
  it("is true only when every task is terminal", () => {
    const done = buildTimeline([
      ttask({ id: "a", status: "completed" }),
      ttask({ id: "b", status: "failed" }),
    ]);
    expect(isTimelineComplete(done)).toBe(true);

    const mixed = buildTimeline([
      ttask({ id: "a", status: "completed" }),
      ttask({ id: "b", status: "running" }),
    ]);
    expect(isTimelineComplete(mixed)).toBe(false);
  });

  it("is false for an empty timeline", () => {
    expect(isTimelineComplete([])).toBe(false);
  });
});

describe("timelineSpanMs", () => {
  it("spans earliest start to latest end", () => {
    const tl = buildTimeline([
      ttask({
        id: "a",
        startedAt: "2026-06-16T10:00:00.000Z",
        completedAt: "2026-06-16T10:00:04.000Z",
      }),
      ttask({
        id: "b",
        startedAt: "2026-06-16T10:00:02.000Z",
        completedAt: "2026-06-16T10:00:10.000Z",
      }),
    ]);
    expect(timelineSpanMs(tl)).toBe(10_000);
  });

  it("is null with no started/completed pair", () => {
    expect(timelineSpanMs(buildTimeline([ttask({ id: "a", status: "pending" })]))).toBeNull();
  });
});

describe("formatDuration", () => {
  it("formats ms / s / m and the null placeholder", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(0)).toBe("—");
    expect(formatDuration(250)).toBe("250ms");
    expect(formatDuration(1500)).toBe("1.5s");
    expect(formatDuration(90_000)).toBe("1.5m");
  });
});

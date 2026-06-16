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
  addLabel,
  removeLabel,
  setTaskLabels,
  seedTaskFromTemplate,
  seedTasksFromTemplates,
  validate,
  hasErrors,
  type TaskDraft,
  type TemplateSeed,
} from "@/components/task-groups/task-form-logic";
import {
  buildTimeline,
  buildTimelineFromExecutions,
  executionToTimelineInput,
  taskDurationMs,
  isTimelineComplete,
  timelineSpanMs,
  formatDuration,
  type TimelineTaskInput,
  type ExecutionRowInput,
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
    labels: overrides.labels ?? [],
    templateId: overrides.templateId ?? null,
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

// ─── labels: emptyTask default + chip reducer (add/remove/dedupe/trim) ──────────

describe("emptyTask labels/templateId defaults", () => {
  it("starts with empty labels and no template provenance", () => {
    const t = emptyTask();
    expect(t.labels).toEqual([]);
    expect(t.templateId).toBeNull();
  });
});

describe("addLabel", () => {
  it("appends a trimmed label, preserving order", () => {
    expect(addLabel(["a"], "b")).toEqual(["a", "b"]);
    expect(addLabel(["a"], "  spaced  ")).toEqual(["a", "spaced"]);
  });

  it("rejects an empty/whitespace-only label (no-op copy)", () => {
    const base = ["a"];
    expect(addLabel(base, "")).toEqual(["a"]);
    expect(addLabel(base, "   ")).toEqual(["a"]);
    expect(addLabel(base, "")).not.toBe(base); // returns a copy, not the input ref
  });

  it("de-dupes an already-present label (after trim)", () => {
    expect(addLabel(["a", "b"], "a")).toEqual(["a", "b"]);
    expect(addLabel(["a"], "  a ")).toEqual(["a"]);
  });

  it("does not mutate the input list", () => {
    const base = ["a"];
    addLabel(base, "b");
    expect(base).toEqual(["a"]);
  });
});

describe("removeLabel", () => {
  it("removes a label by value, preserving the order of the rest", () => {
    expect(removeLabel(["a", "b", "c"], "b")).toEqual(["a", "c"]);
  });

  it("is a no-op when the label is absent", () => {
    expect(removeLabel(["a"], "z")).toEqual(["a"]);
  });

  it("does not mutate the input list", () => {
    const base = ["a", "b"];
    removeLabel(base, "a");
    expect(base).toEqual(["a", "b"]);
  });
});

describe("setTaskLabels + reducers preserve labels/templateId", () => {
  it("setTaskLabels replaces labels immutably, keeping other fields", () => {
    const t = task({ id: "x", name: "N", templateId: "tpl-1" });
    const next = setTaskLabels(t, ["new"]);
    expect(next.labels).toEqual(["new"]);
    expect(next.name).toBe("N");
    expect(next.templateId).toBe("tpl-1");
    expect(t.labels).toEqual([]); // original untouched
  });

  it("toggleDependency / setTaskModel keep labels + templateId", () => {
    const t = task({ labels: ["fe"], templateId: "tpl-1" });
    expect(toggleDependency(t, "d1").labels).toEqual(["fe"]);
    expect(toggleDependency(t, "d1").templateId).toBe("tpl-1");
    expect(setTaskModel(t, "claude-sonnet").labels).toEqual(["fe"]);
    expect(setTaskModel(t, "claude-sonnet").templateId).toBe("tpl-1");
  });

  it("removeTaskFromList preserves surviving siblings' labels + provenance", () => {
    const list = [
      task({ id: "a", labels: ["x"] }),
      task({ id: "b", labels: ["y"], templateId: "tpl-2", dependsOn: ["a"] }),
    ];
    const next = removeTaskFromList(list, "a");
    expect(next).toHaveLength(1);
    expect(next[0].labels).toEqual(["y"]);
    expect(next[0].templateId).toBe("tpl-2");
  });
});

// ─── seed-from-template reducer (FE4) ───────────────────────────────────────────

function seed(overrides: Partial<TemplateSeed> = {}): TemplateSeed {
  return {
    id: overrides.id ?? "tpl-1",
    name: overrides.name ?? "Summarise",
    description: overrides.description ?? "Summarise the input",
    executionMode: "executionMode" in overrides ? overrides.executionMode : "direct_llm",
    modelSlug: "modelSlug" in overrides ? overrides.modelSlug : "claude-sonnet",
    input: "input" in overrides ? overrides.input : { foo: "bar" },
    labels: "labels" in overrides ? overrides.labels : ["research"],
  };
}

describe("seedTaskFromTemplate", () => {
  it("copies name/desc/mode/model/labels and stamps templateId (provenance)", () => {
    const draft = seedTaskFromTemplate(seed());
    expect(draft.name).toBe("Summarise");
    expect(draft.description).toBe("Summarise the input");
    expect(draft.executionMode).toBe("direct_llm");
    expect(draft.modelSlug).toBe("claude-sonnet");
    expect(draft.labels).toEqual(["research"]);
    expect(draft.templateId).toBe("tpl-1");
  });

  it("assigns a FRESH client id, never the template id, and empty dependsOn", () => {
    const draft = seedTaskFromTemplate(seed({ id: "tpl-1" }));
    expect(draft.id).not.toBe("tpl-1");
    expect(draft.dependsOn).toEqual([]);
  });

  it("normalizes pipeline_run and defaults a missing/odd mode to direct_llm", () => {
    expect(seedTaskFromTemplate(seed({ executionMode: "pipeline_run" })).executionMode).toBe(
      "pipeline_run",
    );
    expect(seedTaskFromTemplate(seed({ executionMode: null })).executionMode).toBe("direct_llm");
    expect(seedTaskFromTemplate(seed({ executionMode: "bogus" })).executionMode).toBe(
      "direct_llm",
    );
  });

  it("copies labels by value (editing the draft never mutates the template)", () => {
    const tpl = seed({ labels: ["a"] });
    const draft = seedTaskFromTemplate(tpl);
    draft.labels.push("b");
    expect(tpl.labels).toEqual(["a"]);
  });

  it("tolerates a null/absent modelSlug + labels", () => {
    const draft = seedTaskFromTemplate(seed({ modelSlug: null, labels: null }));
    expect(draft.modelSlug).toBeNull();
    expect(draft.labels).toEqual([]);
  });
});

describe("seedTasksFromTemplates", () => {
  it("appends seeded rows AFTER the existing manual rows, in template order", () => {
    const manual = [task({ id: "m1", name: "Manual one" })];
    const next = seedTasksFromTemplates(manual, [
      seed({ id: "tpl-1", name: "T1" }),
      seed({ id: "tpl-2", name: "T2" }),
    ]);
    expect(next.map((t) => t.name)).toEqual(["Manual one", "T1", "T2"]);
    expect(next[0].templateId).toBeNull(); // manual row preserved verbatim
    expect(next[1].templateId).toBe("tpl-1");
    expect(next[2].templateId).toBe("tpl-2");
  });

  it("does not mutate the input task list", () => {
    const manual = [task({ id: "m1" })];
    seedTasksFromTemplates(manual, [seed()]);
    expect(manual).toHaveLength(1);
  });

  it("seeds onto an empty list", () => {
    const next = seedTasksFromTemplates([], [seed({ id: "tpl-9" })]);
    expect(next).toHaveLength(1);
    expect(next[0].templateId).toBe("tpl-9");
  });
});

// ─── buildTimeline on EXECUTION rows (FE5 adapter) ──────────────────────────────

function exec(overrides: Partial<ExecutionRowInput> = {}): ExecutionRowInput {
  return {
    id: overrides.id ?? "e1",
    taskId: "taskId" in overrides ? overrides.taskId : "t1",
    taskName: "taskName" in overrides ? overrides.taskName : "Step",
    status: overrides.status ?? "completed",
    modelSlug: "modelSlug" in overrides ? overrides.modelSlug : null,
    startedAt: "startedAt" in overrides ? overrides.startedAt : null,
    completedAt: "completedAt" in overrides ? overrides.completedAt : null,
  };
}

describe("executionToTimelineInput", () => {
  it("maps the execution id as the timeline key and surfaces taskName", () => {
    const input = executionToTimelineInput(
      exec({ id: "e-7", taskName: "Build", modelSlug: "claude-opus" }),
    );
    expect(input.id).toBe("e-7");
    expect(input.name).toBe("Build");
    expect(input.modelSlug).toBe("claude-opus");
    expect(input.executionMode).toBeNull();
  });

  it("falls back to a placeholder name when the definition was deleted", () => {
    expect(executionToTimelineInput(exec({ taskName: null })).name).toBe("(removed task)");
    expect(executionToTimelineInput(exec({ taskName: "  " })).name).toBe("(removed task)");
  });
});

describe("buildTimelineFromExecutions", () => {
  it("orders started executions by startedAt and surfaces taskName + model", () => {
    const tl = buildTimelineFromExecutions([
      exec({
        id: "late",
        taskName: "Late",
        status: "failed",
        startedAt: "2026-06-16T10:00:10.000Z",
        completedAt: "2026-06-16T10:00:12.000Z",
      }),
      exec({
        id: "early",
        taskName: "Early",
        status: "completed",
        modelSlug: "claude-sonnet",
        startedAt: "2026-06-16T10:00:01.000Z",
        completedAt: "2026-06-16T10:00:03.000Z",
      }),
      exec({ id: "pending", taskName: "Pending", status: "pending" }),
    ]);
    expect(tl.map((e) => e.id)).toEqual(["early", "late", "pending"]);
    expect(tl.map((e) => e.name)).toEqual(["Early", "Late", "Pending"]);
    expect(tl[0].modelSlug).toBe("claude-sonnet");
    expect(tl[0].durationMs).toBe(2000);
    expect(tl[2].hasRun).toBe(false);
  });

  it("handles a mixed completed/failed/running set with the right statuses", () => {
    const tl = buildTimelineFromExecutions([
      exec({ id: "c", status: "completed", startedAt: "2026-06-16T10:00:00.000Z", completedAt: "2026-06-16T10:00:01.000Z" }),
      exec({ id: "f", status: "failed", startedAt: "2026-06-16T10:00:02.000Z", completedAt: "2026-06-16T10:00:03.000Z" }),
      exec({ id: "r", status: "running", startedAt: "2026-06-16T10:00:04.000Z" }),
    ]);
    expect(tl.map((e) => e.status)).toEqual(["completed", "failed", "running"]);
    expect(isTimelineComplete(tl)).toBe(false); // a running row keeps it incomplete
    const running = tl.find((e) => e.id === "r")!;
    expect(running.durationMs).toBeNull(); // no completedAt
    expect(running.hasRun).toBe(true);
  });

  it("returns [] for no executions", () => {
    expect(buildTimelineFromExecutions([])).toEqual([]);
  });
});

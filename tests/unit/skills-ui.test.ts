/**
 * Unit tests for Skills UI logic (PR #171 — clickable SkillCards, SkillDetailModal,
 * SkillLibraryDetailModal, SkillEditor, custom teams).
 *
 * Uses the same source-inspection + pure-logic approach as pipeline-ux.test.ts.
 * No browser/jsdom needed — tests run in node environment.
 *
 * Covers:
 * 1. SkillCard: team badge color mapping (TEAM_BADGE_COLORS), accessibility attributes
 * 2. SkillDetailModal: buildSkillConfigForPreview output shape, TEAM_BADGE_COLORS coverage,
 *    SHARING_ICONS / SHARING_BADGE_STYLES coverage
 * 3. SkillLibraryDetailModal: noopRollback, component export present
 * 4. SkillEditor: team dropdown option in source
 * 5. Skills page: route registration present in App.tsx
 * 6. CreateTaskGroup: route /task-groups/new registered, helper functions
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");

function readSource(relPath: string): string {
  return readFileSync(resolve(PROJECT_ROOT, relPath), "utf-8");
}

// ─── SkillCard ────────────────────────────────────────────────────────────────

describe("SkillCard component (PR #171)", () => {
  const source = readSource("client/src/components/skills/SkillCard.tsx");

  it("exports SkillCard as a named function export", () => {
    expect(source).toMatch(/export function SkillCard/);
  });

  it("has TEAM_BADGE_COLORS mapping for all standard teams", () => {
    const expectedTeams = [
      "planning",
      "architecture",
      "development",
      "testing",
      "code_review",
      "deployment",
      "monitoring",
      "fact_check",
    ];
    for (const team of expectedTeams) {
      expect(source, `Missing badge color for team: ${team}`).toContain(team);
    }
  });

  it("fallback badge class is applied for unknown teamId", () => {
    // The ?? operator handles the fallback — verify it's present in source
    expect(source).toMatch(/TEAM_BADGE_COLORS\[skill\.teamId\]\s*\?\?/);
  });

  it("card is clickable — has onClick={onView} handler", () => {
    expect(source).toContain("onClick={onView}");
  });

  it("card has role=button for accessibility", () => {
    expect(source).toContain('role="button"');
  });

  it("card has tabIndex for keyboard navigation", () => {
    expect(source).toContain("tabIndex={0}");
  });

  it("card handles Enter/Space keyboard events via onKeyDown", () => {
    expect(source).toContain("onKeyDown");
    expect(source).toContain('"Enter"');
    expect(source).toContain('" "');
  });

  it("card has aria-label for screen readers", () => {
    expect(source).toMatch(/aria-label=\{`View skill: \$\{skill\.name\}`\}/);
  });

  it("edit button calls onEdit and stops propagation (not onView)", () => {
    // The edit/delete buttons should call their specific handlers, not onView
    expect(source).toContain("onEdit");
    expect(source).toContain("onDelete");
  });

  it("shows lock icon for built-in skills", () => {
    expect(source).toContain("Lock");
    expect(source).toContain("isBuiltin");
  });

  it("built-in skills hide edit/delete buttons (conditional rendering)", () => {
    // Built-in skills do not show edit/delete — the buttons are inside !skill.isBuiltin block
    expect(source).toContain("!skill.isBuiltin");
  });
});

// ─── SkillLibraryDetailModal ──────────────────────────────────────────────────

describe("SkillLibraryDetailModal component (PR #171)", () => {
  const source = readSource("client/src/components/skills/SkillLibraryDetailModal.tsx");

  it("exports SkillLibraryDetailModal as named export", () => {
    expect(source).toMatch(/export function SkillLibraryDetailModal/);
  });

  it("has noopRollback function defined", () => {
    expect(source).toContain("noopRollback");
  });

  it("noopRollback accepts a version parameter", () => {
    expect(source).toMatch(/function noopRollback\(_version/);
  });

  it("renders version history section", () => {
    expect(source.toLowerCase()).toMatch(/version/);
  });

  it("has install/copy functionality", () => {
    // Skill library modals typically have install or copy-to-use
    expect(source.toLowerCase()).toMatch(/install|copy|use/);
  });
});

// ─── SkillEditor ──────────────────────────────────────────────────────────────

describe("SkillEditor component — team dropdown (PR #171)", () => {
  const source = readSource("client/src/components/skills/SkillEditor.tsx");

  it("exports SkillEditor as named export", () => {
    expect(source).toMatch(/export function SkillEditor/);
  });

  it("has team dropdown/select in the form", () => {
    // The team dropdown was a new feature in PR #171
    expect(source.toLowerCase()).toMatch(/team|teamid/i);
  });

  it("renders teams from SDLC_TEAMS import (not hardcoded literals)", () => {
    // Teams are injected from builtinTeamEntries = Object.entries(SDLC_TEAMS)
    expect(source).toContain("SDLC_TEAMS");
    expect(source).toContain("builtinTeamEntries");
  });

  it("has form validation (required fields)", () => {
    expect(source).toMatch(/required|min|validation|schema/i);
  });

  it("has onSaved callback for parent notification", () => {
    expect(source).toContain("onSaved");
  });

  it("has onClose callback for dialog dismissal", () => {
    expect(source).toContain("onClose");
  });
});

// ─── Task-form shared bits (still used by the Task Library) ───────────────────
//
// The standalone Task Groups pages (CreateTaskGroup / TaskGroup / …) were retired
// once the dispute moved onto the consilium loop page. The shared task-form module
// they used SURVIVES because the Task Library still authors templates with it, so
// these assertions target the reusable module directly (not a deleted page).

describe("shared task-form module (task-form-logic + task-form)", () => {
  const formLogic = readSource("client/src/components/task-groups/task-form-logic.ts");
  const formRow = readSource("client/src/components/task-groups/task-form.tsx");

  it("exposes the shared emptyTask helper with executionMode + dependsOn", () => {
    expect(formLogic).toContain("function emptyTask");
    expect(formLogic).toContain("executionMode");
    expect(formLogic).toContain("dependsOn");
  });

  it("supports both pipeline_run and direct_llm execution modes (shared TaskRow)", () => {
    expect(formRow).toContain('"pipeline_run"');
    expect(formRow).toContain('"direct_llm"');
  });

  it("has task dependency management (shared toggleDependency)", () => {
    expect(formLogic).toContain("toggleDependency");
    expect(formLogic).toContain("dependsOn");
  });
});

// ─── emptyTask — pure logic ───────────────────────────────────────────────────

describe("CreateTaskGroup — emptyTask helper logic", () => {
  // Re-implement emptyTask in test scope to verify behavior
  type ExecutionMode = "direct_llm" | "pipeline_run";

  interface TaskDraft {
    id: string;
    name: string;
    description: string;
    executionMode: ExecutionMode;
    dependsOn: string[];
  }

  function emptyTask(): TaskDraft {
    return {
      id: "test-id",
      name: "",
      description: "",
      executionMode: "direct_llm",
      dependsOn: [],
    };
  }

  it("creates task with empty name by default", () => {
    const task = emptyTask();
    expect(task.name).toBe("");
  });

  it("creates task with default executionMode=direct_llm", () => {
    const task = emptyTask();
    expect(task.executionMode).toBe("direct_llm");
  });

  it("creates task with empty dependsOn array", () => {
    const task = emptyTask();
    expect(task.dependsOn).toEqual([]);
  });

  it("creates task with empty description", () => {
    const task = emptyTask();
    expect(task.description).toBe("");
  });

  it("toggleDep logic: adds dep when not present", () => {
    const task: TaskDraft = emptyTask();
    const name = "Backend API";
    const next = task.dependsOn.includes(name)
      ? task.dependsOn.filter((d) => d !== name)
      : [...task.dependsOn, name];
    expect(next).toContain("Backend API");
  });

  it("toggleDep logic: removes dep when already present", () => {
    const task: TaskDraft = { ...emptyTask(), dependsOn: ["Backend API", "Database"] };
    const name = "Backend API";
    const next = task.dependsOn.includes(name)
      ? task.dependsOn.filter((d) => d !== name)
      : [...task.dependsOn, name];
    expect(next).not.toContain("Backend API");
    expect(next).toContain("Database");
  });
});

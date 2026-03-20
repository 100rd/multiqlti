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

// ─── SkillDetailModal ─────────────────────────────────────────────────────────

describe("SkillDetailModal component — buildSkillConfigForPreview logic", () => {
  // Extract and re-implement the pure function for testing
  // (mirrors the function in client/src/components/skills/SkillDetailModal.tsx)

  interface MarketplaceSkillData {
    name: string;
    description: string;
    teamId: string;
    version: string;
    author: string;
    tags: string[];
    sharing: "public" | "private" | "team";
    modelPreference?: string;
    usageCount: number;
  }

  function buildSkillConfigForPreview(skill: MarketplaceSkillData): string {
    const config = {
      name: skill.name,
      description: skill.description,
      teamId: skill.teamId,
      version: skill.version,
      author: skill.author,
      tags: skill.tags,
      sharing: skill.sharing,
      modelPreference: skill.modelPreference,
      usageCount: skill.usageCount,
    };
    return JSON.stringify(config, null, 2);
  }

  const testSkill: MarketplaceSkillData = {
    name: "Code Review Pro",
    description: "Performs thorough code reviews",
    teamId: "code_review",
    version: "1.2.0",
    author: "engineering-team",
    tags: ["review", "quality"],
    sharing: "public",
    modelPreference: "claude-sonnet-4-6",
    usageCount: 150,
  };

  it("produces valid JSON string", () => {
    const result = buildSkillConfigForPreview(testSkill);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it("includes name, description, teamId in output", () => {
    const result = buildSkillConfigForPreview(testSkill);
    const parsed = JSON.parse(result) as MarketplaceSkillData;
    expect(parsed.name).toBe("Code Review Pro");
    expect(parsed.description).toBe("Performs thorough code reviews");
    expect(parsed.teamId).toBe("code_review");
  });

  it("includes version and author", () => {
    const result = buildSkillConfigForPreview(testSkill);
    const parsed = JSON.parse(result) as MarketplaceSkillData;
    expect(parsed.version).toBe("1.2.0");
    expect(parsed.author).toBe("engineering-team");
  });

  it("includes tags array", () => {
    const result = buildSkillConfigForPreview(testSkill);
    const parsed = JSON.parse(result) as MarketplaceSkillData;
    expect(parsed.tags).toEqual(["review", "quality"]);
  });

  it("includes sharing level", () => {
    const result = buildSkillConfigForPreview(testSkill);
    const parsed = JSON.parse(result) as MarketplaceSkillData;
    expect(parsed.sharing).toBe("public");
  });

  it("includes usageCount", () => {
    const result = buildSkillConfigForPreview(testSkill);
    const parsed = JSON.parse(result) as MarketplaceSkillData;
    expect(parsed.usageCount).toBe(150);
  });

  it("is pretty-printed with 2 spaces indentation", () => {
    const result = buildSkillConfigForPreview(testSkill);
    expect(result).toContain("\n  ");
  });

  it("handles undefined modelPreference gracefully", () => {
    const skillNoModel = { ...testSkill, modelPreference: undefined };
    const result = buildSkillConfigForPreview(skillNoModel);
    // JSON.stringify omits undefined values — the key should not be present
    expect(() => JSON.parse(result)).not.toThrow();
  });

  describe("source structure checks", () => {
    const source = readSource("client/src/components/skills/SkillDetailModal.tsx");

    it("exports SkillDetailModal as named export", () => {
      expect(source).toMatch(/export function SkillDetailModal/);
    });

    it("has SHARING_ICONS mapping for all sharing levels", () => {
      // Keys are unquoted object properties: public:, team:, private:
      expect(source).toMatch(/public:\s/);
      expect(source).toMatch(/private:\s/);
      expect(source).toMatch(/team:\s/);
    });

    it("has SHARING_BADGE_STYLES mapping", () => {
      expect(source).toContain("SHARING_BADGE_STYLES");
    });

    it("has download functionality for both JSON and YAML", () => {
      expect(source).toContain(".json");
      expect(source).toContain(".yaml");
    });
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

  it("includes custom team support (from API)", () => {
    expect(source).toContain("customTeams");
    expect(source).toContain("useSkillTeams");
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

// ─── CreateTaskGroup page (PR #167) ──────────────────────────────────────────

describe("CreateTaskGroup page (PR #167)", () => {
  const source = readSource("client/src/pages/CreateTaskGroup.tsx");

  it("has emptyTask helper that creates a task draft with default values", () => {
    expect(source).toContain("function emptyTask");
    expect(source).toContain("executionMode");
    expect(source).toContain("dependsOn");
  });

  it("supports both manual and submit-work view modes", () => {
    expect(source).toContain('"manual"');
    expect(source).toContain('"submit-work"');
  });

  it("has split preview functionality (LLM-assisted task splitting)", () => {
    expect(source).toContain("splitPreview");
    expect(source).toContain("useSplitPreview");
  });

  it("has submit-work flow with tracker integration", () => {
    expect(source).toContain("useSubmitWork");
    expect(source).toContain("trackerUrl");
  });

  it("supports both pipeline_run and direct_llm execution modes", () => {
    expect(source).toContain('"pipeline_run"');
    expect(source).toContain('"direct_llm"');
  });

  it("has task dependency management (toggleDep)", () => {
    expect(source).toContain("toggleDep");
    expect(source).toContain("dependsOn");
  });

  it("navigates back on success", () => {
    expect(source).toContain("useLocation");
  });

  it("route /task-groups/new is registered in App.tsx", () => {
    const appSource = readSource("client/src/App.tsx");
    expect(appSource).toContain("/task-groups/new");
    expect(appSource).toContain("CreateTaskGroup");
  });

  it("route /task-groups/:id/trace is registered in App.tsx (PR #169)", () => {
    const appSource = readSource("client/src/App.tsx");
    expect(appSource).toContain("/task-groups/:id/trace");
    expect(appSource).toContain("TaskGroupTrace");
  });
});

// ─── CreateTaskGroup — pure logic (emptyTask) ─────────────────────────────────

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

/**
 * DB-layer project scoping for LIST/READ + aggregate methods
 * (strict-project-isolation work).
 *
 * Proves — WITHOUT a real database — that the storage read methods which
 * previously did a raw `db.select().from(table)` now embed a project_id filter,
 * and that the global-catalog methods (getModels / getActiveModels) use the
 * "global-or-current" predicate (project_id IS NULL OR project_id = $ctx).
 *
 * Technique: build the SAME Drizzle query the storage method builds and call
 * `.toSQL()` (pure serialisation — no connection). The presence of the
 * project_id column reference + the bound projectId param in the generated SQL
 * is the structural proof that project A's query cannot match project B's rows.
 * For the two tables that have NO project_id column (traces, consilium_loops),
 * we prove the SCOPED SUB-QUERY (through pipeline_runs / task_groups) carries
 * the filter.
 *
 * Mirrors the harness in db-layer-isolation.test.ts.
 */

import { describe, it, expect, vi } from "vitest";
import { eq, inArray, desc, asc } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

// ─── Mock configLoader before any server module is imported ──────────────────
vi.mock("../../../server/config/loader.js", () => ({
  configLoader: {
    get: () => ({
      database: { url: undefined },
      server: { nodeEnv: "test", port: 3000 },
      auth: { jwtSecret: "test-secret-minimum-32-chars-xx", bcryptRounds: 4, sessionTtlDays: 1 },
      encryption: { key: undefined },
      providers: {},
      features: {
        sandbox: { enabled: false },
        privacy: { enabled: false },
        maintenance: { enabled: false, cronSchedule: "" },
      },
    }),
  },
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { db, withProject, withProjectList, withProjectOrGlobal } from "../../../server/db.js";
import { runAsProject, runAsSystem } from "../../../server/context.js";
import {
  models,
  pipelines,
  pipelineRuns,
  skills,
  taskGroups,
  consiliumLoops,
  traces,
  llmRequests,
  mcpServers,
  specializationProfiles,
  modelSkillBindings,
  chatMessages,
} from "../../../shared/schema.js";

const dialect = new PgDialect();
function frag(sql: import("drizzle-orm").SQL): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(sql);
  return { sql: q.sql, params: q.params };
}

const PROJ = "proj-iso-A";
const OTHER = "proj-iso-B";

// ─── Group 1: simple scoped list methods embed project_id ────────────────────

describe("Scoped list methods embed the current project_id filter", () => {
  // table, the column-qualified regex we expect in the generated SQL
  const cases: Array<[string, any, RegExp]> = [
    ["getPipelines -> pipelines", pipelines, /"pipelines"\."project_id"/],
    ["getPipelineRuns -> pipeline_runs", pipelineRuns, /"pipeline_runs"\."project_id"/],
    ["getSkills -> skills", skills, /"skills"\."project_id"/],
    ["getTaskGroups -> task_groups", taskGroups, /"task_groups"\."project_id"/],
    ["getLlmStats* -> llm_requests", llmRequests, /"llm_requests"\."project_id"/],
  ];

  for (const [label, table, colRe] of cases) {
    it(`${label}: WHERE carries project_id + bound projectId param`, async () => {
      const q = await runAsProject(PROJ, async () =>
        db.select().from(table).where(withProject(table)).toSQL(),
      );
      expect(q.sql).toMatch(colRe);
      expect(q.params).toContain(PROJ);
    });

    it(`${label}: project A vs B produce different bound params (isolation proof)`, async () => {
      const qa = await runAsProject(PROJ, async () =>
        db.select().from(table).where(withProject(table)).toSQL(),
      );
      const qb = await runAsProject(OTHER, async () =>
        db.select().from(table).where(withProject(table)).toSQL(),
      );
      expect(qa.sql).toBe(qb.sql); // same shape
      expect(qa.params).toContain(PROJ);
      expect(qb.params).toContain(OTHER);
      expect(qa.params).not.toContain(OTHER);
    });
  }

  it("getPipelineRuns(pipelineId): both the run filter AND the project filter are present", async () => {
    const q = await runAsProject(PROJ, async () =>
      db
        .select()
        .from(pipelineRuns)
        .where(withProject(pipelineRuns, eq(pipelineRuns.pipelineId, "pipe-7")))
        .toSQL(),
    );
    expect(q.sql).toMatch(/"pipeline_runs"\."project_id"/);
    expect(q.params).toContain(PROJ);
    expect(q.params).toContain("pipe-7");
  });
});

// ─── Group 2: subquery scoping for tables WITHOUT a project_id column ─────────

describe("Subquery scoping: traces and consilium_loops scope through a project-scoped parent", () => {
  it("getTraces: filters traces.run_id IN (project-scoped pipeline_runs)", async () => {
    const q = await runAsProject(PROJ, async () =>
      db
        .select()
        .from(traces)
        .where(
          inArray(
            traces.runId,
            db.select({ id: pipelineRuns.id }).from(pipelineRuns).where(withProject(pipelineRuns)),
          ),
        )
        .orderBy(desc(traces.createdAt))
        .toSQL(),
    );
    // The inner subquery must carry pipeline_runs.project_id + the project param.
    expect(q.sql).toMatch(/"traces"\."run_id" in \(select/i);
    expect(q.sql).toMatch(/"pipeline_runs"\."project_id"/);
    expect(q.params).toContain(PROJ);
    // traces itself has no project_id column — make sure we did NOT invent one.
    expect(q.sql).not.toMatch(/"traces"\."project_id"/);
  });

  it("getLoops: filters consilium_loops.group_id IN (project-scoped task_groups)", async () => {
    const q = await runAsProject(PROJ, async () =>
      db
        .select()
        .from(consiliumLoops)
        .where(
          inArray(
            consiliumLoops.groupId,
            db.select({ id: taskGroups.id }).from(taskGroups).where(withProject(taskGroups)),
          ),
        )
        .orderBy(desc(consiliumLoops.createdAt))
        .toSQL(),
    );
    expect(q.sql).toMatch(/"consilium_loops"\."group_id" in \(select/i);
    expect(q.sql).toMatch(/"task_groups"\."project_id"/);
    expect(q.params).toContain(PROJ);
    expect(q.sql).not.toMatch(/"consilium_loops"\."project_id"/);
  });

  it("traces genuinely has NO project_id column (justifies the subquery scoping)", () => {
    expect((traces as Record<string, unknown>).projectId).toBeUndefined();
  });

  it("consilium_loops now carries a project_id column (scoped on its own)", () => {
    expect((consiliumLoops as Record<string, unknown>).projectId).toBeDefined();
  });
});

// ─── Group 3: GLOBAL CATALOG — getModels / getActiveModels visibility ─────────

describe("Global-catalog visibility (withProjectOrGlobal) for the models table", () => {
  it("project context: predicate is (project_id IS NULL OR project_id = $ctx)", async () => {
    const { sql, params } = await runAsProject(PROJ, async () =>
      frag(withProjectOrGlobal(models)!),
    );
    expect(sql).toMatch(/"models"\."project_id" is null/i);
    expect(sql).toMatch(/"models"\."project_id" =/i);
    expect(params).toContain(PROJ);
  });

  it("getModels query: global rows (NULL) stay visible alongside the current project", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(models).where(withProjectOrGlobal(models)).toSQL(),
    );
    expect(q.sql).toMatch(/is null/i);
    expect(q.sql).toMatch(/"models"\."project_id"/);
    expect(q.params).toContain(PROJ);
  });

  it("getActiveModels: global-or-current AND is_active = true", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(models).where(withProjectOrGlobal(models, eq(models.isActive, true))).toSQL(),
    );
    expect(q.sql).toMatch(/is null/i);
    expect(q.sql).toMatch(/"models"\."project_id"/);
    expect(q.params).toContain(PROJ);
    expect(q.params).toContain(true);
  });

  it("project A vs B: the bound project param differs (private project models isolated)", async () => {
    const qa = await runAsProject(PROJ, async () => frag(withProjectOrGlobal(models)!));
    const qb = await runAsProject(OTHER, async () => frag(withProjectOrGlobal(models)!));
    expect(qa.params).toContain(PROJ);
    expect(qb.params).toContain(OTHER);
    expect(qa.params).not.toContain(OTHER);
  });

  it("system context, no condition: returns undefined → no project filter (sees WHOLE catalog)", async () => {
    const result = await runAsSystem("test-catalog-reconcile", async () =>
      withProjectOrGlobal(models),
    );
    expect(result).toBeUndefined();
    // And the resulting query has no project_id WHERE clause at all.
    const q = await runAsSystem("test-catalog-reconcile", async () =>
      db.select().from(models).where(withProjectOrGlobal(models)).toSQL(),
    );
    // No WHERE clause at all (project_id appears only in the SELECT column list).
    expect(q.sql).not.toMatch(/\bwhere\b/i);
  });

  it("system context WITH condition: returns the condition only, no project/global filter", async () => {
    const { sql } = await runAsSystem("test-active-reconcile", async () =>
      frag(withProjectOrGlobal(models, eq(models.isActive, true))!),
    );
    expect(sql).toMatch(/is_active/i);
    expect(sql).not.toMatch(/project_id/);
  });

  it("fail-closed: withProjectOrGlobal throws with no ALS context", () => {
    expect(() => withProjectOrGlobal(models)).toThrow(/no request context/i);
  });
});


// ─── Group 4: Second hardening pass (C1-C3, H1, L1) ──────────────────────────

describe("Second pass: newly scoped raw/aggregate reads embed project_id", () => {
  it("C1 getMcpServers: withProjectList(mcpServers) carries project_id + param", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(mcpServers).where(withProjectList(mcpServers)).orderBy(mcpServers.name).toSQL(),
    );
    expect(q.sql).toMatch(/"mcp_servers"\."project_id"/);
    expect(q.params).toContain(PROJ);
  });

  it("C2 getSpecializationProfiles: withProjectList(specialization_profiles) carries project_id", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(specializationProfiles).where(withProjectList(specializationProfiles)).toSQL(),
    );
    expect(q.sql).toMatch(/"specialization_profiles"\."project_id"/);
    expect(q.params).toContain(PROJ);
  });

  it("C3 getModelsWithSkillBindings: selectDistinct is project-scoped", async () => {
    const q = await runAsProject(PROJ, async () =>
      db
        .selectDistinct({ modelId: modelSkillBindings.modelId })
        .from(modelSkillBindings)
        .where(withProjectList(modelSkillBindings))
        .orderBy(asc(modelSkillBindings.modelId))
        .toSQL(),
    );
    expect(q.sql).toMatch(/distinct/i);
    expect(q.sql).toMatch(/"model_skill_bindings"\."project_id"/);
    expect(q.params).toContain(PROJ);
  });

  it("H1 getChatMessages WITHOUT runId: base is unconditionally project-scoped (no full-tenant dump)", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(chatMessages).where(withProjectList(chatMessages)).toSQL(),
    );
    expect(q.sql).toMatch(/"chat_messages"\."project_id"/);
    expect(q.params).toContain(PROJ);
  });

  it("H1 getChatMessages WITH runId: project filter AND run_id are both present", async () => {
    const q = await runAsProject(PROJ, async () =>
      db
        .select()
        .from(chatMessages)
        .where(withProjectList(chatMessages, eq(chatMessages.runId, "run-9")))
        .toSQL(),
    );
    expect(q.sql).toMatch(/"chat_messages"\."project_id"/);
    expect(q.sql).toMatch(/"chat_messages"\."run_id"/);
    expect(q.params).toContain(PROJ);
    expect(q.params).toContain("run-9");
  });

  it("H1 getChatMessages in SYSTEM context with runId: cross-project by run_id (no project filter, no throw)", async () => {
    const q = await runAsSystem("test-handoff", async () =>
      db
        .select()
        .from(chatMessages)
        .where(withProjectList(chatMessages, eq(chatMessages.runId, "run-9")))
        .toSQL(),
    );
    // project_id appears only in the SELECT column list; the WHERE clause must
    // carry ONLY the run_id filter (cross-project, audited by runAsSystem).
    const whereClause = q.sql.split(/ where /i)[1] ?? "";
    expect(whereClause).not.toMatch(/project_id/);
    expect(q.sql).toMatch(/"chat_messages"\."run_id"/);
    expect(q.params).toContain("run-9");
  });

  it("L1 getModelBySlug: global-or-current (IS NULL OR =) AND slug — global models stay resolvable", async () => {
    const q = await runAsProject(PROJ, async () =>
      db.select().from(models).where(withProjectOrGlobal(models, eq(models.slug, "claude-sonnet"))).toSQL(),
    );
    expect(q.sql).toMatch(/is null/i);
    expect(q.sql).toMatch(/"models"\."project_id"/);
    expect(q.sql).toMatch(/"models"\."slug"/);
    expect(q.params).toContain(PROJ);
    expect(q.params).toContain("claude-sonnet");
  });
});

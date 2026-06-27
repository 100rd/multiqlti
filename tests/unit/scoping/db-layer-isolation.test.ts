/**
 * DB-layer project scoping — unit tests (ADR-001 PR-0f, items 1-3)
 *
 * Proves the isolation contract of `withProject`, `withProjectInsert`,
 * `runAsProject`, `runAsSystem`, `getProjectId`, and `unscopedSystemQuery`
 * WITHOUT hitting a real database.  The helpers build Drizzle SQL fragments
 * and manage ALS context; no query is ever executed here.
 *
 * SQL verification uses PgDialect.sqlToQuery() to serialise the Drizzle SQL
 * expressions returned by `withProject`, confirming the exact project_id
 * value embedded in the generated WHERE clause.  Two different project
 * contexts produce two different SQL params — the structural proof that
 * project A's queries cannot match project B's rows.
 *
 * Coverage:
 *  Group 1 — Fail-closed: no context → throws
 *  Group 2 — Project context: correct projectId in SQL + in insert data
 *  Group 3 — Context isolation: nested and concurrent contexts
 *  Group 4 — System context: getProjectId throws; withProject guards; unscopedSystemQuery
 *  Group 5 — SQL proof across the three Phase-0c secret tables
 */

import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { eq } from "drizzle-orm";

// ─── Mock configLoader before any server module is imported ──────────────────
// server/db.ts creates a Pool at module load; without this mock configLoader.get()
// may throw if required env vars are absent in CI.

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

import { withProject, withProjectInsert } from "../../../server/db.js";
import {
  runAsProject,
  runAsSystem,
  getProjectId,
  unscopedSystemQuery,
} from "../../../server/context.js";
import {
  providerKeys,
  argoCdConfig,
  triggers,
} from "../../../shared/schema.js";
import { pgTable, text } from "drizzle-orm/pg-core";

// ─── Helper: serialise a Drizzle SQL fragment to { sql, params } ─────────────

const dialect = new PgDialect();

function toQuery(sql: import("drizzle-orm").SQL): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(sql);
  return { sql: q.sql, params: q.params };
}

// ─── Group 1: Fail-closed — no ALS context → throws ─────────────────────────

describe("Fail-closed: withProject/withProjectInsert throw with no ALS context", () => {
  it("withProject(providerKeys) throws without a context", () => {
    expect(() => withProject(providerKeys)).toThrow(
      /no request context/i,
    );
  });

  it("withProject(argoCdConfig) throws without a context", () => {
    expect(() => withProject(argoCdConfig)).toThrow(
      /no request context/i,
    );
  });

  it("withProject(triggers) throws without a context", () => {
    expect(() => withProject(triggers)).toThrow(
      /no request context/i,
    );
  });

  it("withProjectInsert(providerKeys, data) throws without a context", () => {
    expect(() =>
      withProjectInsert(providerKeys, { provider: "anthropic", apiKeyEncrypted: "enc" }),
    ).toThrow(/no request context/i);
  });

  it("getProjectId() throws without a context", () => {
    expect(() => getProjectId()).toThrow(/no request context/i);
  });
});

// ─── Group 2: Project context — correct projectId in SQL and insert data ─────

describe("Project context: withProject generates SQL filtered to the current project", () => {
  it("under runAsProject('proj-a'), getProjectId() returns 'proj-a'", async () => {
    const result = await runAsProject("proj-a", async () => getProjectId());
    expect(result).toBe("proj-a");
  });

  it("under runAsProject('proj-a'), withProject(providerKeys) embeds project_id='proj-a' in SQL", async () => {
    const { sql, params } = await runAsProject("proj-a", async () =>
      toQuery(withProject(providerKeys)),
    );
    expect(sql).toMatch(/project_id/);
    expect(params).toContain("proj-a");
  });

  it("under runAsProject('proj-b'), withProject(providerKeys) embeds project_id='proj-b' — different from proj-a", async () => {
    const qA = await runAsProject("proj-a", async () => toQuery(withProject(providerKeys)));
    const qB = await runAsProject("proj-b", async () => toQuery(withProject(providerKeys)));

    // Both SQL strings are identical in structure, but the params differ.
    expect(qA.sql).toBe(qB.sql); // same column reference
    expect(qA.params[0]).toBe("proj-a");
    expect(qB.params[0]).toBe("proj-b");
    // The core isolation proof: proj-a param cannot match proj-b rows.
    expect(qA.params[0]).not.toBe(qB.params[0]);
  });

  it("withProject(triggers, condition) ANDs the project filter with the given condition", async () => {
    const condition = eq(triggers.enabled, true);
    const { sql, params } = await runAsProject("proj-x", async () =>
      toQuery(withProject(triggers, condition)),
    );
    // Both the project_id filter AND the additional condition must appear.
    expect(sql).toMatch(/project_id/);
    expect(params).toContain("proj-x");
    // The enabled=true param should also be present (ANDed condition).
    expect(params).toContain(true);
  });

  it("under runAsProject('proj-a'), withProjectInsert stamps projectId='proj-a'", async () => {
    const result = await runAsProject("proj-a", async () =>
      withProjectInsert(providerKeys, { provider: "anthropic", apiKeyEncrypted: "enc" }),
    );
    expect((result as Record<string, unknown>).projectId).toBe("proj-a");
  });

  it("under runAsProject('proj-b'), withProjectInsert stamps projectId='proj-b'", async () => {
    const result = await runAsProject("proj-b", async () =>
      withProjectInsert(providerKeys, { provider: "openai", apiKeyEncrypted: "enc2" }),
    );
    expect((result as Record<string, unknown>).projectId).toBe("proj-b");
  });

  it("withProjectInsert stamping is specific to the context — proj-a vs proj-b differ", async () => {
    const rA = await runAsProject("proj-a", async () =>
      withProjectInsert(providerKeys, { provider: "anthropic", apiKeyEncrypted: "x" }),
    );
    const rB = await runAsProject("proj-b", async () =>
      withProjectInsert(providerKeys, { provider: "anthropic", apiKeyEncrypted: "x" }),
    );
    expect((rA as Record<string, unknown>).projectId).toBe("proj-a");
    expect((rB as Record<string, unknown>).projectId).toBe("proj-b");
  });
});

// ─── Group 3: Context isolation — nested and concurrent contexts ─────────────

describe("Context isolation: nested and concurrent runAsProject calls", () => {
  it("inner runAsProject shadows outer; outer resumes correctly after inner completes", async () => {
    const results: string[] = [];

    await runAsProject("outer-proj", async () => {
      results.push(getProjectId()); // "outer-proj"

      await runAsProject("inner-proj", async () => {
        results.push(getProjectId()); // "inner-proj"
      });

      results.push(getProjectId()); // back to "outer-proj"
    });

    expect(results).toEqual(["outer-proj", "inner-proj", "outer-proj"]);
  });

  it("concurrent runAsProject calls each see their own projectId (no ALS bleed)", async () => {
    // Start two concurrent contexts and collect what each sees.
    const collected: Record<string, string[]> = { a: [], b: [] };

    await Promise.all([
      runAsProject("concurrent-a", async () => {
        // Yield so the two tasks interleave, then read context.
        await Promise.resolve();
        collected["a"].push(getProjectId());
        await Promise.resolve();
        collected["a"].push(getProjectId());
      }),
      runAsProject("concurrent-b", async () => {
        await Promise.resolve();
        collected["b"].push(getProjectId());
        await Promise.resolve();
        collected["b"].push(getProjectId());
      }),
    ]);

    expect(collected["a"]).toEqual(["concurrent-a", "concurrent-a"]);
    expect(collected["b"]).toEqual(["concurrent-b", "concurrent-b"]);
  });
});

// ─── Group 4: System context ──────────────────────────────────────────────────

describe("System context: getProjectId throws; withProject guards", () => {
  it("under runAsSystem, getProjectId() throws (structural barrier against project-scoped reads)", async () => {
    await runAsSystem("test-audit-reason", async () => {
      expect(() => getProjectId()).toThrow(/system context/i);
    });
  });

  it("under runAsSystem, withProject(providerKeys) with NO condition throws", async () => {
    // System context cannot read all project rows silently through withProject.
    await runAsSystem("test-no-condition", async () => {
      expect(() => withProject(providerKeys)).toThrow(/system context.*WHERE condition/i);
    });
  });

  it("under runAsSystem, withProject(argoCdConfig) with NO condition throws", async () => {
    // argoCdConfig.getArgoCdConfig() uses withProject(argoCdConfig) — so calling it
    // in system context throws, proving system code cannot read per-project ArgoCD secrets.
    await runAsSystem("test-argocd-guard", async () => {
      expect(() => withProject(argoCdConfig)).toThrow(/system context.*WHERE condition/i);
    });
  });

  it("under runAsSystem, withProject(table, condition) returns condition WITHOUT project filter", async () => {
    // When a condition is explicitly provided, system context is permitted to make
    // a cross-project read (audited by runAsSystem's reason).  The returned SQL must
    // NOT contain a project_id filter — it is a cross-project query by design.
    const condition = eq(triggers.enabled, true);

    const { sql, params } = await runAsSystem("test-cross-project-read", async () =>
      toQuery(withProject(triggers, condition)),
    );

    // The condition itself is returned as-is — no project_id filter injected.
    expect(sql).not.toMatch(/project_id/);
    // Only the condition's own params are present (enabled = true).
    expect(params).toContain(true);
    // Notably: no "proj-xxx" string in params, confirming no project filter was added.
    expect(params.some((p) => typeof p === "string" && p.startsWith("proj"))).toBe(false);
  });

  it("under runAsSystem, withProjectInsert stamps projectId=null (globally shared row)", async () => {
    const result = await runAsSystem("test-global-insert", async () =>
      withProjectInsert(providerKeys, { provider: "builtin", apiKeyEncrypted: "x" }),
    );
    expect((result as Record<string, unknown>).projectId).toBeNull();
  });

  it("unscopedSystemQuery throws when called OUTSIDE a runAsSystem context", async () => {
    await expect(
      unscopedSystemQuery("test-label", async () => "should not run"),
    ).rejects.toThrow(/outside system context/i);
  });

  it("unscopedSystemQuery throws when called inside runAsProject (not system context)", async () => {
    await runAsProject("proj-a", async () => {
      await expect(
        unscopedSystemQuery("test-label", async () => "should not run"),
      ).rejects.toThrow(/outside system context/i);
    });
  });

  it("unscopedSystemQuery runs the query inside runAsSystem", async () => {
    const value = await runAsSystem("test-unscoped-query", async () =>
      unscopedSystemQuery("test-label", async () => "cross-project-result"),
    );
    expect(value).toBe("cross-project-result");
  });
});

// ─── Group 5: SQL proof across the three Phase-0c secret tables ─────────────

describe("SQL proof: all three Phase-0c secret tables carry the project filter", () => {
  const PROJECT_ID = "proj-phase0c";

  it("providerKeys: withProject generates SQL filtering on provider_keys.project_id", async () => {
    const { sql, params } = await runAsProject(PROJECT_ID, async () =>
      toQuery(withProject(providerKeys)),
    );
    expect(sql).toMatch(/"provider_keys"\."project_id"/);
    expect(params[0]).toBe(PROJECT_ID);
  });

  it("argoCdConfig: withProject generates SQL filtering on argocd_config.project_id", async () => {
    const { sql, params } = await runAsProject(PROJECT_ID, async () =>
      toQuery(withProject(argoCdConfig)),
    );
    expect(sql).toMatch(/"argocd_config"\."project_id"/);
    expect(params[0]).toBe(PROJECT_ID);
  });

  it("triggers: withProject generates SQL filtering on triggers.project_id", async () => {
    const condition = eq(triggers.pipelineId, "pipe-1");
    const { sql, params } = await runAsProject(PROJECT_ID, async () =>
      toQuery(withProject(triggers, condition)),
    );
    expect(sql).toMatch(/"triggers"\."project_id"/);
    expect(params).toContain(PROJECT_ID);
  });

  it("withProject on a table WITHOUT projectId column throws — prevents accidental unscoped access", async () => {
    // A table that was not yet migrated (no projectId column) must be rejected
    // at development/test time, not silently bypass isolation.
    const unmigratedTable = pgTable("legacy_table", {
      id: text("id").primaryKey(),
    });

    // Verify the column guard fires when the table lacks projectId.
    await expect(
      runAsProject("proj-guard", async () => withProject(unmigratedTable as any)),
    ).rejects.toThrow(/no "projectId" column/);
  });
});

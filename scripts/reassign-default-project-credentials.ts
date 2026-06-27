/**
 * ADR-001 PR-0c — Operator credential-reassignment helper.
 *
 * PURPOSE
 * -------
 * Migration 0027_phase0c_projectid_secret_tables.sql assigned all pre-existing
 * provider_keys and argocd_config rows to the sentinel project '__default__'.
 * This is a safe placeholder — it does NOT scope those credentials to any real
 * user project, and the sentinel project should never be exposed to end-users.
 *
 * Operators MUST reassign these rows to the correct projects before enabling
 * hard project isolation (PR-0a fail-closed + PR-0b requireProject wiring).
 * Until they do, the credentials remain accessible only through the sentinel
 * context (which only exists in the DB — no HTTP route carries this project id).
 *
 * USAGE
 * -----
 *   DATABASE_URL=postgresql://... npx tsx scripts/reassign-default-project-credentials.ts
 *
 * The script is READ-ONLY by default. Pass --apply to perform the reassignment
 * interactively (requires editing the TARGET_PROJECT_ID constant below first).
 *
 * STEPS FOR OPERATORS
 * -------------------
 * 1. List all real projects:
 *      SELECT id, name FROM projects WHERE id != '__default__';
 *
 * 2. For each provider_key row in __default__, decide which project owns it:
 *      SELECT id, provider, created_at FROM provider_keys WHERE project_id = '__default__';
 *      UPDATE provider_keys SET project_id = '<real-project-id>' WHERE id = '<row-id>';
 *
 * 3. For the argocd_config row(s) in __default__:
 *      SELECT id, server_url, enabled FROM argocd_config WHERE project_id = '__default__';
 *      UPDATE argocd_config SET project_id = '<real-project-id>' WHERE id = <row-id>;
 *
 * 4. Once all rows are reassigned, you may delete the sentinel project:
 *      DELETE FROM projects WHERE id = '__default__';
 *    (or rename it to make it obvious it's been processed)
 *
 * 5. Document the reassignment in your change log for SOC-2 / audit purposes.
 */

import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main(): Promise<void> {
  const applyMode = process.argv.includes("--apply");

  console.log("=== ADR-001 PR-0c: Default-project credential inventory ===\n");

  if (!process.env.DATABASE_URL) {
    console.error("ERROR: DATABASE_URL is not set.");
    process.exit(1);
  }

  const client = await pool.connect();

  try {
    // ── Provider keys in sentinel project ────────────────────────────────────
    const providerKeyRows = await client.query<{
      id: string;
      provider: string;
      created_at: Date;
    }>(
      "SELECT id, provider, created_at FROM provider_keys WHERE project_id = '__default__' ORDER BY provider",
    );

    console.log(`provider_keys assigned to __default__: ${providerKeyRows.rowCount ?? 0}`);
    if (providerKeyRows.rows.length > 0) {
      for (const row of providerKeyRows.rows) {
        console.log(`  • id=${row.id}  provider=${row.provider}  created_at=${row.created_at.toISOString()}`);
      }
    } else {
      console.log("  (none — all provider keys have been reassigned ✓)");
    }

    // ── ArgoCD config rows in sentinel project ────────────────────────────────
    const argoCdRows = await client.query<{
      id: number;
      server_url: string | null;
      enabled: boolean;
    }>(
      "SELECT id, server_url, enabled FROM argocd_config WHERE project_id = '__default__' ORDER BY id",
    );

    console.log(`\nargocd_config assigned to __default__: ${argoCdRows.rowCount ?? 0}`);
    if (argoCdRows.rows.length > 0) {
      for (const row of argoCdRows.rows) {
        console.log(
          `  • id=${row.id}  server_url=${row.server_url ?? "(null)"}  enabled=${row.enabled}`,
        );
      }
    } else {
      console.log("  (none — all argocd configs have been reassigned ✓)");
    }

    // ── Real projects (for reference) ─────────────────────────────────────────
    const projectRows = await client.query<{ id: string; name: string }>(
      "SELECT id, name FROM projects WHERE id != '__default__' ORDER BY name",
    );

    console.log(`\nAvailable real projects (${projectRows.rowCount ?? 0}):`);
    for (const row of projectRows.rows) {
      console.log(`  • id=${row.id}  name=${row.name}`);
    }

    if (applyMode) {
      console.log("\n--apply mode is not automated. Edit this script to add UPDATE statements.");
      console.log("Example:");
      console.log(
        "  await client.query(\"UPDATE provider_keys SET project_id = '<id>' WHERE id = '<row-id>'\");",
      );
    } else {
      console.log(
        "\nRun with --apply to update rows (you must edit the script with the correct target project ids).",
      );
    }

    const allClear =
      (providerKeyRows.rowCount ?? 0) === 0 && (argoCdRows.rowCount ?? 0) === 0;
    if (allClear) {
      console.log("\n✓ All credentials have been reassigned. Safe to remove the __default__ project.");
    } else {
      console.log(
        "\n⚠  Action required: reassign the rows above before enabling hard project isolation (PR-0a+0b).",
      );
    }
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});

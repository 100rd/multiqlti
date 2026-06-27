/**
 * Phase 0d — one-time data migration: encrypt plaintext credential fields.
 *
 * Affected tables:
 *   tracker_connections.api_token       — was stored as plaintext; now AES-256-GCM
 *   remote_agents.auth_token_enc        — was stored as plaintext despite the _enc name
 *
 * The ARGOCD_TOKEN cleanup in mcp_servers.env is handled by the companion SQL
 * migration: migrations/0027_phase0d_clean_argocd_env.sql
 *
 * Usage:
 *   DATABASE_URL=<url> ENCRYPTION_KEY=<key> npx tsx scripts/encrypt-existing-secrets.ts
 *
 * Safety:
 *   - Idempotent: rows that are already valid AES-256-GCM ciphertexts are skipped.
 *   - Dry-run mode: set DRY_RUN=true to preview without writing.
 *   - MUST be run with the NEW code deployed (i.e. after this PR merges) so that
 *     the ENCRYPTION_KEY in the environment is the same key the app will use to
 *     decrypt.
 *   - Run ONCE per environment, before restarting the application with the new
 *     code; if the application starts with the new code before this script runs,
 *     new rows will be encrypted correctly but old rows will cause decrypt errors
 *     until this script completes.
 *
 * Operational note: after running this script, ROTATE the affected tokens
 * (Jira API tokens, remote agent bearer tokens) — encryption is not a substitute
 * for rotation of credentials that were previously stored in plaintext.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { trackerConnections, remoteAgents } from "../shared/schema.js";
import { encrypt, decrypt } from "../server/crypto.js";
import { eq } from "drizzle-orm";

const DRY_RUN = process.env["DRY_RUN"] === "true";

if (!process.env["DATABASE_URL"]) {
  console.error("DATABASE_URL is required");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
const db = drizzle(pool);

/**
 * Returns true if the value looks like an AES-256-GCM ciphertext produced
 * by server/crypto.ts:encrypt().
 *
 * Format: hex(iv[12] + authTag[16] + ciphertext[N]) — minimum 56 hex chars.
 * We attempt an actual decrypt as the authoritative check; this heuristic is
 * just used for logging clarity.
 */
function isAlreadyEncrypted(value: string): boolean {
  // Minimum: 12-byte IV + 16-byte authTag = 28 bytes = 56 hex chars
  if (value.length < 56) return false;
  if (!/^[0-9a-f]+$/i.test(value)) return false;
  try {
    decrypt(value);
    return true;
  } catch {
    return false;
  }
}

async function encryptTrackerTokens(): Promise<void> {
  console.log("\n=== tracker_connections.api_token ===");

  const rows = await db
    .select({ id: trackerConnections.id, apiToken: trackerConnections.apiToken })
    .from(trackerConnections);

  let skipped = 0;
  let updated = 0;
  let nullRows = 0;

  for (const row of rows) {
    if (!row.apiToken) {
      nullRows++;
      continue;
    }

    if (isAlreadyEncrypted(row.apiToken)) {
      console.log(`  [SKIP] ${row.id} — already encrypted`);
      skipped++;
      continue;
    }

    const ciphertext = encrypt(row.apiToken);
    console.log(`  [${DRY_RUN ? "DRY" : "ENC"}] ${row.id} — encrypting api_token (${row.apiToken.slice(0, 4)}...)`);

    if (!DRY_RUN) {
      await db
        .update(trackerConnections)
        .set({ apiToken: ciphertext })
        .where(eq(trackerConnections.id, row.id));
    }
    updated++;
  }

  console.log(
    `  Done: ${updated} encrypted, ${skipped} already-encrypted, ${nullRows} null (no-op).`,
  );
}

async function encryptRemoteAgentTokens(): Promise<void> {
  console.log("\n=== remote_agents.auth_token_enc ===");

  const rows = await db
    .select({ id: remoteAgents.id, authTokenEnc: remoteAgents.authTokenEnc })
    .from(remoteAgents);

  let skipped = 0;
  let updated = 0;
  let nullRows = 0;

  for (const row of rows) {
    if (!row.authTokenEnc) {
      nullRows++;
      continue;
    }

    if (isAlreadyEncrypted(row.authTokenEnc)) {
      console.log(`  [SKIP] ${row.id} — already encrypted`);
      skipped++;
      continue;
    }

    const ciphertext = encrypt(row.authTokenEnc);
    console.log(`  [${DRY_RUN ? "DRY" : "ENC"}] ${row.id} — encrypting auth_token_enc (${row.authTokenEnc.slice(0, 4)}...)`);

    if (!DRY_RUN) {
      await db
        .update(remoteAgents)
        .set({ authTokenEnc: ciphertext })
        .where(eq(remoteAgents.id, row.id));
    }
    updated++;
  }

  console.log(
    `  Done: ${updated} encrypted, ${skipped} already-encrypted, ${nullRows} null (no-op).`,
  );
}

async function main(): Promise<void> {
  if (DRY_RUN) {
    console.log("DRY_RUN=true — no writes will be made.");
  }

  try {
    await encryptTrackerTokens();
    await encryptRemoteAgentTokens();
    console.log("\nMigration complete.");
    console.log(
      "\nREMINDER: rotate the affected credentials (Jira API tokens, remote-agent bearer tokens).",
    );
    console.log(
      "Also apply: migrations/0027_phase0d_clean_argocd_env.sql (removes ARGOCD_TOKEN from mcp_servers.env).",
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});

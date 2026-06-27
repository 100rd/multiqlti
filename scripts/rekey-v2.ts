#!/usr/bin/env tsx
/**
 * rekey-v2.ts — ADR-001 PR-0e data migration script
 *
 * Re-encrypts every AES-256-GCM ciphertext stored by server/crypto.ts to the
 * new v2: format, which uses a per-value random salt.  The script is idempotent:
 * values already prefixed `v2:` are skipped.
 *
 * USAGE
 * ─────
 *   # Dry-run (prints what would change, writes nothing):
 *   DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/rekey-v2.ts --dry-run
 *
 *   # Live run (re-encrypts all non-v2: rows):
 *   DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/rekey-v2.ts
 *
 *   # Verification gate — confirm ALL rows carry v2: before fallback removal:
 *   DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/rekey-v2.ts --verify
 *
 * DEPLOY SEQUENCE (per ADR-001 §4 PR-0e)
 * ────────────────────────────────────────
 *   1. Deploy Commit 1 (versioned ciphertext + dual-key rekey).
 *   2. Run this script with --dry-run first to audit scope.
 *   3. Run without flags to rekey all rows in EACH environment (dev → staging → prod).
 *   4. Run with --verify in EACH environment.  All rows must report 0 non-v2: rows.
 *   5. ONLY THEN deploy Commit 2 (fallback removal + mandatory ENCRYPTION_KEY).
 *
 * COLUMNS COVERED
 * ───────────────
 *   provider_keys.api_key_encrypted
 *   git_skill_sources.encrypted_pat
 *   argocd_config.token_enc
 *   workspace_connections.secrets_encrypted
 *   tracker_connections.api_token        (will be encrypted after PR-0d merges)
 *   remote_agents.auth_token_enc         (will be encrypted after PR-0d merges)
 *
 * TRIGGER-CRYPTO NOTE
 * ───────────────────
 *   server/services/trigger-crypto.ts uses a SEPARATE key (TRIGGER_SECRET_KEY)
 *   and a different ciphertext format (no static salt, direct 32-byte hex key).
 *   That column (triggers.secretEncrypted) is NOT touched here — migrate it
 *   separately if/when trigger-crypto gains a versioned format.
 */

import { Pool } from "pg";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

// ─── Helpers (inline — no server imports to keep script standalone) ───────────

const ALGORITHM = "aes-256-gcm";
const KEY_LEN = 32;
const LEGACY_SALT = "multiqlti-provider-keys-v1";
const V2_SALT_LEN = 32;
const V2_PREFIX = "v2:";
const DEV_FALLBACK_KEY = "dev-default-insecure-key-change-me!";

function deriveKey(secret: string, salt: string): Buffer {
  return scryptSync(secret, salt, KEY_LEN);
}

/** Is this value already in the v2: format? */
function isV2(value: string): boolean {
  return value.startsWith(V2_PREFIX);
}

/**
 * Attempt to decrypt a legacy (unprefixed) ciphertext with the given key and
 * the static legacy salt.  Throws on GCM auth-tag failure.
 */
function tryDecryptLegacy(hex: string, secret: string): string {
  const buf = Buffer.from(hex, "hex");
  if (buf.length < 12 + 16) throw new Error("Too short to be valid ciphertext");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const payload = buf.subarray(28);
  const key = deriveKey(secret, LEGACY_SALT);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
}

/**
 * Encrypt plaintext in the v2: format with a fresh random salt per call.
 * Wire format: "v2:" + hex(salt[32] | iv[12] | authTag[16] | ciphertext)
 */
function encryptV2(plaintext: string, secret: string): string {
  const salt = randomBytes(V2_SALT_LEN);
  const key = deriveKey(secret, salt.toString("hex"));
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return V2_PREFIX + Buffer.concat([salt, iv, authTag, encrypted]).toString("hex");
}

/**
 * Decrypt a value in either v2: or legacy format.
 * Returns the plaintext, or throws if it cannot be decrypted with any known key.
 */
function decryptAny(value: string, currentKey: string): string {
  if (value.startsWith(V2_PREFIX)) {
    // Already v2: — decrypt with current key and embedded salt
    const hex = value.slice(V2_PREFIX.length);
    const buf = Buffer.from(hex, "hex");
    const V2_HEADER_LEN = V2_SALT_LEN + 12 + 16;
    if (buf.length < V2_HEADER_LEN) throw new Error("v2: ciphertext too short");
    const salt = buf.subarray(0, V2_SALT_LEN);
    const iv = buf.subarray(V2_SALT_LEN, V2_SALT_LEN + 12);
    const authTag = buf.subarray(V2_SALT_LEN + 12, V2_HEADER_LEN);
    const payload = buf.subarray(V2_HEADER_LEN);
    const key = deriveKey(currentKey, salt.toString("hex"));
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(payload), decipher.final()]).toString("utf8");
  }

  // Legacy format — try current key first, then the dev fallback
  try {
    return tryDecryptLegacy(value, currentKey);
  } catch {
    // Current key failed; try the known insecure fallback
  }
  return tryDecryptLegacy(value, DEV_FALLBACK_KEY);
}

// ─── Column descriptors ────────────────────────────────────────────────────────

interface Column {
  /** Human-readable label for log output */
  label: string;
  /** SQL to fetch rows: must return { id, value } */
  selectSql: string;
  /** SQL to update a single row's encrypted column */
  updateSql: string;
  /** Whether this column may be NULL (nullable columns are skipped when NULL) */
  nullable: boolean;
}

const COLUMNS: Column[] = [
  {
    label: "provider_keys.api_key_encrypted",
    selectSql: "SELECT id::text, api_key_encrypted AS value FROM provider_keys WHERE api_key_encrypted IS NOT NULL",
    updateSql: "UPDATE provider_keys SET api_key_encrypted = $1 WHERE id::text = $2",
    nullable: false,
  },
  {
    label: "git_skill_sources.encrypted_pat",
    selectSql: "SELECT id::text, encrypted_pat AS value FROM git_skill_sources WHERE encrypted_pat IS NOT NULL",
    updateSql: "UPDATE git_skill_sources SET encrypted_pat = $1 WHERE id::text = $2",
    nullable: true,
  },
  {
    label: "argocd_config.token_enc",
    selectSql: "SELECT id::text, token_enc AS value FROM argocd_config WHERE token_enc IS NOT NULL",
    updateSql: "UPDATE argocd_config SET token_enc = $1 WHERE id::text = $2",
    nullable: true,
  },
  {
    label: "workspace_connections.secrets_encrypted",
    selectSql: "SELECT id::text, secrets_encrypted AS value FROM workspace_connections WHERE secrets_encrypted IS NOT NULL",
    updateSql: "UPDATE workspace_connections SET secrets_encrypted = $1 WHERE id::text = $2",
    nullable: true,
  },
  {
    label: "tracker_connections.api_token",
    selectSql: "SELECT id::text, api_token AS value FROM tracker_connections WHERE api_token IS NOT NULL",
    updateSql: "UPDATE tracker_connections SET api_token = $1 WHERE id::text = $2",
    nullable: true,
  },
  {
    label: "remote_agents.auth_token_enc",
    selectSql: "SELECT id::text, auth_token_enc AS value FROM remote_agents WHERE auth_token_enc IS NOT NULL",
    updateSql: "UPDATE remote_agents SET auth_token_enc = $1 WHERE id::text = $2",
    nullable: true,
  },
];

// ─── Modes ─────────────────────────────────────────────────────────────────────

type Mode = "live" | "dry-run" | "verify";

interface Stats {
  label: string;
  total: number;
  alreadyV2: number;
  rekeyed: number;
  errors: number;
  nonV2Remaining: number;
}

async function processColumn(
  pool: Pool,
  col: Column,
  currentKey: string,
  mode: Mode,
): Promise<Stats> {
  const stats: Stats = {
    label: col.label,
    total: 0,
    alreadyV2: 0,
    rekeyed: 0,
    errors: 0,
    nonV2Remaining: 0,
  };

  let rows: Array<{ id: string; value: string }>;
  try {
    const result = await pool.query<{ id: string; value: string }>(col.selectSql);
    rows = result.rows;
  } catch (err) {
    // Table may not exist yet (e.g. tracker_connections.api_token pre-PR-0d)
    console.warn(`  [skip] ${col.label}: table/column not found (${(err as Error).message})`);
    return stats;
  }

  stats.total = rows.length;

  for (const row of rows) {
    const { id, value } = row;

    if (!value) continue;

    if (isV2(value)) {
      stats.alreadyV2++;
      continue;
    }

    // Non-v2: value
    stats.nonV2Remaining++;

    if (mode === "verify") continue; // just counting

    // Try to decrypt with current key, then fallback
    let plaintext: string;
    try {
      plaintext = decryptAny(value, currentKey);
    } catch (err) {
      console.error(
        `  [error] ${col.label} id=${id}: could not decrypt — ` +
        `${(err as Error).message}`,
      );
      stats.errors++;
      continue;
    }

    if (mode === "dry-run") {
      console.log(`  [would rekey] ${col.label} id=${id}`);
      continue;
    }

    // live: re-encrypt as v2:
    const rekeyed = encryptV2(plaintext, currentKey);
    try {
      await pool.query(col.updateSql, [rekeyed, id]);
      stats.rekeyed++;
      console.log(`  [rekeyed] ${col.label} id=${id}`);
    } catch (err) {
      console.error(`  [error] ${col.label} id=${id}: update failed — ${(err as Error).message}`);
      stats.errors++;
    }
  }

  return stats;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const isDryRun = args.includes("--dry-run");
  const isVerify = args.includes("--verify");
  const isHelp = args.includes("--help") || args.includes("-h");

  if (isHelp) {
    console.log(`
rekey-v2.ts — ADR-001 PR-0e rekey migration script

Usage:
  DATABASE_URL=... ENCRYPTION_KEY=... npx tsx scripts/rekey-v2.ts [options]

Options:
  --dry-run   Show what would be rekeyed without writing any changes.
  --verify    Check that ALL rows carry v2:. Exit 1 if any non-v2: rows remain.
  --help      Show this help message.

Environment:
  DATABASE_URL    PostgreSQL connection string (required).
  ENCRYPTION_KEY  (or MULTI_ENCRYPTION_KEY) The app's encryption key (required).

Columns covered:
  provider_keys.api_key_encrypted
  git_skill_sources.encrypted_pat
  argocd_config.token_enc
  workspace_connections.secrets_encrypted
  tracker_connections.api_token          (after PR-0d)
  remote_agents.auth_token_enc           (after PR-0d)

Columns NOT covered (separate key/format):
  triggers.secret_encrypted              (TRIGGER_SECRET_KEY — migrate separately)
`);
    process.exit(0);
  }

  // --- Validate env ---
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.error("Error: DATABASE_URL is not set.");
    process.exit(1);
  }

  const currentKey = process.env.ENCRYPTION_KEY ?? process.env.MULTI_ENCRYPTION_KEY;
  if (!currentKey || currentKey.length < 32) {
    console.error(
      "Error: ENCRYPTION_KEY (or MULTI_ENCRYPTION_KEY) is not set or is shorter than 32 chars.",
    );
    process.exit(1);
  }

  const mode: Mode = isVerify ? "verify" : isDryRun ? "dry-run" : "live";
  console.log(`\n=== rekey-v2.ts [mode: ${mode}] ===\n`);

  if (mode === "live") {
    console.log(
      "WARNING: This will re-encrypt existing rows in the database.\n" +
      "         Make sure a database backup exists before proceeding.\n",
    );
  }

  const pool = new Pool({ connectionString: dbUrl });

  const allStats: Stats[] = [];
  let totalErrors = 0;
  let totalNonV2 = 0;

  for (const col of COLUMNS) {
    console.log(`Processing: ${col.label}`);
    const stats = await processColumn(pool, col, currentKey, mode);
    allStats.push(stats);
    totalErrors += stats.errors;
    totalNonV2 += stats.nonV2Remaining;
    console.log(
      `  total=${stats.total} already_v2=${stats.alreadyV2} ` +
      (mode === "live" ? `rekeyed=${stats.rekeyed} ` : "") +
      (mode === "dry-run" ? `would_rekey=${stats.nonV2Remaining} ` : "") +
      (mode === "verify" ? `non_v2=${stats.nonV2Remaining} ` : "") +
      `errors=${stats.errors}`,
    );
  }

  await pool.end();

  console.log("\n=== Summary ===");
  if (mode === "verify") {
    if (totalNonV2 > 0) {
      console.error(
        `\nFAIL: ${totalNonV2} row(s) are NOT in v2: format across the covered columns.` +
        "\n      Run the live rekey before deploying the fallback-removal commit.",
      );
      process.exit(1);
    }
    if (totalErrors > 0) {
      console.error(`\nFAIL: ${totalErrors} error(s) encountered during verification.`);
      process.exit(1);
    }
    console.log("\nPASS: All covered rows are in v2: format. Safe to deploy fallback removal.");
    process.exit(0);
  }

  if (totalErrors > 0) {
    console.error(`\n${totalErrors} error(s) encountered. Review the output above.`);
    process.exit(1);
  }

  if (mode === "dry-run") {
    const wouldRekey = allStats.reduce((acc, s) => acc + s.nonV2Remaining, 0);
    console.log(`\nDry-run complete. Would rekey ${wouldRekey} row(s). No changes written.`);
  } else {
    const total = allStats.reduce((acc, s) => acc + s.rekeyed, 0);
    console.log(`\nRekey complete. ${total} row(s) re-encrypted to v2: format.`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});

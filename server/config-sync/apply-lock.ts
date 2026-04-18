/**
 * apply-lock.ts — Postgres advisory lock for config-sync apply.
 *
 * Issue #319: Config sync safety layer
 *
 * Uses `pg_try_advisory_lock` (non-blocking) so that a concurrent apply
 * returns immediately with a clear error rather than waiting indefinitely.
 *
 * Lock name: "config_sync_apply"
 * Key derivation: FNV-32 of the lock name, cast to a 32-bit signed integer.
 * Postgres advisory locks operate on a single bigint or two int4 values; we
 * use the two-arg form pg_try_advisory_lock(classid, objid) with both halves
 * derived from the name hash so the lock is stable across restarts.
 */

import { Pool } from "pg";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LockResult =
  | { acquired: true; release: () => Promise<void> }
  | { acquired: false; retryAfterSeconds: number };

/** Name used in advisory lock derivation. */
export const APPLY_LOCK_NAME = "config_sync_apply";

/** How long a caller should wait before retrying (advisory value). */
const RETRY_AFTER_SECONDS = 30;

// ─── Lock key derivation ──────────────────────────────────────────────────────

/**
 * Compute a stable 32-bit signed integer from a string using FNV-32a.
 * Postgres advisory lock ids must be int4 — values are taken mod 2^31 to
 * stay within the signed range.
 */
export function lockKeyFromName(name: string): { classId: number; objId: number } {
  // FNV-32a
  let hash = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = (Math.imul(hash, 0x01000193) >>> 0);
  }
  // Split the 32-bit value into two 16-bit halves so both fit in int4
  const classId = (hash >>> 16) & 0x7fff; // upper 15 bits, positive
  const objId = hash & 0xffff;            // lower 16 bits
  return { classId, objId };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Attempt to acquire the config-sync advisory lock.
 *
 * Returns `{ acquired: true, release }` on success, or
 * `{ acquired: false, retryAfterSeconds }` when another apply is in progress.
 *
 * The lock is tied to the connection — releasing it returns the connection
 * to the pool.
 *
 * @param pool  A `pg` Pool instance (must have DATABASE_URL configured).
 */
export async function acquireApplyLock(pool: Pool): Promise<LockResult> {
  const { classId, objId } = lockKeyFromName(APPLY_LOCK_NAME);

  // Acquire a dedicated connection for the lock lifetime
  const client = await pool.connect();

  try {
    const result = await client.query<{ pg_try_advisory_lock: boolean }>(
      "SELECT pg_try_advisory_lock($1, $2) AS pg_try_advisory_lock",
      [classId, objId],
    );

    const acquired = result.rows[0]?.pg_try_advisory_lock === true;

    if (!acquired) {
      client.release();
      return { acquired: false, retryAfterSeconds: RETRY_AFTER_SECONDS };
    }

    return {
      acquired: true,
      release: async () => {
        try {
          await client.query(
            "SELECT pg_advisory_unlock($1, $2)",
            [classId, objId],
          );
        } finally {
          client.release();
        }
      },
    };
  } catch (err) {
    client.release();
    throw err;
  }
}

/**
 * Run a callback while holding the apply lock.
 * Automatically releases the lock when the callback resolves or rejects.
 *
 * Throws `ApplyLockBusyError` when the lock cannot be acquired.
 */
export async function withApplyLock<T>(
  pool: Pool,
  fn: () => Promise<T>,
): Promise<T> {
  const lock = await acquireApplyLock(pool);

  if (!lock.acquired) {
    throw new ApplyLockBusyError(lock.retryAfterSeconds);
  }

  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

// ─── Error class ──────────────────────────────────────────────────────────────

/**
 * Thrown when `withApplyLock` cannot acquire the lock because another apply
 * is already in progress.
 */
export class ApplyLockBusyError extends Error {
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number) {
    super(
      `Config-sync apply is already in progress — retry in ${retryAfterSeconds}s`,
    );
    this.name = "ApplyLockBusyError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

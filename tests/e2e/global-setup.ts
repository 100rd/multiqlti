/**
 * Playwright globalSetup — idempotent E2E fixture-user bootstrap.
 *
 * Problem: the `e2e@multiqlti.test` fixture user may exist in the DB from a
 * prior run but with a stale bcrypt hash (e.g. seeded by a different test run
 * or a hand-crafted migration). `authService.register()` is closed once any
 * user exists, so the auth helper's register path never fires. The result is
 * `Invalid credentials` → undefined token → all E2E specs fail in loginPage().
 *
 * Fix: before the test run, idempotently ensure the fixture user row has the
 * correct password hash. We use INSERT … ON CONFLICT (email) DO UPDATE so the
 * operation is safe to run repeatedly and never touches any other user row.
 *
 * Constraints:
 *  - Never deletes any row.
 *  - Only touches the single `e2e@multiqlti.test` email address.
 *  - Never touches `admin@example.com` or any other user.
 *  - No-op (returns immediately) when DATABASE_URL is not set — tests skip
 *    cleanly in that case via their own HAS_DATABASE guard.
 *  - Uses `pg` (direct project dep) + `bcryptjs` (direct project dep);
 *    no new dependencies are introduced.
 *  - Role is preserved at 'admin' if the row already has that value, so an
 *    existing privileged fixture user is never downgraded.
 *
 * Email and password are the exact constants from tests/e2e/helpers/auth.ts.
 * If those constants change, update this file to match.
 */
import { Pool } from "pg";
import bcrypt from "bcryptjs";

// ── Must match constants in tests/e2e/helpers/auth.ts exactly ──────────────
const FIXTURE_EMAIL = "e2e@multiqlti.test";
const FIXTURE_PASSWORD = "e2e-test-password-secure";
const FIXTURE_NAME = "E2E Admin";
const FIXTURE_ROLE = "admin";

/**
 * bcrypt work-factor matches server/config/schema.ts default (12).
 * Tests don't need a fast hash here because globalSetup runs once per suite,
 * not per test. Using the production round count keeps the hash identical to
 * what the real server would produce, which keeps verify logic consistent.
 */
const BCRYPT_ROUNDS = 12;

export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // DATABASE_URL absent → MemStorage / no-DB mode. All DB-dependent tests
    // guard themselves with HAS_DATABASE and skip; nothing to do here.
    return;
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const passwordHash = await bcrypt.hash(FIXTURE_PASSWORD, BCRYPT_ROUNDS);

    // Idempotent upsert scoped strictly to the fixture email.
    //
    // INSERT path (first ever run): creates the fixture user with a fresh id.
    // UPDATE path (subsequent runs): refreshes password_hash + ensures active.
    //   - role: stays 'admin' if it is already 'admin', otherwise promoted.
    //     This prevents accidental downgrade if a prior run set role='admin'.
    //   - id, name, created_at, oauth_*, avatar_url: never modified on update.
    //
    // The WHERE clause on the DO UPDATE is redundant (ON CONFLICT already
    // scopes to the conflicting row) but makes the intent explicit to readers.
    await pool.query(
      `
      INSERT INTO users (id, email, name, password_hash, is_active, role)
      VALUES (gen_random_uuid(), $1, $2, $3, true, $4)
      ON CONFLICT (email) DO UPDATE
        SET password_hash = EXCLUDED.password_hash,
            is_active     = true,
            role          = CASE
                              WHEN users.role = 'admin' THEN 'admin'
                              ELSE EXCLUDED.role
                            END
      WHERE users.email = $1
      `,
      [FIXTURE_EMAIL, FIXTURE_NAME, passwordHash, FIXTURE_ROLE],
    );

    console.log(
      `[global-setup] Fixture user ${FIXTURE_EMAIL} upserted — password hash refreshed.`,
    );
  } finally {
    await pool.end();
  }
}

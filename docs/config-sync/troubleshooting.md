# Config Sync Troubleshooting

## Apply failed

### "Another apply is already in progress — retry in 30 seconds"

`apply` uses a Postgres advisory lock (`pg_try_advisory_lock`) to prevent concurrent applies. If a previous run is still active, or if a previous run crashed without releasing its connection, the lock may still be held.

**Check for stuck connections:**

```sql
SELECT pid, application_name, state, query_start, query
FROM pg_stat_activity
WHERE query ILIKE '%pg_advisory%';
```

If you see a connection that has been waiting for minutes and you are confident no apply is actually running, terminate it:

```sql
SELECT pg_terminate_backend(<pid>);
```

Then re-run `apply`.

**If `DATABASE_URL` is not set**, the advisory lock is skipped entirely and this error will not appear.

---

### "Aborted: safety check failed — GIT_CONFLICT_MARKERS"

One or more YAML files contain unresolved git conflict markers (`<<<<<<<`, `>>>>>>>`, `=======`).

1. Run `git status` inside the config repo to identify conflicted files.
2. Open each conflicted file and resolve the conflict manually — choose which version to keep and remove all marker lines.
3. Stage and commit the resolved files.
4. Re-run `apply`.

`apply` performs this check before any database write. There is no flag to skip it.

---

### "Aborted: DB has out-of-band modifications since last export"

The database was modified (via the UI or API) after the last `export` ran. The YAML files in the repo do not reflect those changes.

**Option 1 — re-export first (recommended):**

```bash
npx tsx script/mqlti-config.ts export
npx tsx script/mqlti-config.ts push
```

This captures the latest database state into the repo, then applies.

**Option 2 — apply anyway and overwrite the DB changes:**

```bash
npx tsx script/mqlti-config.ts apply --force
```

`--force` applies the YAML as-is. Any changes made in the UI since the last export are overwritten.

---

### "Aborted due to conflicts — DB has modifications since last export"

Similar to the previous case but specifically for named entities (pipelines, connections, etc.) that were edited in the UI after the last export. The entity's `updatedAt` in the database is newer than `lastExportAt`.

The error output lists each conflicting entity with its `dbUpdatedAt` and `lastExportAt` timestamps.

Resolution is the same: either re-export and push, or use `--force`.

---

### Apply exits with errors but some entities were written

`apply` uses a best-effort rollback on error: it captures a snapshot of the database before writing and attempts to restore it if any applier fails. The rollback is not a true ACID transaction. If you see the message "Errors occurred — rollback attempted. DB state may be partially modified", check the entity-level error output to identify which entities failed, then inspect the database directly.

For a clean recovery:
1. Re-export the current database state: `npx tsx script/mqlti-config.ts export`
2. Inspect the diff: `npx tsx script/mqlti-config.ts diff`
3. Re-apply: `npx tsx script/mqlti-config.ts apply`

---

### Safety warnings appear but apply proceeds

Safety warnings (level `warn`) are informational. They do not stop `apply`. Three warning codes exist:

| Code | Meaning |
|---|---|
| `DB_DRIFT` | Pipelines or skills were modified in the DB after the last export |
| `ACTIVE_RUNS_ON_DELETED_PIPELINES` | A pipeline being deleted has a pending/running run |
| `BULK_DELETE` | The apply would delete more than 20% of entities of a given type |

These are shown before any writes occur. Review them, then proceed or abort manually. Use `--yes` to suppress the interactive prompts in automation:

```bash
npx tsx script/mqlti-config.ts apply --yes
```

---

## YAML merge conflicts

Merge conflicts happen when two machines edit the same YAML file in parallel and both push. Git surfaces them as conflict markers in the file.

**Resolution steps:**

1. `git pull` — this will report conflicts.
2. Open the conflicted file. It will look like:

   ```
   <<<<<<< HEAD
   name: pipeline-v1
   =======
   name: pipeline-v2
   >>>>>>> origin/main
   ```

3. Decide which version to keep (or manually merge the two). Remove all marker lines.
4. `git add <file>` — stage the resolved file.
5. `git rebase --continue` (if using rebase) or `git commit` (if using merge).
6. Re-run `apply`.

**Prevention:** Use `push` frequently. Short-lived divergence means fewer conflicts. If two machines need to own different sets of entities, organise them into separate config repos.

---

## New machine cannot decrypt secrets

A new machine cannot decrypt `.secret` files unless its public key was enrolled and an existing keyholder ran `secrets rotate` to re-encrypt the files.

**Check whether the machine's key is enrolled:**

```bash
npx tsx script/mqlti-config.ts secrets list
```

If `public-keys/<this-hostname>.json` does not appear in the recipient list for a `.secret` file, the machine was not enrolled at the time of last encryption.

**Fix — from an already-enrolled machine:**

```bash
# Pull the new machine's public key
git pull

# Re-encrypt all .secret files to include the new machine
npx tsx script/mqlti-config.ts secrets rotate

git add public-keys/ **/*.secret
git commit -m "chore: add <new-hostname> as secret recipient"
git push
```

**Fix — on the new machine after the re-encryption is pushed:**

```bash
git pull
# .secret files now include this machine as a recipient
npx tsx script/mqlti-config.ts apply
```

If the private key file is missing on the new machine (`~/.config/mqlti/age-keys.txt`), run `secrets rotate` first to generate a new key pair and start the enrollment process.

---

## Corrupted lock file (`.mqlti-config.yaml`)

`.mqlti-config.yaml` stores the sync timestamps (`lastExportAt`, `lastApplyAt`, `lastPushAt`, `lastPullAt`). It is a YAML file managed by the CLI and is not intended for manual editing.

If it is corrupted or deleted:

1. `status` will fail with "Could not read .mqlti-config.yaml".
2. `apply` will proceed without conflict detection (treats all entities as new).

**Recover a deleted meta file:**

```bash
# Run export — it will re-create the meta file with lastExportAt set
npx tsx script/mqlti-config.ts export
```

**Recover a corrupted meta file:**

Delete the file and re-export:

```bash
rm .mqlti-config.yaml
npx tsx script/mqlti-config.ts export
```

The timestamps for `lastApplyAt`, `lastPushAt`, and `lastPullAt` are lost, but they are informational only. The most important timestamp for conflict detection is `lastExportAt`, which is restored by re-exporting.

---

## `mqlti config history` fails — "Requires DATABASE_URL to be set"

The `history` subcommand reads the `config_applies` audit table in Postgres. It requires `DATABASE_URL` to be set in the environment.

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/mydb \
  npx tsx script/mqlti-config.ts history
```

If `DATABASE_URL` is not available (e.g. running against MemStorage in development), the command exits with code 1. This is expected.

---

## Health check warning after apply

After a successful apply, the CLI hits `$MQLTI_INSTANCE_URL/api/health` (default `http://localhost:5000/api/health`). The result is informational and does not affect the apply outcome.

Status values in the output:

| Status | Meaning |
|---|---|
| `ok` | Instance responded within timeout |
| `degraded` | Instance responded but reported degraded state |
| `unreachable` | TCP connection failed or timed out |
| `error` | HTTP request threw an unexpected error |

If you see `unreachable` in environments where the instance is running but on a different port or host, set `MQLTI_INSTANCE_URL` correctly:

```bash
MQLTI_INSTANCE_URL=http://localhost:3000 \
  npx tsx script/mqlti-config.ts apply
```

---

## `push` fails — "No remote configured"

`push` calls `git push` after committing. If no remote is set, it exits with exit code 1 and the hint "Add a remote".

```bash
git -C /path/to/config-repo remote add origin git@github.com:your-org/your-config-repo.git
npx tsx script/mqlti-config.ts push
```

If the upstream branch is not set, use:

```bash
git -C /path/to/config-repo push --set-upstream origin main
```

Subsequent `push` calls will use the configured upstream.

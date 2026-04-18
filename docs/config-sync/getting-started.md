# Getting Started with Config Sync

This guide walks through every common setup scenario from scratch.

## Prerequisites

- `npx tsx` available (comes with the project's dev dependencies)
- A running Multiqlti instance (for `export` and `apply`)
- Git installed and configured

The config CLI is at `script/mqlti-config.ts`. All examples below run it as:

```bash
npx tsx script/mqlti-config.ts <subcommand>
```

## Bootstrapping the first machine

### 1. Create the config repository

```bash
npx tsx script/mqlti-config.ts init ./my-config-repo
```

This creates:
- The directory structure (`pipelines/`, `triggers/`, `connections/`, etc.)
- `.mqlti-config.yaml` — sync metadata
- `.gitignore` — blocks `*.key`, `*.pem`, `.env.*`
- A git repository (`git init`)

### 2. Generate and enroll your machine key

```bash
cd my-config-repo
npx tsx script/mqlti-config.ts secrets rotate
```

This generates an X25519 key pair and writes:
- Private key → `~/.config/mqlti/age-keys.txt` (mode 0600, never committed)
- Public key → `public-keys/<hostname>.json` (commit this)

### 3. Export your current instance config

```bash
npx tsx script/mqlti-config.ts export
```

This reads from the running Multiqlti database and writes YAML files into the entity directories. The `lastExportAt` timestamp is updated in `.mqlti-config.yaml`.

### 4. Encrypt any secret files

If any connection or other entity file contains sensitive values that you moved into a separate file, encrypt it:

```bash
npx tsx script/mqlti-config.ts secrets add connections/gitlab-main.yaml
```

This produces `connections/gitlab-main.yaml.secret` and adds the plaintext file to `.gitignore`.

### 5. Push to remote

Add a remote and push:

```bash
git remote add origin git@github.com:your-org/your-config-repo.git
npx tsx script/mqlti-config.ts push
```

`push` runs `export`, commits, and pushes in one step. If the export was already done, it commits whatever changed.

Check the status at any time:

```bash
npx tsx script/mqlti-config.ts status
```

## Setting up a second machine (clone + apply)

### 1. Clone the config repository

```bash
git clone git@github.com:your-org/your-config-repo.git my-config-repo
cd my-config-repo
```

### 2. Generate a key for this machine

```bash
npx tsx script/mqlti-config.ts secrets rotate
```

This writes the new public key to `public-keys/<this-hostname>.json`. Commit and push it:

```bash
git add public-keys/
git commit -m "chore: enroll <this-hostname>"
git push
```

### 3. Re-encrypt secrets from an enrolled machine

The new machine's public key is now in the repo, but existing `.secret` files do not yet include it as a recipient. An already-enrolled machine must re-encrypt:

```bash
# On the first (already-enrolled) machine
git pull
npx tsx script/mqlti-config.ts secrets rotate
git add public-keys/ **/*.secret
git commit -m "chore: add <new-hostname> as secret recipient"
git push
```

### 4. Pull the updated secrets and apply

Back on the new machine:

```bash
git pull
npx tsx script/mqlti-config.ts apply
```

`apply` reads the YAML files, diffs them against the live database, and writes only the delta. The new machine can now decrypt secrets because its public key was added in step 3.

## Adding a third machine

The process is identical to adding a second machine. The only difference is that more `.secret` files may need re-encryption. `secrets rotate` re-encrypts all `.secret` files found under the repo root in one pass, so no manual enumeration is needed.

## Key rotation

To rotate your key (e.g. after a suspected private key compromise):

```bash
# On the affected machine
npx tsx script/mqlti-config.ts secrets rotate
git add public-keys/ **/*.secret
git commit -m "security: rotate secrets for <hostname>"
git push
```

`secrets rotate` replaces `~/.config/mqlti/age-keys.txt` with a new key pair, overwrites `public-keys/<hostname>.json`, and re-encrypts every `.secret` file in the repo. Anyone holding only the old private key can no longer decrypt after the rotated files are pushed.

If you want to revoke a machine entirely (e.g. a decommissioned laptop), delete its `public-keys/<hostname>.json` file, then run `secrets rotate` on any remaining enrolled machine to re-encrypt without the removed recipient.

## Daily workflow

### Push today's changes

```bash
npx tsx script/mqlti-config.ts push
```

`push` exports, commits, and pushes in one step.

### Pull and apply changes from another machine

```bash
npx tsx script/mqlti-config.ts pull --auto-apply
```

`pull` fetches and rebases. With `--auto-apply` it immediately runs `apply`. Without the flag it prints a reminder to run `apply` manually.

### Preview what would change before applying

```bash
npx tsx script/mqlti-config.ts diff
```

### Apply with confirmation prompts suppressed (CI / automation)

```bash
npx tsx script/mqlti-config.ts apply --yes
```

`--yes` skips interactive safety warning prompts. Safety checks still run; only `abort`-level checks stop the apply.

### View apply history

```bash
npx tsx script/mqlti-config.ts history
npx tsx script/mqlti-config.ts history --limit 5
```

Requires `DATABASE_URL` to be set. Shows the last N apply operations with timestamps, operator, git commit SHA, and change counts.

## Environment variables

| Variable | Used by | Description |
|---|---|---|
| `DATABASE_URL` | `apply`, `history` | Postgres connection string; enables advisory locking and audit log |
| `MQLTI_INSTANCE_URL` | `apply` | Base URL for post-apply health check (default: `http://localhost:5000`) |
| `USER` | `apply` | Recorded as `appliedBy` in the audit log (set automatically by the OS) |

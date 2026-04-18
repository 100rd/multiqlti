# Config Sync

Config sync lets you version-control your Multiqlti instance configuration in a git repository and apply it across multiple machines. Pipelines, triggers, connections, and other entities are stored as YAML files. A CLI (`mqlti config`) exports from the database, applies changes back, and handles encryption for sensitive values.

## What syncs

| Entity kind | Directory | Tombstone on delete | Notes |
|---|---|---|---|
| `pipeline` | `pipelines/` | Yes | Full pipeline definition including stages and DAG |
| `trigger` | `triggers/` | Yes | All four trigger types (schedule, webhook, github_event, file_change) |
| `prompt` | `prompts/` | Yes | Skills that carry a `systemPromptOverride` |
| `skill-state` | `skill-states/` | No | Installed skill lock file — absence does not delete skills |
| `connection` | `connections/` | Yes | Non-secret config only; credentials go in `.secret` files |
| `provider-key` | `provider-keys/` | Yes | Reference expressions only (`${env:…}`, `${file:…}`, `${vault:…}`) |
| `preferences` | `preferences/` | No | UI preferences; absence does not reset preferences |

## What does not sync

**Pipeline run history** — runs are live operational data, not configuration. They are never exported or applied.

**Workspace code / editor state** — the workspace file system is isolated per session and is not part of the config-sync contract.

**Raw API credentials** — `connection` and `provider-key` entities carry only references or non-secret config. The actual secrets are encrypted with `mqlti config secrets add` and live in `.secret` files committed alongside the YAML. See [secrets.md](./secrets.md) for the cryptographic protocol.

## Repository layout

After `mqlti config init`:

```
my-config-repo/
├── .mqlti-config.yaml      # sync metadata (lastExportAt, lastApplyAt, …)
├── .gitignore              # blocks *.key, *.pem, .env
├── public-keys/            # one JSON file per enrolled machine
├── pipelines/
├── triggers/
├── connections/
├── provider-keys/
├── prompts/
├── skill-states/
└── preferences/
```

Each entity lives in its own `.yaml` file named after the entity. The file name is derived from the entity's display name. One file per entity is the default; the exporter never colocates multiple entities in a single file.

## Threat model summary

The threat model is defined in full in [secrets.md](./secrets.md#threat-model). Key points:

- The git repository (including remotes, CI logs, and GitHub) may be read by anyone. Secrets committed in plaintext are a security incident. This is prevented by two mechanisms: the `.gitignore` blocks source files, and `secrets add` produces `.secret` files containing only AES-256-GCM ciphertext.
- `.secret` files are safe to commit. They are decryptable only by machines whose X25519 public key was enrolled before encryption.
- Tampering with a `.secret` file is detected at decryption time via AES-256-GCM authentication tags.
- The advisory lock (`pg_try_advisory_lock`) prevents two concurrent `apply` runs from corrupting the database.
- Git conflict markers in YAML files abort `apply` before any database write occurs.

## CLI quick reference

```
npx tsx script/mqlti-config.ts <subcommand> [options]

Subcommands:
  init <path>                  Create a new config-sync repository
  status                       Show git state and sync timestamps
  export                       Export live DB state to YAML files
  apply [--dry-run] [--force]  Apply YAML files to the running instance
  diff                         Show diff between YAML repo and live DB
  push                         Export + commit + push to remote git
  pull [--auto-apply]          Pull remote changes; optionally apply
  secrets add <src>            Encrypt a file for all repo recipients
  secrets rotate               Regenerate machine keys + re-encrypt all .secret files
  secrets list                 List recipients in each .secret file
  history [--limit N]          Show last N apply operations (default 20)
```

See [getting-started.md](./getting-started.md) for a step-by-step walkthrough, [schemas.md](./schemas.md) for the per-entity YAML format, and [troubleshooting.md](./troubleshooting.md) for common failure modes.

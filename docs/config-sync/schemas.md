# Config Sync YAML Schemas

Every file in a config-sync repository is a YAML document that serialises one entity. All entities share two required top-level fields:

| Field | Type | Description |
|---|---|---|
| `kind` | string (discriminator) | Identifies the entity type. Must be one of the values below. |
| `apiVersion` | semver string | Schema version for this entity. Current value for all kinds: `"1.0.0"`. |

Unknown fields are rejected at parse time. The Zod schemas in `shared/config-sync/schemas.ts` use `.strict()` throughout — any extra key is a validation error and the entity is skipped during `apply`.

---

## Sync matrix

| `kind` | Directory | Tombstone default | Identified by |
|---|---|---|---|
| `pipeline` | `pipelines/` | Yes | `name` |
| `trigger` | `triggers/` | Yes | Filename slug (pipeline name + trigger type + ID prefix) |
| `prompt` | `prompts/` | Yes | `name` |
| `skill-state` | `skill-states/` | No | Filename |
| `connection` | `connections/` | Yes | `name` |
| `provider-key` | `provider-keys/` | Yes | `provider` |
| `preferences` | `preferences/` | No | `scope` + optional `userId` |

**Tombstone** means that if a YAML file is absent from the repository, the corresponding entity is deleted from the database during `apply`. Kinds with tombstone = No are additive only; removing the file does not delete from the database.

---

## `pipeline`

```yaml
kind: pipeline
apiVersion: "1.0.0"
name: code-review-pipeline
description: Optional description (max 2000 chars)
isTemplate: false
stages:
  - teamId: architecture
    modelSlug: claude-sonnet-4-6
    enabled: true
    temperature: 0.3
    maxTokens: 4096
    approvalRequired: false
    executionStrategy: single  # single | moa | debate | voting
```

With a DAG layout:

```yaml
kind: pipeline
apiVersion: "1.0.0"
name: dag-pipeline
stages: []
dag:
  stages:
    - id: stage-a
      teamId: research
      modelSlug: claude-sonnet-4-6
      enabled: true
      position: { x: 100, y: 200 }
    - id: stage-b
      teamId: synthesis
      modelSlug: claude-sonnet-4-6
      enabled: true
      position: { x: 400, y: 200 }
  edges:
    - id: edge-1
      from: stage-a
      to: stage-b
```

See `docs/config-sync/examples/pipeline.yaml` for a fuller example.

---

## `trigger`

Triggers reference a pipeline by name via `pipelineRef`. Four `config.type` values are supported.

**schedule**

```yaml
kind: trigger
apiVersion: "1.0.0"
pipelineRef: code-review-pipeline
enabled: true
config:
  type: schedule
  cron: "0 9 * * 1-5"
  timezone: "America/New_York"
  input: "Run scheduled code health check"  # optional
```

**webhook**

```yaml
kind: trigger
apiVersion: "1.0.0"
pipelineRef: code-review-pipeline
enabled: true
config:
  type: webhook
```

**github_event**

```yaml
kind: trigger
apiVersion: "1.0.0"
pipelineRef: code-review-pipeline
enabled: true
config:
  type: github_event
  repository: "my-org/my-repo"   # must be owner/repo format
  events:
    - pull_request
    - push
  refFilter: "refs/heads/main"   # optional
```

**file_change**

```yaml
kind: trigger
apiVersion: "1.0.0"
pipelineRef: code-review-pipeline
enabled: false
config:
  type: file_change
  watchPath: /workspace/src
  patterns:
    - "**/*.ts"
    - "!**/*.test.ts"
  debounceMs: 1000               # optional
  input: "File changed"          # optional
```

---

## `prompt`

Prompts map to skills that carry a `systemPromptOverride`.

```yaml
kind: prompt
apiVersion: "1.0.0"
name: senior-code-reviewer
description: Optional description
defaultPrompt: |
  You are a senior code reviewer. Focus on security and maintainability.
stageOverrides:
  - teamId: architecture
    systemPrompt: "Focus only on architectural concerns."
tags:
  - code-review
  - security
```

---

## `skill-state`

The skill-state entity is a lock file snapshot of installed skills. It is intentionally non-tombstone: removing it does not uninstall skills.

```yaml
kind: skill-state
apiVersion: "1.0.0"
generatedAt: "2026-04-17T10:00:00.000Z"
skills:
  - id: skill-abc123
    name: code-analyzer
    version: "1.2.0"
    source: market        # builtin | market | git | local
    externalId: "market/code-analyzer"
    autoUpdate: false
    installedAt: "2026-01-01T00:00:00.000Z"
```

`source` values:
- `builtin` — shipped with the instance
- `market` — installed from the skill marketplace
- `git` — installed from a git URL
- `local` — installed from a local path

---

## `connection`

Connections store non-secret configuration only. API tokens, passwords, and other credentials must be placed in a `.secret` file (see [secrets.md](./secrets.md)).

```yaml
kind: connection
apiVersion: "1.0.0"
name: github-main
type: github   # gitlab | github | kubernetes | aws | jira | grafana | generic_mcp
workspaceRef: my-workspace
status: active  # active | inactive
config:
  host: "https://api.github.com"
  owner: "my-org"
  repo: "my-repo"
```

The `config` map accepts any key-value pairs. What goes here depends on the connection type; there is no fixed schema for `config` beyond it being a non-secret map.

---

## `provider-key`

Provider keys record which AI model provider a key belongs to and where to find the actual secret. The key material is never stored in the YAML file.

```yaml
kind: provider-key
apiVersion: "1.0.0"
provider: anthropic   # anthropic | google | openai | xai | mistral | groq | vllm | ollama | lmstudio
secretRef: "${env:ANTHROPIC_API_KEY}"
description: "Production Anthropic key for Claude models"
enabled: true
```

`secretRef` must be a reference expression in one of three forms:

| Form | Example | Resolution |
|---|---|---|
| `${env:NAME}` | `${env:ANTHROPIC_API_KEY}` | Read from environment variable at runtime |
| `${file:path}` | `${file:./secrets/openai.key}` | Read from a file path relative to the repo |
| `${vault:path}` | `${vault:secret/multiqlti/google-key}` | Read from HashiCorp Vault |

---

## `preferences`

Preferences store UI and feature-flag settings. They are non-tombstone.

```yaml
kind: preferences
apiVersion: "1.0.0"
scope: global   # global | user
ui:
  theme: system   # light | dark | system
  layout: default # default | compact | wide
  featureFlags:
    experimental-dag-editor: true
extra:
  customKey: customValue
```

For user-scoped preferences, add `userId`:

```yaml
kind: preferences
apiVersion: "1.0.0"
scope: user
userId: "ws-abc123"
ui:
  theme: dark
```

---

## Why pipeline runs and workspace code do not sync

**Pipeline runs** are live operational records — they represent what happened, not how the instance is configured. Exporting and applying run history would create data conflicts across machines and make `apply` non-idempotent. Run history is queried via `mqlti config history` (which reads the audit log of `apply` operations, not pipeline execution records).

**Workspace code** is ephemeral per-session state. It is not part of the declarative config contract and has no deterministic serialisation that would survive a round-trip through git.

---

## Adding a new entity kind

1. Add a Zod schema in `shared/config-sync/schemas.ts` following the existing pattern: `z.object({ kind: z.literal("your-kind"), apiVersion: SemverSchema, … }).strict()`.
2. Add the new schema to the `ConfigEntitySchema` discriminated union.
3. Create a new exporter in `server/config-sync/exporters/` and a new applier in `server/config-sync/appliers/`.
4. Register both in `export-orchestrator.ts` and `apply-orchestrator.ts`.
5. Add the entity directory name to `ENTITY_DIRS` in `script/mqlti-config.ts` so `init` creates it.
6. Add a row to the sync matrix above.
7. Add an example file to `docs/config-sync/examples/`.

# External Connections

External Connections let a workspace communicate with third-party services through
built-in MCP (Model Context Protocol) servers. Each connection holds non-secret
configuration (URLs, project keys, region, etc.) plus an encrypted secrets blob.
When a pipeline stage runs, the platform resolves the connection, decrypts its
secrets, and hands them to the appropriate MCP server — the secrets never leave the
server process and are never included in tool output, audit logs, or API responses.

## Provider matrix

| Type | Display name | Built-in MCP server | Status |
|---|---|---|---|
| `gitlab` | GitLab | Yes — `GitLabMcpServer` | GA |
| `github` | GitHub | Yes — `GitHubMcpServer` | GA |
| `kubernetes` | Kubernetes | Yes — `KubernetesMcpServer` | GA |
| `generic_mcp` | Generic MCP / Docker-Run | Yes — `DockerRunMcpServer` | GA |
| `aws` | AWS | No built-in server | Preview |
| `jira` | Jira | No built-in server | GA (config only) |
| `grafana` | Grafana | No built-in server | GA (config only) |

Providers marked **GA (config only)** expose their credentials to pipeline tools via
connection metadata but do not ship a built-in MCP server. Use a `generic_mcp`
connection pointing at a self-hosted MCP server if you need active tooling for those
providers.

## Security model

### Credential storage

Secrets are stored as an AES-GCM encrypted JSON blob (`secrets_encrypted` column)
in the `workspace_connections` table. Plaintext secrets are accepted by the API,
encrypted immediately inside the storage layer, and the plaintext is discarded.
Secrets are **never** returned by any API endpoint — responses include only a boolean
`hasSecrets` flag.

The `config` field (URLs, project keys, region, etc.) is stored in plaintext in the
`config_json` JSONB column because it is non-sensitive and needed for connectivity
probes.

### Scopes

Every tool exposed by a built-in MCP server is tagged with one of two scopes:

| Scope | Meaning |
|---|---|
| `read` | Always allowed; does not mutate remote state (or mutations are non-destructive, e.g. posting a comment). |
| `destructive` | Blocked unless `allowDestructive=true` is set on the connection. |

Tools with scope `destructive` include:
- `k8s_delete_namespace` (Kubernetes)
- `docker_run_privileged` (Docker-Run / generic MCP)

### Audit log

Every MCP tool call is recorded in the `mcp_tool_calls` table (90-day default
retention, overridable with `MCP_TOOL_CALL_RETENTION_DAYS`). Before persistence,
args and results pass through a redaction layer (`server/tools/audit.ts`) that:

- Strips values whose key name matches a sensitive-key list (`token`, `authorization`,
  `password`, `api_key`, `secret`, `credentials`, etc.).
- Replaces string values that match known secret patterns (Bearer tokens, AWS AKIA
  keys, GitHub `ghp_` PATs, GitLab `glpat-` PATs, long base64 strings) with
  `[REDACTED]`.

OTel spans are emitted alongside every DB write so traces appear in your
observability pipeline.

### RBAC

Connection operations require one of two global roles:

| Operation | Minimum role |
|---|---|
| List connections, read metadata, view usage metrics | `maintainer` |
| Create, update, delete, test connections | `admin` |
| Sync from `connections.yaml` | `admin` |

`user`-role accounts receive HTTP 403 on all connection endpoints.

### Encryption at rest

The secrets blob is encrypted with AES-GCM using a server-managed key. The key
material must be provided to the server via an environment variable or secret
manager — it is never stored in the database or committed to source control.

## How to add a connection

### Via the REST API

```http
POST /api/workspaces/{workspaceId}/connections
Content-Type: application/json
Authorization: Bearer <token>

{
  "type": "gitlab",
  "name": "My GitLab instance",
  "config": {
    "host": "https://gitlab.example.com",
    "projectId": "42"
  },
  "secrets": {
    "token": "glpat-xxxxxxxxxxxx"
  }
}
```

The `config` object is validated against the per-type Zod schema before saving
(see [Per-type config schemas](#per-type-config-schemas) below). The `secrets`
object accepts any key/value pairs; the well-known keys consumed by each built-in
server are documented in the per-type guides.

### Via connections.yaml (declarative)

Place a `.multiqlti/connections.yaml` file in your workspace root:

```yaml
version: 1
connections:
  - name: My GitLab instance
    type: gitlab
    config:
      host: https://gitlab.example.com
      projectId: "42"
    secrets:
      token: ${env:GITLAB_TOKEN}
```

Secret values **must** use reference expressions — plaintext is rejected:

| Expression | Resolves from |
|---|---|
| `${env:VAR_NAME}` | Environment variable |
| `${file:./path/to/file}` | File contents (trimmed) |
| `${vault:secret/path}` | HashiCorp Vault (if configured) |

Trigger a sync (dry-run):

```http
POST /api/workspaces/{workspaceId}/connections/sync
Content-Type: application/json

{ "autoApply": false }
```

Pass `"autoApply": true` to apply the plan. Pass `"includeDeletes": true` to allow
the sync to remove connections that are present in the DB but absent from the YAML.

### Test a connection

After creating a connection, verify reachability (no authentication required for
the probe — it only checks network connectivity):

```http
POST /api/workspaces/{workspaceId}/connections/{connectionId}/test
```

Response:
```json
{ "ok": true, "latencyMs": 42, "details": "HTTP 200 from https://gitlab.com/api/v4/version" }
```

## Per-type config schemas

Each connection type is validated against a Zod schema defined in
`shared/schema.ts`. The tables below list every field.

### gitlab

| Field | Type | Default | Required |
|---|---|---|---|
| `host` | URL string | `https://gitlab.com` | No |
| `projectId` | string | — | No |
| `groupPath` | string | — | No |
| `apiVersion` | `"v4"` | `"v4"` | No |

### github

| Field | Type | Default | Required |
|---|---|---|---|
| `host` | URL string | `https://api.github.com` | No |
| `owner` | string | — | Yes |
| `repo` | string | — | No |
| `appId` | string | — | No |

### kubernetes

| Field | Type | Default | Required |
|---|---|---|---|
| `server` | URL string | — | Yes |
| `namespace` | string | `"default"` | No |
| `insecureSkipTlsVerify` | boolean | `false` | No |

### aws

| Field | Type | Default | Required |
|---|---|---|---|
| `region` | string | — | Yes |
| `accountId` | string | — | No |
| `roleArn` | string | — | No |

### jira

| Field | Type | Default | Required |
|---|---|---|---|
| `host` | URL string | — | Yes |
| `email` | email string | — | No |
| `projectKey` | string | — | No |

### grafana

| Field | Type | Default | Required |
|---|---|---|---|
| `host` | URL string | — | Yes |
| `orgId` | positive integer | `1` | No |

### generic_mcp

| Field | Type | Default | Required |
|---|---|---|---|
| `endpoint` | URL string | — | Yes |
| `transport` | `"stdio"` \| `"sse"` \| `"streamable-http"` | `"sse"` | No |
| `description` | string | — | No |

## Usage metrics

```http
GET /api/workspaces/{workspaceId}/connections/{connectionId}/usage
```

Returns a `ConnectionUsageMetrics` object with:

- `callsPerDay` — calls per calendar day for the last 30 days
- `topTools` — top tools ranked by invocation count
- `errorRate7d` — error rate (0–1) over the last 7 days
- `p95LatencyMs` — P95 latency in milliseconds over the last 30 days
- `isOrphan` — `true` when the connection had zero calls in the last 30 days

## Per-type guides

- [GitLab](./gitlab.md)
- [GitHub](./github.md)
- [Kubernetes](./kubernetes.md)
- [AWS](./aws.md) _(preview)_
- [Jira](./jira.md)
- [Grafana](./grafana.md)
- [Generic MCP / Docker-Run](./generic-mcp.md)

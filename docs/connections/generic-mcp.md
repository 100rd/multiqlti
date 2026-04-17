# Generic MCP Connection

The `generic_mcp` connection type serves two purposes:

1. **Connect to any external MCP server** via SSE, streamable-HTTP, or stdio
   transport. Use this for self-hosted MCP servers (Jira, Grafana, AWS, custom
   tools, etc.).

2. **Docker-Run capability** — when the connection config sets the `memoryLimit`,
   `cpuLimit`, or other Docker-related fields (and is registered with the
   `DockerRunMcpServer` factory), the built-in `docker_run` and
   `docker_run_privileged` tools become available.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `endpoint` | URL string | — | **Required.** URL of the MCP server endpoint (e.g. `https://mcp.example.com/sse`). |
| `transport` | `"stdio"` \| `"sse"` \| `"streamable-http"` | `"sse"` | Transport protocol. |
| `description` | string | — | Human-readable description of what this MCP server provides. |

### Additional fields for Docker-Run

These fields are consumed by the `DockerRunMcpServer` when the connection is
registered as a Docker-Run provider:

| Field | Type | Notes |
|---|---|---|
| `memoryLimit` | string | Memory cap for containers (e.g. `"512m"`, `"1g"`). Hard cap is `"2g"`. |
| `cpuLimit` | number | CPU fraction cap (e.g. `0.5` = half a core). Hard cap is `2`. |
| `networkEnabled` | boolean | Whether containers may access the network. Default `false`. |
| `timeout` | number | Timeout in seconds. Hard cap is `300`. |

## Required credentials

Generic MCP connections accept any secret key/value pairs. Common patterns:

| Secret key | Description |
|---|---|
| `apiKey` | Bearer token or API key sent as an `Authorization` header by the MCP server. |
| `token` | Alternative to `apiKey`. |

The built-in `DockerRunMcpServer` does not require any secrets.

## Supported tools (Docker-Run)

### `docker_run` — scope: `read`

Run a Docker image in a sandboxed container with CPU/memory caps. Network is
disabled by default.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `image` | string | Yes | — | Docker image (e.g. `"python:3.12-slim"`). |
| `command` | string | Yes | — | Shell command to execute inside the container. |
| `memoryLimit` | string | No | connection default | Capped at connection limit and hard cap (`2g`). |
| `cpuLimit` | number | No | connection default | Capped at connection limit and hard cap (`2`). |
| `timeout` | number | No | connection default | Seconds; capped at connection limit and hard cap (`300`). |
| `files` | array | No | — | Files to write into the workdir before running. Each item: `{ path: string, content: string }`. |
| `env` | object | No | — | Environment variables to set inside the container. |
| `installCommand` | string | No | — | Command to run before the main command (e.g. `"pip install -r requirements.txt"`). |
| `workdir` | string | No | — | Working directory inside the container. |

Returns exit code, duration, memory/CPU limits used, stdout, and stderr.

### `docker_run_privileged` — scope: `destructive`

Same as `docker_run` but with network access forced on. Requires
`allowDestructive=true` on the connection.

## Connectivity probe

The test endpoint probes `{endpoint}` directly (HTTP GET). Any response with
status < 500 is treated as a healthy connection.

## Example pipeline snippets

### External MCP server

```yaml
version: 1
connections:
  - name: my-jira-mcp
    type: generic_mcp
    config:
      endpoint: https://mcp.example.com/jira/sse
      transport: sse
      description: Self-hosted Jira MCP server
    secrets:
      apiKey: ${env:JIRA_MCP_API_KEY}
```

### Docker-Run sandbox

```yaml
version: 1
connections:
  - name: docker-sandbox
    type: generic_mcp
    config:
      endpoint: https://not-used-for-docker-run.example.com
      memoryLimit: "512m"
      cpuLimit: 0.5
      networkEnabled: false
      timeout: 60
```

The `endpoint` field is required by the Zod schema even for Docker-Run
connections. Use a placeholder URL when there is no external MCP endpoint.

## Troubleshooting

### `docker: command not found` / `docker_run` fails

The Docker daemon must be running and accessible to the server process. Confirm
with `docker info` on the server host.

### Container exits with non-zero code

Check `stderr` in the tool output. Common causes:
- Missing dependencies: add an `installCommand`.
- Wrong `image` tag: use `docker pull <image>` on the server host to verify.
- Timeout exceeded: increase `timeout` up to the connection cap.

### Memory limit rejected

Memory strings must use `m` (megabytes) or `g` (gigabytes) suffix (e.g. `512m`,
`1g`). The hard cap is `2g`.

### `docker_run_privileged` returns `DestructiveOperationDeniedError`

Set `allowDestructive: true` when creating or updating the connection.

### MCP server returns 401/403

- Verify the `apiKey` or `token` secret is correct.
- Check the MCP server's own authentication documentation.

### Rotating credentials

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "apiKey": "new-key-here" } }
```

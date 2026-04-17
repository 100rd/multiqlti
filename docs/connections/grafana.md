# Grafana Connection

Stores credentials and configuration for a Grafana instance. There is no
built-in MCP server for Grafana — the connection provides metadata and
credentials for a self-hosted Grafana MCP server or custom pipeline tool.

## Required credentials

| Secret key | Description |
|---|---|
| `serviceAccountToken` | Grafana service account token (recommended). |
| `apiKey` | Legacy Grafana API key (deprecated in Grafana 9+; prefer service account tokens). |

Generate a service account token at
`{host}/org/serviceaccounts` or via the Grafana API.

## Minimum permissions

| Permission | Required for |
|---|---|
| `dashboards:read` | Listing and fetching dashboard definitions. |
| `datasources:read` | Querying data sources. |
| `annotations:read` | Reading annotations. |
| `annotations:write` | Creating annotations. |

Assign these permissions to the service account via a Grafana role.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | URL string | — | **Required.** Grafana base URL (e.g. `https://grafana.example.com`). |
| `orgId` | positive integer | `1` | Grafana organization ID. Defaults to the default org (`1`). |

## Connectivity probe

The test endpoint probes `{host}/api/health`. A successful response indicates the
instance is reachable and healthy.

## Example pipeline snippet

```yaml
version: 1
connections:
  - name: my-grafana
    type: grafana
    config:
      host: https://grafana.example.com
      orgId: 1
    secrets:
      serviceAccountToken: ${env:GRAFANA_TOKEN}
```

## Troubleshooting

### HTTP 401 Unauthorized

- Confirm the service account token is valid and has not been revoked.
- Check the `orgId` — a token scoped to org 1 cannot access org 2 resources.

### Probe fails with connection refused

- Verify the `host` URL is reachable from the server host (not from your
  browser or workstation behind a VPN).

### `/api/health` returns non-200

- Grafana may be starting up or in maintenance mode.
- Check Grafana server logs.

### Rotating credentials

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "serviceAccountToken": "glsa_new-token-here" } }
```

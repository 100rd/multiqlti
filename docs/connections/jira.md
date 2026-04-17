# Jira Connection

Stores credentials and configuration for a Jira Cloud or Jira Data Center
instance. There is no built-in MCP server for Jira — the connection provides
metadata and credentials that a self-hosted Jira MCP server or custom pipeline
tool can consume.

## Required credentials

| Secret key | Description |
|---|---|
| `apiToken` | Jira API token (Jira Cloud) or Personal Access Token (Jira Data Center). |
| `password` | Basic-auth password (not recommended; prefer `apiToken`). |

For Jira Cloud, generate an API token at
`https://id.atlassian.com/manage-profile/security/api-tokens`.

## Minimum permissions

| Permission | Required for |
|---|---|
| Browse Projects (`BROWSE`) | Listing issues, sprints, and project metadata. |
| Create Issues (`CREATE_ISSUES`) | Creating new issues. |
| Edit Issues (`EDIT_ISSUES`) | Updating issue fields. |
| Transition Issues (`TRANSITION_ISSUES`) | Moving issues through workflow states. |

Assign these permissions through a Jira project role or a global role, depending
on your Jira configuration.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | URL string | — | **Required.** Jira base URL (e.g. `https://mycompany.atlassian.net` or `https://jira.example.com`). |
| `email` | email string | — | Atlassian account email used with the API token for Jira Cloud basic auth. |
| `projectKey` | string | — | Default project key (e.g. `ENG`). Used as a default by tools that support it. |

## Supported tools

There is no built-in MCP server for Jira. Use a `generic_mcp` connection to
connect to a self-hosted Jira MCP server.

## Connectivity probe

The test endpoint probes `{host}/status`. A successful response (HTTP < 500)
indicates the instance is reachable.

## Example pipeline snippet

```yaml
version: 1
connections:
  - name: my-jira
    type: jira
    config:
      host: https://mycompany.atlassian.net
      email: automation@example.com
      projectKey: ENG
    secrets:
      apiToken: ${env:JIRA_API_TOKEN}
```

## Troubleshooting

### HTTP 401 Unauthorized

- Confirm `email` matches the Atlassian account that owns the token.
- For Jira Cloud, use an API token (not your login password) as the `apiToken`
  secret.
- For Jira Data Center, use a Personal Access Token and omit `email`.

### HTTP 403 Forbidden

- The account lacks the required Jira project permissions.

### Host URL format

- Jira Cloud: `https://yourcompany.atlassian.net` (no trailing slash, no `/rest`
  suffix).
- Jira Data Center: `https://jira.example.com` (root URL of your server).

### Rotating credentials

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "apiToken": "new-token-here" } }
```

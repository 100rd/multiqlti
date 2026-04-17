# GitLab Connection

Connects a workspace to a GitLab instance (GitLab.com or self-hosted). The
built-in `GitLabMcpServer` uses the GitLab REST API v4 with a Personal Access
Token (PAT) or a project/group access token.

## Required credentials

| Secret key | Description |
|---|---|
| `token` | GitLab Personal Access Token or project access token. |
| `gitlabToken` | Alternative key — looked up if `token` is absent. |

At least one of these keys must be present in the `secrets` object. The token
must have the minimum scopes listed below.

## Minimum token scopes

| Scope | Required for |
|---|---|
| `read_api` | All read tools (`gitlab_list_mrs`, `gitlab_get_mr_diff`, `gitlab_list_pipelines`, `gitlab_list_commits`) |
| `api` | Write tool (`gitlab_post_note`) |

A PAT with `read_api` is sufficient for read-only pipelines. Add `api` only when
the `gitlab_post_note` tool is needed.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | URL string | `https://gitlab.com` | Base URL of your GitLab instance. |
| `projectId` | string | — | Default project path (`namespace/project`) or numeric ID. Overridable per tool call. |
| `groupPath` | string | — | Group path for group-level operations (not currently used by built-in tools; stored for future use). |
| `apiVersion` | `"v4"` | `"v4"` | Must be `"v4"`. |

## Supported tools

All tools are scoped `read` (always allowed; no `allowDestructive` needed).

### `gitlab_list_mrs`

List merge requests for a project.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | No | connection default | Project path (`namespace/project`) or numeric ID. |
| `state` | string | No | `"opened"` | One of `opened`, `closed`, `merged`, `locked`, `all`. |
| `perPage` | number | No | `20` | 1–100. |
| `page` | number | No | `1` | Page number. |

Returns an array of MR objects with IID, title, state, author, and web URL.

### `gitlab_get_mr_diff`

Get per-file diffs for a merge request.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | No | connection default | Project path or ID. |
| `mrIid` | number | Yes | — | MR IID (project-scoped integer). |

### `gitlab_list_pipelines`

List CI/CD pipeline runs.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | No | connection default | Project path or ID. |
| `ref` | string | No | — | Filter by branch or tag. |
| `status` | string | No | — | One of `created`, `waiting_for_resource`, `preparing`, `pending`, `running`, `success`, `failed`, `canceled`, `skipped`, `manual`, `scheduled`. |
| `perPage` | number | No | `10` | 1–100. |

### `gitlab_post_note`

Post a comment on an MR or issue. Classified as `read` scope (non-destructive
write — does not modify code or settings).

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | No | connection default | Project path or ID. |
| `resourceType` | string | No | `"merge_requests"` | `"merge_requests"` or `"issues"`. |
| `resourceIid` | number | Yes | — | MR or issue IID. |
| `body` | string | Yes | — | Note body (Markdown supported). |

### `gitlab_list_commits`

List commits for a branch.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `project` | string | No | connection default | Project path or ID. |
| `ref` | string | No | — | Branch, tag, or commit SHA. |
| `perPage` | number | No | `20` | 1–100. |
| `page` | number | No | `1` | Page number. |

## Example pipeline snippet

```yaml
version: 1
connections:
  - name: my-gitlab
    type: gitlab
    config:
      host: https://gitlab.com
      projectId: my-org/my-project
    secrets:
      token: ${env:GITLAB_TOKEN}
```

Reference the connection in a pipeline stage by its name. The tools become
available to any stage that lists the connection in `allowedConnections`.

## Troubleshooting

### HTTP 401 Unauthorized

- Verify `GITLAB_TOKEN` is set and non-empty.
- Check that the token has not expired (GitLab PATs have an optional expiry).
- Self-hosted GitLab: confirm the `host` URL does not have a trailing slash and
  that the instance is reachable from the server.

### HTTP 403 Forbidden

- The token lacks the required scope. Add `read_api` (or `api` for
  `gitlab_post_note`).
- For group-owned projects, the token must belong to a member of the group.

### HTTP 404 Not Found on tool calls

- Confirm `projectId` is the correct namespace/project path or numeric ID.
- URL encoding is applied automatically — do not pre-encode the path.

### Connectivity probe fails

The test endpoint probes `{host}/api/v4/version`. If this returns 404, the host
URL or GitLab version is incorrect. A 401 or 200 both indicate a reachable
instance.

### Rotating credentials

Patch the connection with new secrets:

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "token": "glpat-new-token-here" } }
```

Omitting `secrets` from the PATCH body leaves existing secrets unchanged. Setting
`"secrets": null` removes all stored secrets.

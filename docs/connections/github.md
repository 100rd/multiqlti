# GitHub Connection

Connects a workspace to GitHub (github.com or GitHub Enterprise). The built-in
`GitHubMcpServer` uses the GitHub REST API v2022-11-28 with a Personal Access
Token or a GitHub App installation token.

## Required credentials

| Secret key | Description |
|---|---|
| `token` | GitHub Personal Access Token (`ghp_...`) or GitHub App installation token. |
| `githubToken` | Alternative key — looked up if `token` is absent. |

## Minimum token scopes

For GitHub PATs, use fine-grained tokens scoped to the target repositories.

| Permission | Level | Required for |
|---|---|---|
| `Pull requests` | Read | `github_list_prs`, `github_get_pr_files`, `github_get_pr_diff` |
| `Issues` | Read-write | `github_post_comment` (comments appear on both PRs and issues via the Issues API) |
| `Actions` | Read | `github_list_workflows` |

For classic PATs, the `repo` scope covers all of the above.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `host` | URL string | `https://api.github.com` | Override for GitHub Enterprise (e.g. `https://github.example.com/api/v3`). |
| `owner` | string | — | **Required.** GitHub org or user name. Accepts `owner/repo` to also set the default repo. |
| `repo` | string | — | Default repository name (without owner prefix). |
| `appId` | string | — | GitHub App ID, for future App-based auth flows (not currently consumed by the built-in server). |

## Supported tools

All tools are scoped `read`.

### `github_list_prs`

List pull requests for a repository.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | No | connection default | `"owner/repo"` or just `"repo"` when owner is set on the connection. |
| `state` | string | No | `"open"` | One of `open`, `closed`, `all`. |
| `perPage` | number | No | `30` | 1–100. |
| `page` | number | No | `1` | Page number. |

### `github_get_pr_files`

List files changed in a pull request.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | No | connection default | `"owner/repo"`. |
| `prNumber` | number | Yes | — | Pull request number. |

Returns filename, status (`added`, `removed`, `modified`, etc.), additions, and deletions.

### `github_get_pr_diff`

Get the raw unified diff for a pull request. Uses
`Accept: application/vnd.github.diff`.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | No | connection default | `"owner/repo"`. |
| `prNumber` | number | Yes | — | Pull request number. |

### `github_post_comment`

Post a comment on a pull request or issue. Classified as `read` scope
(non-destructive write).

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | No | connection default | `"owner/repo"`. |
| `issueNumber` | number | Yes | — | PR or issue number. |
| `body` | string | Yes | — | Comment body (Markdown supported). |

Returns the created comment URL.

### `github_list_workflows`

List recent Actions workflow runs.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `repo` | string | No | connection default | `"owner/repo"`. |
| `branch` | string | No | — | Filter by branch. |
| `status` | string | No | — | One of `queued`, `in_progress`, `completed`, `waiting`, `requested`, `pending`. |
| `perPage` | number | No | `10` | 1–30. |

## Example pipeline snippet

```yaml
version: 1
connections:
  - name: my-github
    type: github
    config:
      host: https://api.github.com
      owner: my-org
      repo: my-repo
    secrets:
      token: ${env:GITHUB_TOKEN}
```

## Troubleshooting

### HTTP 401 Bad credentials

- Confirm `GITHUB_TOKEN` is set and has not been revoked.
- Fine-grained PATs require the token to be approved if the org has a policy
  requiring admin approval.

### HTTP 403 Resource not accessible

- Check the token's repository permission scope.
- If `owner` is an organization, the token must be authorized for that org
  (SSO-protected orgs require SAML SSO authorization).

### HTTP 404 Not Found

- Verify `owner` and `repo` are correct. Names are case-insensitive on github.com
  but case-sensitive on some GitHub Enterprise instances.

### Diff endpoint returns empty string

- Confirm the PR is not empty (no commits, or commits with no diff).
- Very large diffs may be truncated by GitHub.

### Rotating credentials

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "token": "ghp_new-token-here" } }
```

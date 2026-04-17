# AWS Connection

> **Preview** — The AWS connection type stores credentials and configuration for
> use by pipeline tools, but there is no built-in MCP server for AWS yet. Use a
> `generic_mcp` connection pointing at a self-hosted AWS MCP server (e.g. the
> [AWS Labs MCP server](https://github.com/awslabs/mcp)) if you need active AWS
> tooling today.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `region` | string | — | **Required.** AWS region (e.g. `us-east-1`). |
| `accountId` | string | — | AWS account ID. Used for display and cross-account role validation. |
| `roleArn` | string | — | IAM role ARN to assume via STS (e.g. `arn:aws:iam::123456789012:role/MyRole`). |

## Recommended credential approach

Prefer short-lived credentials via IAM role assumption over long-lived access keys:

1. Create an IAM role with the minimum required policies.
2. Set `roleArn` on the connection config.
3. Store the caller's `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` as
   connection secrets (see below).

| Secret key | Description |
|---|---|
| `accessKeyId` | AWS Access Key ID for the calling identity. |
| `secretAccessKey` | AWS Secret Access Key for the calling identity. |
| `sessionToken` | AWS Session Token (for temporary credentials). |

## Connectivity probe

The test endpoint has no suitable AWS probe URL and returns
`{ "ok": false, "details": "No probe URL available for type \"aws\"" }`.
This is expected behavior — the connection is valid even when the probe fails.

## Troubleshooting

### No tools available after creating an AWS connection

There is no built-in MCP server for AWS. To use AWS tools in pipelines, create a
`generic_mcp` connection pointing at a compatible AWS MCP server endpoint, and
store your AWS credentials in that connection's secrets.

### Rotating credentials

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{
  "secrets": {
    "accessKeyId": "AKIANEW...",
    "secretAccessKey": "new-secret-here"
  }
}
```

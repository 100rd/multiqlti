# Kubernetes Connection

Connects a workspace to a Kubernetes cluster. The built-in `KubernetesMcpServer`
runs `kubectl` and `helm` commands in-process using `child_process.spawn` — no
shell interpolation is used, so arguments cannot escape into shell.

The server is **namespace-scoped**: every tool operates within the `namespace`
set on the connection config. Tools cannot address resources outside that
namespace, providing a hard isolation boundary for ephemeral environments.

## Required credentials

The server looks for a kubeconfig file path in the `secrets` object.

| Secret key | Description |
|---|---|
| `kubeconfigPath` | Absolute path to a kubeconfig file on the server's filesystem. If absent, the in-cluster service account or `~/.kube/config` is used. |

Alternatives supported by `kubectl` itself (environment variables like
`KUBECONFIG`, or an in-cluster service account mount) also work when
`kubeconfigPath` is not supplied.

## Minimum RBAC permissions

Grant the service account or user in the kubeconfig the following Kubernetes RBAC
permissions within the target namespace:

| Resource | Verbs | Required for |
|---|---|---|
| `pods`, `deployments`, `services`, `configmaps` | `get`, `list`, `create`, `update`, `patch` | `k8s_deploy_manifest` |
| `pods/log` | `get` | `k8s_get_logs` |
| `pods/portforward` | `create` | `k8s_port_forward_check` |
| Helm releases (secrets/configmaps named `sh.helm.*`) | `get`, `list`, `create`, `update` | `k8s_apply_helm_chart` |
| `namespaces` | `delete` | `k8s_delete_namespace` (destructive) |

For ephemeral smoke-test namespaces, a `ClusterRole` with `admin` bound to the
namespace is the simplest setup.

## Config fields

| Field | Type | Default | Notes |
|---|---|---|---|
| `server` | URL string | — | **Required.** Kubernetes API server URL (e.g. `https://k8s.example.com:6443`). |
| `namespace` | string | `"default"` | Namespace all tools are scoped to. Must match Kubernetes naming rules (`^[a-z0-9][a-z0-9-]{0,251}[a-z0-9]$`). |
| `insecureSkipTlsVerify` | boolean | `false` | Set `true` only for local dev clusters with self-signed certificates. |

## Supported tools

### `k8s_deploy_manifest` — scope: `read`

Apply a Kubernetes YAML manifest to the scoped namespace via `kubectl apply`.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `manifest` | string | Yes | YAML manifest content. Multi-document YAML (`---` separators) is supported. |

Returns `kubectl apply` stdout/stderr. Exit code non-zero is surfaced as an error
string prefixed with `Error (exit N):`.

### `k8s_apply_helm_chart` — scope: `read`

Install or upgrade a Helm release via `helm upgrade --install`.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `releaseName` | string | Yes | Helm release name. |
| `chart` | string | Yes | Chart reference: `repo/chart` (e.g. `bitnami/nginx`) or local path. |
| `valuesYaml` | string | No | Helm values as a YAML string, piped to `helm upgrade -f -`. |
| `version` | string | No | Chart version (e.g. `"1.2.3"`). |

`--create-namespace` is always passed so the namespace is created if absent.

### `k8s_port_forward_check` — scope: `read`

Start a `kubectl port-forward` for a pod, wait 1.5 s, perform an HTTP health
check with `curl`, then kill the forward.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `podName` | string | Yes | — | Pod name in the scoped namespace. |
| `targetPort` | number | Yes | — | Container port to forward. |
| `healthPath` | string | No | `"/health"` | HTTP path to check. |

The local port is computed as `30000 + (targetPort % 10000)` to stay above the
privileged port boundary.

Returns `Status: HEALTHY` or `Status: UNHEALTHY` plus the response body.

### `k8s_get_logs` — scope: `read`

Fetch the last N lines of pod logs via `kubectl logs --tail=N`.

| Argument | Type | Required | Default | Notes |
|---|---|---|---|---|
| `podName` | string | Yes | — | Pod name. |
| `containerName` | string | No | — | Container name (needed for multi-container pods). |
| `tail` | number | No | `100` | Lines to return (max 1000). |

### `k8s_delete_namespace` — scope: `destructive`

Delete the scoped namespace and all resources in it via
`kubectl delete namespace`. Requires `allowDestructive=true` on the connection
and `confirm: "DELETE"` in the tool call.

| Argument | Type | Required | Notes |
|---|---|---|---|
| `confirm` | string | Yes | Must be exactly `"DELETE"`. |

This tool is designed for tear-down of ephemeral smoke-test namespaces. Use a
dedicated short-lived namespace (e.g. `smoke-test-<runId>`) — never point this
at a shared or production namespace.

## Example pipeline snippet

```yaml
version: 1
connections:
  - name: my-k8s-cluster
    type: kubernetes
    config:
      server: https://k8s.example.com:6443
      namespace: smoke-test
    secrets:
      kubeconfigPath: ${env:KUBECONFIG_PATH}
```

To enable the destructive tear-down tool, set `allowDestructive: true` on the
connection via the API:

```http
POST /api/workspaces/{workspaceId}/connections
Content-Type: application/json

{
  "type": "kubernetes",
  "name": "my-k8s-cluster",
  "config": { "server": "https://k8s.example.com:6443", "namespace": "smoke-test", "allowDestructive": true },
  "secrets": { "kubeconfigPath": "/secrets/kube/config" }
}
```

Note: `allowDestructive` is a top-level connection flag managed by the registry —
not a config schema field — so it does not appear in the Zod config schema but
must be passed at connection creation/update time.

## Troubleshooting

### `kubectl: command not found`

The `kubectl` binary must be on the `PATH` of the server process. Install it on
the server host and confirm with `which kubectl`.

### `helm: command not found`

Same as above for the Helm binary. Required only for `k8s_apply_helm_chart`.

### `Error (exit 1): Unable to connect to the server`

- Verify the `server` URL is reachable from the server host (not from your
  workstation).
- Check that the kubeconfig at `kubeconfigPath` has the correct `server` URL
  and that the certificate authority is trusted.
- For self-signed CAs, set `insecureSkipTlsVerify: true` (dev only).

### `Error (exit 1): Forbidden`

The service account lacks the required RBAC permissions. See
[Minimum RBAC permissions](#minimum-rbac-permissions) above.

### Port-forward health check always returns UNHEALTHY

- Confirm the container is listening on `targetPort`.
- Increase the wait time by using a readiness probe in your manifest before
  calling the health check tool.
- Confirm `curl` is installed on the server host.

### Namespace validation error

Kubernetes namespace names must match `^[a-z0-9][a-z0-9-]{0,251}[a-z0-9]$`.
Single-character names (`[a-z0-9]`) are also valid.

### Rotating credentials

Replace the kubeconfig file at the path stored in `kubeconfigPath`, or patch the
connection with a new path:

```http
PATCH /api/workspaces/{workspaceId}/connections/{connectionId}
Content-Type: application/json

{ "secrets": { "kubeconfigPath": "/new/path/kubeconfig" } }
```

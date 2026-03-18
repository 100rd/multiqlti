# Phase 6.10 — ArgoCD MCP Integration + K8s Privacy Masking: Architecture

**Date**: 2026-03-18
**Status**: DESIGN — Pending Security Review
**Branch**: feature/phase-6.10-argocd-mcp

---

## Table of Contents

1. [Overview](#1-overview)
2. [What Already Exists (No Rewrite)](#2-what-already-exists)
3. [DB Schema Changes](#3-db-schema-changes)
4. [API Contracts](#4-api-contracts)
5. [ArgoCD MCP Server Adapter](#5-argocd-mcp-server-adapter)
6. [Agent Skills — Infrastructure Monitor](#6-agent-skills--infrastructure-monitor)
7. [Privacy Proxy Extensions](#7-privacy-proxy-extensions)
8. [Frontend Component Tree](#8-frontend-component-tree)
9. [Data Flow Diagram](#9-data-flow-diagram)
10. [Security Checklist](#10-security-checklist)
11. [Test Strategy](#11-test-strategy)
12. [Implementation Order](#12-implementation-order)
13. [Environment Variables](#13-environment-variables)

---

## 1. Overview

Phase 6.10 connects multiqlti to ArgoCD via the MCP protocol, adds a built-in "Infrastructure Monitor" skill that wraps ArgoCD tools with privacy masking, extends the K8s privacy classifier with pod/service/cluster/secret/configmap patterns, and provides a Settings UI section for configuring the ArgoCD connection.

### Key Design Decisions

**ADR-6.10-1: Use existing `mcp_servers` table + `McpClientManager`**
The ArgoCD integration reuses the generic MCP infrastructure. No new DB table is needed for the ArgoCD connection. A seed row is inserted via migration with `name = 'argocd'`, transport `sse`, and env-var-driven URL + token. The existing `POST /api/mcp/servers/:id/connect` flow handles connectivity.

**ADR-6.10-2: ArgoCD as SSE transport, not stdio**
ArgoCD MCP server (`argocd-mcp`) exposes an SSE endpoint. We do not spawn a subprocess. Transport type = `sse`. URL and token are supplied via environment variables `ARGOCD_SERVER_URL` and `ARGOCD_TOKEN`.

**ADR-6.10-3: Privacy masking at the skill layer, not gateway layer**
Privacy masking for ArgoCD responses is applied in the `Infrastructure Monitor` skill's `execute` wrapper, not in the generic gateway. This avoids performance overhead on all LLM calls and keeps k8s masking opt-in per skill.

**ADR-6.10-4: New `argocd_config` table for connection settings**
While ArgoCD is registered as an `mcp_servers` row, a separate lightweight `argocd_config` table holds the structured settings (server URL, token encrypted, verify SSL) for the Settings UI. The `mcp_servers` row is kept in sync by the service layer on config save.

**ADR-6.10-5: Extend EntityType union, not create new classifier**
New K8s entity types are added to the existing `EntityType` union in `shared/types.ts` and new `BUILTIN_PATTERNS` entries added to `server/privacy/classifier.ts`. No new classifier class needed.

---

## 2. What Already Exists (No Rewrite)

| File | What it does | Phase 6.10 interaction |
|------|-------------|----------------------|
| `server/tools/mcp-client.ts` | `McpClientManager` — connects, disconnects, calls MCP tools via stdio/SSE | **Used as-is** — ArgoCD server registered and connected through this |
| `server/privacy/classifier.ts` | `DataClassifier` — detects entities via regex patterns | **Extended** — new patterns added for k8s_pod, k8s_service, etc. |
| `server/privacy/anonymizer.ts` | `AnonymizerService` — pseudonymizes classified entities | **Extended** — new `generatePseudonym` cases for new types |
| `shared/types.ts` `EntityType` | Union type of all entity types | **Extended** — 6 new members added |
| `server/skills/builtin.ts` | Array of built-in skills seeded on startup | **Extended** — new `INFRASTRUCTURE_MONITOR_SKILL` added |

---

## 3. DB Schema Changes

### 3.1 Migration File

`migrations/0004_phase_6_10_argocd.sql`

```sql
-- Phase 6.10: ArgoCD MCP Integration

-- ─── ArgoCD connection config ────────────────────────────────────────────────
CREATE TABLE argocd_config (
  id           INTEGER PRIMARY KEY DEFAULT 1,  -- singleton row
  server_url   TEXT,                             -- e.g. https://argocd.example.com
  token_enc    TEXT,                             -- AES-256-GCM encrypted ArgoCD API token
  verify_ssl   BOOLEAN NOT NULL DEFAULT TRUE,
  enabled      BOOLEAN NOT NULL DEFAULT FALSE,
  mcp_server_id INTEGER REFERENCES mcp_servers(id) ON DELETE SET NULL,
  last_health_check_at TIMESTAMP,
  health_status TEXT NOT NULL DEFAULT 'unknown',  -- 'connected' | 'error' | 'unknown'
  health_error TEXT,
  created_at   TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT argocd_config_singleton CHECK (id = 1)
);

COMMENT ON TABLE argocd_config IS
  'Singleton row storing ArgoCD connection config. Phase 6.10.';
COMMENT ON COLUMN argocd_config.token_enc IS
  'AES-256-GCM encrypted ArgoCD API token. Use encrypt()/decrypt() from server/crypto.ts.';
```

### 3.2 Drizzle Schema Addition (`shared/schema.ts`)

```typescript
// ─── ArgoCD Config (Phase 6.10) ───────────────────────────────────────────────
export const ARGOCD_HEALTH_STATUS = ['connected', 'error', 'unknown'] as const;
export type ArgoCdHealthStatus = typeof ARGOCD_HEALTH_STATUS[number];

export const argoCdConfig = pgTable('argocd_config', {
  id: integer('id').primaryKey().default(1),
  serverUrl: text('server_url'),
  tokenEnc: text('token_enc'),
  verifySsl: boolean('verify_ssl').notNull().default(true),
  enabled: boolean('enabled').notNull().default(false),
  mcpServerId: integer('mcp_server_id').references(() => mcpServers.id, { onDelete: 'set null' }),
  lastHealthCheckAt: timestamp('last_health_check_at'),
  healthStatus: text('health_status').notNull().default('unknown').$type<ArgoCdHealthStatus>(),
  healthError: text('health_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
});

export const insertArgoCdConfigSchema = createInsertSchema(argoCdConfig).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export type InsertArgoCdConfig = z.infer<typeof insertArgoCdConfigSchema>;
export type ArgoCdConfigRow = typeof argoCdConfig.$inferSelect;
```

---

## 4. API Contracts

All endpoints are under `/api/settings/argocd` and require authentication (covered by the existing `app.use("/api/settings", requireAuth)` middleware).

### 4.1 GET /api/settings/argocd

Returns current ArgoCD configuration (token never returned).

**Response 200**:
```json
{
  "configured": true,
  "serverUrl": "https://argocd.example.com",
  "verifySsl": true,
  "enabled": true,
  "healthStatus": "connected",
  "healthError": null,
  "lastHealthCheckAt": "2026-03-18T10:00:00.000Z",
  "mcpServerId": 3
}
```

### 4.2 PUT /api/settings/argocd

Save or update ArgoCD config. Token is optional — omitting it keeps the existing token.

**Request body** (validated with Zod):
```typescript
const SaveArgoCdConfigSchema = z.object({
  serverUrl: z.string().url().max(500),
  token: z.string().min(1).max(2000).optional(), // omit = keep existing
  verifySsl: z.boolean().default(true),
  enabled: z.boolean().default(true),
});
```

**Response 200**: Same shape as GET.

**Side effects**:
1. Encrypt token with `encrypt()` from `server/crypto.ts`
2. Upsert `argocd_config` row (id=1)
3. Upsert `mcp_servers` row with `name='argocd'`, transport=`sse`, url=serverUrl, env=`{ARGOCD_TOKEN: token}`, autoConnect=enabled
4. Store `mcp_servers.id` in `argocd_config.mcp_server_id`
5. If `enabled=true`: call `mcpClientManager.connect(mcpServerRow)` and run health check
6. Update `argocd_config.healthStatus` / `healthError`

### 4.3 DELETE /api/settings/argocd

Remove ArgoCD config (disconnect, delete MCP server row, reset config).

**Response 204** on success.

### 4.4 POST /api/settings/argocd/test

Test ArgoCD connectivity: call `list_applications` tool and return application list.

**Response 200**:
```json
{
  "ok": true,
  "applicationCount": 5,
  "applications": ["app-a", "app-b", "app-c", "app-d", "app-e"],
  "latencyMs": 234
}
```

**Response 400/500** on failure:
```json
{
  "ok": false,
  "error": "Connection refused to https://argocd.example.com"
}
```

---

## 5. ArgoCD MCP Server Adapter

### 5.1 ArgoCD Tool Names

When connected, the ArgoCD MCP server registers these tools in the `toolRegistry` under prefixed names (`argocd__<tool>`):

| MCP Tool Name | Prefixed Tool Name | Description |
|---|---|---|
| `list_applications` | `argocd__list_applications` | List all ArgoCD applications |
| `get_application` | `argocd__get_application` | Get details for a specific app |
| `sync_application` | `argocd__sync_application` | Trigger a sync for an app |
| `get_application_resource_tree` | `argocd__get_application_resource_tree` | Get K8s resource tree |
| `get_application_workload_logs` | `argocd__get_application_workload_logs` | Get pod logs |

### 5.2 ArgoCD Service (`server/services/argocd-service.ts`)

New service wrapping tool calls with privacy masking:

```typescript
export interface AppStatus {
  name: string;  // pseudonymized
  health: string;
  sync: string;
  namespace: string;  // pseudonymized
  server: string;     // pseudonymized
}

export class ArgoCdService {
  constructor(
    private readonly anonymizer: AnonymizerService,
  ) {}

  async listApplications(sessionId: string, level: AnonymizationLevel): Promise<AppStatus[]>
  async syncApplication(appName: string, sessionId: string, level: AnonymizationLevel): Promise<string>
  async getDeploymentLogs(appName: string, container: string, sessionId: string, level: AnonymizationLevel): Promise<string>
  async getResourceEvents(appName: string, sessionId: string, level: AnonymizationLevel): Promise<string>
}
```

The service:
1. Calls `mcpClientManager.callTool('argocd', toolName, args)`
2. Passes the raw response through `anonymizer.anonymize(raw, sessionId, level)`
3. Returns the masked result

---

## 6. Agent Skills — Infrastructure Monitor

### 6.1 New Built-in Skill

Added to `server/skills/builtin.ts`:

```typescript
{
  id: 'builtin-infrastructure-monitor',
  name: 'Infrastructure Monitor',
  description: 'Monitor and manage Kubernetes deployments via ArgoCD. Queries app status, triggers syncs, and reads deployment logs — with automatic privacy masking of cluster/service names.',
  teamId: 'monitoring',
  systemPromptOverride: `You are an infrastructure monitoring assistant with read/write access to ArgoCD.

Available tools:
- argocd__list_applications — list all deployed applications with health/sync status
- argocd__get_application — get details for a specific application
- argocd__sync_application — trigger a GitOps sync for an application
- argocd__get_application_resource_tree — inspect the K8s resource tree
- argocd__get_application_workload_logs — retrieve pod/container logs

Privacy: All cluster names, service names, pod names, and namespaces are automatically masked before being sent to the LLM. Masked names use the format [k8s_pod_a], [k8s_service_b], etc.

When responding:
1. Use masked names consistently — do not guess real names
2. Summarize health/sync status clearly
3. For sync operations, confirm before proceeding
4. Highlight degraded or OutOfSync applications first`,
  tools: [
    'argocd__list_applications',
    'argocd__get_application',
    'argocd__sync_application',
    'argocd__get_application_resource_tree',
    'argocd__get_application_workload_logs',
  ],
  modelPreference: null,
  outputSchema: null,
  tags: ['infrastructure', 'kubernetes', 'argocd', 'monitoring', 'devops'],
  isBuiltin: true,
  isPublic: true,
  createdBy: 'system',
}
```

### 6.2 TeamId

The skill uses `teamId: 'monitoring'`. This is already a valid `TeamId` value in `shared/types.ts`. No schema change needed.

---

## 7. Privacy Proxy Extensions

### 7.1 New EntityType Members (`shared/types.ts`)

Extend the `EntityType` union:

```typescript
export type EntityType =
  | 'domain'
  | 'ip_address'
  | 'ip_cidr'
  | 'k8s_namespace'
  | 'k8s_resource'   // already exists
  | 'k8s_pod'        // NEW
  | 'k8s_service'    // NEW
  | 'k8s_configmap'  // NEW
  | 'k8s_secret_ref' // NEW
  | 'k8s_ingress'    // NEW
  | 'k8s_cluster'    // NEW
  | 'argocd_app'     // already exists
  | 'argocd_project' // NEW
  | 'git_url'
  | 'docker_image'
  | 'cloud_account'
  | 'cloud_resource_id'
  | 'env_variable'
  | 'api_key'
  | 'email'
  | 'hostname'
  | 'service_name'
  | 'custom_pattern';
```

### 7.2 New BUILTIN_PATTERNS Entries (`server/privacy/classifier.ts`)

```typescript
{
  type: 'k8s_pod',
  severity: 'medium',
  patterns: [
    // Standard pod name: deployment-name-<replicaset>-<random>
    /\b([a-z0-9][a-z0-9-]{1,50})-[a-z0-9]{5}-[a-z0-9]{5}\b/g,
    // Pod name explicit key=value
    /pod(?:Name)?:\s*['"]?([a-z0-9][a-z0-9-]{2,62})/gi,
  ],
},
{
  type: 'k8s_service',
  severity: 'medium',
  patterns: [
    // K8s service DNS: svc-name.namespace.svc.cluster.local
    /\b([a-z0-9][a-z0-9-]{1,61}[a-z0-9])\.([a-z0-9-]+)\.svc\.cluster\.local\b/g,
    // service: key in YAML
    /service:\s*['"]?([a-z0-9][a-z0-9-]{1,61}[a-z0-9])/gi,
  ],
},
{
  type: 'k8s_configmap',
  severity: 'low',
  patterns: [
    /configMap(?:Name)?:\s*['"]?([a-z0-9][a-z0-9-]{2,62})/gi,
    /configmap\/([a-z0-9][a-z0-9-]{2,62})/gi,
  ],
},
{
  type: 'k8s_secret_ref',
  severity: 'high',
  patterns: [
    /secretName:\s*['"]?([a-z0-9][a-z0-9-]{2,62})/gi,
    /secret\/([a-z0-9][a-z0-9-]{2,62})/gi,
  ],
},
{
  type: 'k8s_ingress',
  severity: 'medium',
  patterns: [
    /ingress\/([a-z0-9][a-z0-9-]{2,62})/gi,
    /ingressName:\s*['"]?([a-z0-9][a-z0-9-]{2,62})/gi,
  ],
},
{
  type: 'k8s_cluster',
  severity: 'high',
  patterns: [
    // AWS EKS cluster ARN
    /arn:aws:eks:[a-z0-9-]+:\d{12}:cluster\/([a-z0-9][a-z0-9-]{2,99})/g,
    // kubeconfig context names (often cluster-name patterns)
    /current-context:\s*['"]?([a-z0-9][a-z0-9._-]{2,100})/gi,
    // server: https://... (API server endpoint)
    /server:\s*https:\/\/([a-zA-Z0-9.-]+\.(?:eks\.amazonaws\.com|k8s\.io|example\.internal))/gi,
  ],
},
{
  type: 'argocd_project',
  severity: 'medium',
  patterns: [
    /project:\s*['"]?([a-z0-9][a-z0-9-]{2,62})/gi,
    /"project":\s*"([a-z0-9][a-z0-9-]{2,62})"/gi,
  ],
  allowlist: ['default'],
},
```

### 7.3 New `generatePseudonym` Cases (`server/privacy/anonymizer.ts`)

```typescript
case 'k8s_pod':
  return `pod-${label}-example`;

case 'k8s_service':
  return `svc-${label}.ns-${label}.svc.cluster.local`;

case 'k8s_configmap':
  return `cm-${label}`;

case 'k8s_secret_ref':
  return `secret-${label}`;

case 'k8s_ingress':
  return `ingress-${label}`;

case 'k8s_cluster':
  // Preserve cloud prefix if detectable
  if (value.startsWith('arn:aws:eks:')) {
    return value.replace(/cluster\/[^/\s]+/, `cluster/cluster-${label}`);
  }
  return `cluster-${label}`;

case 'argocd_project':
  return `project-${label}`;
```

---

## 8. Frontend Component Tree

### 8.1 New Files

```
client/src/
└── components/
    └── settings/
        └── ArgocdSettings.tsx        # Main section component
client/src/
└── hooks/
    └── useArgoCdSettings.ts          # Query + mutation hooks
```

### 8.2 `ArgocdSettings.tsx` Component Spec

**Props**: none (reads from query hooks internally)

**State**:
```typescript
interface LocalState {
  serverUrl: string;
  token: string;        // write-only input, never populated from server
  showToken: boolean;
  verifySsl: boolean;
  enabled: boolean;
  testResult: { ok: boolean; applicationCount?: number; applications?: string[]; error?: string } | null;
  isTesting: boolean;
}
```

**Layout**:
```
<Card>
  <CardHeader>
    <CardTitle>
      <Server icon /> Infrastructure — ArgoCD
    </CardTitle>
    <CardDescription>Connect multiqlti to your ArgoCD instance for deployment monitoring</CardDescription>
  </CardHeader>
  <CardContent>
    <!-- Status Badge Row -->
    <div class="flex items-center gap-2">
      <StatusBadge status={healthStatus} />   <!-- connected | error | not configured -->
      {lastHealthCheckAt && <span class="text-xs text-muted-foreground">Last checked {relativeTime}</span>}
    </div>

    <!-- Form -->
    <form>
      <!-- Server URL -->
      <Label>ArgoCD Server URL</Label>
      <Input type="url" placeholder="https://argocd.example.com" value={serverUrl} />

      <!-- Auth Token -->
      <Label>Authentication Token</Label>
      <div class="relative">
        <Input type={showToken ? "text" : "password"} placeholder={configured ? "••••••••" : "Enter token"} value={token} />
        <Button variant="ghost" size="icon" onClick={toggleShowToken}>
          {showToken ? <EyeOff /> : <Eye />}
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">Token is stored encrypted. Leave blank to keep existing token.</p>

      <!-- Verify SSL Toggle -->
      <div class="flex items-center gap-2">
        <Switch checked={verifySsl} onCheckedChange={setVerifySsl} />
        <Label>Verify SSL Certificate</Label>
      </div>

      <!-- Enabled Toggle -->
      <div class="flex items-center gap-2">
        <Switch checked={enabled} onCheckedChange={setEnabled} />
        <Label>Enable ArgoCD integration</Label>
      </div>
    </form>

    <!-- Action Buttons -->
    <div class="flex gap-2">
      <Button onClick={handleSave} disabled={isSaving}>
        {isSaving ? <Loader2 /> : <Save />} Save
      </Button>
      <Button variant="outline" onClick={handleTest} disabled={isTesting || !configured}>
        {isTesting ? <Loader2 /> : <Plug />} Test Connection
      </Button>
      {configured && (
        <Button variant="ghost" className="text-destructive" onClick={handleDelete}>
          <Trash2 /> Remove
        </Button>
      )}
    </div>

    <!-- Test Result Panel -->
    {testResult && (
      <div class={cn("p-3 rounded-md text-sm", testResult.ok ? "bg-green-50" : "bg-red-50")}>
        {testResult.ok ? (
          <>
            <CheckCircle2 className="text-green-600" />
            Connected — {testResult.applicationCount} application(s) found
            {testResult.applications?.map(name => <Badge>{name}</Badge>)}
          </>
        ) : (
          <>
            <XCircle className="text-red-600" />
            {testResult.error}
          </>
        )}
      </div>
    )}
  </CardContent>
</Card>
```

### 8.3 `useArgoCdSettings.ts` Hook Spec

```typescript
// Queries
export function useArgoCdConfig(): UseQueryResult<ArgoCdConfigResponse>
export function useTestArgoCd(): UseMutationResult<TestResult, Error>
export function useSaveArgoCdConfig(): UseMutationResult<ArgoCdConfigResponse, Error, SavePayload>
export function useDeleteArgoCdConfig(): UseMutationResult<void, Error>
```

Query key: `['/api/settings/argocd']`

### 8.4 Integration into `Settings.tsx`

The existing Settings page has a sidebar navigation. Phase 6.10 adds an "Infrastructure" nav group with an "ArgoCD" item, rendered as:

```typescript
// In Settings.tsx sidebar nav items array, add:
{ label: 'ArgoCD', icon: Server, section: 'infrastructure-argocd' }

// In the content rendering switch/conditional, add:
{activeSection === 'infrastructure-argocd' && <ArgocdSettings />}
```

No full rewrite of Settings.tsx — only additive changes to the nav array and conditional content block.

---

## 9. Data Flow Diagram

```
User action (pipeline run / chat)
         │
         ▼
  Pipeline Stage (teamId: 'monitoring')
         │  uses skill: builtin-infrastructure-monitor
         ▼
  Tool call: argocd__list_applications
         │
         ▼
  McpClientManager.callTool('argocd', 'list_applications', {})
         │
         ▼
  ArgoCD MCP Server (SSE transport)
  → Returns raw JSON with real app names, namespaces, cluster URLs
         │
         ▼
  AnonymizerService.anonymize(rawResponse, sessionId, 'strict')
  → DataClassifier detects: k8s_namespace, k8s_cluster, argocd_app, argocd_project, k8s_pod
  → Replaces with pseudonyms: env-svc-a, cluster-a, app-a, project-a, pod-a-example
         │
         ▼
  Masked response sent to LLM
         │
         ▼
  LLM response contains masked names
         │
         ▼
  AnonymizerService.rehydrate(llmResponse, sessionId)  [optional — for display]
         │
         ▼
  Final output
```

---

## 10. Security Checklist

| # | Control | Status |
|---|---------|--------|
| S1 | ArgoCD token stored encrypted (AES-256-GCM) via `encrypt()` in `server/crypto.ts` | Required |
| S2 | Token never returned in GET responses or logs | Required |
| S3 | All `/api/settings/argocd/*` endpoints require authentication (`requireAuth` middleware) | Required |
| S4 | `serverUrl` validated as URL, max 500 chars — prevents SSRF to localhost/internal | Required |
| S5 | URL blocklist: deny `localhost`, `127.0.0.1`, `::1`, `169.254.*` (SSRF protection) | Required |
| S6 | `verifySsl=false` triggers admin-only warning — non-admins cannot disable SSL verification | Required |
| S7 | `sync_application` tool is destructive — pipeline stages must have `approvalRequired: true` when using sync | Design recommendation |
| S8 | ArgoCD token scoped to read-only unless sync is explicitly needed | Deployment guidance |
| S9 | K8s entity pseudonyms are session-scoped — cleared after session TTL (default 1h) | Inherited from anonymizer |
| S10 | MCP env vars (token) are never returned in `GET /api/mcp/servers` (existing `env: undefined` stripping) | Already enforced |

---

## 11. Test Strategy

### Unit Tests (`tests/unit/`)

**`tests/unit/privacy/argocd-k8s-classifier.test.ts`**
- Tests for each new pattern: k8s_pod, k8s_service, k8s_configmap, k8s_secret_ref, k8s_ingress, k8s_cluster, argocd_project
- Tests that allowlisted values (default project) are NOT masked
- Tests deduplication when pod name overlaps with service name pattern
- Tests full ArgoCD JSON response → all sensitive names masked

**`tests/unit/privacy/argocd-anonymizer.test.ts`**
- Tests new `generatePseudonym` cases return correct format
- Tests session consistency: same real name → same pseudonym within session
- Tests rehydration of k8s pseudonyms

**`tests/unit/services/argocd-service.test.ts`**
- Mock `mcpClientManager.callTool` returning fixture JSON
- Verify `listApplications` returns masked app names
- Verify `syncApplication` calls correct tool with correct args
- Verify error propagation when MCP not connected

### Integration Tests (`tests/integration/`)

**`tests/integration/argocd-settings.test.ts`**
- POST PUT /api/settings/argocd → upserts argocd_config row
- GET /api/settings/argocd → returns config without token
- POST /api/settings/argocd/test → calls list_applications mock
- DELETE /api/settings/argocd → clears config and disconnects MCP

### Component Tests

**`tests/unit/components/ArgocdSettings.test.tsx`**
- Renders "not configured" state correctly
- Test Connection button calls POST /api/settings/argocd/test
- Save button disabled when serverUrl is empty
- Token input type toggles on Eye/EyeOff click
- Test result panel shows application list on success
- Shows error message on test failure

---

## 12. Implementation Order

1. **Migration**: `migrations/0004_phase_6_10_argocd.sql` + `shared/schema.ts` additions
2. **Privacy types**: Extend `EntityType` union in `shared/types.ts`
3. **Privacy classifier**: Add new `BUILTIN_PATTERNS` in `server/privacy/classifier.ts`
4. **Privacy anonymizer**: Add new `generatePseudonym` cases in `server/privacy/anonymizer.ts`
5. **ArgoCD service**: Create `server/services/argocd-service.ts`
6. **Settings route**: Create `server/routes/argocd-settings.ts`, register in `server/routes.ts`
7. **Builtin skill**: Add `builtin-infrastructure-monitor` to `server/skills/builtin.ts`
8. **Frontend hooks**: Create `client/src/hooks/useArgoCdSettings.ts`
9. **Frontend component**: Create `client/src/components/settings/ArgocdSettings.tsx`
10. **Settings page integration**: Additive changes to `client/src/pages/Settings.tsx`
11. **Unit tests**: classifier, anonymizer, argocd-service, ArgocdSettings component
12. **Integration tests**: argocd-settings route

---

## 13. Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ARGOCD_SERVER_URL` | Optional | ArgoCD server base URL. Overrides DB config if set. |
| `ARGOCD_TOKEN` | Optional | ArgoCD API token. Overrides DB config if set. |
| `ARGOCD_VERIFY_SSL` | Optional | `false` to skip SSL verification (default: `true`) |

Environment variables take precedence over DB config (same pattern as provider keys).

# Security Code Review — Phase 6.3 Event-Driven Triggers

**Reviewer**: security-expert
**Date**: 2026-03-16
**Scope**: Full OWASP Top 10 code review of the trigger subsystem
**Status**: VETOED — 3 blocking issues

---

## Files Reviewed

| File | Location |
|------|----------|
| `trigger-crypto.ts` | `server/services/trigger-crypto.ts` |
| `trigger-service.ts` | `server/services/trigger-service.ts` |
| `webhook-handler.ts` | `server/services/webhook-handler.ts` |
| `cron-scheduler.ts` | `server/services/cron-scheduler.ts` |
| `github-event-handler.ts` | `server/services/github-event-handler.ts` |
| `file-watcher.ts` | `server/services/file-watcher.ts` |
| `routes/triggers.ts` | `server/routes/triggers.ts` |
| `routes/webhooks.ts` | `server/routes/webhooks.ts` |
| `shared/types.ts` | `shared/types.ts` (trigger types) |
| `shared/schema.ts` | `shared/schema.ts` (triggers table) |
| `server/storage.ts` | trigger CRUD methods |
| `server/routes.ts` | middleware wiring |
| `server/index.ts` | body parser configuration |

---

## OWASP Top 10 Checklist

### A01 — Broken Access Control

**[PASS] All CRUD routes require auth**

`server/routes.ts` registers `app.use("/api/triggers", requireAuth)` at line 74 and `app.use("/api/pipelines", requireAuth)` at line 52. Both prefixes are covered before any trigger route is registered. The global middleware fires before route handlers. Auth is enforced.

**[PASS] Public webhook endpoints correctly excluded from auth**

`/api/webhooks/:triggerId` and `/api/github-events` are NOT listed in the `requireAuth` middleware block. These are intentionally public — they receive from external services and authenticate via HMAC. Correct.

**[VETO] ISSUE-1 — Trigger ownership: any maintainer can read/write ANY pipeline's triggers**

`routes/triggers.ts` uses `requireRole("maintainer", "admin")` on write routes, but there is **no pipeline ownership check**. The `GET /api/pipelines/:pipelineId/triggers` and `POST /api/pipelines/:pipelineId/triggers` routes accept any valid authenticated maintainer regardless of who owns the pipeline.

Pipeline routes (`routes/pipelines.ts`) correctly use `requireOwnerOrRole()` for `PATCH` and `DELETE`. Trigger routes skip this entirely.

**Concrete attack**: User A (maintainer) creates a pipeline. User B (maintainer) can call `GET /api/pipelines/{A-pipeline-id}/triggers` to list all triggers, then `DELETE /api/triggers/{id}` to delete them. No ownership relationship is checked.

**Fix required in `server/routes/triggers.ts`**: Before CRUD operations on any trigger, resolve the parent pipeline, then apply `requireOwnerOrRole(() => pipeline.ownerId, "admin")`. For the GET-by-trigger-id route, look up the trigger's `pipelineId`, fetch the pipeline owner, and enforce the same check.

---

### A02 — Cryptographic Failures

**[PASS] AES-256-GCM used correctly**

`trigger-crypto.ts`: `randomBytes(12)` produces a unique IV per encryption call (line 45). The auth tag is extracted with `cipher.getAuthTag()` and set with `decipher.setAuthTag()` before decryption (lines 48, 61). Encrypt output is `iv || authTag || ciphertext` in hex. All three components are present and properly sequenced.

**[PASS] HMAC uses `crypto.timingSafeEqual`**

`webhook-handler.ts` line 95: `timingSafeEqual(Buffer.from(hexSig, "hex"), Buffer.from(expected, "hex"))` is used. The comparison is in constant time.

**[CONCERN] No explicit length pre-check before `timingSafeEqual`**

The architecture review condition required a length pre-check before `timingSafeEqual` to prevent a length oracle. The implementation relies on a `try/catch` to handle the case where `timingSafeEqual` throws when buffer lengths differ (line 94-98). This is functionally correct — an invalid-length signature returns `false` — but the pre-check was an explicit requirement.

The catch block silently returns `false` on any `timingSafeEqual` throw. This handles the length mismatch case correctly. However, `Buffer.from(hexSig, "hex")` silently truncates on odd-length hex strings rather than throwing, meaning a 63-character hex input produces a 31-byte buffer and timingSafeEqual throws, caught, returns false. This is safe but the explicit guard specified in the architecture condition is absent.

**Recommendation (non-blocking)**: Add an explicit `if (hexSig.length !== 64) return false;` before the buffer conversion. This documents intent and avoids reliance on exception control flow.

**[PASS] Secrets never in logs or API responses**

`trigger-service.ts#toPublic()` returns `hasSecret: boolean` (never the secret value). The `InsertTrigger` and `UpdateTrigger` types accept a plaintext `secret` only at creation/update time and it is immediately encrypted. The `PipelineTrigger` shape in `shared/types.ts` has no `secret` or `secretEncrypted` field. The global request logger in `server/index.ts` logs `capturedJsonResponse` which will only ever contain the public shape.

---

### A03 — Injection

**[PASS] No raw SQL — all queries through Drizzle ORM**

`server/storage-pg.ts` uses Drizzle's typed query builder throughout. No `sql` template literals with user input were found in trigger methods.

**[PASS] Cron expressions validated before passing to node-cron**

`cron-scheduler.ts` line 37: `cron.validate(config.cron)` is called and the method returns early on failure. node-cron v4.2.1 is installed.

**[VETO] ISSUE-2 — Timezone not validated; invalid value causes cron subsystem DoS**

`ScheduleConfigSchema` in `routes/triggers.ts` validates `timezone` only as `z.string().max(100).optional()`. No IANA timezone format check is applied.

`cron-scheduler.ts#scheduleTrigger()` passes `config.timezone` directly to `cron.schedule()` without a try/catch around that call. Verified by runtime test: `cron.schedule('* * * * *', fn, { timezone: 'INVALID' })` throws `Error: Invalid time zone specified: INVALID`. This exception propagates synchronously out of `scheduleTrigger()` through `bootstrap()` up to the `try/catch` in `routes.ts`.

The consequence at startup: if any stored `schedule` trigger has an invalid timezone, `cronScheduler.bootstrap()` throws, the `catch` block logs the error, and **all cron tasks and file watchers fail to start** for the lifetime of that server process. The routes themselves still function (registered before `bootstrap()`), but no scheduled or file-change triggers will fire.

A maintainer who creates a schedule trigger with `timezone: "INJECTED"` will permanently break scheduled execution for all users until a developer manually fixes the database and restarts the server.

**Fix required — two changes:**

1. `server/routes/triggers.ts` `ScheduleConfigSchema`: add timezone validation. The simplest approach is a runtime check via `Intl.supportedValuesOf("timeZone")` or a regex allowlist. At minimum, add a `.refine()` that checks `Intl.DateTimeFormat` construction succeeds:
   ```typescript
   timezone: z.string().max(100).optional().refine(
     (tz) => tz === undefined || isValidIANATimezone(tz),
     { message: "Invalid IANA timezone" }
   )
   ```

2. `server/services/cron-scheduler.ts#scheduleTrigger()`: wrap `cron.schedule()` in a try/catch so a single bad trigger cannot abort the loop:
   ```typescript
   try {
     const task = cron.schedule(config.cron, ..., { timezone: config.timezone ?? "UTC" });
     this.tasks.set(trigger.id, task);
   } catch (e) {
     console.error(`[cron-scheduler] Failed to schedule trigger ${trigger.id}:`, e);
   }
   ```

**[PASS] File paths sanitized**

`file-watcher.ts#validateWatchPath()`: paths are resolved via `realpathSync`, confined to `WATCH_BASE_PATH`, rejected if containing `..` after resolution, and rejected if matching any entry in `DENIED_PATHS` (which includes `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/run`, `/root`, `/var/run/docker.sock`, `/run/secrets`).

**[PASS] GitHub webhook payload treated as untrusted input**

`github-event-handler.ts` casts the payload to `Record<string, unknown>` and only reads typed fields (`repository.full_name`, `ref`) for routing decisions. No eval, no exec, no template expansion. The `{{filePath}}` substitution in `file-watcher.ts` is applied to `config.input` using a literal string replace — not a template engine — and the result is passed as data to `fireTrigger`, not executed as code.

---

### A04 — Insecure Design

**[PASS] Rate limiting on webhook endpoint**

`webhook-handler.ts`: `checkRateLimit(triggerId)` is the first operation in `handleWebhookRequest()` (line 141) before any DB access. The limit is 60 requests per 60-second window per trigger ID. Implemented with a sliding-window (window resets on first call after expiry).

**[PASS] Rate limiter eviction prevents memory exhaustion**

`startRateLimitCleanup()` runs a `setInterval` every 5 minutes that evicts entries older than 2× the window. A `MAX_ENTRIES = 10_000` cap triggers additional 10%-oldest eviction. `cleanupTimer.unref()` prevents the timer from keeping the process alive. This satisfies the architecture condition.

**[PASS] Disabled triggers cannot be fired via webhook**

`webhook-handler.ts` line 147: `if (!trigger || !trigger.enabled)` returns 404. Disabled triggers are indistinguishable from non-existent triggers to the caller.

---

### A05 — Security Misconfiguration

**[PASS] `express.raw()` NOT used — `express.json()` with `verify` hook captures raw body**

`server/index.ts` uses `express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`. This is applied globally but is correct — the `verify` callback captures the raw body for HMAC verification while still parsing JSON. There is no separate `express.raw()` call. The raw body is always a `Buffer`, which `webhook-handler.ts` handles correctly.

**[PASS] `TRIGGER_SECRET_KEY` required; `TriggerCrypto` throws if missing**

`trigger-crypto.ts` constructor validates that `TRIGGER_SECRET_KEY` is a non-empty 64-character hex string. If the regex check passes but `Buffer.from(raw, "hex").length !== 32`, a second throw fires. If the key is absent, `new TriggerService(storage)` throws inside the `try` block in `routes.ts`, which prevents route registration and logs a clear startup message.

**[PASS] No debug/dev defaults in production paths**

`TriggerCrypto` has no dev fallback (unlike `server/crypto.ts`). `WATCH_BASE_PATH` defaults to `process.cwd()` with a console warning, which is acceptable (the warning is visible at startup).

---

### A06 — Vulnerable Components

**[PASS] chokidar 5.0.0 — no known CVEs**

chokidar 5.x is the current major release. No published CVEs were found against this version as of 2026-03-16. `npm audit` returned no findings for this package.

**[PASS] node-cron 4.2.1 — no known CVEs**

node-cron 4.2.1 is current. No published CVEs found. `npm audit` returned no findings.

---

### A07 — Authentication Failures

**[PASS] Session/JWT validation happens before trigger CRUD**

`requireAuth` middleware is registered at `app.use("/api/triggers", requireAuth)` and `app.use("/api/pipelines", requireAuth)`. Express middleware runs in registration order; both prefixes are registered before route handlers. Confirmed by reading `server/routes.ts` lines 52-74 (middleware block) vs lines 76-116 (route registration block).

**[PASS] GitHub signature verified: `X-Hub-Signature-256` HMAC-SHA256**

`github-event-handler.ts` lines 58-62 check `headers["x-hub-signature-256"]` using `verifyHmacSignature()` with HMAC-SHA256. Signature verification happens per-trigger (each trigger may have its own secret).

---

### A08 — Software/Data Integrity

**[CONCERN] GitHub payload parsed before per-trigger HMAC verification**

`github-event-handler.ts` extracts `repository.full_name` and `ref` from the untrusted payload at lines 35-37, before any HMAC verification occurs. The routing logic (which triggers to fire) is therefore based on unverified data.

This is architecturally unavoidable given the per-trigger-secret design (there is no global GitHub app secret in this implementation). An attacker can craft a request with an arbitrary `repository` and `ref` to influence which triggers are evaluated. The HMAC check still occurs before `fireTrigger()` is called, so no pipeline can be triggered without a valid secret. No code execution flows from the unverified payload fields directly.

The concern is information disclosure: an unauthenticated caller can observe the response to learn which `repository` values have triggers configured (see VETO ISSUE-3 below).

**[PASS] Trigger config validated with strict type-discriminated schemas**

`routes/triggers.ts` implements `validateTriggerConfig()` (Fix 3): a switch statement dispatches to `WebhookConfigSchema`, `ScheduleConfigSchema`, `GitHubConfigSchema`, or `FileChangeConfigSchema` based on the discriminated type. `WebhookConfigSchema.strict()` rejects unknown keys. No passthrough catch-all exists.

---

### A09 — Logging Failures

**[PASS] Errors logged with correlation IDs server-side**

All catch blocks in `routes/triggers.ts` and `routes/webhooks.ts` generate a `correlationId()` (8-char UUID prefix), log the full error with `console.error`, and return only `{ error: "Internal server error", correlationId }` to the caller.

**[PASS] No secrets in log output**

`routes/triggers.ts` does not log request bodies. The `fireTrigger` implementation in `routes.ts` logs only trigger ID and pipeline ID. `cron-scheduler.ts` logs trigger ID on error. None of these include decrypted secrets or the `secretEncrypted` field.

**[VETO] ISSUE-3 — `/api/github-events` leaks internal trigger IDs and error details**

`github-event-handler.ts` returns `{ fired: string[], errors: string[] }` where `fired` contains trigger IDs of successfully fired triggers and `errors` contains messages like `"Trigger abc123: invalid HMAC signature (delivery xyz)"`.

`routes/webhooks.ts` line 63 returns this object directly: `return res.json(result)`.

The `/api/github-events` endpoint is public (no auth required). Any external caller can POST to it and receive:
- A list of trigger IDs that matched and were fired (`fired`)
- A list of trigger IDs that matched but failed HMAC (`errors`)

This is a significant information disclosure. An attacker learns internal trigger IDs (UUIDs), which triggers are active and listening for which repositories, and can enumerate the trigger namespace via targeted payloads.

**Fix required in `server/routes/webhooks.ts`**: Strip internal IDs from the response. Return only aggregate counts, not the IDs or raw error strings:
```typescript
return res.json({
  fired: result.fired.length,
  errors: result.errors.length > 0 ? result.errors.length : undefined,
});
```
Log the full `result` server-side for audit purposes. The caller receives only enough to confirm delivery.

**[PASS] Failed webhook attempts logged**

`webhook-handler.ts`: rate limit exceeded returns 429 (logged by global request logger). Invalid HMAC returns 401 (logged). `github-event-handler.ts` pushes HMAC failures to `errors[]` which is logged server-side via `console.error` in the catch path of `routes/webhooks.ts`.

---

### A10 — SSRF

**[PASS] File watcher paths anchored to `WATCH_BASE_PATH`**

Symlinks are resolved via `realpathSync`. Paths are rejected if outside `WATCH_BASE_PATH`. Denylist covers `/etc`, `/proc`, `/sys`, `/dev`, `/boot`, `/run`, `/root`, `/var/run/docker.sock`, `/run/secrets`. Path traversal (`..`) after resolution triggers rejection.

**[PASS] No outbound HTTP calls triggered by trigger config values**

The `fireTrigger` implementation in `routes.ts` only calls `storage.getPipeline()`, `storage.updateTrigger()`, and `log()`. It does not make any outbound HTTP requests. Trigger config fields (`watchPath`, `repository`, `cron`, etc.) do not flow into any HTTP client. No SSRF vector exists.

---

## Summary of Findings

| # | OWASP | Severity | Issue | File(s) |
|---|-------|----------|-------|---------|
| VETO-1 | A01 | Critical | Any maintainer can CRUD any pipeline's triggers regardless of ownership | `server/routes/triggers.ts` — all routes |
| VETO-2 | A03 / A04 | High | Unvalidated timezone string causes cron subsystem DoS on restart | `server/routes/triggers.ts` `ScheduleConfigSchema` + `server/services/cron-scheduler.ts` `scheduleTrigger()` |
| VETO-3 | A09 | High | `/api/github-events` returns internal trigger IDs in plain-text response | `server/routes/webhooks.ts` line 63 + `server/services/github-event-handler.ts` return shape |
| CONCERN-1 | A02 | Low | No explicit length pre-check before `timingSafeEqual` (relies on catch) | `server/services/webhook-handler.ts` line 94 |
| CONCERN-2 | A08 | Low | GitHub payload parsed before HMAC (unavoidable, but documented) | `server/services/github-event-handler.ts` lines 35-37 |

---

## VETOED

The PR cannot proceed until the following three issues are resolved.

### VETO-1 Fix — `server/routes/triggers.ts`

On every trigger route that reads or mutates a trigger, resolve the parent pipeline and apply ownership gating identical to `routes/pipelines.ts`. Specifically:

- `GET /api/pipelines/:pipelineId/triggers`: fetch the pipeline by `pipelineId`, call `requireOwnerOrRole(() => pipeline.ownerId, "admin")` as an inline middleware or guard before returning triggers.
- `POST /api/pipelines/:pipelineId/triggers`: same ownership check before creating.
- `GET /api/triggers/:id`, `PATCH /api/triggers/:id`, `DELETE /api/triggers/:id`, `POST /api/triggers/:id/enable`, `POST /api/triggers/:id/disable`: resolve trigger → `trigger.pipelineId` → fetch pipeline → enforce `requireOwnerOrRole(() => pipeline.ownerId, "admin")`.

### VETO-2 Fix — Two-file change

**File 1: `server/routes/triggers.ts`** — add `.refine()` to the `timezone` field in `ScheduleConfigSchema`:

```typescript
const ScheduleConfigSchema = z.object({
  cron: z.string().min(1).max(200),
  timezone: z.string().max(100).optional().refine(
    (tz) => {
      if (tz === undefined) return true;
      try {
        Intl.DateTimeFormat(undefined, { timeZone: tz });
        return true;
      } catch {
        return false;
      }
    },
    { message: "Invalid IANA timezone identifier" }
  ),
  input: z.string().max(100_000).optional(),
});
```

**File 2: `server/services/cron-scheduler.ts`** — wrap `cron.schedule()` in a try/catch inside `scheduleTrigger()`:

The call to `cron.schedule(config.cron, callback, { timezone: config.timezone ?? "UTC" })` must be inside a `try/catch` block that logs the error and returns without adding to `this.tasks`. This prevents a single bad trigger from aborting the entire bootstrap loop.

### VETO-3 Fix — `server/routes/webhooks.ts`

Change line 63 from:
```typescript
return res.json(result);
```
to:
```typescript
// Log full result server-side for audit; return only counts to caller
const cid = correlationId();
if (result.errors.length > 0) {
  console.error(`[webhooks] github-events cid=${cid} fired=${result.fired.length} errors=${result.errors.length}`, result.errors);
}
return res.json({ fired: result.fired.length });
```

---

## Non-Blocking Recommendations (Address in follow-up)

1. **Add explicit length pre-check in `webhook-handler.ts`** (CONCERN-1): Before calling `timingSafeEqual`, add `if (hexSig.length !== 64) return false;` to make the intent explicit and avoid exception-as-flow-control.

2. **Document the per-trigger HMAC architecture decision** (CONCERN-2): The fact that GitHub payload routing uses unverified data before per-trigger HMAC is a deliberate trade-off. Add a code comment in `github-event-handler.ts` explaining this is safe because `fireTrigger` is never called before HMAC passes.

3. **Cron/file-watcher lifecycle hooks**: New schedule and file_change triggers created via API are not activated until server restart. Add a comment in `routes/triggers.ts` POST handler documenting this limitation, or wire in live scheduler updates.

4. **`/api/github-events` response on partial success**: After VETO-3 fix, consider returning HTTP 207 Multi-Status when some triggers fire and others fail, rather than always returning HTTP 200.

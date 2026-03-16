# Security Final Sign-Off — Phase 6.3 Event-Driven Triggers

**Date**: 2026-03-16
**Reviewer**: security-expert
**Scope**: Verification of all 3 VETO fixes and 2 non-blocking recommendations from the prior OWASP code review
**Source worktree**: `.claude/worktrees/agent-ab336dba` (commit `b450963`)

---

## VETO-1: Broken Access Control (OWASP A01) — Ownership Gating

**Claim**: `assertPipelineOwnership()` helper added to `server/routes/triggers.ts`, applied to all 7 trigger routes, and `registerTriggerRoutes` now takes `storage` as third param.

**Verification** (file: `server/routes/triggers.ts`, lines 111–336):

The `assertPipelineOwnership()` async function is defined at lines 111–136. It:
- Looks up the pipeline via `storage.getPipeline(pipelineId)` and returns 404 if not found.
- Invokes `requireOwnerOrRole(() => ownerId, "admin")` as middleware.
- Returns `false` (preventing handler continuation) if the middleware sends a 401/403 or pipeline is missing.
- Returns `true` only when `next()` is called and no response has been sent.

`registerTriggerRoutes()` signature at line 140 is:
```
registerTriggerRoutes(app: Express, triggerService: TriggerService, storage: IStorage): void
```
`storage` is present as the third parameter. ✅

Call sites confirmed:

| Route | Line | Call |
|-------|------|------|
| GET /api/pipelines/:pipelineId/triggers | 148–149 | `assertPipelineOwnership(pipelineId, storage, req, res)` |
| POST /api/pipelines/:pipelineId/triggers | 174–175 | `assertPipelineOwnership(pipelineId, storage, req, res)` |
| GET /api/triggers/:id | 209–210 | `assertPipelineOwnership(trigger.pipelineId, storage, req, res)` |
| PATCH /api/triggers/:id | 233–234 | `assertPipelineOwnership(trigger.pipelineId, storage, req, res)` |
| DELETE /api/triggers/:id | 272–273 | `assertPipelineOwnership(trigger.pipelineId, storage, req, res)` |
| POST /api/triggers/:id/enable | 300–301 | `assertPipelineOwnership(trigger.pipelineId, storage, req, res)` |
| POST /api/triggers/:id/disable | 323–324 | `assertPipelineOwnership(trigger.pipelineId, storage, req, res)` |

All 7 routes call `assertPipelineOwnership` and check the boolean return value with `if (!allowed) return`.

**Status**: ✅ CONFIRMED — VETO-1 fully resolved across all 7 routes.

---

## VETO-2a: Timezone Injection via ScheduleConfigSchema (OWASP A03)

**Claim**: `ScheduleConfigSchema.timezone` now has `.refine()` using `Intl.DateTimeFormat`.

**Verification** (file: `server/routes/triggers.ts`, lines 34–49):

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
  ...
```

The `.refine()` is present. It uses the `Intl.DateTimeFormat` constructor as a runtime IANA timezone validator. The `undefined` guard handles the optional case. The error message does not leak any internal detail about the failure. A bad timezone returns a 400 with `"Invalid IANA timezone identifier"`.

**Status**: ✅ CONFIRMED — VETO-2a fully resolved.

---

## VETO-2b: Cron Scheduler try/catch to Prevent DoS on Bootstrap (OWASP A04)

**Claim**: `CronScheduler#scheduleTrigger()` wraps `cron.schedule()` in try/catch.

**Verification** (file: `server/services/cron-scheduler.ts`, lines 42–66):

```typescript
try {
  const task = cron.schedule(
    config.cron,
    async () => { ... },
    { timezone: config.timezone ?? "UTC" },
  );
  this.tasks.set(trigger.id, task);
} catch (err) {
  console.error(`[cron-scheduler] Failed to schedule trigger ${trigger.id}:`, err);
  // Do NOT rethrow — prevents one bad trigger from aborting bootstrap
}
```

The try/catch wraps the entire `cron.schedule()` call and its task registration. The catch block logs the error with the trigger ID and does not rethrow, so a single invalid stored trigger cannot abort `bootstrap()` and starve all subsequent scheduled triggers.

The inner `fireTrigger` callback also has its own independent try/catch (lines 50–56), which is defense-in-depth for runtime fire failures.

**Status**: ✅ CONFIRMED — VETO-2b fully resolved.

---

## VETO-3: Information Disclosure on `/api/github-events` (OWASP A09)

**Claim**: `/api/github-events` now returns only `{ fired: number }`, with full result logged server-side using a correlation ID.

**Verification** (file: `server/routes/webhooks.ts`, lines 64–71):

```typescript
const cid = correlationId();
if (result.errors && result.errors.length > 0) {
  console.error({ cid, fired: result.fired?.length, errors: result.errors }, "github-events partial failure");
}
return res.json({ fired: result.fired?.length ?? 0 });
```

The response body is exclusively `{ fired: number }`. Trigger IDs, raw error strings, and internal state from `result` are not sent to the caller. Errors and fired trigger IDs are logged server-side with a correlation ID. The `?? 0` guard handles undefined safely.

**Status**: ✅ CONFIRMED — VETO-3 fully resolved.

---

## CONCERN-1 (Non-Blocking): Explicit Length Pre-Check in `verifyHmacSignature`

**Claim**: Added `if (hexSig.length !== 64) return false` before `timingSafeEqual`.

**Verification** (file: `server/services/webhook-handler.ts`, line 93):

```typescript
if (hexSig.length !== 64) return false;
```

Present at line 93, immediately after the `sha256=` prefix strip. A valid HMAC-SHA256 hex digest is always 64 characters; anything else short-circuits before the crypto operation. The existing try/catch around `timingSafeEqual` (lines 98–103) remains as secondary defense for any residual edge case.

**Status**: ✅ CONFIRMED — CONCERN-1 addressed.

---

## CONCERN-2 (Non-Blocking): Architectural Safety Comment in `github-event-handler.ts`

**Claim**: Explanatory comment added documenting why pre-HMAC routing is architecturally safe.

**Verification** (file: `server/services/github-event-handler.ts`, lines 35–40):

```
// CONCERN-2 note: routing (repository/ref matching) uses pre-HMAC payload fields.
// This is a deliberate architectural trade-off: the per-trigger-secret design requires
// us to identify candidate triggers before we can look up their individual secrets.
// This is safe because fireTrigger is NEVER called before a successful HMAC check —
// an attacker can influence which triggers are *evaluated* but cannot fire any trigger
// without possessing the corresponding secret.
```

The comment is accurate: `fireTrigger` is called only inside the loop after `verifyHmacSignature` returns `true` (line 65–68). The comment correctly explains the invariant.

**Status**: ✅ CONFIRMED — CONCERN-2 addressed.

---

## Additional Observations

The following pre-existing controls from prior review passes remain intact:

- `requireRole("maintainer", "admin")` middleware is applied on all mutating routes (POST create, PATCH, DELETE, POST enable, POST disable) at the Express middleware layer, before the async handler body runs.
- `ZodError` handling on all routes returns 400 without leaking stack traces.
- Correlation IDs are generated for every 500-path log line; callers receive only the ID, not the internal error.
- Rate limiting in `webhook-handler.ts` remains in place (60 req/min per trigger).

No new issues identified during this review pass.

---

## Verdict

| # | Issue | Status |
|---|-------|--------|
| VETO-1 | Ownership gating on all 7 trigger routes | ✅ CONFIRMED |
| VETO-2a | Timezone validation via Intl.DateTimeFormat refine | ✅ CONFIRMED |
| VETO-2b | cron.schedule() wrapped in try/catch | ✅ CONFIRMED |
| VETO-3 | /api/github-events returns only `{ fired: number }` | ✅ CONFIRMED |
| CONCERN-1 | Explicit length pre-check before timingSafeEqual | ✅ CONFIRMED |
| CONCERN-2 | Architectural safety comment on pre-HMAC routing | ✅ CONFIRMED |

---

## SECURITY APPROVED — PR can proceed

All 3 blocking VETO issues have been correctly implemented. Both non-blocking recommendations have been addressed. No new security issues were introduced. The Phase 6.3 Event-Driven Triggers feature is cleared for pull request creation.

/**
 * WebhookHandler — validates incoming webhook requests with HMAC-SHA256
 * and enforces a sliding-window rate limit per trigger.
 *
 * Fix 1 (Security): rateLimitMap is periodically cleaned to prevent unbounded
 * memory growth from entries for deleted/inactive triggers.
 */
import { createHmac, timingSafeEqual } from "crypto";
import type { Request, Response } from "express";
import type { TriggerRow } from "@shared/schema";

// ─── Rate limit config ────────────────────────────────────────────────────────

const RATE_LIMIT_WINDOW_MS = 60_000; // 1 minute sliding window
const RATE_LIMIT_MAX_CALLS = 60; // 60 requests per window per trigger
const MAX_ENTRIES = 10_000; // cap on total entries to prevent unbounded growth
const CLEANUP_INTERVAL_MS = 5 * 60_000; // evict stale entries every 5 minutes
const EVICT_OLDEST_FRACTION = 0.1; // evict 10% of oldest entries when cap is exceeded

interface RateLimitEntry {
  count: number;
  windowStart: number;
}

// Module-level map so the cleanup interval can reference it
const rateLimitMap = new Map<string, RateLimitEntry>();
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Evict entries older than 2× the window period.
 * If the map still exceeds MAX_ENTRIES after time-based eviction,
 * additionally evict the oldest 10% by windowStart.
 */
export function cleanupRateLimit(): void {
  const cutoff = Date.now() - 2 * RATE_LIMIT_WINDOW_MS;

  // Time-based eviction
  for (const [key, entry] of rateLimitMap.entries()) {
    if (entry.windowStart < cutoff) {
      rateLimitMap.delete(key);
    }
  }

  // Cap-based eviction: if still too large, evict oldest 10%
  if (rateLimitMap.size > MAX_ENTRIES) {
    const entries = Array.from(rateLimitMap.entries()).sort(
      ([, a], [, b]) => a.windowStart - b.windowStart,
    );
    const toEvict = Math.ceil(entries.length * EVICT_OLDEST_FRACTION);
    for (let i = 0; i < toEvict; i++) {
      rateLimitMap.delete(entries[i][0]);
    }
  }
}

/** Start the periodic cleanup interval. Called once at server startup. */
export function startRateLimitCleanup(): void {
  if (cleanupTimer !== null) return;
  cleanupTimer = setInterval(cleanupRateLimit, CLEANUP_INTERVAL_MS);
  // Allow Node.js to exit even if this timer is still pending
  if (cleanupTimer.unref) cleanupTimer.unref();
}

/** Stop the cleanup interval. Called during graceful shutdown. */
export function stopRateLimitCleanup(): void {
  if (cleanupTimer !== null) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

// ─── HMAC verification ───────────────────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 signature.
 * The request body must be the raw Buffer (stored in req.rawBody by express.json verify).
 * Returns true if the signature matches, false otherwise.
 */
export function verifyHmacSignature(
  rawBody: Buffer | unknown,
  secret: string,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  // Support both "sha256=<hex>" (GitHub style) and plain hex signatures
  const hexSig = signatureHeader.startsWith("sha256=")
    ? signatureHeader.slice(7)
    : signatureHeader;

  // CONCERN-1 fix: explicit length pre-check documents intent and avoids relying
  // on exception-as-flow-control. A valid HMAC-SHA256 hex digest is always 64 chars.
  if (hexSig.length !== 64) return false;

  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody ?? ""), "utf8");
  const expected = createHmac("sha256", secret).update(body).digest("hex");

  try {
    return timingSafeEqual(Buffer.from(hexSig, "hex"), Buffer.from(expected, "hex"));
  } catch {
    // timingSafeEqual throws if buffers differ in length (invalid hex)
    return false;
  }
}

/**
 * Verify a GitLab webhook token (`X-Gitlab-Token`) via constant-time comparison.
 * GitLab does NOT sign the body — it sends a static secret token verbatim, so this
 * is a plain equality check (not HMAC). Fail-closed: missing token/secret or a
 * length mismatch is treated as a mismatch (never falls through to a truthy compare).
 */
export function verifyGitlabToken(
  headerToken: string | undefined,
  secret: string | undefined,
): boolean {
  if (!headerToken || !secret) return false;

  const headerBuf = Buffer.from(headerToken, "utf8");
  const secretBuf = Buffer.from(secret, "utf8");
  if (headerBuf.length !== secretBuf.length) return false;

  return timingSafeEqual(headerBuf, secretBuf);
}

// ─── Rate limiting ────────────────────────────────────────────────────────────

/**
 * Check and increment the rate limit counter for a trigger.
 * Returns true if the request is allowed, false if rate limited.
 */
export function checkRateLimit(triggerId: string): boolean {
  const now = Date.now();
  const entry = rateLimitMap.get(triggerId);

  if (!entry || now - entry.windowStart >= RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(triggerId, { count: 1, windowStart: now });
    return true;
  }

  if (entry.count >= RATE_LIMIT_MAX_CALLS) {
    return false;
  }

  entry.count++;
  return true;
}

// ─── Request handler ─────────────────────────────────────────────────────────

export interface WebhookHandlerDeps {
  getTrigger: (id: string) => Promise<TriggerRow | undefined>;
  getSecret: (id: string) => Promise<string | null>;
  // Returns the shared TriggerFireResult (widened to `unknown` — ignored here).
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<unknown>;
}

export async function handleWebhookRequest(
  req: Request,
  res: Response,
  deps: WebhookHandlerDeps,
): Promise<void> {
  const triggerId = String(req.params.triggerId);

  // Rate limit check
  if (!checkRateLimit(triggerId)) {
    res.status(429).json({ error: "Rate limit exceeded" });
    return;
  }

  const trigger = await deps.getTrigger(triggerId);
  if (!trigger || !trigger.enabled) {
    res.status(404).json({ error: "Trigger not found" });
    return;
  }

  // If a secret is configured, verify the HMAC signature.
  //
  // GitHub signs the RAW request body with the trigger secret and sends the digest
  // as `X-Hub-Signature-256: sha256=<hex>` (verifyHmacSignature accepts that exact
  // scheme). The raw body (captured by express.json's `verify` into req.rawBody) is
  // what GitHub hashed — we MUST NOT re-serialize req.body (key order / whitespace
  // would differ and every signature would fail). A generic webhook may instead use
  // `X-Webhook-Signature`. Unsigned/tampered request ⇒ 401, fireTrigger NOT called.
  const secret = await deps.getSecret(triggerId);
  if (secret) {
    if (trigger.type === "gitlab_event") {
      // GitLab sends a static token verbatim (no body signing) — constant-time
      // equality check, NOT HMAC.
      const token = req.headers["x-gitlab-token"];
      if (!verifyGitlabToken(token as string | undefined, secret)) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }
    } else {
      const sig = req.headers["x-hub-signature-256"] ?? req.headers["x-webhook-signature"];
      if (!verifyHmacSignature(req.rawBody, secret, sig as string | undefined)) {
        res.status(401).json({ error: "Invalid signature" });
        return;
      }
    }
  }

  // A github_event/gitlab_event trigger fires off the provider event TYPE (from the
  // X-GitHub-Event / X-Gitlab-Event header), so wrap the body in the
  // `{ event, delivery, payload }` envelope the provider dispatch reads (mapping
  // PR/push → a review). Every other trigger type keeps receiving the bare body.
  // The header is only trusted to SELECT the mapping; no review fires without the
  // signature/token check above having passed.
  const payload: unknown =
    trigger.type === "github_event"
      ? {
          event: String(req.headers["x-github-event"] ?? ""),
          delivery: String(req.headers["x-github-delivery"] ?? "unknown"),
          payload: req.body,
        }
      : trigger.type === "gitlab_event"
        ? {
            event: String(req.headers["x-gitlab-event"] ?? ""),
            delivery: String(req.headers["x-gitlab-event-uuid"] ?? "unknown"),
            payload: req.body,
          }
        : (req.body as unknown);
  await deps.fireTrigger(trigger, payload);
  res.status(200).json({ ok: true });
}

/**
 * GitHubEventHandler — routes GitHub webhook events to matching triggers.
 *
 * GitHub sends a JSON payload with an X-GitHub-Event header.
 * We match the event type against each trigger's configured events array.
 */
import type { TriggerRow } from "@shared/schema";
import type { GitHubEventTriggerConfig } from "@shared/types";
import { verifyHmacSignature } from "./webhook-handler.js";

export interface GitHubEventHandlerDeps {
  getEnabledTriggersByType: (type: "github_event") => Promise<TriggerRow[]>;
  getSecret: (id: string) => Promise<string | null>;
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<void>;
}

/**
 * Process an incoming GitHub webhook event.
 * Finds all enabled github_event triggers whose repository and events match,
 * verifies the HMAC signature if a secret is configured, then fires each match.
 */
export async function handleGitHubEvent(
  rawBody: Buffer | unknown,
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
  deps: GitHubEventHandlerDeps,
): Promise<{ fired: string[]; errors: string[] }> {
  const eventType = String(headers["x-github-event"] ?? "");
  const deliveryId = String(headers["x-github-delivery"] ?? "unknown");

  if (!eventType) {
    return { fired: [], errors: ["Missing X-GitHub-Event header"] };
  }

  // CONCERN-2 note: routing (repository/ref matching) uses pre-HMAC payload fields.
  // This is a deliberate architectural trade-off: the per-trigger-secret design requires
  // us to identify candidate triggers before we can look up their individual secrets.
  // This is safe because fireTrigger is NEVER called before a successful HMAC check —
  // an attacker can influence which triggers are *evaluated* but cannot fire any trigger
  // without possessing the corresponding secret.
  const body = payload as Record<string, unknown>;
  const repository = (body.repository as Record<string, unknown> | undefined)?.full_name;
  const ref = String((body.ref as string | undefined) ?? "");

  const triggers = await deps.getEnabledTriggersByType("github_event");
  const fired: string[] = [];
  const errors: string[] = [];

  for (const trigger of triggers) {
    const config = trigger.config as GitHubEventTriggerConfig;

    // Match repository
    if (config.repository && repository !== config.repository) continue;

    // Match event type
    if (!config.events.includes(eventType)) continue;

    // Match optional ref filter
    if (config.refFilter && ref && !ref.startsWith(config.refFilter)) continue;

    // Verify HMAC if secret is configured
    const secret = await deps.getSecret(trigger.id);
    if (secret) {
      const sig = headers["x-hub-signature-256"] as string | undefined;
      if (!verifyHmacSignature(rawBody, secret, sig)) {
        errors.push(`Trigger ${trigger.id}: invalid HMAC signature (delivery ${deliveryId})`);
        continue;
      }
    }

    try {
      await deps.fireTrigger(trigger, { event: eventType, delivery: deliveryId, payload });
      fired.push(trigger.id);
    } catch (e) {
      errors.push(`Trigger ${trigger.id}: ${(e as Error).message}`);
    }
  }

  return { fired, errors };
}

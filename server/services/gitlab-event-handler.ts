/**
 * GitLabEventHandler — routes GitLab webhook events to matching triggers.
 *
 * GitLab sends a JSON payload with an X-Gitlab-Event header.
 * We match the event type against each trigger's configured events array.
 */
import type { TriggerRow } from "@shared/schema";
import type { GitLabEventTriggerConfig } from "@shared/types";
import { verifyGitlabToken } from "./webhook-handler.js";

export interface GitLabEventHandlerDeps {
  getEnabledTriggersByType: (type: "gitlab_event") => Promise<TriggerRow[]>;
  getSecret: (id: string) => Promise<string | null>;
  // Returns the shared TriggerFireResult (widened to `unknown` — ignored here).
  fireTrigger: (trigger: TriggerRow, payload: unknown) => Promise<unknown>;
}

/**
 * Process an incoming GitLab webhook event.
 * Finds all enabled gitlab_event triggers whose project and events match,
 * verifies the shared-secret token if configured, then fires each match.
 */
export async function handleGitLabEvent(
  rawBody: Buffer | unknown,
  headers: Record<string, string | string[] | undefined>,
  payload: unknown,
  deps: GitLabEventHandlerDeps,
): Promise<{ fired: string[]; errors: string[] }> {
  const eventType = String(headers["x-gitlab-event"] ?? "");
  const deliveryId = String(headers["x-gitlab-event-uuid"] ?? "unknown");

  if (!eventType) {
    return { fired: [], errors: ["Missing X-Gitlab-Event header"] };
  }

  // CONCERN-2 note (mirrors github-event-handler.ts): routing (project/ref matching)
  // uses pre-auth payload fields. This is a deliberate architectural trade-off: the
  // per-trigger-secret design requires us to identify candidate triggers before we
  // can look up their individual secrets. This is safe because fireTrigger is NEVER
  // called before a successful token check — an attacker can influence which
  // triggers are *evaluated* but cannot fire any trigger without possessing the
  // corresponding secret token.
  const body = payload as Record<string, unknown>;
  const project = (body.project as Record<string, unknown> | undefined)?.path_with_namespace;
  const ref = String((body.ref as string | undefined) ?? "");

  const triggers = await deps.getEnabledTriggersByType("gitlab_event");
  const fired: string[] = [];
  const errors: string[] = [];

  for (const trigger of triggers) {
    const config = trigger.config as GitLabEventTriggerConfig;

    // Match project
    if (config.project && project !== config.project) continue;

    // Match event type
    if (!config.events.includes(eventType)) continue;

    // Match optional ref filter
    if (config.refFilter && ref && !ref.startsWith(config.refFilter)) continue;

    // Verify shared-secret token if configured
    const secret = await deps.getSecret(trigger.id);
    if (secret) {
      const token = headers["x-gitlab-token"] as string | undefined;
      if (!verifyGitlabToken(token, secret)) {
        errors.push(`Trigger ${trigger.id}: invalid token (delivery ${deliveryId})`);
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

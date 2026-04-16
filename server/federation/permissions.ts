/**
 * Share Permission Service (issue #232)
 *
 * Provides fine-grained permission checks for shared sessions.
 * Each shared session can have a role (owner/collaborator/viewer) and
 * granular flags controlling chat, vote, memory visibility, and stage access.
 */
import type { SharedSession, ShareRole, SharePermissions } from "@shared/types";

// ── Default permissions per role ─────────────────────────────────────────────

const ROLE_DEFAULTS: Record<ShareRole, SharePermissions> = {
  owner: {
    role: "owner",
    allowedStages: null,
    canChat: true,
    canVote: true,
    canViewMemories: true,
  },
  collaborator: {
    role: "collaborator",
    allowedStages: null,
    canChat: true,
    canVote: true,
    canViewMemories: true,
  },
  viewer: {
    role: "viewer",
    allowedStages: null,
    canChat: false,
    canVote: false,
    canViewMemories: true,
  },
};

/** Return the default permission set for a given role. */
export function getDefaultPermissions(role: ShareRole): SharePermissions {
  return { ...ROLE_DEFAULTS[role] };
}

/** Resolve effective permissions -- use session overrides or role defaults. */
export function resolvePermissions(session: SharedSession): SharePermissions {
  if (session.permissions) {
    return session.permissions;
  }
  return getDefaultPermissions("collaborator");
}

/** Check whether the session holder can send chat messages. */
export function canChat(session: SharedSession): boolean {
  return resolvePermissions(session).canChat;
}

/** Check whether the session holder can cast votes. */
export function canVote(session: SharedSession): boolean {
  return resolvePermissions(session).canVote;
}

/** Check whether the session holder can view memories. */
export function canViewMemories(session: SharedSession): boolean {
  return resolvePermissions(session).canViewMemories;
}

/**
 * Check whether the session holder can view a specific stage.
 * When allowedStages is null, all stages are accessible.
 */
export function canViewStage(
  session: SharedSession,
  stageId: string,
): boolean {
  const perms = resolvePermissions(session);
  if (perms.allowedStages === null) return true;
  return perms.allowedStages.includes(stageId);
}

/**
 * Filter a WsEvent based on the subscriber's permissions.
 * Returns the event unchanged if allowed, or null if it should be suppressed.
 */
export function filterEvent(
  session: SharedSession,
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  const perms = resolvePermissions(session);
  const eventType = event.type as string | undefined;

  if (!eventType) return event;

  if (isChatEvent(eventType) && !perms.canChat) {
    return null;
  }

  if (isVoteEvent(eventType) && !perms.canVote) {
    return null;
  }

  if (isMemoryEvent(eventType) && !perms.canViewMemories) {
    return null;
  }

  if (isStageEvent(eventType)) {
    const stageId = extractStageId(event);
    if (stageId && perms.allowedStages !== null) {
      if (!perms.allowedStages.includes(stageId)) {
        return null;
      }
    }
  }

  return event;
}

// ── Private helpers ──────────────────────────────────────────────────────────

function isChatEvent(type: string): boolean {
  return type.startsWith("chat:") || type === "chat_message";
}

function isVoteEvent(type: string): boolean {
  return type.startsWith("vote:") || type === "approval_vote";
}

function isMemoryEvent(type: string): boolean {
  return type.startsWith("memory:") || type === "memory_created";
}

function isStageEvent(type: string): boolean {
  return type.startsWith("stage:") || type === "stage_update";
}

function extractStageId(event: Record<string, unknown>): string | null {
  const payload = event.payload as Record<string, unknown> | undefined;
  if (payload && typeof payload.stageId === "string") {
    return payload.stageId;
  }
  if (typeof event.stageId === "string") {
    return event.stageId;
  }
  return null;
}

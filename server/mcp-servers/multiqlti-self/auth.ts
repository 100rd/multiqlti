/**
 * MCP Client Token Auth (issue #274)
 *
 * Provides scoped API tokens for external MCP clients:
 *  - Token type "mcp_client" — separate from user session JWTs
 *  - Scope: reachable workspace IDs, callable tool allow-list, max run concurrency
 *  - Tokens are hashed (SHA-256) before storage; plaintext shown once at creation
 *  - Tokens can be revoked; expiry is optional
 *
 * Concurrency tracking is in-process (Map<tokenId, activeRunCount>).
 * This is intentionally simple — a production system would use Redis.
 */

import { createHash, randomBytes } from "crypto";
import type {
  McpClientToken,
  McpTokenScope,
  CreateMcpClientTokenInput,
  CreateMcpClientTokenResult,
} from "@shared/types";

// ─── Token generation ──────────────────────────────────────────────────────────

/**
 * Generate a cryptographically random MCP client token.
 * Format: "mq_mcp_<48 random hex chars>"
 * Total length: 55 chars — recognisable prefix + sufficient entropy.
 */
export function generateRawToken(): string {
  return `mq_mcp_${randomBytes(24).toString("hex")}`;
}

/** Hash a raw token with SHA-256 for safe storage. */
export function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/** Extract the last 8 characters of a raw token as a display suffix. */
export function tokenSuffix(rawToken: string): string {
  return rawToken.slice(-8);
}

// ─── Public context returned by validate ─────────────────────────────────────

/**
 * The subset of a stored token that callers need to construct a McpCallContext.
 * Does not include the token hash or other internal fields.
 */
export interface ValidatedTokenContext {
  id: string;
  scope: McpTokenScope;
}

// ─── In-memory token store ────────────────────────────────────────────────────

interface StoredToken {
  id: string;
  workspaceId: string;
  name: string;
  tokenHash: string;
  tokenSuffix: string;
  scope: McpTokenScope;
  createdAt: Date;
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  isRevoked: boolean;
}

/**
 * In-memory MCP client token storage.
 *
 * This is intentionally separate from IStorage to keep the scope narrow for
 * issue #274. A future migration can move this into PostgreSQL / PgStorage.
 */
export class McpTokenStore {
  private readonly byId = new Map<string, StoredToken>();
  private readonly byHash = new Map<string, StoredToken>();

  /**
   * Create a new MCP client token.
   * Returns the record + the one-time-visible raw token.
   */
  create(input: CreateMcpClientTokenInput): CreateMcpClientTokenResult {
    const rawToken = generateRawToken();
    const hash = hashToken(rawToken);
    const suffix = tokenSuffix(rawToken);
    const id = `mct_${randomBytes(12).toString("hex")}`;

    const stored: StoredToken = {
      id,
      workspaceId: input.workspaceId,
      name: input.name,
      tokenHash: hash,
      tokenSuffix: suffix,
      scope: { ...input.scope },
      createdAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      lastUsedAt: null,
      isRevoked: false,
    };

    this.byId.set(id, stored);
    this.byHash.set(hash, stored);

    return {
      token: this.toPublic(stored),
      rawToken,
    };
  }

  /**
   * Validate a raw token string.
   * Returns the public context if valid, null otherwise.
   * Updates lastUsedAt on success.
   */
  validate(rawToken: string): ValidatedTokenContext | null {
    const hash = hashToken(rawToken);
    const stored = this.byHash.get(hash);
    if (!stored) return null;
    if (stored.isRevoked) return null;
    if (stored.expiresAt && stored.expiresAt < new Date()) return null;
    stored.lastUsedAt = new Date();
    return { id: stored.id, scope: { ...stored.scope } };
  }

  /** Revoke a token by ID. Returns false if not found. */
  revoke(id: string): boolean {
    const stored = this.byId.get(id);
    if (!stored) return false;
    stored.isRevoked = true;
    return true;
  }

  /** List all tokens for a workspace (public shapes only, no hashes). */
  listByWorkspace(workspaceId: string): McpClientToken[] {
    return Array.from(this.byId.values())
      .filter((t) => t.workspaceId === workspaceId)
      .map((t) => this.toPublic(t));
  }

  /** Get a single token by ID (public shape). */
  getById(id: string): McpClientToken | null {
    const stored = this.byId.get(id);
    return stored ? this.toPublic(stored) : null;
  }

  /** Delete all tokens for tests. */
  _reset(): void {
    this.byId.clear();
    this.byHash.clear();
  }

  private toPublic(stored: StoredToken): McpClientToken {
    return {
      id: stored.id,
      workspaceId: stored.workspaceId,
      name: stored.name,
      tokenSuffix: stored.tokenSuffix,
      scope: { ...stored.scope },
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
      lastUsedAt: stored.lastUsedAt,
      isRevoked: stored.isRevoked,
    };
  }
}

// ─── Singleton ────────────────────────────────────────────────────────────────

export const mcpTokenStore = new McpTokenStore();

// ─── Scope Checking ───────────────────────────────────────────────────────────

/**
 * Check whether a token's scope allows access to a given workspace.
 * Returns false if the workspace is not in the token's allowed list.
 */
export function checkWorkspaceAccess(scope: McpTokenScope, workspaceId: string): boolean {
  return scope.workspaceIds.includes(workspaceId);
}

/**
 * Check whether a token's scope allows calling a specific tool.
 * Passes when the allow-list is ["*"] or contains the tool name.
 */
export function checkToolAccess(scope: McpTokenScope, toolName: string): boolean {
  const list = scope.allowedTools;
  if (list.length === 1 && list[0] === "*") return true;
  return (list as string[]).includes(toolName);
}

// ─── Concurrency tracking ──────────────────────────────────────────────────────

const activeRunsByToken = new Map<string, number>();

/**
 * Acquire a run slot for the token.
 * Returns true if a slot is available (and increments the counter).
 * Returns false if at capacity.
 */
export function acquireRunSlot(tokenId: string, maxConcurrency: number): boolean {
  const current = activeRunsByToken.get(tokenId) ?? 0;
  if (current >= maxConcurrency) return false;
  activeRunsByToken.set(tokenId, current + 1);
  return true;
}

/**
 * Release a run slot for the token.
 * Must be called when the run completes or is cancelled.
 */
export function releaseRunSlot(tokenId: string): void {
  const current = activeRunsByToken.get(tokenId) ?? 0;
  if (current <= 0) {
    activeRunsByToken.delete(tokenId);
    return;
  }
  activeRunsByToken.set(tokenId, current - 1);
}

/** Get current active run count for a token (for tests). */
export function getActiveRunCount(tokenId: string): number {
  return activeRunsByToken.get(tokenId) ?? 0;
}

/** Reset concurrency counters (for tests). */
export function _resetConcurrency(): void {
  activeRunsByToken.clear();
}

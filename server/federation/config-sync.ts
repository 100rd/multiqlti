/**
 * config-sync.ts — Federation config-sync event stream service.
 *
 * Issue #321: Config sync federation event stream
 * Issue #322: Offline queue per peer with TTL + coalesce
 *
 * Architecture: transactional outbox pattern + per-peer offline queue
 *
 *  1. Outbox writer — `enqueueConfigEvent(kind, entityId, operation, payload)`
 *     called from the storage layer whenever a syncable entity is mutated.
 *     Inserts a row into `config_events_outbox`.
 *
 *  2. Publisher loop — periodically reads unsent outbox rows, broadcasts them
 *     to connected peers via `config:event` federation messages, marks
 *     `sent_at` on success.  If delivery to a specific peer fails the event
 *     is enqueued in that peer's offline queue (peer_pending_events) via the
 *     `PeerQueueService`.
 *
 *  3. Subscriber handler — receives `config:event` messages, verifies the
 *     federation HMAC (already done by the transport layer), checks the
 *     idempotency key (peer_id, entity_kind, entity_id, version), then
 *     delegates to `applyOne` which dispatches to the existing per-entity
 *     applier infrastructure from issue #317.
 *
 *  4. Reconnect flush — when a heartbeat (`peer:heartbeat`) is received the
 *     service flushes the peer's offline queue in enqueued_at ASC order.
 *
 * Idempotency guarantee:
 *   Each received event is keyed by (peerId, entityKind, entityId, version).
 *   The first application is recorded in `config_events_received`; subsequent
 *   duplicates are silently discarded.
 */

import crypto from "crypto";
import type { FederationManager } from "./index.js";
import type { FederationMessage, PeerInfo } from "./types.js";
import type { ConfigEventOperation } from "@shared/schema";
import type { TriggerType, TriggerConfig } from "@shared/types";
import type { IStorage } from "../storage.js";
import type { PeerQueueService, SendEventFn } from "./peer-queue.js";
import type { ConflictDetector } from "./config-conflict.js";

// ─── Constants ────────────────────────────────────────────────────────────────

/** Default polling interval for the publisher loop (ms). */
const DEFAULT_PUBLISH_INTERVAL_MS = 5_000;

/** Maximum number of outbox rows fetched per publisher tick. */
const MAX_BATCH_SIZE = 100;

/** Federation message type used for config-sync events. */
const MSG_TYPE = "config:event";

/** Federation message type indicating a peer is alive — triggers queue flush. */
const HEARTBEAT_MSG_TYPE = "peer:heartbeat";

// ─── Public types ─────────────────────────────────────────────────────────────

/** Payload transmitted in each `config:event` federation message. */
export interface ConfigEventPayload {
  /** Entity kind — mirrors `entity_kind` column (e.g. "pipeline", "trigger"). */
  entityKind: string;
  /** Stable entity identifier (usually the entity's primary key). */
  entityId: string;
  /** Mutation kind: create | update | delete. */
  operation: ConfigEventOperation;
  /**
   * Full entity snapshot as plain JSON.
   * Empty object `{}` for deletes where no payload is meaningful.
   */
  payload: Record<string, unknown>;
  /**
   * Monotonic version string — used as the idempotency key component.
   * Callers should supply the entity's `updatedAt` ISO timestamp or a
   * UUID if no timestamp is available.
   */
  version: string;
  /** ISO-8601 timestamp of when the event was created on the originating instance. */
  issuedAt: string;
}

/** Minimal interface for the outbox store — subset of IStorage needed here. */
export interface IConfigSyncStore {
  /**
   * Insert one outbox row.
   * Returns the generated row id.
   */
  insertConfigEvent(
    entityKind: string,
    entityId: string,
    operation: ConfigEventOperation,
    payload: Record<string, unknown>,
  ): Promise<string>;

  /**
   * Fetch up to `limit` unsent events ordered by `created_at` ASC.
   */
  getUnsentConfigEvents(limit: number): Promise<Array<{
    id: string;
    entityKind: string;
    entityId: string;
    operation: ConfigEventOperation;
    payloadJsonb: Record<string, unknown>;
    createdAt: Date;
  }>>;

  /**
   * Stamp `sent_at = now()` on the given outbox row ids.
   */
  markConfigEventsSent(ids: string[]): Promise<void>;

  /**
   * Record that an event was received from a peer so it is not applied twice.
   * Returns `true` if the record was newly inserted (event not seen before),
   * `false` if the idempotency key already exists (duplicate — ignore).
   */
  recordConfigEventReceived(
    peerId: string,
    entityKind: string,
    entityId: string,
    version: string,
  ): Promise<boolean>;
}

/** Per-entity apply function — must write exactly one entity to storage. */
export type ApplyOneFn = (
  entityKind: string,
  entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
  storage: IStorage,
) => Promise<void>;

export interface ConfigSyncOptions {
  /** How often to poll the outbox (ms). Defaults to 5 000 ms. */
  publishIntervalMs?: number;
  /**
   * Optional peer-queue service.  When provided, failed per-peer deliveries
   * are enqueued here instead of silently dropped.
   */
  peerQueue?: PeerQueueService;
  /**
   * Optional send-event function to use when flushing the offline queue.
   * Defaults to the federation transport send.
   */
  flushSendFn?: SendEventFn;
  /**
   * Optional conflict detector.  When provided, each incoming event is
   * checked for conflicts before being applied.  Blocked events (human-in-the-
   * loop) are recorded in the conflict store and not forwarded to `applyOne`.
   */
  conflictDetector?: ConflictDetector;
}

// ─── Default applyOne implementation ─────────────────────────────────────────

/**
 * Default `applyOne` dispatcher.
 *
 * Routes incoming events to the existing per-entity applier infrastructure
 * from issue #317.  Each case performs the minimum DB write needed to
 * materialise the remote entity state locally.
 *
 * Delete operations currently log a warning and are no-ops — the full
 * tombstone semantics require the diff-engine to be involved, which is
 * outside the scope of real-time event streaming.
 */
export async function defaultApplyOne(
  entityKind: string,
  entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
  storage: IStorage,
): Promise<void> {
  switch (entityKind) {
    case "pipeline":
      await applyPipelineEvent(entityId, operation, payload, storage);
      break;

    case "trigger":
      await applyTriggerEvent(entityId, operation, payload, storage);
      break;

    case "skill":
      await applySkillEvent(entityId, operation, payload, storage);
      break;

    default:
      // Unknown entity kinds are silently ignored — forward compatibility.
      break;
  }
}

// ─── Main service ─────────────────────────────────────────────────────────────

/**
 * Federation config-sync event stream service.
 *
 * Lifecycle:
 *   1. Construct with `new ConfigSyncService(federation, storage, syncStore, instanceId, applyOne, options)`
 *   2. Call `start()` to begin the publisher polling loop.
 *   3. Call `stop()` to cancel the loop cleanly.
 *
 * The constructor registers the `config:event` and `peer:heartbeat` handlers
 * on the federation transport immediately; `start()` / `stop()` only control
 * the publisher timer.
 */
export class ConfigSyncService {
  private publishTimer: ReturnType<typeof setInterval> | null = null;
  private readonly publishIntervalMs: number;
  private readonly peerQueue: PeerQueueService | null;
  private readonly flushSendFn: SendEventFn | null;
  private readonly conflictDetector: ConflictDetector | null;

  constructor(
    private readonly federation: FederationManager,
    private readonly storage: IStorage,
    private readonly syncStore: IConfigSyncStore,
    private readonly instanceId: string,
    private readonly applyOne: ApplyOneFn = defaultApplyOne,
    options: ConfigSyncOptions = {},
  ) {
    this.publishIntervalMs = options.publishIntervalMs ?? DEFAULT_PUBLISH_INTERVAL_MS;
    this.peerQueue = options.peerQueue ?? null;
    this.flushSendFn = options.flushSendFn ?? null;
    this.conflictDetector = options.conflictDetector ?? null;

    this.federation.on(MSG_TYPE, this.handleIncoming.bind(this));
    this.federation.on(HEARTBEAT_MSG_TYPE, this.handleHeartbeat.bind(this));
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────

  /** Start the outbox publisher polling loop. */
  start(): void {
    if (this.publishTimer !== null) return;
    this.publishTimer = setInterval(() => {
      this.publishPending().catch(() => {
        // Publisher errors are swallowed to keep the loop alive.
      });
    }, this.publishIntervalMs);
  }

  /** Stop the outbox publisher polling loop. */
  stop(): void {
    if (this.publishTimer !== null) {
      clearInterval(this.publishTimer);
      this.publishTimer = null;
    }
  }

  // ── Outbox writer ────────────────────────────────────────────────────────────

  /**
   * Enqueue a config mutation event in the outbox.
   *
   * Call this from the storage layer immediately after any successful write
   * to a syncable entity.  Returns the new outbox row id.
   */
  async enqueueConfigEvent(
    entityKind: string,
    entityId: string,
    operation: ConfigEventOperation,
    payload: Record<string, unknown>,
  ): Promise<string> {
    return this.syncStore.insertConfigEvent(entityKind, entityId, operation, payload);
  }

  // ── Publisher loop ────────────────────────────────────────────────────────────

  /**
   * Read unsent outbox rows and broadcast each to connected peers.
   * Marks `sent_at` on every row that was successfully dispatched to ALL peers.
   * If delivery fails for a specific peer, enqueues the event in that peer's
   * offline queue (if a `PeerQueueService` is configured).
   *
   * Exposed as a public method so tests can invoke it synchronously
   * without waiting for the timer.
   */
  async publishPending(): Promise<void> {
    const peers = this.federation.getPeers();
    if (peers.length === 0) return;

    const unsent = await this.syncStore.getUnsentConfigEvents(MAX_BATCH_SIZE);
    if (unsent.length === 0) return;

    // IDs that were successfully delivered to every peer — mark sent_at.
    const fullyDeliveredIds: string[] = [];

    for (const row of unsent) {
      const eventPayload: ConfigEventPayload = {
        entityKind: row.entityKind,
        entityId: row.entityId,
        operation: row.operation,
        payload: row.payloadJsonb,
        version: row.createdAt.toISOString(),
        issuedAt: row.createdAt.toISOString(),
      };

      let deliveredToAll = true;

      for (const peer of peers) {
        const delivered = await this.sendToPeer(peer, row.id, eventPayload);
        if (!delivered) {
          deliveredToAll = false;
          // Enqueue in offline queue if the service is wired up.
          if (this.peerQueue) {
            await this.peerQueue.enqueue(
              peer.instanceId,
              row.id,
              row.entityKind,
              row.entityId,
            ).catch(() => {
              // Queue errors must not stall the publisher.
            });
          }
        }
      }

      if (deliveredToAll) {
        fullyDeliveredIds.push(row.id);
      }
    }

    if (fullyDeliveredIds.length > 0) {
      await this.syncStore.markConfigEventsSent(fullyDeliveredIds);
    }
  }

  // ── Peer-queue flush (reconnect) ──────────────────────────────────────────────

  /**
   * Flush the offline queue for a peer.
   * Called automatically when a `peer:heartbeat` is received.
   * Can also be called manually for testing.
   */
  async flushPeer(peerId: string): Promise<{ sent: number; failed: number }> {
    if (!this.peerQueue) return { sent: 0, failed: 0 };

    const sendFn = this.flushSendFn ?? this.buildDefaultFlushSendFn();
    return this.peerQueue.flush(peerId, sendFn);
  }

  // ── Subscriber handler ───────────────────────────────────────────────────────

  /**
   * Handle an incoming `config:event` federation message.
   *
   * Flow:
   *   1. Validate payload structure.
   *   2. Check idempotency key — discard duplicate events silently.
   *   3. Run conflict detection (if a ConflictDetector is wired up).
   *      - No conflict  → apply normally.
   *      - Conflict + apply allowed (LWW / auto-merge) → apply, optionally
   *        using the merged payload.
   *      - Conflict + blocked (human-in-the-loop) → skip apply; the conflict
   *        row is persisted in the conflict store for human resolution.
   *   4. Delegate to `applyOne`.
   */
  private async handleIncoming(msg: FederationMessage, peer: PeerInfo): Promise<void> {
    const raw = msg.payload as Record<string, unknown>;

    if (!raw || typeof raw !== "object") return;

    const event = raw["event"] as ConfigEventPayload | undefined;
    if (!event || typeof event !== "object") return;

    const { entityKind, entityId, operation, payload, version } = event;

    if (
      typeof entityKind !== "string" || entityKind.length === 0 ||
      typeof entityId !== "string" || entityId.length === 0 ||
      typeof operation !== "string" ||
      !["create", "update", "delete"].includes(operation) ||
      typeof payload !== "object" || payload === null ||
      typeof version !== "string" || version.length === 0
    ) {
      return;
    }

    const isNew = await this.syncStore.recordConfigEventReceived(
      peer.instanceId,
      entityKind,
      entityId,
      version,
    );

    if (!isNew) return;

    // ── Conflict detection ───────────────────────────────────────────────────
    if (this.conflictDetector) {
      const result = await this.conflictDetector.check(
        peer.instanceId,
        entityKind,
        entityId,
        version,
        payload as Record<string, unknown>,
        operation as ConfigEventOperation,
      );

      if (result.conflicted && !result.applyEvent) {
        // Human-in-the-loop required — do not apply.
        return;
      }

      if (result.conflicted && result.applyEvent && result.mergedPayload) {
        // Auto-merge produced a merged payload — apply the merged result.
        await this.applyOne(
          entityKind,
          entityId,
          operation as ConfigEventOperation,
          result.mergedPayload,
          this.storage,
        );
        return;
      }
    }

    await this.applyOne(
      entityKind,
      entityId,
      operation as ConfigEventOperation,
      payload as Record<string, unknown>,
      this.storage,
    );
  }

  /**
   * Handle an incoming `peer:heartbeat` message — triggers offline queue flush.
   */
  private async handleHeartbeat(_msg: FederationMessage, peer: PeerInfo): Promise<void> {
    await this.flushPeer(peer.instanceId).catch(() => {
      // Flush errors must not crash the handler.
    });
  }

  // ── Internal helpers ──────────────────────────────────────────────────────────

  /**
   * Attempt to deliver one event to one peer.
   * Returns `true` if delivery succeeded, `false` otherwise.
   */
  private async sendToPeer(
    peer: PeerInfo,
    _rowId: string,
    eventPayload: ConfigEventPayload,
  ): Promise<boolean> {
    try {
      this.federation.send(MSG_TYPE, {
        from: this.instanceId,
        event: eventPayload,
      }, peer.instanceId);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Build a `SendEventFn` that uses the federation transport.
   * Used when no explicit `flushSendFn` is provided.
   */
  private buildDefaultFlushSendFn(): import("./peer-queue.js").SendEventFn {
    return async (peerId, _eventId, entityKind, entityId, operation, payloadJsonb) => {
      try {
        this.federation.send(MSG_TYPE, {
          from: this.instanceId,
          event: {
            entityKind,
            entityId,
            operation: operation as import("@shared/schema").ConfigEventOperation,
            payload: payloadJsonb,
            version: new Date().toISOString(),
            issuedAt: new Date().toISOString(),
          } satisfies ConfigEventPayload,
        }, peerId);
        return true;
      } catch {
        return false;
      }
    };
  }
}

// ─── Per-entity apply helpers ─────────────────────────────────────────────────

async function applyPipelineEvent(
  _entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
  storage: IStorage,
): Promise<void> {
  if (operation === "delete") {
    return;
  }

  const name = typeof payload["name"] === "string" ? payload["name"] : null;
  if (!name) return;

  const pipelines = await storage.getPipelines();
  const existing = pipelines.find((p) => p.name === name);

  if (operation === "create" || (!existing && operation === "update")) {
    await storage.createPipeline({
      name,
      description: typeof payload["description"] === "string" ? payload["description"] : null,
      stages: Array.isArray(payload["stages"])
        ? (payload["stages"] as import("@shared/schema").InsertPipeline["stages"])
        : [],
      dag: (payload["dag"] as import("@shared/schema").InsertPipeline["dag"]) ?? null,
      isTemplate: typeof payload["isTemplate"] === "boolean" ? payload["isTemplate"] : false,
    });
    return;
  }

  if (operation === "update" && existing) {
    await storage.updatePipeline(existing.id, {
      name,
      description: typeof payload["description"] === "string" ? payload["description"] : null,
      stages: Array.isArray(payload["stages"])
        ? (payload["stages"] as import("@shared/schema").InsertPipeline["stages"])
        : existing.stages as import("@shared/schema").InsertPipeline["stages"],
      dag: (payload["dag"] as import("@shared/schema").InsertPipeline["dag"]) ?? null,
      isTemplate: typeof payload["isTemplate"] === "boolean" ? payload["isTemplate"] : existing.isTemplate,
    });
  }
}

async function applyTriggerEvent(
  _entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
  storage: IStorage,
): Promise<void> {
  if (operation === "delete") return;

  const pipelineId = typeof payload["pipelineId"] === "string" ? payload["pipelineId"] : null;
  if (!pipelineId) return;

  const triggerId = typeof payload["id"] === "string" ? payload["id"] : null;

  if (operation === "create" || (operation === "update" && !triggerId)) {
    const triggerConfig = (payload["config"] ?? {}) as TriggerConfig;
    const triggerType: TriggerType =
      typeof (triggerConfig as Record<string, unknown>)["type"] === "string"
        ? (triggerConfig as Record<string, unknown>)["type"] as TriggerType
        : "webhook";
    await storage.createTrigger({
      pipelineId,
      type: triggerType,
      enabled: typeof payload["enabled"] === "boolean" ? payload["enabled"] : true,
      config: triggerConfig,
      secretEncrypted: null,
    });
    return;
  }

  if (operation === "update" && triggerId) {
    await storage.updateTrigger(triggerId, {
      enabled: typeof payload["enabled"] === "boolean" ? payload["enabled"] : true,
      config: (payload["config"] ?? {}) as TriggerConfig,
    });
  }
}

async function applySkillEvent(
  _entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
  storage: IStorage,
): Promise<void> {
  if (operation === "delete") return;

  const skillId = typeof payload["id"] === "string" ? payload["id"] : null;
  const name = typeof payload["name"] === "string" ? payload["name"] : null;

  if (!name) return;

  if (operation === "create") {
    await storage.createSkill({
      name,
      description: typeof payload["description"] === "string" ? payload["description"] : "",
      teamId: typeof payload["teamId"] === "string" ? payload["teamId"] : "",
      systemPromptOverride: typeof payload["systemPromptOverride"] === "string"
        ? payload["systemPromptOverride"]
        : "",
    });
    return;
  }

  if (operation === "update" && skillId) {
    await storage.updateSkill(skillId, {
      name,
      description: typeof payload["description"] === "string" ? payload["description"] : undefined,
      teamId: typeof payload["teamId"] === "string" ? payload["teamId"] : undefined,
      systemPromptOverride: typeof payload["systemPromptOverride"] === "string"
        ? payload["systemPromptOverride"]
        : undefined,
    });
  }
}

// ─── Standalone helper ───────────────────────────────────────────────────────

/**
 * Convenience helper for the storage layer.
 *
 * Creates a lightweight wrapper that holds a reference to a `ConfigSyncService`
 * instance and exposes the `enqueueConfigEvent` method with a simpler call
 * signature for use inside storage methods.
 *
 * Example:
 * ```ts
 * const enqueue = makeEnqueuer(configSyncService);
 * // inside storage.createPipeline():
 * await enqueue("pipeline", newPipeline.id, "create", { ...newPipeline });
 * ```
 */
export function makeEnqueuer(
  service: ConfigSyncService | null,
): (
  kind: string,
  entityId: string,
  operation: ConfigEventOperation,
  payload: Record<string, unknown>,
) => Promise<void> {
  return async (kind, entityId, operation, payload) => {
    if (!service) return;
    await service.enqueueConfigEvent(kind, entityId, operation, payload);
  };
}

// ─── In-memory store (for tests and MemStorage environments) ─────────────────

/**
 * In-memory implementation of `IConfigSyncStore`.
 *
 * Used in unit tests and MemStorage environments where a real Postgres pool is
 * unavailable.  Not suitable for production.
 */
export class InMemoryConfigSyncStore implements IConfigSyncStore {
  private outbox: Array<{
    id: string;
    entityKind: string;
    entityId: string;
    operation: ConfigEventOperation;
    payloadJsonb: Record<string, unknown>;
    createdAt: Date;
    sentAt: Date | null;
  }> = [];

  private received = new Set<string>();

  async insertConfigEvent(
    entityKind: string,
    entityId: string,
    operation: ConfigEventOperation,
    payload: Record<string, unknown>,
  ): Promise<string> {
    const id = crypto.randomUUID();
    this.outbox.push({
      id,
      entityKind,
      entityId,
      operation,
      payloadJsonb: payload,
      createdAt: new Date(),
      sentAt: null,
    });
    return id;
  }

  async getUnsentConfigEvents(limit: number) {
    return this.outbox
      .filter((r) => r.sentAt === null)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit)
      .map((r) => ({
        id: r.id,
        entityKind: r.entityKind,
        entityId: r.entityId,
        operation: r.operation,
        payloadJsonb: r.payloadJsonb,
        createdAt: r.createdAt,
      }));
  }

  async markConfigEventsSent(ids: string[]): Promise<void> {
    const idSet = new Set(ids);
    const now = new Date();
    for (const row of this.outbox) {
      if (idSet.has(row.id)) {
        row.sentAt = now;
      }
    }
  }

  async recordConfigEventReceived(
    peerId: string,
    entityKind: string,
    entityId: string,
    version: string,
  ): Promise<boolean> {
    const key = `${peerId}:${entityKind}:${entityId}:${version}`;
    if (this.received.has(key)) return false;
    this.received.add(key);
    return true;
  }

  /** Test helper — get all outbox rows. */
  getAllOutboxRows() {
    return [...this.outbox];
  }

  /** Test helper — clear all state. */
  reset(): void {
    this.outbox = [];
    this.received.clear();
  }
}

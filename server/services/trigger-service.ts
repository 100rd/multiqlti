/**
 * TriggerService — CRUD operations for pipeline triggers.
 *
 * Handles encryption/decryption of secrets, webhook URL synthesis,
 * and public-facing Trigger shape construction.
 */
import type { IStorage } from "../storage.js";
import type { TriggerRow } from "@shared/schema";
import type {
  PipelineTrigger,
  InsertTrigger,
  UpdateTrigger,
  TriggerType,
  TriggerConfig,
} from "@shared/types";
import { TriggerCrypto } from "./trigger-crypto.js";

export class TriggerService {
  private readonly crypto: TriggerCrypto;
  private readonly storage: IStorage;

  constructor(storage: IStorage) {
    this.storage = storage;
    this.crypto = new TriggerCrypto();
  }

  // ─── Public helpers ───────────────────────────────────────────────────────

  /**
   * Synthesize the webhook URL for webhook and github_event triggers.
   *
   * FIX: the default now reflects the ACTUAL server port (`PORT`, the dev server
   * runs on 5050) instead of the hardcoded 5000 — a bare `http://localhost:5000`
   * URL pointed at nothing. Note that even the correct localhost URL will NEVER
   * receive a GitHub webhook (GitHub's servers cannot reach a local/LAN address):
   * for delivery, `PUBLIC_URL` must be a publicly-reachable tunnel (cloudflared/
   * ngrok), OR use github polling (features.triggers.githubPolling). The UI shows
   * this guidance next to the copied URL.
   */
  webhookUrl(triggerId: string): string {
    const baseUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 5000}`;
    return `${baseUrl}/api/webhooks/${triggerId}`;
  }

  /** Map a DB row to the public-facing PipelineTrigger shape (no secrets). */
  toPublic(row: TriggerRow): PipelineTrigger {
    const trigger: PipelineTrigger = {
      id: row.id,
      pipelineId: row.pipelineId,
      type: row.type as TriggerType,
      config: row.config as TriggerConfig,
      hasSecret: row.secretEncrypted !== null && row.secretEncrypted !== undefined,
      enabled: row.enabled,
      lastTriggeredAt: row.lastTriggeredAt ?? null,
      suppressedCount: row.suppressedCount ?? 0,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };

    if (trigger.type === "webhook" || trigger.type === "github_event") {
      trigger.webhookUrl = this.webhookUrl(row.id);
    }

    return trigger;
  }

  // ─── CRUD ─────────────────────────────────────────────────────────────────

  async getTriggers(pipelineId: string): Promise<PipelineTrigger[]> {
    const rows = await this.storage.getTriggers(pipelineId);
    return rows.map((r) => this.toPublic(r));
  }

  /** T1: all triggers in the current project ALS (pipeline-based AND pipeline-less). */
  async getProjectTriggers(): Promise<PipelineTrigger[]> {
    const rows = await this.storage.getProjectTriggers();
    return rows.map((r) => this.toPublic(r));
  }

  async getTrigger(id: string): Promise<PipelineTrigger | null> {
    const row = await this.storage.getTrigger(id);
    return row ? this.toPublic(row) : null;
  }

  async createTrigger(data: InsertTrigger): Promise<PipelineTrigger> {
    const secretEncrypted = data.secret ? this.crypto.encrypt(data.secret) : undefined;
    const row = await this.storage.createTrigger({
      // T1: nullable — a loop-template trigger carries no pipeline.
      pipelineId: data.pipelineId ?? null,
      type: data.type,
      config: data.config,
      secretEncrypted: secretEncrypted ?? null,
      enabled: data.enabled ?? true,
    });
    return this.toPublic(row);
  }

  async updateTrigger(id: string, updates: UpdateTrigger): Promise<PipelineTrigger | null> {
    const existing = await this.storage.getTrigger(id);
    if (!existing) return null;

    let secretEncrypted: string | null | undefined = undefined;
    if (updates.secret === null) {
      // Explicitly remove secret
      secretEncrypted = null;
    } else if (updates.secret !== undefined) {
      secretEncrypted = this.crypto.encrypt(updates.secret);
    }

    const row = await this.storage.updateTrigger(id, {
      ...(updates.type !== undefined && { type: updates.type }),
      ...(updates.config !== undefined && { config: updates.config }),
      ...(secretEncrypted !== undefined && { secretEncrypted }),
      ...(updates.enabled !== undefined && { enabled: updates.enabled }),
    });
    return this.toPublic(row);
  }

  async deleteTrigger(id: string): Promise<boolean> {
    const existing = await this.storage.getTrigger(id);
    if (!existing) return false;
    await this.storage.deleteTrigger(id);
    return true;
  }

  async enableTrigger(id: string): Promise<PipelineTrigger | null> {
    return this.updateTrigger(id, { enabled: true });
  }

  async disableTrigger(id: string): Promise<PipelineTrigger | null> {
    return this.updateTrigger(id, { enabled: false });
  }

  /**
   * Retrieve the decrypted secret for a trigger (used internally by handlers).
   * Returns null if no secret is stored.
   */
  async getSecret(id: string): Promise<string | null> {
    const row = await this.storage.getTrigger(id);
    if (!row || !row.secretEncrypted) return null;
    return this.crypto.decrypt(row.secretEncrypted);
  }
}

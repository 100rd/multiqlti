/**
 * Lazy brief generation + lock + rate-limit (Security C1, M1).
 *
 * There is NO cron fan-out. A brief is generated lazily on the first GET of the
 * day for a (workspace,user,briefDate); the result is cached as the persisted
 * `morning_brief` + `news_item` rows and served on subsequent GETs.
 *
 *   - M1 (lock): generation is claimed via the UNIQUE(workspace,user,brief_date)
 *     row. `storage.createMorningBrief` returns `claimed` — only the winner
 *     generates; concurrent first-GETs that lose the claim poll for `ready`.
 *   - C1 (rate-limit): each (workspace,user,day) allows ONE auto-generation plus
 *     a small bounded number of manual refreshes/day. The count is persisted in
 *     `morning_brief.meta.genCount`, so the limit survives process restarts and
 *     cannot be bypassed by concurrent requests racing an in-memory counter.
 *
 * The generator is injected so the scheduler is unit/integration testable.
 */
import type { IStorage } from "../storage.js";
import type { MorningBriefRow } from "@shared/schema";
import type { GenerateBriefParams, GenerateBriefResult } from "./brief-generator.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

export const MAX_GENERATIONS_PER_DAY = 4; // 1 auto + 3 manual refreshes
const POLL_INTERVAL_MS = 100;
const POLL_TIMEOUT_MS = 30_000;

// ─── Typed error ─────────────────────────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}

// ─── Scheduler ─────────────────────────────────────────────────────────────────

export type GenerateFn = (params: GenerateBriefParams) => Promise<GenerateBriefResult>;

export interface BriefSchedulerOptions {
  /** Override the poll cadence (tests use a small value or 0). */
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
  /** Injectable sleep (tests). */
  sleep?: (ms: number) => Promise<void>;
}

export class BriefScheduler {
  private readonly pollIntervalMs: number;
  private readonly pollTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly storage: IStorage,
    private readonly generate: GenerateFn,
    opts: BriefSchedulerOptions = {},
  ) {
    this.pollIntervalMs = opts.pollIntervalMs ?? POLL_INTERVAL_MS;
    this.pollTimeoutMs = opts.pollTimeoutMs ?? POLL_TIMEOUT_MS;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  /**
   * Lazy path for GET: return the cached brief if present; otherwise the FIRST
   * caller generates (claims the lock) and the rest poll for `ready`.
   */
  async ensureBrief(params: GenerateBriefParams): Promise<MorningBriefRow> {
    const existing = await this.storage.getMorningBriefByDate(
      params.workspaceId,
      params.userId,
      params.briefDate,
    );
    if (existing && existing.status === "ready") return existing;
    if (existing && existing.status === "generating") return this.waitForReady(params, existing.id);

    const { brief, claimed } = await this.storage.createMorningBrief({
      workspaceId: params.workspaceId,
      userId: params.userId,
      briefDate: params.briefDate,
      status: "generating",
      meta: { genCount: 1, trigger: "auto" },
    });
    if (!claimed) {
      // Another request won the lock — poll for its result.
      return this.waitForReady(params, brief.id);
    }
    await this.generate(params);
    return (await this.storage.getMorningBrief(brief.id)) ?? brief;
  }

  /**
   * Manual refresh (POST /news/refresh): rate-limited per (workspace,user,day).
   * Returns the briefId. Throws RateLimitError when the daily cap is exceeded.
   */
  async triggerNow(params: GenerateBriefParams): Promise<string> {
    const existing = await this.storage.getMorningBriefByDate(
      params.workspaceId,
      params.userId,
      params.briefDate,
    );
    if (!existing) {
      const { brief } = await this.storage.createMorningBrief({
        workspaceId: params.workspaceId,
        userId: params.userId,
        briefDate: params.briefDate,
        status: "generating",
        meta: { genCount: 1, trigger: "manual" },
      });
      await this.generate(params);
      return brief.id;
    }

    const count = readGenCount(existing);
    if (count >= MAX_GENERATIONS_PER_DAY) {
      throw new RateLimitError("Daily brief generation limit reached");
    }
    await this.storage.updateMorningBriefStatus(existing.id, {
      status: "generating",
      meta: { ...existing.meta, genCount: count + 1, trigger: "manual" },
    });
    await this.generate(params);
    return existing.id;
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async waitForReady(params: GenerateBriefParams, briefId: string): Promise<MorningBriefRow> {
    const deadline = Date.now() + this.pollTimeoutMs;
    for (;;) {
      const current = await this.storage.getMorningBrief(briefId);
      if (current && current.status !== "generating") return current;
      if (Date.now() >= deadline) {
        // Stop waiting — return whatever we have (status still 'generating').
        return current ?? (await this.mustGet(briefId));
      }
      await this.sleep(this.pollIntervalMs);
    }
  }

  private async mustGet(briefId: string): Promise<MorningBriefRow> {
    const row = await this.storage.getMorningBrief(briefId);
    if (!row) throw new Error(`Brief vanished: ${briefId}`);
    return row;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function readGenCount(brief: MorningBriefRow): number {
  const raw = (brief.meta as Record<string, unknown> | null)?.genCount;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 1;
}

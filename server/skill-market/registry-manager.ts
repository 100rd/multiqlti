import type {
  SkillRegistryAdapter,
  RegistrySearchOptions,
  ExternalSkillSummary,
} from "./types.js";

/**
 * Manages multiple {@link SkillRegistryAdapter} instances and provides
 * unified search, health-check, and lifecycle operations across all
 * registered external registries.
 */
export class RegistryManager {
  private adapters = new Map<string, SkillRegistryAdapter>();

  // ─── Adapter lifecycle ──────────────────────────────────────────────────

  /** Register an adapter. Overwrites any existing adapter with the same id. */
  register(adapter: SkillRegistryAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  /** Remove an adapter by id. No-op if the id is unknown. */
  unregister(adapterId: string): void {
    this.adapters.delete(adapterId);
  }

  /** Retrieve an adapter by id, or undefined if not registered. */
  getAdapter(adapterId: string): SkillRegistryAdapter | undefined {
    return this.adapters.get(adapterId);
  }

  /** Return all registered adapters (enabled and disabled). */
  listAdapters(): SkillRegistryAdapter[] {
    return Array.from(this.adapters.values());
  }

  /** Return only enabled adapters. */
  listEnabled(): SkillRegistryAdapter[] {
    return this.listAdapters().filter((a) => a.enabled);
  }

  // ─── Aggregate operations ───────────────────────────────────────────────

  /**
   * Search all enabled adapters in parallel with a per-adapter timeout.
   *
   * Results are merged, sorted by descending popularity, and returned
   * alongside per-source diagnostics (count, latency, errors).
   *
   * @param query   - Free-text search query forwarded to each adapter.
   * @param options - Standard search options plus optional source filter
   *                  and per-adapter timeout (default 5 000 ms).
   */
  async searchAll(
    query: string,
    options?: RegistrySearchOptions & {
      sources?: string[];
      timeoutMs?: number;
    },
  ): Promise<{
    results: ExternalSkillSummary[];
    total: number;
    sources: Record<
      string,
      { count: number; latencyMs: number; error?: string }
    >;
  }> {
    const timeoutMs = options?.timeoutMs ?? 5000;

    const adapters = options?.sources
      ? this.listEnabled().filter((a) => options.sources!.includes(a.id))
      : this.listEnabled();

    const results: ExternalSkillSummary[] = [];
    const sources: Record<
      string,
      { count: number; latencyMs: number; error?: string }
    > = {};

    await Promise.allSettled(
      adapters.map(async (adapter) => {
        const start = Date.now();
        try {
          const result = await withTimeout(
            adapter.search(query, options),
            timeoutMs,
          );
          results.push(...result.items);
          sources[adapter.id] = {
            count: result.items.length,
            latencyMs: Date.now() - start,
          };
        } catch (err) {
          sources[adapter.id] = {
            count: 0,
            latencyMs: Date.now() - start,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );

    return {
      results: results.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)),
      total: results.length,
      sources,
    };
  }

  /**
   * Health-check every registered adapter in parallel.
   *
   * Returns a record keyed by adapter id with the health result.
   */
  async healthCheckAll(): Promise<
    Record<string, { ok: boolean; latencyMs: number; error?: string }>
  > {
    const results: Record<
      string,
      { ok: boolean; latencyMs: number; error?: string }
    > = {};

    await Promise.allSettled(
      this.listAdapters().map(async (adapter) => {
        results[adapter.id] = await adapter.healthCheck();
      }),
    );

    return results;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Race a promise against a timeout. Rejects with an Error if the
 * timeout fires first.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Adapter timeout")), ms);
    promise
      .then((v) => {
        clearTimeout(timer);
        resolve(v);
      })
      .catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
  });
}

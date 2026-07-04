/**
 * Mock Omniscience `search` MCP tool (memory-architecture ADR, Track A).
 *
 * A contract-faithful test double of the real Omniscience v0.2 `search` tool — no
 * live Omniscience needed. It:
 *   - enforces the tool name `search`,
 *   - validates params (required `query`; `retrieval_strategy` enum with the
 *     v0.1 downgrade of structural/keyword/auto → hybrid; optional ISO-8601
 *     `as_of`; optional limit/filters),
 *   - returns the real v0.2 `SearchResponse` envelope (`hits: SearchHit[]` plus
 *     sibling fields like query_stats/degraded_subsystems) as the JSON text
 *     payload an MCP tool call would yield.
 *
 * Exposes:
 *   - `makeMockOmniscienceCaller()` → an OmniscienceToolCaller for the provider,
 *   - `lastCall` capture so tests can assert what params were passed through.
 */
import { z } from "zod";
import type { OmniscienceToolCaller } from "../../server/memory/omniscience-provider";

// ─── Contract param validation (server side) ────────────────────────────────────

const REQUESTED_STRATEGIES = ["hybrid", "structural", "keyword", "auto"] as const;
/** v0.1 only truly implements hybrid; everything else downgrades to it. */
const EFFECTIVE_STRATEGIES = ["hybrid"] as const;

type RequestedStrategy = (typeof REQUESTED_STRATEGIES)[number];
type EffectiveStrategy = (typeof EFFECTIVE_STRATEGIES)[number];

const searchParamsSchema = z.object({
  query: z.string().min(1),
  retrieval_strategy: z.enum(REQUESTED_STRATEGIES).default("hybrid"),
  as_of: z.string().datetime().optional(),
  limit: z.number().int().positive().optional(),
  filters: z.object({ source_types: z.array(z.string()).optional() }).optional(),
});

export type MockSearchParams = z.infer<typeof searchParamsSchema>;

/**
 * Downgrade any requested strategy to the v0.1 effective strategy (hybrid).
 * The requested value is intentionally ignored — that IS the contract behavior.
 */
export function downgradeStrategy(_requested: RequestedStrategy): EffectiveStrategy {
  return "hybrid";
}

// ─── Result shaping (real Omniscience v0.2 SearchHit shape) ─────────────────────

/**
 * A test double of the real `SearchHit`: nested `source` (id/name/type), a SINGLE
 * `citation` object (not an array), plus optional scoring/provenance extras.
 */
export interface MockHit {
  chunk_id: string;
  document_id?: string;
  score: number;
  text: string;
  source?: { id: string; name?: string; type: string };
  citation?: { uri: string; title?: string | null; indexed_at?: string; doc_version?: number } | null;
  metadata?: Record<string, unknown>;
  confidence?: number | null;
  score_type?: string | null;
  impact?: number | null;
  source_instance?: string | null;
  lineage?: unknown;
}

/** Default citation-bearing fixture hits, in the real v0.2 SearchHit shape. */
export function defaultMockHits(): MockHit[] {
  return [
    {
      chunk_id: "c1",
      document_id: "d1",
      score: 0.92,
      text: "The retry policy uses exponential backoff with a 1s base.",
      source: { id: "src-retry", name: "retry.ts", type: "git" },
      citation: {
        uri: "git://repo/server/retry.ts#L10",
        title: "retry.ts",
        indexed_at: "2026-06-01T00:00:00.000Z",
        doc_version: 3,
      },
      confidence: 0.88,
      score_type: "calibrated",
      metadata: { commit: "abc123" },
    },
    {
      chunk_id: "c2",
      document_id: "d2",
      score: 0.81,
      text: "Incident #42: backoff misconfiguration caused a thundering herd.",
      source: { id: "inc-42", name: "Incident 42", type: "jira" },
      citation: { uri: "jira://INC-42", title: "Incident 42 postmortem", indexed_at: "2026-06-02T00:00:00.000Z", doc_version: 1 },
    },
  ];
}

// ─── Captured call ───────────────────────────────────────────────────────────────

export interface CapturedCall {
  toolName: string;
  params: MockSearchParams;
  /** The effective strategy after v0.1 downgrade. */
  effectiveStrategy: EffectiveStrategy;
}

export interface MockOmniscienceOptions {
  /** Hits to return; defaults to defaultMockHits(). */
  hits?: MockHit[];
  /** When set, the caller rejects with this error (to test fallback). */
  failWith?: Error;
  /** When true, return malformed (non-contract) JSON to test boundary validation. */
  returnMalformed?: boolean;
}

/**
 * Build an OmniscienceToolCaller backed by the mock. The returned object also
 * carries `lastCall` for assertions.
 */
export function makeMockOmniscienceCaller(
  options: MockOmniscienceOptions = {},
): OmniscienceToolCaller & { lastCall: CapturedCall | null } {
  const state: { lastCall: CapturedCall | null } = { lastCall: null };

  const caller = (async (toolName: string, args: Record<string, unknown>) => {
    if (options.failWith) throw options.failWith;

    if (toolName !== "search") {
      throw new Error(`Mock Omniscience only implements "search", got "${toolName}"`);
    }

    const parsed = searchParamsSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `Mock Omniscience param validation failed: ${parsed.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; ")}`,
      );
    }

    const effectiveStrategy = downgradeStrategy(parsed.data.retrieval_strategy);
    state.lastCall = { toolName, params: parsed.data, effectiveStrategy };

    if (options.returnMalformed) {
      // No top-level `hits` → fails boundary validation, as a real malformed
      // payload would.
      return JSON.stringify({ results: "not the contract shape" });
    }

    const hits = options.hits ?? defaultMockHits();
    const limited =
      parsed.data.limit !== undefined ? hits.slice(0, parsed.data.limit) : hits;
    // Full v0.2 SearchResponse envelope: hits + sibling fields the provider must
    // tolerate and ignore.
    return JSON.stringify({
      hits: limited,
      query_stats: {
        total_matches_before_filters: hits.length,
        vector_matches: hits.length,
        text_matches: 0,
        duration_ms: 3,
      },
      effective_as_of: null,
      meta: null,
      min_applied_version: null,
      degraded_subsystems: [],
      staleness_seconds: null,
      pinned_watermark: null,
      snapshot_id: null,
      next_cursor: null,
    });
  }) as OmniscienceToolCaller & { lastCall: CapturedCall | null };

  Object.defineProperty(caller, "lastCall", {
    get: () => state.lastCall,
    enumerable: true,
  });

  return caller;
}

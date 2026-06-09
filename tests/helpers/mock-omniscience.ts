/**
 * Mock Omniscience `search` MCP tool (memory-architecture ADR, Track A).
 *
 * A contract-faithful test double of Omniscience ADR 0004's `search` tool — no
 * live Omniscience needed. It:
 *   - enforces the tool name `search`,
 *   - validates params (required `query`; `retrieval_strategy` enum with the
 *     v0.1 downgrade of structural/keyword/auto → hybrid; optional ISO-8601
 *     `as_of`; optional limit/filters),
 *   - returns citation-bearing chunk results as the JSON text payload an MCP
 *     tool call would yield.
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

// ─── Result shaping ─────────────────────────────────────────────────────────────

export interface MockChunk {
  id: string;
  text: string;
  score: number;
  source_id?: string;
  source_type?: string;
  citations?: Array<{ source_id: string; uri?: string; title?: string }>;
  metadata?: Record<string, unknown>;
}

/** Default citation-bearing fixture chunks. */
export function defaultMockChunks(): MockChunk[] {
  return [
    {
      id: "c1",
      text: "The retry policy uses exponential backoff with a 1s base.",
      score: 0.92,
      source_id: "src-retry",
      source_type: "code",
      citations: [
        { source_id: "src-retry", uri: "git://repo/server/retry.ts#L10", title: "retry.ts" },
      ],
      metadata: { commit: "abc123" },
    },
    {
      id: "c2",
      text: "Incident #42: backoff misconfiguration caused a thundering herd.",
      score: 0.81,
      source_id: "inc-42",
      source_type: "incident",
      citations: [{ source_id: "inc-42", title: "Incident 42 postmortem" }],
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
  /** Chunks to return; defaults to defaultMockChunks(). */
  chunks?: MockChunk[];
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
      return JSON.stringify({ results: "not the contract shape" });
    }

    const chunks = options.chunks ?? defaultMockChunks();
    const limited =
      parsed.data.limit !== undefined ? chunks.slice(0, parsed.data.limit) : chunks;
    return JSON.stringify({ chunks: limited });
  }) as OmniscienceToolCaller & { lastCall: CapturedCall | null };

  Object.defineProperty(caller, "lastCall", {
    get: () => state.lastCall,
    enumerable: true,
  });

  return caller;
}

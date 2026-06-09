/**
 * Production wiring for the Morning News Board routes.
 *
 * Bridges the route/generator layer's injected interfaces to the real
 * collaborators, mirroring `knowledge/practice-card-deps.ts`. Tests bypass this
 * and inject mocks instead.
 *
 *   - boardProvider: built ONLY when backend === "omniscience" AND
 *     omniscience.board.enabled === true (Security H3 explicit opt-in) AND a
 *     token resolves; otherwise null → the generator degrades
 *     (internalDegraded=true), never crashes (backend=local default).
 *   - searchInternal: the existing Omniscience `search` path (OmniscienceProvider)
 *     for narrative internal items; empty when Omniscience is disabled.
 *   - fetchExternal: news-fetcher over the curated news-sources via the real,
 *     SSRF-hardened safeFetch.
 *   - summarize: the gateway (Gateway.complete); the M4 untrusted-data framing is
 *     already applied by the generator before the prompt reaches here.
 *
 * The Omniscience token is read from env by the connection layer at connect
 * time and is NEVER persisted or returned here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { AppConfig } from "../config/schema.js";
import {
  resolveOmniscienceToken,
  buildOmniscienceTransport,
  makeToolCaller,
} from "../memory/omniscience-connection.js";
import { OmniscienceProvider } from "../memory/omniscience-provider.js";
import { OmniscienceBoardProvider } from "../memory/omniscience-board-provider.js";
import { safeFetch, type SafeFetchResponse } from "../knowledge/safe-fetch.js";
import { fetchSources, type FetchedNewsItem } from "./news-fetcher.js";
import { allowedNewsSources } from "./news-sources.js";
import type {
  GenerateBriefDeps,
  InternalCandidate,
  SummarizeInput,
  SummarizeResult,
} from "./brief-generator.js";
import type { Gateway } from "../gateway/index.js";
import type { IStorage } from "../storage.js";

const CLIENT_NAME = "multiqlti-omniscience-board-client";
const CLIENT_VERSION = "1.0.0";
const SUMMARY_MODEL_SLUG = "mock"; // resolved by the gateway; falls back to mock provider
const SUMMARY_MAX_TOKENS = 280;
const INTERNAL_TOP_K = 8;
/** Placeholder — the Omniscience path derives workspace from the token, ignores this. */
const OMNI_WS_PLACEHOLDER = "omniscience";

// ─── Live deps bundle ─────────────────────────────────────────────────────────

export interface NewsLiveDeps {
  deps: Omit<GenerateBriefDeps, "storage">;
  /** Disposer for any MCP client opened here; call on shutdown. */
  close: () => Promise<void>;
}

/**
 * Build the live generator collaborators. The board provider + internal search
 * are wired only when Omniscience is selected AND a token is present; any
 * connect failure degrades to a null board provider (no throw).
 */
export async function buildNewsLiveDeps(config: AppConfig, gateway: Gateway): Promise<NewsLiveDeps> {
  const summarize = makeGatewaySummarizer(gateway);
  const fetchExternal = makeExternalFetcher();

  const omni = await tryConnectOmniscience(config);
  if (!omni) {
    return {
      deps: { boardProvider: null, searchInternal: async () => [], fetchExternal, summarize },
      close: async () => {},
    };
  }

  return {
    deps: {
      boardProvider: omni.boardProvider,
      searchInternal: omni.searchInternal,
      fetchExternal,
      summarize,
    },
    close: omni.close,
  };
}

// ─── Omniscience connection (board + search), env-only token ─────────────────

interface OmniBundle {
  boardProvider: OmniscienceBoardProvider;
  searchInternal: (asOf: string) => Promise<InternalCandidate[]>;
  close: () => Promise<void>;
}

async function tryConnectOmniscience(config: AppConfig): Promise<OmniBundle | null> {
  if (config.memory.retrieval.backend !== "omniscience") return null;
  const cfg = config.memory.retrieval.omniscience;
  // Security H3: the board internal feed is an EXPLICIT opt-in, separate from
  // selecting the Omniscience RAG backend. Without board.enabled the board
  // provider stays null and the internal feed degrades gracefully.
  if (!cfg.board.enabled) return null;
  try {
    const token = resolveOmniscienceToken(cfg); // reads env; throws if absent
    const transport = buildOmniscienceTransport(cfg, token);
    const client = new Client({ name: CLIENT_NAME, version: CLIENT_VERSION }, { capabilities: {} });
    await client.connect(transport);

    const callTool = makeToolCaller(client);
    const boardProvider = new OmniscienceBoardProvider(callTool);
    const searchProvider = new OmniscienceProvider(callTool, {
      retrievalStrategy: cfg.retrievalStrategy,
    });

    return {
      boardProvider,
      searchInternal: makeInternalSearch(searchProvider),
      close: async () => {
        await client.close();
      },
    };
  } catch {
    // Connect/token failure → degrade to no board provider (generator sets
    // internalDegraded). We deliberately do not surface the error or the token.
    return null;
  }
}

/** Map Omniscience `search` chunks into narrative internal candidates. */
function makeInternalSearch(
  provider: OmniscienceProvider,
): (asOf: string) => Promise<InternalCandidate[]> {
  return async (asOf: string) => {
    const result = await provider.retrieveContext({
      query: "platform changes deploys incidents in the last 24h",
      workspaceId: OMNI_WS_PLACEHOLDER,
      topK: INTERNAL_TOP_K,
      asOf,
    });
    return result.chunks.map((chunk) => ({
      title: deriveTitle(chunk.chunkText),
      summary: chunk.chunkText,
      seedEntityId: chunk.sourceId,
      sourceName: "omniscience",
    }));
  };
}

function deriveTitle(text: string): string {
  const firstLine = text.split("\n")[0]?.trim() ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}...` : firstLine || "Internal update";
}

// ─── External fetcher over the real safeFetch ────────────────────────────────

function makeExternalFetcher(): () => Promise<FetchedNewsItem[]> {
  return () =>
    fetchSources(allowedNewsSources(), {
      safeFetch: (url: string): Promise<SafeFetchResponse> => safeFetch(url),
    });
}

// ─── Gateway summarizer (M4 framing comes from the generator) ────────────────

function makeGatewaySummarizer(
  gateway: Gateway,
): (input: SummarizeInput) => Promise<SummarizeResult> {
  return async (input: SummarizeInput) => {
    const response = await gateway.complete({
      modelSlug: SUMMARY_MODEL_SLUG,
      messages: [{ role: "user", content: input.prompt }],
      maxTokens: SUMMARY_MAX_TOKENS,
    });
    return parseSummary(response.content, input.title);
  };
}

/**
 * Parse the model output into {summary, whyRelevant}. The model is asked for a
 * short factual summary + why it matters. We accept a JSON object if present,
 * else fall back to using the whole content as the summary (never throws).
 */
export function parseSummary(content: string, fallbackTitle: string): SummarizeResult {
  const trimmed = (content ?? "").trim();
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const summary = typeof obj.summary === "string" ? obj.summary : trimmed;
      const whyRelevant = typeof obj.whyRelevant === "string" ? obj.whyRelevant : "";
      return { summary: summary || fallbackTitle, whyRelevant };
    }
  } catch {
    // not JSON — fall through
  }
  return { summary: trimmed || fallbackTitle, whyRelevant: "" };
}

// ─── Convenience: full generator deps with storage bound ─────────────────────

export function bindGeneratorDeps(
  storage: IStorage,
  live: Omit<GenerateBriefDeps, "storage">,
): GenerateBriefDeps {
  return { storage, ...live };
}

/**
 * Mock Omniscience board tools (`blast_radius`, `incident_timeline`,
 * `source_stats`) — a contract-faithful test double mirroring
 * `mock-omniscience.ts`, built straight from the on-disk Omniscience contract
 * (blast_radius.py / incident_timeline.py / mcp/tools.py source_stats).
 *
 * It:
 *   - dispatches on the tool name (rejects unknown tools),
 *   - validates params per the contract (action_type enum, max_depth [1,5],
 *     alert_id `alert://{provider}/{id}`, tz-aware UTC `as_of`),
 *   - propagates Omniscience `code:message` error envelopes
 *     (forbidden / entity_not_found / invalid_alert_id / invalid_timezone /
 *     source_not_found) as thrown errors,
 *   - returns the contract JSON text payload an MCP tool call would yield,
 *   - supports `returnMalformed`, `failWith`, and `unscopedToken` (→ forbidden
 *     for the workspace-scoped graph tools).
 */
import type { OmniscienceToolCaller } from "../../server/memory/omniscience-provider";

// ─── Contract fixtures ────────────────────────────────────────────────────────

export interface MockImpact {
  entity_id: string;
  entity_type: string;
  dependency_path?: Array<{ from_entity: string; to_entity: string; edge_type: string }>;
  impact_score: number;
  confidence: number;
}

export interface MockTimelineEvent {
  ts: string;
  entity_id: string;
  entity_type: string;
  change_kind: "created" | "ended";
  before_state_summary?: string | null;
  after_state_summary?: string | null;
  source: string;
}

export function defaultMockImpacted(): MockImpact[] {
  return [
    {
      entity_id: "payments-api",
      entity_type: "service",
      dependency_path: [{ from_entity: "db-primary", to_entity: "payments-api", edge_type: "DEPENDS_ON" }],
      impact_score: 0.8,
      confidence: 1,
    },
    {
      entity_id: "checkout-pod-7",
      entity_type: "pod",
      dependency_path: [],
      impact_score: 0.48,
      confidence: 0.5,
    },
  ];
}

export function defaultMockEvents(): MockTimelineEvent[] {
  return [
    {
      ts: "2026-06-08T05:00:00Z",
      entity_id: "payments-api",
      entity_type: "service",
      change_kind: "created",
      after_state_summary: "deployed v2.3.1",
      source: "argocd",
    },
  ];
}

const ACTION_TYPES = ["restart", "delete", "scale_down", "cordon"] as const;
const ALERT_ID_RE = /^alert:\/\/[^/]+\/.+$/;

/** UTC tz-aware ISO-8601 ('Z' or +00:00). Mirrors ADR-0008 §5 invalid_timezone. */
function isUtcIso(value: string): boolean {
  if (!/(?:Z|\+00:00)$/.test(value)) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}

// ─── Options + captured calls ─────────────────────────────────────────────────

export interface MockBoardOptions {
  impacted?: MockImpact[];
  events?: MockTimelineEvent[];
  /** Force a thrown error on every call (e.g. transport down). */
  failWith?: Error;
  /** Return non-contract JSON to exercise zod boundary rejection. */
  returnMalformed?: boolean;
  /**
   * Return more array rows than the provider's `.max()` cap, to exercise the
   * bound. The provider caps impacted/events at this many — set higher to trip.
   */
  oversize?: number;
  /** Simulate a non-workspace-scoped token → forbidden on graph tools. */
  unscopedToken?: boolean;
}

export interface CapturedBoardCall {
  toolName: string;
  args: Record<string, unknown>;
}

export interface MockBoardCaller {
  caller: OmniscienceToolCaller;
  lastCall: () => CapturedBoardCall | null;
}

const GRAPH_TOOLS = new Set(["blast_radius", "incident_timeline"]);

export function makeMockBoardCaller(options: MockBoardOptions = {}): MockBoardCaller {
  let lastCall: CapturedBoardCall | null = null;

  const caller: OmniscienceToolCaller = async (toolName, args) => {
    if (options.failWith) throw options.failWith;
    lastCall = { toolName, args };

    if (options.unscopedToken && GRAPH_TOOLS.has(toolName)) {
      throw new Error("forbidden:Graph retrieval requires a workspace-scoped token");
    }

    switch (toolName) {
      case "blast_radius":
        return handleBlastRadius(args, options);
      case "incident_timeline":
        return handleIncidentTimeline(args, options);
      case "source_stats":
        return handleSourceStats(args, options);
      default:
        throw new Error(`Mock Omniscience board does not implement "${toolName}"`);
    }
  };

  return { caller, lastCall: () => lastCall };
}

// ─── Per-tool handlers ────────────────────────────────────────────────────────

function handleBlastRadius(args: Record<string, unknown>, options: MockBoardOptions): string {
  const entityId = args.entity_id;
  if (typeof entityId !== "string" || !entityId.trim()) {
    throw new Error("invalid_entity_id:entity_id must be a non-empty string");
  }
  if (entityId === "__missing__") {
    throw new Error(`entity_not_found:${entityId}`);
  }
  const actionType = (args.action_type ?? "restart") as string;
  if (!ACTION_TYPES.includes(actionType as (typeof ACTION_TYPES)[number])) {
    throw new Error(`invalid_action_type:action_type must be one of: ${ACTION_TYPES.join(", ")}`);
  }
  const maxDepth = (args.max_depth ?? 3) as number;
  assertDepth(maxDepth);
  assertAsOf(args.as_of);

  if (options.returnMalformed) {
    return JSON.stringify({ impacted: [{ entity_id: "x", unexpected_field: true }] });
  }
  const impacted = sized(options.impacted ?? defaultMockImpacted(), options.oversize);
  return JSON.stringify({
    seed_entity_id: entityId,
    action_type: actionType,
    max_depth: maxDepth,
    impacted,
    effective_as_of: "2026-06-09T05:00:00Z",
    meta: null,
  });
}

function handleIncidentTimeline(args: Record<string, unknown>, options: MockBoardOptions): string {
  const alertId = args.alert_id;
  if (typeof alertId !== "string" || !ALERT_ID_RE.test(alertId)) {
    throw new Error("invalid_alert_id:alert_id must be alert://{provider}/{id}");
  }
  if (alertId === "alert://pd/__missing__") {
    throw new Error(`alert_not_found:${alertId}`);
  }
  const maxDepth = (args.max_depth ?? 2) as number;
  assertDepth(maxDepth);
  assertAsOf(args.as_of);

  if (options.returnMalformed) {
    return JSON.stringify({ events: [{ ts: 123, bad: true }] });
  }
  const events = sized(options.events ?? defaultMockEvents(), options.oversize);
  return JSON.stringify({
    alert_id: alertId,
    events,
    effective_as_of: "2026-06-09T05:00:00Z",
    window_from: null,
    window_to: null,
    entity_types_filter: null,
    truncated: false,
  });
}

function handleSourceStats(args: Record<string, unknown>, options: MockBoardOptions): string {
  const sourceId = args.source_id;
  if (typeof sourceId !== "string" || !sourceId.trim()) {
    throw new Error("source_not_found:");
  }
  if (sourceId === "__missing__") {
    throw new Error(`source_not_found:${sourceId}`);
  }
  if (options.returnMalformed) {
    return JSON.stringify({ id: 99, name: 7 });
  }
  return JSON.stringify({
    id: sourceId,
    name: "argocd",
    type: "gitops",
    status: "active",
    last_sync_at: "2026-06-09T04:00:00Z",
    last_error: null,
    last_error_at: null,
    freshness_sla_seconds: 86400,
    is_stale: false,
    age_seconds: 3600,
    staleness_margin_seconds: -82800,
    indexed_document_count: 120,
    indexed_chunk_count: 980,
    last_ingestion_run: {
      id: "run-1",
      started_at: "2026-06-09T04:00:00Z",
      finished_at: "2026-06-09T04:01:00Z",
      status: "completed",
      docs_new: 3,
      docs_updated: 1,
      docs_removed: 0,
      errors: null,
    },
  });
}

// ─── Shared guards ──────────────────────────────────────────────────────────

function assertDepth(maxDepth: unknown): void {
  if (typeof maxDepth !== "number" || maxDepth < 1 || maxDepth > 5) {
    throw new Error("invalid_max_depth:max_depth must be in [1,5]");
  }
}

function assertAsOf(asOf: unknown): void {
  if (asOf === undefined || asOf === null) return;
  if (typeof asOf !== "string" || !isUtcIso(asOf)) {
    throw new Error("invalid_timezone:as_of must be tz-aware UTC ISO-8601");
  }
}

function sized<T>(rows: T[], oversize: number | undefined): T[] {
  if (oversize === undefined) return rows;
  const out: T[] = [];
  for (let i = 0; i < oversize; i += 1) out.push(rows[i % rows.length]);
  return out;
}

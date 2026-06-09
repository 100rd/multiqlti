/**
 * OmniscienceBoardProvider — board-specific MCP client extension.
 *
 * A SIBLING to `omniscience-provider.ts` (which wraps only `search`). This
 * provider wraps the three board graph/health tools — `blast_radius`,
 * `incident_timeline`, `source_stats` — reusing the SAME tool-caller seam
 * (`OmniscienceToolCaller`) the connection layer already owns. It does NOT touch
 * the connection or the existing provider, and never reads or persists the token
 * (the token stays env-only, resolved in `omniscience-connection.ts`).
 *
 * Security:
 *   - H2: every response is parsed with a `.strict()` zod schema AND `.max()`
 *     bounds on arrays (`impacted[]`, `events[]`) — capped to avoid unbounded
 *     LLM/memory pressure. A malformed/foreign/oversize payload throws.
 *   - Inputs are validated BEFORE the call (max_depth [1,5], action_type enum,
 *     alert_id `alert://{provider}/{id}`, `as_of` tz-aware UTC ending Z/+00:00).
 *   - Omniscience `code:message` error envelopes (forbidden / entity_not_found /
 *     invalid_alert_id / invalid_timezone / source_not_found) propagate
 *     unswallowed.
 *   - C2: `toAffects` exposes `blast_radius.impacted` as the structured affects[]
 *     source — the ONLY origin of affects data, never LLM-derived.
 */
import { z } from "zod";
import type { BlastAffect } from "@shared/schema";
import type { OmniscienceToolCaller } from "./omniscience-provider.js";

// ─── Bounds (Security H2) ──────────────────────────────────────────────────────

export const MAX_IMPACTED = 100 as const;
export const MAX_EVENTS = 500 as const;
export const MIN_MAX_DEPTH = 1 as const;
export const MAX_MAX_DEPTH = 5 as const;
const DEFAULT_BLAST_DEPTH = 3 as const;
const DEFAULT_TIMELINE_DEPTH = 2 as const;

export const ACTION_TYPES = ["restart", "delete", "scale_down", "cordon"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

const ALERT_ID_RE = /^alert:\/\/[^/]+\/.+$/;
const UTC_SUFFIX_RE = /(?:Z|\+00:00)$/;

// ─── Typed error ─────────────────────────────────────────────────────────────

/** Thrown for invalid inputs or boundary-validation failures. No secrets. */
export class BoardProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BoardProviderError";
  }
}

// ─── Boundary schemas (mirror the on-disk contract EXACTLY) ──────────────────

const dependencyPathStep = z
  .object({ from_entity: z.string(), to_entity: z.string(), edge_type: z.string() })
  .strict();

const blastImpact = z
  .object({
    entity_id: z.string(),
    entity_type: z.string(),
    dependency_path: z.array(dependencyPathStep).max(MAX_EVENTS).default([]),
    impact_score: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const blastRadiusResponse = z
  .object({
    seed_entity_id: z.string(),
    action_type: z.enum(ACTION_TYPES),
    max_depth: z.number().int().min(MIN_MAX_DEPTH).max(MAX_MAX_DEPTH),
    impacted: z.array(blastImpact).max(MAX_IMPACTED).default([]),
    effective_as_of: z.string(),
    meta: z.record(z.unknown()).nullable().optional(),
  })
  .strict();

const timelineEvent = z
  .object({
    ts: z.string(),
    entity_id: z.string(),
    entity_type: z.string(),
    change_kind: z.enum(["created", "ended"]),
    before_state_summary: z.string().nullable().optional(),
    after_state_summary: z.string().nullable().optional(),
    source: z.string(),
  })
  .strict();

const incidentTimelineResponse = z
  .object({
    alert_id: z.string(),
    events: z.array(timelineEvent).max(MAX_EVENTS).default([]),
    effective_as_of: z.string(),
    window_from: z.string().nullable().optional(),
    window_to: z.string().nullable().optional(),
    entity_types_filter: z.array(z.string()).nullable().optional(),
    truncated: z.boolean().default(false),
  })
  .strict();

const ingestionRun = z
  .object({
    id: z.string(),
    started_at: z.string(),
    finished_at: z.string().nullable(),
    status: z.string(),
    docs_new: z.number(),
    docs_updated: z.number(),
    docs_removed: z.number(),
    errors: z.unknown().nullable(),
  })
  .strict();

const sourceStatsResponse = z
  .object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    status: z.string(),
    last_sync_at: z.string().nullable(),
    last_error: z.string().nullable(),
    last_error_at: z.string().nullable(),
    freshness_sla_seconds: z.number().nullable(),
    is_stale: z.boolean(),
    age_seconds: z.number(),
    staleness_margin_seconds: z.number().nullable(),
    indexed_document_count: z.number(),
    indexed_chunk_count: z.number(),
    last_ingestion_run: ingestionRun.nullable(),
  })
  .strict();

// ─── Public mapped types ──────────────────────────────────────────────────────

export interface BlastRadius {
  seedEntityId: string;
  actionType: ActionType;
  maxDepth: number;
  impacted: Array<{
    entityId: string;
    entityType: string;
    impactScore: number;
    confidence: number;
    path: Array<{ fromEntity: string; toEntity: string; edgeType: string }>;
  }>;
}

export interface IncidentTimeline {
  alertId: string;
  truncated: boolean;
  events: Array<{
    ts: string;
    entityId: string;
    entityType: string;
    changeKind: "created" | "ended";
    beforeStateSummary: string | null;
    afterStateSummary: string | null;
    source: string;
  }>;
}

export interface SourceStats {
  id: string;
  name: string;
  type: string;
  status: string;
  lastSyncAt: string | null;
  isStale: boolean;
  ageSeconds: number;
  indexedDocumentCount: number;
  indexedChunkCount: number;
}

export interface BlastRadiusParams {
  entityId: string;
  actionType?: ActionType;
  maxDepth?: number;
  asOf?: string;
}

export interface IncidentTimelineParams {
  alertId: string;
  fromTs?: string;
  toTs?: string;
  entityTypes?: string[];
  asOf?: string;
  maxDepth?: number;
}

// ─── Provider ────────────────────────────────────────────────────────────────

export class OmniscienceBoardProvider {
  constructor(private readonly callTool: OmniscienceToolCaller) {}

  async blastRadius(params: BlastRadiusParams): Promise<BlastRadius> {
    const entityId = requireNonEmpty(params.entityId, "entity_id");
    const actionType = params.actionType ?? "restart";
    if (!ACTION_TYPES.includes(actionType)) {
      throw new BoardProviderError(`invalid action_type: ${actionType}`);
    }
    const maxDepth = validateDepth(params.maxDepth, DEFAULT_BLAST_DEPTH);
    const asOf = validateAsOf(params.asOf);

    const args: Record<string, unknown> = {
      entity_id: entityId,
      action_type: actionType,
      max_depth: maxDepth,
      ...(asOf ? { as_of: asOf } : {}),
    };
    const parsed = parse(blastRadiusResponse, await this.callTool("blast_radius", args), "blast_radius");
    return {
      seedEntityId: parsed.seed_entity_id,
      actionType: parsed.action_type,
      maxDepth: parsed.max_depth,
      impacted: parsed.impacted.map((i) => ({
        entityId: i.entity_id,
        entityType: i.entity_type,
        impactScore: i.impact_score,
        confidence: i.confidence,
        path: i.dependency_path.map((p) => ({
          fromEntity: p.from_entity,
          toEntity: p.to_entity,
          edgeType: p.edge_type,
        })),
      })),
    };
  }

  async incidentTimeline(params: IncidentTimelineParams): Promise<IncidentTimeline> {
    if (typeof params.alertId !== "string" || !ALERT_ID_RE.test(params.alertId)) {
      throw new BoardProviderError("invalid alert_id: must be alert://{provider}/{id}");
    }
    const maxDepth = validateDepth(params.maxDepth, DEFAULT_TIMELINE_DEPTH);
    const asOf = validateAsOf(params.asOf);

    const args: Record<string, unknown> = {
      alert_id: params.alertId,
      max_depth: maxDepth,
      ...(params.fromTs ? { from_ts: params.fromTs } : {}),
      ...(params.toTs ? { to_ts: params.toTs } : {}),
      ...(params.entityTypes ? { entity_types: params.entityTypes } : {}),
      ...(asOf ? { as_of: asOf } : {}),
    };
    const parsed = parse(
      incidentTimelineResponse,
      await this.callTool("incident_timeline", args),
      "incident_timeline",
    );
    return {
      alertId: parsed.alert_id,
      truncated: parsed.truncated,
      events: parsed.events.map((e) => ({
        ts: e.ts,
        entityId: e.entity_id,
        entityType: e.entity_type,
        changeKind: e.change_kind,
        beforeStateSummary: e.before_state_summary ?? null,
        afterStateSummary: e.after_state_summary ?? null,
        source: e.source,
      })),
    };
  }

  async sourceStats(sourceId: string): Promise<SourceStats> {
    const id = requireNonEmpty(sourceId, "source_id");
    const parsed = parse(
      sourceStatsResponse,
      await this.callTool("source_stats", { source_id: id }),
      "source_stats",
    );
    return {
      id: parsed.id,
      name: parsed.name,
      type: parsed.type,
      status: parsed.status,
      lastSyncAt: parsed.last_sync_at,
      isStale: parsed.is_stale,
      ageSeconds: parsed.age_seconds,
      indexedDocumentCount: parsed.indexed_document_count,
      indexedChunkCount: parsed.indexed_chunk_count,
    };
  }

  /**
   * C2: the ONLY origin of `affects[]`. Maps structural blast_radius.impacted
   * into the persisted BlastAffect shape. Never derived from any LLM output.
   */
  toAffects(blast: BlastRadius): BlastAffect[] {
    return blast.impacted.map((i) => ({
      entityId: i.entityId,
      entityType: i.entityType,
      impactScore: i.impactScore,
      confidence: i.confidence,
      path: i.path,
    }));
  }
}

// ─── Validation helpers (run BEFORE the call) ────────────────────────────────

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new BoardProviderError(`${field} must be a non-empty string`);
  }
  return value;
}

function validateDepth(maxDepth: number | undefined, fallback: number): number {
  const depth = maxDepth ?? fallback;
  if (!Number.isInteger(depth) || depth < MIN_MAX_DEPTH || depth > MAX_MAX_DEPTH) {
    throw new BoardProviderError(`max_depth must be an integer in [${MIN_MAX_DEPTH},${MAX_MAX_DEPTH}]`);
  }
  return depth;
}

function validateAsOf(asOf: string | undefined): string | undefined {
  if (asOf === undefined) return undefined;
  if (typeof asOf !== "string" || !UTC_SUFFIX_RE.test(asOf) || !Number.isFinite(Date.parse(asOf))) {
    throw new BoardProviderError("as_of must be a tz-aware UTC ISO-8601 datetime (ending 'Z' or '+00:00')");
  }
  return asOf;
}

// ─── Boundary parse (Security H2) ────────────────────────────────────────────

function parse<S extends z.ZodTypeAny>(schema: S, raw: string, tool: string): z.output<S> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new BoardProviderError(`Omniscience ${tool} returned non-JSON payload`);
  }
  const result = schema.safeParse(json);
  if (!result.success) {
    throw new BoardProviderError(
      `Omniscience ${tool} response failed validation: ${result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  return result.data;
}

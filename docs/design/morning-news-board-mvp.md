# Morning News Board — Stage 1 (MVP) Design

**Status**: Proposed (design phase only — no implementation)
**Author**: solution-architect
**Date**: 2026-06-09
**Scope**: A personalized daily brief for a DevOps/SRE/Platform engineer, opened in the morning inside multiqlti. Two feeds (internal + external), profile-based personalization, and an "affects YOUR platform" cross-link powered by Omniscience `blast_radius`.

> This is an Architecture Decision + task-breakdown document. It deliberately reuses the existing Omniscience MCP client, the SSRF-safe knowledge-fetch stack, the RAG/pgvector layer, the practice-card schema/route/UI pattern, and the refresh-scheduler cron. No live Omniscience instance exists yet; Stage 1 is built and tested against a MOCK that mirrors `tests/helpers/mock-omniscience.ts`.

---

## 1. Omniscience MCP contract findings (authoritative, from disk)

Source of truth read for this design:
- `project/Omniscience/docs/api/mcp.md`
- `project/Omniscience/apps/server/src/omniscience_server/mcp/server.py` (the `@mcp_server.tool` registrations)
- `project/Omniscience/apps/server/src/omniscience_server/mcp/incident_timeline.py`
- `project/Omniscience/packages/retrieval/src/omniscience_retrieval/blast_radius.py` (response Pydantic models + constants)
- `project/Omniscience/apps/server/src/omniscience_server/blast_radius.py` (FastAPI orchestration, error codes)

The server registers **13 tools**. The board uses a **subset of 4** for Stage 1 (`search`, `blast_radius`, `incident_timeline`, `source_stats`) and treats `replay_context` + `get_related_entities` as **Stage 2 / optional** (designed-for but not wired). Below are the exact wire signatures.

### Tools the board WILL call (Stage 1)

#### `search` (scope: `search`)
`server.py:259` — `async def search(query, ctx, top_k=10, sources=None, types=None, max_age_seconds=None, filters=None, include_tombstoned=False, retrieval_strategy="hybrid", as_of=None)`
- `query: str` (required), `top_k: int=10`, `sources: list[str]|None`, `types: list[str]|None`, `max_age_seconds: int|None`, `filters: dict|None`, `include_tombstoned: bool=false`, `retrieval_strategy: str="hybrid"` (v0.1 downgrades structural/keyword/auto→hybrid), `as_of: str|None` (ISO-8601 UTC).
- Returns `{ hits: [{ chunk_id, document_id, score, text, source{id,name,type}, citation{uri,title,indexed_at,doc_version}, lineage{...}, metadata{...} }], query_stats{...} }`.
- **Note**: the on-disk REST `search` output key is `hits`, but multiqlti's existing `OmniscienceProvider.parseSearchResult` validates a `{ chunks: [...] }` shape and the existing `mock-omniscience.ts` returns `{ chunks }`. We KEEP the existing provider contract for the board's internal-feed reuse (the provider is the seam we already own); the board does not re-derive `search`. See §6 risk R1.

#### `blast_radius` (scope: `search` + **workspace-scoped token**) — issue #234
`server.py:626` — `async def blast_radius(entity_id, ctx, action_type="restart", max_depth=3, as_of=None)`
- `entity_id: str` (required, canonical entity name), `action_type: str` ∈ `{"restart","delete","scale_down","cordon"}` (default `"restart"`), `max_depth: int` clamped `[1,5]` (default `3`), `as_of: str|None`.
- Constants (from `packages/retrieval/.../blast_radius.py`): `ACTION_TYPES=("restart","delete","scale_down","cordon")`, `DEFAULT_MAX_DEPTH=3`, `MIN_MAX_DEPTH=1`, `MAX_MAX_DEPTH=5`.
- Returns `BlastRadiusResponse` (`blast_radius.py:118`):
  ```
  {
    seed_entity_id: string,
    action_type: "restart"|"delete"|"scale_down"|"cordon",
    max_depth: int (1..5),
    impacted: [{
      entity_id: string,
      entity_type: string,             // e.g. "service", "pod", "function"
      dependency_path: [{ from_entity, to_entity, edge_type }],
      impact_score: number (0..1),
      confidence: number (0..1)
    }],                                 // ranked DESC by impact_score
    effective_as_of: ISO-8601 datetime,
    meta: object | null
  }
  ```
- Error codes: `invalid_entity_id`, `invalid_action_type`, `entity_not_found` (also returned for cross-workspace entity → no existence leak), `forbidden` (token not workspace-scoped), `invalid_timezone`.

#### `incident_timeline` (scope: `search` + **workspace-scoped token**) — issue #235
`server.py:575` / `incident_timeline.py:41` — `async def incident_timeline(alert_id, ctx, from_ts=None, to_ts=None, entity_types=None, as_of=None, max_depth=2)`
- `alert_id: str` MUST be `alert://{provider}/{provider_alert_id}` (else `invalid_alert_id`), `from_ts/to_ts: str|None` (event-time window), `entity_types: list[str]|None` (allowlist), `as_of: str|None`, `max_depth: int` clamped `[1,5]` (default `TIMELINE_MAX_DEPTH`=2).
- Returns events sorted ascending by timestamp with before/after summaries + source provenance (mirrors REST `GET /api/v1/incidents/{id}/timeline`, shape `IncidentTimelineResponse`). Used by the "what happened + why" internal feed when an alert is the trigger.
- Errors: `invalid_alert_id`, `alert_not_found` (cross-workspace too), `forbidden`, `invalid_timezone`.

#### `source_stats` (scope: `sources:read`)
`server.py:472` — `async def source_stats(source_id, ctx)`
- `source_id: str` (required). Returns counts, freshness, recent errors, last ingestion run. **Used as the internal-feed health/freshness indicator** ("internal feed may be stale" banner) and to gate degraded mode.
- Error: `source_not_found`.

### Tools designed-for but Stage 2 (NOT wired in Stage 1)

- `get_related_entities` (`server.py:347`) — `(entity_name, ctx, max_depth=1, edge_types=None, as_of=None)` → seed + related entities + edges, `effective_as_of`, optional `meta`. Workspace-scoped. Stage 2 enrichment of the "affects you" panel.
- `replay_context` (`server.py:699`) — `(ctx, audit_log_id=None, at_time=None, tool_name=None, arguments=None)` → original-shape response + deterministic `state_fingerprint`. Either `audit_log_id` OR (`at_time`+`tool_name`+`arguments`). Workspace-scoped. Stage 2 "what did we see at 6am" reproducibility.

### Tools noted for awareness (NOT used by the board)
`get_document` (`source`), `get_entity`, `list_sources`, `resolve_incident` (issue #153), `find_similar_incidents` (#233), `suggest_runbook` (#231), `generate_postmortem` (#232).

### Cross-cutting contract invariants (apply to every board call)
1. **Auth**: stdio → `OMNISCIENCE_TOKEN` env; http → `Authorization: Bearer`. Token scopes: `search`, `sources:read`. The graph tools (`blast_radius`, `incident_timeline`, `get_related_entities`, `replay_context`) additionally require a **workspace-scoped** token; an unscoped token returns `forbidden`.
2. **`as_of` bitemporal** (ADR-0008 §5): ISO-8601 **timezone-aware UTC** (`Z` or `+00:00`). Naive/non-UTC → `invalid_timezone`. The board's internal feed passes `as_of = <now>` and `max_age_seconds = 86400` (last 24h). Pre-history `as_of` → empty result with `meta.degraded_response = "as_of_before_recorded_history"`.
3. **ACL**: `workspace_id` is ALWAYS derived from the token, never from input. Cross-workspace ids return `*_not_found` — existence is never leaked. The board never sends a workspace id to Omniscience.
4. **Errors** are `code:message` envelopes serialized by FastMCP into MCP tool errors. The board treats ANY Omniscience error as a degrade-to-empty-internal-feed signal (never a 500 to the user).

---

## 2. Reuse map (reuse vs genuinely new)

### Reused as-is (no edit)
| File / symbol | Used for |
|---|---|
| `server/memory/omniscience-connection.ts` → `makeToolCaller(client)` | Generic MCP tool caller: already wraps `client.callTool({name, arguments})` for ANY tool name. The board reuses this verbatim. |
| `server/memory/omniscience-connection.ts` → `resolveOmniscienceToken`, `buildOmniscienceTransport`, `connectOmniscience` | Transport + token-from-env (never persisted). Reused. |
| `server/memory/omniscience-provider.ts` → `OmniscienceToolCaller` type, `OmniscienceProvider` | `search` path for the internal feed's RAG/archive use. The caller seam is the extension point (see §3). |
| `server/knowledge/safe-fetch.ts` → `safeFetch`, `AllowlistError`, `SsrfBlockedError` | SSRF-hardened external news fetch (DNS-resolved-IP gate + connect-pinning + redirect re-validation + body cap). REUSED for the external feed. |
| `server/knowledge/source-allowlist.ts` → `isAllowedSource` | First-line host/scheme/path gate. We EXTEND its host list (new edit, see "new"). |
| `server/auth/middleware.ts` → `requireAuth`, `requireOwnerOrRole` | Workspace-scope + owner-gate every route. |
| `server/storage.ts` / `server/storage-pg.ts` repo pattern (`createPracticeCard:2229`, `listPracticeCards:2270`, `updatePracticeCardState:2293`, `createRefreshRun:2304`) | New repo methods mirror these incl. idempotent onConflict. |
| `server/gateway/index.ts` → `Gateway.complete(request, ...)` (`index.ts:242`) | Summarization, relevance "why it matters" text. In-scope at `routes.ts:89`. |
| `server/memory/{vector-store,chunker,embeddings}.ts` + `memory_chunks` (`schema.ts:1469`) | External-feed dedup + archive search (project news into a chunk like practice-cards do via `projectToChunk`). |
| `node-cron` via the `KnowledgeRefreshScheduler` pattern (`server/knowledge/refresh-scheduler.ts`) | The daily-brief cron blueprint (cadence, `triggerNow:91`, per-workspace loop, idempotent run row). |
| `client/src/hooks/use-practice-cards.ts` style | The new `use-morning-brief.ts` hook (react-query, `{data,meta}` unwrap, inert-render security note). |
| `client/src/pages/KnowledgeBase.tsx` + `Chat.tsx` + `use-pipeline.ts` | UI composition baseline for the new `MorningBrief.tsx`. |

### Genuinely new
| New artifact | Why new (no existing equivalent) |
|---|---|
| `server/memory/omniscience-board-provider.ts` | Wraps the board-relevant tools (`blast_radius`, `incident_timeline`, `source_stats`) with zod boundary validation. The existing provider wraps ONLY `search`; we do NOT modify it, we add a sibling. |
| `server/news/news-sources.ts` | Curated external news allowlist + per-source parse adapters (AWS what's-new, K8s blog, CNCF, vendor changelogs). Distinct from the terraform-doc allowlist. |
| `server/news/news-fetcher.ts` | Orchestrates `isAllowedSource`→`safeFetch`→parse→normalize `news_item` candidates. |
| `server/news/brief-generator.ts` | The daily job: pulls internal (board provider, `as_of` 24h) + external (fetcher), ranks via gateway, persists `morning_brief`+`news_item`. Mirrors `KnowledgeRefreshScheduler.executeRefresh` idempotency. |
| `server/news/brief-scheduler.ts` | LAZY-on-first-GET generation: `ensureBrief` (lock+cache) + `triggerNow` (rate-limited manual refresh). NOT a cron job (Lead decision; see §5). |
| `server/news/relevance-ranker.ts` | Pure scoring: profile match (role/stack keyword overlap) + feedback signal + Omniscience `blast_radius` "affects-you" boost. Gateway used only for `whyRelevant` prose. |
| `server/news/news-service.ts` | Pure helpers (content hash, dedup key, feedback state machine) — testable without IO, mirrors `practice-card-service.ts`. |
| `server/routes/news.ts` | The REST surface (mirror of `practice-cards.ts`). |
| `shared/schema.ts` additions | `news_profile`, `morning_brief`, `news_item` tables + enums + insert schemas. Extends `CHUNK_SOURCE_TYPES` (`schema.ts:1466`) with `news_item`. |
| `client/src/hooks/use-morning-brief.ts` | React-query hooks for the news surface. |
| `client/src/pages/MorningBrief.tsx` (+ `components/morning-brief/`) | The board page. |
| `tests/helpers/mock-omniscience-board.ts` | Extends the existing mock with `blast_radius`/`incident_timeline`/`source_stats` contract-faithful doubles. |

---

## 3. Omniscience MCP client extension design

**Principle**: the connection layer is already tool-agnostic. `makeToolCaller` (`omniscience-connection.ts:82`) returns an `OmniscienceToolCaller = (toolName, args) => Promise<string>` that calls `client.callTool` and extracts text. **No change to connection.ts.** The only thing hard-coded to `search` is `OmniscienceProvider`. So we add a **sibling provider** that reuses the same caller seam.

### New: `server/memory/omniscience-board-provider.ts`
```ts
// zod boundary schemas mirroring the on-disk contract EXACTLY.
const dependencyPathStep = z.object({ from_entity: z.string(), to_entity: z.string(), edge_type: z.string() }).strict();
const blastImpact = z.object({
  entity_id: z.string(), entity_type: z.string(),
  dependency_path: z.array(dependencyPathStep).default([]),
  impact_score: z.number().min(0).max(1), confidence: z.number().min(0).max(1),
}).strict();
const blastRadiusResponse = z.object({
  seed_entity_id: z.string(),
  action_type: z.enum(["restart","delete","scale_down","cordon"]),
  max_depth: z.number().int().min(1).max(5),
  impacted: z.array(blastImpact).default([]),
  effective_as_of: z.string(),
  meta: z.record(z.unknown()).nullable().optional(),
}).strict();
// incidentTimelineResponse + sourceStatsResponse similarly mirrored.

export class OmniscienceBoardProvider {
  constructor(private readonly callTool: OmniscienceToolCaller) {}

  async blastRadius(p: { entityId: string; actionType?: ActionType; maxDepth?: number; asOf?: string }): Promise<BlastRadius> {
    const args = { entity_id: p.entityId, action_type: p.actionType ?? "restart", max_depth: p.maxDepth ?? 3, ...(p.asOf ? { as_of: p.asOf } : {}) };
    return parse(blastRadiusResponse, await this.callTool("blast_radius", args)); // throws on contract drift
  }
  async incidentTimeline(...) { /* tool "incident_timeline" */ }
  async sourceStats(sourceId: string) { /* tool "source_stats" */ }
}
```

**Key rules baked into the design**:
- **Boundary validation**: every response goes through a `.strict()` zod schema; a malformed/foreign payload throws and the caller degrades. No `any`.
- **Token never persisted**: provider takes only the caller seam; token resolution stays in `connection.ts` (`resolveOmniscienceToken` → env). The board never reads or stores the token.
- **Graceful fallback**: default `memory.retrieval.backend = "local"` (`config/schema.ts:115`) ⇒ no board provider is constructed ⇒ the internal feed renders an empty "internal feed unavailable (Omniscience not configured)" state. When `omniscience` is selected but a call errors (`forbidden`/`entity_not_found`/transport down), `brief-generator` catches per-tool and produces a partial brief (external feed still ships). This mirrors `Retriever.retrieveContext`'s try/catch→local fallback at `retriever.ts:82-94`.
- **as_of discipline**: the generator computes `as_of = new Date().toISOString()` (always `Z`, UTC) and passes `max_age_seconds = 86400` to `search`. We never send naive datetimes.
- **Workspace-scoped token requirement**: documented as an operator pre-req. If the token is not workspace-scoped, `blast_radius`/`incident_timeline` return `forbidden`; the generator treats that as "affects-you disabled" and still ships the rest. (No crash, generic UI note.)

### Config extension (`server/config/schema.ts`)
Add under `memory.retrieval.omniscience` (NON-breaking, all defaulted):
- `board.enabled: boolean = false` — gates board-provider construction.
- `board.actionType: enum(restart|delete|scale_down|cordon) = "restart"` — default action for blast-radius "affects you".
- `board.maxDepth: int 1..5 = 2` — blast-radius depth.
No new token field — reuse `tokenEnv` (`OMNISCIENCE_TOKEN`).

---

## 4. Data model

All tables `varchar` PK `gen_random_uuid()`, `workspace_id` FK → `workspaces.id` `onDelete:"cascade"`, mirroring `practice_cards` (`schema.ts:1561`). Materialized via `npm run db:push` (`drizzle-kit push`, `package.json:12`) — same as practice-cards (the journal is gated at 0012; loose `.sql` is record + CHECK hardening only). New enums exported as `as const` tuples + `z.enum` in insert schemas (mirror `PRACTICE_CARD_STATUSES`).

### 4.1 `news_profile` (one row per user×workspace)
| column | type | notes |
|---|---|---|
| `id` | varchar PK | uuid |
| `workspace_id` | varchar FK | cascade |
| `user_id` | text NOT NULL | bound to `req.user.id` |
| `role` | text NOT NULL default `'sre'` | `NEWS_PROFILE_ROLES` = `["devops","sre","platform"]` |
| `stack` | jsonb `string[]` default `["terraform","kubernetes","aws","argocd","go"]` | personalization keywords |
| `muted_categories` | jsonb `string[]` default `[]` | noise reduction |
| `updated_at` | timestamp defaultNow | |
- Unique `(workspace_id, user_id)`. Index `(workspace_id, user_id)`.

### 4.2 `morning_brief` (one row per user×workspace×local-day)
| column | type | notes |
|---|---|---|
| `id` | varchar PK | uuid |
| `workspace_id` | varchar FK | cascade |
| `user_id` | text NOT NULL | |
| `brief_date` | text NOT NULL | `YYYY-MM-DD` in the user's tz (the personalization key; see §5) |
| `tz` | text NOT NULL default `'UTC'` | IANA tz used to compute `brief_date` + the 24h window |
| `window_start` | timestamp NOT NULL | UTC instant = brief_date 00:00 local |
| `window_end` | timestamp NOT NULL | UTC instant = window_start + 24h |
| `status` | text NOT NULL default `'pending'` | `BRIEF_STATUSES` = `["pending","generating","ready","failed"]` |
| `internal_degraded` | boolean default false | true when Omniscience unavailable/forbidden |
| `generated_at` | timestamp | set when status→ready |
| `created_at` | timestamp defaultNow | |
- **Idempotency**: unique `(workspace_id, user_id, brief_date)`. Re-running the job for the same local day is a no-op upsert (onConflict do-nothing on the brief row; items keyed below). Mirrors `practice_cards_content_hash_uq`.
- Indexes: `(workspace_id, user_id, brief_date)` unique, `(workspace_id, status)`.

### 4.3 `news_item` (mirrors practice-card provenance shape)
| column | type | notes |
|---|---|---|
| `id` | varchar PK | uuid |
| `workspace_id` | varchar FK | cascade |
| `brief_id` | varchar FK → morning_brief.id | cascade |
| `category` | text NOT NULL | `NEWS_CATEGORIES` = `["internal","external"]` |
| `title` | text NOT NULL | inert-rendered |
| `summary` | text NOT NULL | gateway-generated; inert-rendered |
| `source` | jsonb `NewsItemSource` | `{ kind, name, uri?, fetchedAt, sourceVersion? }` — kind ∈ omniscience-search / omniscience-blast / aws-whatsnew / k8s-blog / cncf / vendor-changelog |
| `provenance` | jsonb default `{}` | raw citation/lineage from Omniscience (`citation`,`lineage`) or fetch metadata; never trusted for rendering decisions |
| `relevance_score` | real NOT NULL default 0 | 0..1 from `relevance-ranker` |
| `why_relevant` | text | short "why it matters to YOU" prose (gateway) — inert |
| `affects` | jsonb `BlastAffect[]` default `[]` | from `blast_radius.impacted` → `[{ entityId, entityType, impactScore, confidence, path }]` |
| `read_state` | text NOT NULL default `'unread'` | `NEWS_READ_STATES` = `["unread","read"]` |
| `feedback` | text | `NEWS_FEEDBACK` = `["up","down","hidden"]` or NULL |
| `content_hash` | text NOT NULL | sha256(canonical(title+summary+source.uri+category)) — server-computed, dedup key |
| `created_at` | timestamp defaultNow | |
- **Dedup / idempotency**: unique `(brief_id, content_hash)` → re-running generation upserts items, never duplicates. Cross-brief external dedup additionally uses the RAG `memory_chunks` archive (source_type `news_item`) so the same AWS post seen yesterday is suppressed.
- Indexes: `(brief_id, category, relevance_score)` (the ordered-read query), `(workspace_id, read_state)`, unique `(brief_id, content_hash)`.

### 4.4 RAG projection
Extend `CHUNK_SOURCE_TYPES` (`shared/schema.ts:1466`, also `chunker.ts:13`) with `"news_item"`. External items are projected into `memory_chunks` (`source_type='news_item'`, `source_id=news_item.id`) for cross-day dedup + archive search, exactly as `projectToChunk` (`practice-card-service.ts:162`) does for practice cards. The `news_item` row stays authoritative; the chunk is a derived index.

### Workspace-scoping
Every row carries `workspace_id`; every query filters by it; every route resolves the workspace and 404s cross-workspace ids (the `loadCardInWorkspace` pattern, `practice-cards.ts:452`). `user_id` is always `req.user.id`, never from the body.

---

## 5. Brief generation, ranking & feedback

### Generation model — LAZY-on-first-GET + cache (Lead decision; supersedes any cron-fan-out wording)
> **DECISION (Wave 2):** there is **NO cron fan-out**. A brief is generated **lazily on the first `GET /news/brief` of the day** for a (workspace,user,brief_date) and then served from the persisted cache. This bounds cost to actually-active users and removes the per-profile fan-out. `server/news/brief-scheduler.ts` implements this — it is NOT a cron clone.
- **Lazy path** (`BriefScheduler.ensureBrief`): on a cache miss, `createMorningBrief` atomically **claims** the per-(workspace,user,brief_date) lock (the UNIQUE constraint; `claimed` flag). Only the FIRST miss of the day generates; concurrent first-GETs that lose the claim **poll for `ready`** (Security M1). A `ready` brief is served directly (no regen).
- **Rate limit** (Security C1): each (workspace,user,day) allows **one auto-generation + a small bounded number of manual refreshes** (`MAX_GENERATIONS_PER_DAY`). The count is persisted in `morning_brief.meta.genCount` (DB-layer, survives restarts, race-safe) since there is no request-rate-limit middleware. Exceeding the cap → `429`.
- **Idempotency**: re-running for the same day finds the brief and re-upserts items by `content_hash` only (UNIQUE(brief_id,content_hash) DO NOTHING).
- `triggerNow(workspaceId, userId, briefDate)` backs the manual refresh endpoint (rate-limited) and tests.

### Generation pipeline (`brief-generator.ts`)
1. Upsert the `morning_brief` row (status `generating`).
2. **Internal feed** (only if board provider present): `omniscience search` with `as_of=now`, `max_age_seconds=86400`, `types` filtered to deploy/git/gitops/terraform source types → "what happened yesterday + why". For any seed entity surfaced, call `blast_radius(entityId, actionType=cfg.board.actionType, maxDepth=cfg.board.maxDepth, as_of=now)` to compute `affects[]`. If an incident `alert://...` is present, `incident_timeline` enriches the "why". Wrap each tool call in try/catch; on any error set `internal_degraded=true` and continue.
3. **External feed**: `news-fetcher` iterates the curated source allowlist → `isAllowedSource`→`safeFetch`→parse→candidate `news_item`s. Atomic per source: a source that fails the allowlist or SSRF gate is skipped (logged server-side), never aborts the whole brief.
4. **Dedup**: drop candidates whose `content_hash` already exists in this brief; drop external candidates already present in the `memory_chunks` archive within the window.
5. **Rank**: `relevance-ranker.rankItems(items, profile, feedbackStats)` → `relevance_score`. Gateway (`Gateway.complete`) generates `summary` + `why_relevant` prose per item (bounded, mock-friendly).
6. Persist items (onConflict `(brief_id, content_hash)` do-nothing), project external items into `memory_chunks`, set brief status `ready` + `generated_at`. On unexpected failure → status `failed` (mirrors `executeRefresh` catch at `refresh-scheduler.ts:128`).

### Ranking model (`relevance-ranker.ts`, pure)
`score = clamp01( w_profile * profileMatch + w_affects * affectsBoost + w_feedback * feedbackSignal )`
- `profileMatch`: keyword overlap of item title/summary/source against `profile.stack` + role synonyms.
- `affectsBoost`: max `impact_score` from the item's `affects[]` (internal items that touch the user's platform float to the top — this is the "affects YOU" signal).
- `feedbackSignal`: per-source/per-category EMA of thumbs up/down; `hidden` and `muted_categories` force-drop. Deterministic constants (named consts, no inline magic numbers).

### Personalization + feedback loop
- **Explicit profile**: `news_profile`, default role `sre`, stack `[terraform,kubernetes,aws,argocd,go]`. `GET/PUT` endpoints (self-gated).
- **Feedback capture**: `POST /news/items/:itemId/feedback {action: read|up|down|hidden}` sets `read_state`/`feedback`. Pure state machine in `news-service.ts` (e.g. `up` clears a prior `hidden`). Feedback is read by the next ranking run (noise reduction), closing the loop. No auto-mutation of items by the model.

---

## 6. API contracts (`server/routes/news.ts`, mirrors `practice-cards.ts`)

Base: `/api/workspaces/:id/news`. Every route: `resolveWorkspace`→404, then `requireAuth` (read) or `requireOwnerOrRole(()=>ws.ownerId, "maintainer","admin")` (refresh). All bodies validated with strict zod; `user_id` bound to `req.user.id`; generic client errors; server-side detail logged via a `logServerError` helper (`practice-cards.ts:152`). Response envelope `{ data, meta? }` / `{ error }`.

| Method | Path | Auth | Request (zod) | Response |
|---|---|---|---|---|
| GET | `/news/profile` | requireAuth (self) | — | `{ data: NewsProfileRow }` (creates default if absent) |
| PUT | `/news/profile` | requireAuth (self) | `{ role: enum(NEWS_PROFILE_ROLES), stack: string[]<=50, mutedCategories?: string[]<=20 }` strict | `{ data: NewsProfileRow }` |
| GET | `/news/brief` | requireAuth | query `{ date?: YYYY-MM-DD, category?: enum, readState?: enum }` | `{ data: { brief, items: NewsItemRow[] }, meta:{ internalDegraded } }` (latest ready brief for `req.user.id` unless `date`) |
| GET | `/news/briefs` | requireAuth | query `{ limit<=60=14, offset>=0=0 }` | `{ data: MorningBriefRow[], meta:{ total } }` (history) |
| POST | `/news/refresh` | owner/maintainer/admin | `{ date?: YYYY-MM-DD }` strict | `202 { data: { briefId } }` (async `triggerNow`) |
| POST | `/news/items/:itemId/feedback` | requireAuth | `{ action: enum(read|up|down|hidden) }` strict | `{ data: NewsItemRow }` (404 cross-workspace item) |

Auth note: `GET /news/brief|profile` are self-scoped — a user reads their own brief; the workspace gate ensures the user belongs to the workspace, and `user_id = req.user.id` ensures no cross-user read. `POST /news/refresh` is owner/maintainer/admin (it spends compute + hits Omniscience), mirroring `POST .../refresh` on practice-cards (`practice-cards.ts:397`).

### Wiring
Register in `server/routes.ts` right after the practice-card block (`routes.ts:159-165`) where `storage`, `gateway` (`routes.ts:89`), and the scheduler are already in scope:
```ts
const briefScheduler = initBriefScheduler(storage, gateway, omniscienceBoardProviderOrNull);
registerNewsRoutes(app as unknown as Router, storage, buildNewsDeps({
  gateway, getEmbeddingClient, vector, triggerNow: briefScheduler.triggerNow.bind(briefScheduler),
}));
```
Deps injected (testability): `getEmbeddingClient`, `vector` (insert/delete/search), `gateway`, `refresh.triggerNow`, and an optional `boardProvider` (null when backend≠omniscience → graceful internal-feed degrade).

---

## 7. Board UI plan

New page `client/src/pages/MorningBrief.tsx`, routed (wouter, `client/src/App.tsx`) at `/workspaces/:id/morning-brief` inside the existing auth shell (mirror the `/workspaces/:id/knowledge-base` route at `App.tsx:110`). New hook `client/src/hooks/use-morning-brief.ts` (react-query, mirrors `use-practice-cards.ts`; unwraps `{data}`; **security note in the file header: every brief-/Omniscience-/fetch-derived string — title, summary, whyRelevant, source.uri, affects entity names — is UNTRUSTED and is rendered as plain React children/text only, never via `dangerouslySetInnerHTML` or any HTML sink**, exactly as `use-practice-cards.ts` documents).

Composition (`client/src/components/morning-brief/`):
- `BriefHeader` — date, tz, "internal feed degraded" banner when `meta.internalDegraded`.
- `InternalFeed` — items where `category==="internal"`, relevance-ordered; each card shows title, summary, "why", provenance citation link (rendered as text/URL, opened via standard anchor, not auto-followed).
- `ExternalFeed` — `category==="external"`, relevance-ordered, source badge (AWS/K8s/CNCF/vendor).
- `AffectsYouPanel` — aggregates `affects[]` across internal items, sorted by `impactScore`, showing impacted `entityType`/`entityId` + dependency path; this is the "this affects YOUR platform" cross-link. Empty/disabled state when degraded or backend=local.
- `NewsItemControls` — read toggle, thumbs up/down, hide → calls the feedback mutation, optimistic update + rollback.
- `ProfileEditor` (modal/section) — role + stack chips, muted categories.

Design-quality: editorial morning-brief layout (hierarchy via scale contrast, internal vs external as distinct columns/sections, the AffectsYou panel as a high-emphasis surface), intentional read/hover/active states. Not a default card grid.

---

## 8. Task breakdown (ordered, file-owned, parallelizable)

Conventions: every new file < 800 lines, every function < 30 lines, TDD ≥80% on new modules, no `any`, immutable patterns, generic client errors. Feature branch + PR; no AI mentions in commits. Server on host (`make infra-up` + `make dev`) — never Docker.

### Phase A — Foundations (parallel)
- **A1 [Backend] Schema + enums** — `shared/schema.ts`: add `news_profile`, `morning_brief`, `news_item` tables, enums (`NEWS_PROFILE_ROLES`, `BRIEF_STATUSES`, `NEWS_CATEGORIES`, `NEWS_READ_STATES`, `NEWS_FEEDBACK`), `NewsItemSource`/`BlastAffect` interfaces, insert schemas; extend `CHUNK_SOURCE_TYPES`+`chunker.ts` with `news_item`. Verify `npm run db:push` applies cleanly on a scratch DB. *No deps.*
- **A2 [Backend] Mock** — `tests/helpers/mock-omniscience-board.ts`: extend the existing mock with contract-faithful `blast_radius`/`incident_timeline`/`source_stats` (param validation, error codes incl. `forbidden`/`entity_not_found`/`invalid_timezone`, `as_of` UTC enforcement, malformed-payload + failWith modes). *No deps.*
- **A3 [Security] Threat-model note** — review SSRF reuse plan + token-never-persisted + workspace/user scoping (review artifact, not a doc file). Feeds A5/B4/B-routes. *No deps.*

### Phase B — Server core (parallel after A1/A2)
- **B1 [Backend] Board provider** — `server/memory/omniscience-board-provider.ts` + zod schemas. Tests against A2 mock incl. fallback/degrade. *Deps: A2.*
- **B2 [Backend] Config** — `server/config/schema.ts`: add `memory.retrieval.omniscience.board.*` (defaulted, non-breaking) + tests. *No deps.*
- **B3 [Backend] News service (pure)** — `server/news/news-service.ts`: content hash (canonical, server-side), dedup key, feedback state machine, ranking-free helpers. Pure unit tests. *Deps: A1.*
- **B4 [Backend] Sources + fetcher** — `server/news/news-sources.ts` (allowlist + per-source adapters) and `server/news/news-fetcher.ts` (reuse `isAllowedSource`+`safeFetch`). Also EXTEND `server/knowledge/source-allowlist.ts` host list (or add a news-specific allowlist constant) for AWS/K8s/CNCF/vendor hosts. SSRF tests + atomic-skip tests. *Deps: A1, A3.*
- **B5 [Backend] Storage repo** — `server/storage.ts`+`storage-pg.ts`: `upsertMorningBrief`, `getBriefForUserDate`, `listBriefs`, `upsertNewsItems` (onConflict `(brief_id,content_hash)`), `setNewsItemFeedback`, `get/putNewsProfile`. Mirror practice-card repo + idempotency. Integration tests on real PG. *Deps: A1.*

### Phase C — Generation + API (after B)
- **C1 [Backend] Ranker** — `server/news/relevance-ranker.ts` (pure) + tests (profile/affects/feedback weighting, deterministic). *Deps: B3.*
- **C2 [Backend] Brief generator + scheduler** — `server/news/brief-generator.ts` + `server/news/brief-scheduler.ts` (LAZY-on-first-GET: `ensureBrief` lock+cache+rate-limit, `triggerNow`; idempotent per brief_date; per-tool try/catch degrade; gateway summaries with M4 untrusted-data framing). Tests with mock provider + mock gateway. *Deps: B1, B4, B5, C1.*
- **C3 [Backend] Routes** — `server/routes/news.ts` (the 6 endpoints) + `buildNewsDeps`; wire in `server/routes.ts` after `routes.ts:165`. Route tests (auth, owner-gate, workspace-scope 404, validation, generic errors, degraded meta). *Deps: B1, B5, C2.*

### Phase D — Client (parallel with C, finalize after C3)
- **D1 [Frontend] Hook** — `client/src/hooks/use-morning-brief.ts` (react-query queries/mutations, `{data}` unwrap, inert-render header note). *Deps: C3 contract (can stub against the documented shape first).*
- **D2 [Frontend] Components** — `client/src/components/morning-brief/*` (BriefHeader, InternalFeed, ExternalFeed, AffectsYouPanel, NewsItemControls, ProfileEditor). All untrusted strings inert. *Deps: D1.*
- **D3 [Frontend] Page + route** — `client/src/pages/MorningBrief.tsx` + `App.tsx` route + nav entry. *Deps: D2.*

### Phase E — Verification (after C+D)
- **E1 [QA] Integration/E2E** — brief generation idempotency (double-run = no dup items), degrade-when-Omniscience-absent, feedback→next-rank effect; Playwright happy path (page loads, internal+external sections, affects-you panel, feedback control). *Deps: C3, D3.*
- **E2 [Security] Final review** — SSRF allowlist coverage, no token persisted, parameterized SQL, workspace/owner-gate every route, inert rendering of all fetched/Omniscience text, generic client errors. BLOCK on any CRITICAL. *Deps: C3, D3.*
- **E3 [DevOps] Ops** — document the lazy-gen cost bounds (`MAX_GENERATIONS_PER_DAY`), `OMNISCIENCE_TOKEN` (workspace-scoped) requirement, `memory.retrieval.backend=omniscience` + `board.enabled=true` enablement; confirm host run (`make infra-up`/`make dev`). No `NEWS_BRIEF_CRON` ships in Stage 1. *Deps: C2.*

**Critical path**: A1 → B5 → C2 → C3 → D1 → D3 → E1/E2. A2→B1, B3/B4 fan out in parallel; D1/D2 can start against the documented contract while C is in flight.

---

## Security / Ops note (single shared Omniscience token) — H3

**The board internal feed is OFF by default and exposes ONE shared Omniscience workspace to everyone when on.**

- `OMNISCIENCE_TOKEN` is a **single** token scoped to **one** Omniscience workspace (the token derives its workspace server-side; the board never sends a workspace id). multiqlti workspaces and Omniscience workspaces are different identity domains.
- When the board is enabled, that **one** Omniscience workspace's data — `blast_radius` impacted entities, `incident_timeline` events, and `search` results feeding the internal feed and the "affects YOU" panel — is visible to **ALL board users across ALL multiqlti workspaces**. There is no per-multiqlti-workspace isolation of the Omniscience-sourced internal feed in Stage 1.
- **Two-key opt-in (least surprise):** the board internal feed activates ONLY when BOTH:
  1. `memory.retrieval.backend = "omniscience"`, AND
  2. `memory.retrieval.omniscience.board.enabled = true` (default **false**).

  Enabling the Omniscience RAG backend for other features does **not** turn on the board feed. If the token is missing or the connect fails, the board provider is null and the internal feed degrades to `internalDegraded = true` (the external feed still ships; never a 500).
- **Operator guidance:** only set `board.enabled = true` when sharing that single Omniscience workspace's data with every board user across every multiqlti workspace is acceptable for your deployment. Keep it false otherwise.
- **Stage-2 follow-up (tracked):** per-multiqlti-workspace Omniscience token binding (a token map keyed by multiqlti workspace) so the internal feed is isolated per workspace. Until then, single-shared-token is the documented Stage-1 limitation.

## 9. Risks / open questions (for the Lead)

1. **R1 — `search` output key (`hits` vs `chunks`)**: the on-disk REST `search` doc returns `{ hits: [...] }`, but multiqlti's already-shipped `OmniscienceProvider` + `mock-omniscience.ts` use `{ chunks: [...] }` (contract was frozen earlier against ADR-0004). The board reuses the existing provider for the internal-feed `search`, so it inherits whatever the live server actually emits. **Decision needed**: (a) keep reusing the existing provider as-is and adapt only if/when a live instance proves the `hits` shape, or (b) add a normalization shim now. Recommend (a) — no live instance, don't speculatively diverge from the symbol we own. Flagged for the integration milestone.
2. **R2 — Internal "what happened yesterday" seed strategy**: `search` returns chunks, not a structured event list. How do we derive seed entities for `blast_radius` from a 24h `search`? Options: parse `source.type ∈ {git,deploy,gitops}` hits and use their entity names, or (Stage 2) call `incident_timeline` when an `alert://` is present. Stage 1 recommendation: best-effort — use top-N deploy/git hits as candidate seeds; if none resolve, internal feed shows raw "what happened" chunks without an affects-you boost.
3. **R3 — Workspace-scoped token**: `blast_radius`/`incident_timeline` require a **workspace-scoped** token, but multiqlti workspaces and Omniscience workspaces are different identity domains. Stage 1 assumes one operator-provided `OMNISCIENCE_TOKEN` scoped to a single Omniscience workspace; the affects-you panel is therefore global-per-instance, not per-multiqlti-workspace. **Open question**: is single-workspace Omniscience acceptable for the MVP, or do we need a per-workspace token map (bigger config change)? Recommend single-token MVP.
4. **R4 — External source parsing fragility**: AWS what's-new / K8s blog / CNCF expose RSS/Atom or HTML that changes. Adapters in `news-sources.ts` must fail-soft per source (skip + log, never break the brief). Decision: RSS/Atom-first where available (more stable than HTML scraping); confirm we may add a lightweight feed-parser dep, or hand-roll a minimal XML parse to avoid a new dependency.
5. **R5 — `db:push` vs migration journal**: practice-cards shipped via `db:push` (journal gated at 0012). We follow the same path. Confirm the Lead is comfortable that the news tables are `db:push`-materialized (no new numbered migration), consistent with the established precedent.
6. **R6 — RESOLVED: lazy-on-first-GET, not cron fan-out**: the Lead chose **lazy generation on the first `GET /news/brief` of the day + cache** (implemented in Wave 2). This bounds cost to active users, with a per-(workspace,user,day) lock (M1) + generation rate-limit (C1). No `NEWS_BRIEF_CRON` / `node-cron` job ships in Stage 1. Earlier cron-fan-out wording in this doc is superseded by §5.
7. **R7 — Privacy proxy interaction**: gateway summarization of fetched external + internal Omniscience text flows through `Gateway.complete`, which may anonymize (privacy feature is `enabled:true` by default, `config/schema.ts:75`). Confirm news summarization should run with privacy on (it will scrub entity names from prompts — which could weaken "affects you" prose). Likely fine since `affects[]` is computed structurally from `blast_radius`, not from the LLM.

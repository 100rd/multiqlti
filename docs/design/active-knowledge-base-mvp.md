# Active Knowledge Base — MVP Design (Terraform module best-practices)

**Status**: Proposed (design phase — no implementation)
**Author**: solution-architect
**Date**: 2026-06-07
**Scope**: ONE topic — "Terraform module best-practices". Schema + loops are extensible to other DevOps topics, but we do NOT build for the whole domain yet.

---

## 1. Problem & Principle

We want a **continuously-maintained store of practice-cards** (atomic, cited, dated best-practice assertions) that does not go stale. The MVP must:

- Reuse the existing multiqlti RAG engine, knowledge API, pgvector store, scheduler, and queue. Add only a **thin layer**.
- Treat the **practice-card** (not the document) as the atomic unit, searchable via the existing vector store and carrying freshness + provenance.
- Use the `deep-research` skill + `best-practices-validator` agent as the ingestion/verification primitive. **The model must not bless its own updates** — ingestion and verification are performed by *different* agents and that separation is recorded in the data.
- Run **one** weekly server-side refresh routine that re-researches, diffs, flags stale/superseded cards, and emits a report. **No auto-commit** — a human approves.
- Provide a **thin compliance pass**: link cards to the user's own infra `graphify` graph and surface followed/violated.

### Architecture principle (from war stories)

Boring tech, evolution over revolution. We are **not** introducing a new vector store, scheduler, or fetch stack. We extend three seams that already exist: `memory_chunks` (RAG), `MaintenanceScheduler` (cron + DB-backed policy + no-auto-commit), and the knowledge router. The genuinely new code is small: one table, one source-type, one curation service, one refresh service, one fetch guard, ~6 endpoints, and a compliance mapper.

---

## 2. Reuse Map (verified against the codebase)

| Capability | Existing symbol / file | How we use it | New? |
|---|---|---|---|
| Vector store (insert/search/delete/count/listSources) | `server/memory/vector-store.ts` → `class VectorStore` | Cards are projected into `memory_chunks` for ANN search; reuse `insertChunks`, `search`, `deleteBySource`, `countChunks` verbatim | reuse |
| Chunking | `server/memory/chunker.ts` → `TextChunker` | Use `memory_entry` strategy (1 chunk = 1 card statement+rationale) — short, single-chunk | reuse |
| Embeddings | `server/memory/embeddings.ts` → `EmbeddingProviderFactory`, `DEFAULT_EMBEDDING_CONFIG` (Ollama nomic-embed-text, 768d, local) | Embed card text via per-workspace config; identical flow to `knowledge.ts` ingest | reuse |
| Knowledge API | `server/routes/knowledge.ts` → `registerKnowledgeRoutes(app)` (wired at `server/routes.ts:150`) | Extend the SAME router with practice-card endpoints | reuse + extend |
| RAG chunk table | `shared/schema.ts` → `memoryChunks`, `CHUNK_SOURCE_TYPES` (L1466), `insertMemoryChunkSchema` (L1492) | Add `"practice_card"` to `CHUNK_SOURCE_TYPES`; cards' searchable projection lands here | extend |
| Embedding config table | `shared/schema.ts` → `embeddingProviderConfig` (L1510) | Per-workspace embedding config (already used by search/ingest) | reuse |
| Migrations | `migrations/00NN_*.sql` + `drizzle.config.ts` (schema `./shared/schema.ts`) | Add `0026_practice_cards.sql` following the 0018/0024 idempotent `CREATE TABLE IF NOT EXISTS` + rollback-comment pattern | extend |
| Storage repository | `server/storage.ts` (`interface IStorage` L120, `MemStorage` L355) + `server/storage-pg.ts` (`PgStorage`) | Add `PracticeCard*` methods to `IStorage` and both implementations, mirroring `getTrigger`/`createTrigger` (storage.ts L234/L236) | extend |
| Scheduled refresh | `server/maintenance/scheduler.ts` → `MaintenanceScheduler` (node-cron, DB-backed policies, `start/reload/stop/triggerNow`, **creates records but never commits source**) | Direct template for `KnowledgeRefreshScheduler`. It already implements "scan → write findings → optionally create a pipeline run for humans, never mutate source" | reuse (pattern) + new instance |
| Cron primitive | `node-cron` (used by `MaintenanceScheduler`, `CronScheduler`, `IndexScheduler`) | Same lib, same `cron.validate` guard | reuse |
| Pipeline-bound triggers | `shared/schema.ts` → `triggers` (L677; `TRIGGER_TYPES` L674 includes `"schedule"`, `"github_event"`) + `server/services/cron-scheduler.ts` | Reuse the **trigger model** for cadence + signal triggers; `github_event` already supports `release` for the changelog signal | reuse |
| Queue (optional offload) | `server/queue/` → `StageQueueProducer`, `getRedisConnection`, `isQueueEnabled()` (BullMQ, feature-flagged) | Refresh runs are short; run inline by default. Offload only if `isQueueEnabled()`; not required for MVP | reuse (optional) |
| Gateway / LLM | `server/gateway/index.ts` + `providers/` (claude-cli, antigravity wired) | Curation/refresh **agents** call the gateway; provider chosen by existing model discovery | reuse |
| Auth | `server/auth/middleware.ts` → `requireAuth`, `requireRole`, `requireOwnerOrRole` | **New** endpoints MUST gate on these. NOTE: existing `knowledge.ts` has ZERO auth — we fix that for card-mutating routes | reuse (+ fix gap) |
| Infra graph | `infra/graphify-out/graph.json` (node-link JSON: `nodes[]{id,label,file_type,source_file,metadata{language,kind}}`, 645 nodes) | Compliance pass reads this read-only and maps card `applies_to` → graph nodes | reuse (read-only) |
| Research/verify primitive | `~/.claude/skills/deep-research/SKILL.md`; `.claude/agents/review/best-practices-validator.md` | Off-server agents produce + verify candidate cards; server only accepts validated cards via API | reuse |

**Genuinely new code** (all small, `<800` lines/file, functions `<30` lines):
1. `migrations/0026_practice_cards.sql` + `practiceCards`/`practiceCardRefreshRuns` tables in `shared/schema.ts`.
2. `server/knowledge/practice-card-service.ts` — repository-backed CRUD + projection-into-chunks + diff logic.
3. `server/knowledge/refresh-scheduler.ts` — weekly cron loop (clone of `MaintenanceScheduler` shape).
4. `server/knowledge/source-allowlist.ts` + `server/knowledge/safe-fetch.ts` — SSRF-safe fetch + curated allowlist.
5. `server/knowledge/compliance-mapper.ts` — graph ↔ card mapping (thin).
6. New routes appended to `server/routes/knowledge.ts` (or sibling `server/routes/practice-cards.ts` registered alongside at `server/routes.ts:150`).
7. Tests under `tests/unit`, `tests/integration`, `tests/e2e`.

---

## 3. Data Model

### 3.1 Decision: dedicated `practice_cards` table + projection into `memory_chunks`

**Chosen**: a dedicated `practice_cards` table owns the structured fields, **joined to `memory_chunks` for search** via a `practice_card` source type. Rejected: storing everything in chunk `metadata`.

**Justification**
- Cards have rich, queryable, *relational* state: `status` (active/superseded/deprecated), `supersedes`/`superseded_by` edges, `confidence`, `last_verified_at`, sources with versions. Burying this in `jsonb` metadata makes refresh queries (`WHERE status='active' AND last_verified_at < now()-interval '90 days'`) and the supersession graph unindexable.
- The vector store contract is `(workspace_id, source_type, source_id, chunk_text, embedding, metadata)`. We get search "for free" by projecting each card into one chunk: `source_type='practice_card'`, `source_id=<card.id>`, `chunk_text=statement + "\n\n" + rationale`. Reuse `VectorStore.insertChunks`/`search`/`deleteBySource` unchanged.
- Freshness/provenance stay authoritative in `practice_cards`; the chunk row is a derived index rebuildable any time (and `/re-embed` already exists).
- Blast radius: cards live beside chunks; deleting a workspace cascades both (FK to `workspaces`).

### 3.2 `practice_cards` (new table)

```
practice_cards
  id              VARCHAR PK DEFAULT gen_random_uuid()
  workspace_id    VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  topic           TEXT NOT NULL            -- MVP: 'terraform-module-best-practices'
  statement       TEXT NOT NULL            -- the atomic assertion
  rationale       TEXT NOT NULL            -- why
  applies_to      JSONB NOT NULL DEFAULT '{}'  -- {tool:'terraform', resource_kinds:[...], tags:[...]}
  sources         JSONB NOT NULL DEFAULT '[]'  -- [{url, source_version, fetched_at}]
  confidence      DOUBLE PRECISION NOT NULL DEFAULT 0  -- 0..1
  status          TEXT NOT NULL DEFAULT 'active'  -- 'active'|'superseded'|'deprecated'
  supersedes      JSONB NOT NULL DEFAULT '[]'  -- card ids this replaces
  superseded_by   JSONB NOT NULL DEFAULT '[]'  -- card ids replacing this
  -- adversarial curation provenance (model must not bless its own update):
  ingested_by     TEXT NOT NULL            -- agent/actor that PROPOSED the card
  verified_by     TEXT                     -- agent/actor that VERIFIED it (NULL until verified)
  verification    JSONB NOT NULL DEFAULT '{}'  -- {verdict, notes, checked_sources[], at}
  review_state    TEXT NOT NULL DEFAULT 'pending_verification'
                  -- 'pending_verification'|'verified'|'pending_review'|'accepted'|'rejected'
  content_hash    TEXT NOT NULL            -- sha256(statement+rationale+applies_to) for idempotent upsert + diff
  last_verified_at TIMESTAMPTZ
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()

Indexes:
  practice_cards_workspace_topic_idx   ON (workspace_id, topic)
  practice_cards_status_idx            ON (workspace_id, status)
  practice_cards_review_state_idx      ON (workspace_id, review_state)
  practice_cards_content_hash_uq       UNIQUE (workspace_id, content_hash)   -- dedupe / idempotent ingest
  practice_cards_verified_idx          ON (workspace_id, last_verified_at)
```

**Refresh-run record** (thin, so humans review without re-running):

```
practice_card_refresh_runs
  id            VARCHAR PK DEFAULT gen_random_uuid()
  workspace_id  VARCHAR NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE
  topic         TEXT NOT NULL
  trigger       TEXT NOT NULL            -- 'cadence'|'signal'|'manual'
  status        TEXT NOT NULL DEFAULT 'running'  -- 'running'|'completed'|'failed'
  report        JSONB NOT NULL DEFAULT '{}'  -- {new[], changed[], stale[], superseded[], unchanged_count}
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  completed_at  TIMESTAMPTZ
```

### 3.3 Source-type extension

`shared/schema.ts`:
```
CHUNK_SOURCE_TYPES = ["code", "pipeline_run", "document", "memory_entry", "practice_card"] as const
```
The `memory_chunks` source-type CHECK (added in `0018_memory_chunks.sql`) must be widened: drop + recreate the CHECK in `0026`. `server/memory/chunker.ts` `ChunkSourceType` gains `"practice_card"` and routes to the `memory_entry` (single-chunk) strategy.

### 3.4 Migration approach (drizzle)

- Author `0026_practice_cards.sql` by hand following the exact house style in `0018_memory_chunks.sql`/`0024_*`: `CREATE TABLE IF NOT EXISTS`, explicit `CREATE INDEX IF NOT EXISTS`, trailing `-- Rollback:` block. Idempotent.
- One migration: 2 new tables + `memory_chunks` CHECK widening.
- Keep `shared/schema.ts` drizzle definitions in sync (source of truth for types via `$inferSelect`/`createInsertSchema`). Generate insert zod with `createInsertSchema(practiceCards).omit({id,createdAt,updatedAt}).extend({...enums...})`, mirroring `insertMemoryChunkSchema`.
- Run via the project's existing migrate path; never inside Docker (server on host, pgvector in Docker via `make infra-up`).

---

## 4. API Contracts

All routes extend the knowledge surface, are **zod-validated at the boundary**, use parameterized queries only, and are **auth-gated** (existing `knowledge.ts` routes are unauthenticated — new card-mutating routes MUST use `requireRole`/`requireOwnerOrRole` resolved via the workspace `ownerId`). Responses use the project envelope (`{ data }` / `{ error }`).

Base: `/api/workspaces/:id/knowledge`

### 4.1 `POST /practice-cards/ingest` — accept validated cards (write)
- **Auth**: `requireRole("maintainer","admin")` OR workspace owner.
- **Purpose**: the boundary between agents and the server. Research/verify happens in agents; the server only *persists validated candidate cards* and **re-validates every `sources[].url` against the allowlist + SSRF guard** (never trusts the agent's URLs).
- **Request** (zod):
```
{
  topic: string,                 // checked against KNOWN_TOPICS (MVP: single value)
  ingestedBy: string,            // proposing agent id (required)
  cards: Array<{
    statement: string (1..2000),
    rationale: string (1..8000),
    appliesTo: { tool: 'terraform', resourceKinds?: string[], tags?: string[] },
    sources: Array<{ url: string(url), sourceVersion?: string, fetchedAt: string(datetime) }>(1..),
    confidence: number (0..1)
  }>(1..50),
  replaceTopic?: boolean         // if true, supersede prior active cards for this topic not present now
}
```
- **Behavior**: upsert by `(workspace_id, content_hash)`; new cards land `review_state='pending_verification'`, `verified_by=NULL`. Project each into one `memory_chunks` row via the existing embed→insert flow. URLs failing allowlist/SSRF → 400 with the offending URL.
- **Response**: `201 { data: { accepted: n, cardIds: string[], rejectedUrls: string[] } }`.

### 4.2 `POST /practice-cards/:cardId/verify` — adversarial verification gate (write)
- **Auth**: `requireRole("maintainer","admin")`.
- **Purpose**: record a *different* actor's verdict. **Server enforces `verifiedBy !== card.ingested_by`** (409 if equal) — the model cannot bless its own update.
- **Request**: `{ verifiedBy: string, verdict: 'pass'|'fail'|'needs_changes', notes?: string, checkedSources?: string[] }`.
- **Behavior**: on `pass` → `review_state='pending_review'`, set `verified_by`/`verification`/`last_verified_at=now()`. On `fail`/`needs_changes` → stays/`rejected`. Never auto-`accepted`.
- **Response**: `200 { data: <card> }`.

### 4.3 `POST /practice-cards/:cardId/review` — human accept/reject (write)
- **Auth**: `requireRole("admin")` OR workspace owner (human gate).
- **Request**: `{ decision: 'accept'|'reject', supersedes?: string[] }`.
- **Behavior**: `accept` → `status='active'`, `review_state='accepted'`; if `supersedes`, mark those `status='superseded'` + reciprocal `superseded_by`. `reject` → `review_state='rejected'`, remove search projection (`deleteBySource('practice_card', cardId)`).
- **Response**: `200 { data: <card> }`.

### 4.4 `GET /practice-cards` — list (read)
- **Auth**: `requireAuth`.
- **Query (zod)**: `{ topic?, status?, reviewState?, limit?=50(1..200), offset?=0 }`.
- **Response**: `200 { data: PracticeCard[], meta: { total } }`.

### 4.5 `GET /practice-cards/search` — semantic search over cards (read)
- **Auth**: `requireAuth`.
- **Query**: `{ q: string, topK?=10(1..50) }`.
- **Behavior**: embed `q`, call `VectorStore.search(workspaceId, vec, { sourceTypes:['practice_card'], minScore:0.2, topK })`, hydrate hits by `source_id` → `practice_cards` row (caller gets confidence/freshness/provenance, not just chunk text).
- **Response**: `200 { data: Array<{ card: PracticeCard, score: number }> }`.

### 4.6 `POST /practice-cards/refresh` — manual refresh trigger (write)
- **Auth**: `requireRole("maintainer","admin")`.
- **Behavior**: calls `refreshScheduler.triggerNow(workspaceId, topic, actor)` (same shape as `MaintenanceScheduler.triggerNow`). Returns the `refresh_run` id; loop runs async, writes a report. **No card mutation without human review.**
- **Response**: `202 { data: { refreshRunId } }`.

### 4.7 `GET /practice-cards/refresh-runs/:runId` and `GET /practice-cards/compliance` (read)
- Refresh-run report fetch; thin compliance report (§6). Both `requireAuth`.

---

## 5. Agent / Loop Design

### 5.1 Ingestion path (curated allowlist → ~15–30 validated cards)

```
[Off-server, agent team]                         [Server, thin]
deep-research skill                              POST /practice-cards/ingest
  fan-out search over ALLOWLIST  ──┐               - zod validate
   terraform-best-practices.com    │               - re-check EVERY source url
   developer.hashicorp.com/terraform│                vs allowlist + SSRF guard
   + Terraform CHANGELOG            │               - upsert by content_hash
   opentofu.org                     │               - project -> memory_chunks (embed)
  fetch + read sources             │               - review_state=pending_verification
  normalize -> candidate cards ────┘
        │
        ▼ (DIFFERENT agent)
best-practices-validator agent     ──────────────▶ POST /practice-cards/:id/verify
  adversarially checks each card                    - enforce verifiedBy != ingestedBy
  against fetched primary sources                   - record verdict + checkedSources
  verdict pass/fail/needs_changes                   - on pass -> pending_review
        │
        ▼ (human)
  reviewer in UI               ──────────────────▶ POST /practice-cards/:id/review
                                                    - accept -> status=active
                                                    - reject -> drop projection
```

- **Boundary is explicit**: research + verification are agent work; the server is a guarded persistence + projection layer. The server never fetches the web during ingest except to **validate** supplied URLs (allowlist/HEAD check), and never auto-accepts.
- **Allowlist** (`source-allowlist.ts`): constant host patterns — `terraform-best-practices.com`, `developer.hashicorp.com` (Terraform docs + changelog), `github.com/hashicorp/terraform` (CHANGELOG), `opentofu.org`, `github.com/opentofu/opentofu`. Extensible per-topic later.
- **SSRF-safe fetch** (`safe-fetch.ts`): https-only; host must match allowlist; resolve DNS and reject private/loopback/link-local/metadata ranges (`127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `::1`, `fc00::/7`); cap redirects (follow only within allowlist); timeout; max body size. No general fetch util exists today (verified), so this is new.

### 5.2 Active refresh loop (ONE weekly routine, no auto-commit)

`server/knowledge/refresh-scheduler.ts` is a near-clone of `MaintenanceScheduler` (which proves the "scheduled scan that writes findings and queues work for humans, but never mutates source" pattern):

```
KnowledgeRefreshScheduler (singleton, node-cron)
  start()       -> load enabled refresh policies (MVP: one, topic=terraform-module-best-practices)
                   register weekly cron (default '0 6 * * 1' Mon 06:00 UTC; env-overridable)
  triggerNow()  -> bypass cron (used by POST /refresh)
  executeRefresh(workspaceId, topic, trigger):
     1. insert practice_card_refresh_runs row status=running
     2. signal a deep-research refresh for the topic (agent-driven, off-server)
     3. DIFF candidates vs current active cards (content_hash + semantic match):
          new        = candidate not matching any active card
          changed    = matches an active card by topic+scope but content_hash differs
          stale      = active card with last_verified_at older than STALE_TTL (e.g. 90d)
                       and not re-confirmed by this run
          superseded = active card whose source_version is behind the latest fetched version
     4. write report jsonb to the refresh_run row; status=completed
     5. EMIT report (WS event + UI). DO NOT mutate cards.
        Flagged cards may move review_state to 'pending_review' as a queue hint ONLY;
        status stays 'active' until a human accepts a replacement.
```

- **Cadence trigger** is wired now (weekly cron).
- **Signal trigger** (new release/changelog) is *accommodated* now, wireable later via the existing `triggers` model: a `github_event` trigger on `hashicorp/terraform` `release` events (table + webhook/cron subsystem already support `github_event`). On a release webhook → `refreshScheduler.triggerNow(..., trigger='signal')`. MVP ships cadence and leaves one documented hook for the signal path.
- **Queue**: refresh is short and runs inline by default. If `isQueueEnabled()`, MAY enqueue via `StageQueueProducer`; not required for MVP.

> Server-side agent invocation: the server does not run Claude Code agents itself. For MVP, step 2 emits a "refresh due" signal that the agent team consumes; agents post fresh candidates back through `/ingest`, then the server-side diff in step 3 runs against persisted candidates. This keeps the model-vs-server boundary clean and the diff/report logic fully unit-testable.

### 5.3 Adversarial curation gate (data + API)

- **Data**: `ingested_by` (proposer) and `verified_by` (verifier) are separate, required-to-differ columns; `verification` jsonb records verdict/notes/checked-sources/timestamp; `review_state` is a strict state machine (`pending_verification → verified/pending_review → accepted/rejected`).
- **API enforcement**: `/verify` rejects `verifiedBy === ingested_by` (409). `/review` is a human-only role gate. No endpoint transitions a card to `status='active'` automatically — only `/review accept`.
- **Provenance is permanent**: proposer/verifier/sources stay queryable for audit after acceptance.

---

## 6. Compliance Pass (thin first cut)

Goal: surface where each accepted practice-card is *followed* or *violated* in the user's own infra, using `infra/graphify-out/graph.json` (read-only; node-link JSON, `nodes[]{id,label,file_type,source_file,metadata{language,kind}}`, 645 nodes).

`server/knowledge/compliance-mapper.ts`:
- Load + cache the graph JSON once. For each `accepted` card with `applies_to.tool='terraform'`, derive lightweight matchers from `applies_to.resource_kinds`/`tags` + statement keywords.
- MVP produces a **coverage report**, not a verdict engine:
  - `mapped`: graph nodes (by `source_file`/`label`) plausibly in scope (e.g. `*.tf` files, modules dir).
  - `signal`: coarse followed/violated/unknown heuristic per mapped node from cheap text checks against the node's `source_file` where available (e.g. "remote state with locking" → grep for `backend "s3"` + `dynamodb_table`/`use_lockfile`). Where undetermined → `unknown` (never false-confidence).
- **Output**: `GET /practice-cards/compliance` → `{ data: Array<{ cardId, statement, followed: node[], violated: node[], unknown: node[] }> }`.
- Out of scope for MVP: HCL AST parsing, policy-as-code, write-back.

---

## 7. Task Breakdown (ordered, with ownership, deps, parallelism)

Conventions: TDD (RED→GREEN→REFACTOR, ≥80% coverage), files `<800` lines, functions `<30` lines, immutable updates, explicit error handling, zod at boundaries, parameterized SQL. Feature branch + PR only; no AI mentions in commits.

### Phase A — Schema & storage foundation (blocks everything)
- **A1 (Backend)** — Extend `CHUNK_SOURCE_TYPES` with `practice_card` in `shared/schema.ts`; add `practiceCards` + `practiceCardRefreshRuns` drizzle tables + `createInsertSchema` zod; add `practice_card` to `chunker.ts` `ChunkSourceType` (→ `memory_entry`). *Files*: `shared/schema.ts`, `server/memory/chunker.ts`. *Deps*: none.
- **A2 (DevOps)** — Author `migrations/0026_practice_cards.sql` (2 tables + widen `memory_chunks` source-type CHECK; idempotent; rollback comments) per 0018/0024 style. Verify against pgvector in Docker (`make infra-up`), migrate on host. *Files*: `migrations/0026_practice_cards.sql`. *Deps*: A1 (names). Draft in parallel, finalize after A1.
- **A3 (Backend)** — Add `PracticeCard*` + `PracticeCardRefreshRun*` methods to `IStorage`, `MemStorage`, `PgStorage` mirroring `getTrigger`/`createTrigger`. *Files*: `server/storage.ts`, `server/storage-pg.ts`. *Deps*: A1.

### Phase B — Security primitives (parallel with A; blocks ingest)
- **B1 (Security)** — `server/knowledge/source-allowlist.ts`: host patterns + `isAllowed(url)`; unit tests for tricky hosts (subdomain spoof, userinfo `@`, IDN). *Deps*: none. **Parallelizable.**
- **B2 (Security)** — `server/knowledge/safe-fetch.ts`: SSRF-safe HEAD/GET (https-only, DNS resolve + private-range block, redirect cap within allowlist, timeout, body cap). Unit tests with mocked DNS/fetch (loopback/link-local/metadata/redirect-escape). *Deps*: B1. **Parallelizable with A.**

### Phase C — Practice-card service + ingest/search (core)
- **C1 (Backend)** — `server/knowledge/practice-card-service.ts`: CRUD over storage; `projectToChunk(card)` reusing `TextChunker`(`memory_entry`) + `EmbeddingProviderFactory` + `VectorStore.insertChunks`; `contentHash`; `dropProjection` via `VectorStore.deleteBySource`. *Deps*: A1, A3.
- **C2 (Backend)** — Ingest/verify/review/list/search endpoints (§4.1–4.5) appended to `server/routes/knowledge.ts` (or new `server/routes/practice-cards.ts` registered next to it at `server/routes.ts:150`). Wire auth, zod, server-side URL re-validation (B1/B2), `verifiedBy !== ingestedBy`. *Deps*: C1, B1, B2.
- **C3 (Backend)** — Search hydration (chunk hit → `practice_cards` row join). *Deps*: C1.

### Phase D — Refresh loop (depends on C)
- **D1 (Backend)** — `server/knowledge/refresh-scheduler.ts` cloned from `MaintenanceScheduler`: singleton, weekly cron (env-overridable), `start/reload/stop/triggerNow`, writes `practice_card_refresh_runs`, emits report, **no card mutation**. *Deps*: A3, C1.
- **D2 (Backend)** — Diff engine (`new/changed/stale/superseded`) as a pure, unit-tested function over (currentActiveCards, candidates). *Deps*: C1.
- **D3 (Backend)** — `POST /practice-cards/refresh` + refresh-run GET; wire scheduler `start()` into startup near `cronScheduler.bootstrap()` (`server/routes.ts:235-239`) and `stop()` into shutdown (`server/routes.ts:314`). *Deps*: D1, D2, C2.
- **D4 (Backend, later/optional)** — Signal trigger: document + stub `github_event` release hook → `triggerNow(trigger='signal')`. Wireable, not fully wired for MVP. *Deps*: D1.

### Phase E — Compliance pass (parallel with D)
- **E1 (Backend)** — `server/knowledge/compliance-mapper.ts`: load+cache `infra/graphify-out/graph.json`, map accepted cards → graph nodes, coarse followed/violated/unknown heuristic. *Deps*: C1. **Parallelizable with D.**
- **E2 (Backend)** — `GET /practice-cards/compliance` endpoint. *Deps*: E1, C2.

### Phase F — Frontend (build against contracts in parallel; integrate when endpoints land)
- **F1 (Frontend)** — Card list + detail (status, confidence, freshness badge `last_verified_at`, provenance chips ingested_by/verified_by, source links). *Deps*: C2 contract.
- **F2 (Frontend)** — Review queue UI (`pending_review`, accept/reject, supersede picker). *Deps*: §4.3.
- **F3 (Frontend)** — Refresh-run report view + "Run refresh now". *Deps*: D3.
- **F4 (Frontend)** — Compliance panel (followed/violated/unknown). *Deps*: E2.

### Phase G — QA & Security gates (continuous + final)
- **G1 (QA)** — Unit ≥80%: allowlist, safe-fetch, diff engine, content-hash, projection, state machine. *Parallel per module.*
- **G2 (QA)** — Integration: ingest→verify→review happy path; `verifiedBy===ingestedBy` 409; URL rejected 400; search returns hydrated cards; refresh writes report and mutates nothing. *Deps*: C2, D3.
- **G3 (QA, E2E)** — Playwright: review-queue accept; run-refresh-now surfaces a report. *Deps*: F2, F3.
- **G4 (Security)** — Review `/ingest` (SSRF, URL re-validation, no secret logging), auth gates on every mutating route, adversarial-gate enforcement, and that new routes close the auth gap `knowledge.ts` left open. *Deps*: C2, D3, E2. **Blocking before merge.**

**Parallelization**: A1→(A2,A3) and B1→B2 up front in parallel. C depends on A+B. D and E run in parallel after C1/C2. F builds against contracts from the start. G1 continuous; G2/G3/G4 gate the merge.

---

## 8. Risks / Open Questions (for the Lead)

1. **Server-side agent invocation boundary.** The refresh loop cannot run Claude Code agents itself. Design has the loop emit a "refresh due" signal; agents feed candidates back via `/ingest`, then diff runs server-side. **Confirm** acceptable vs. shelling out to an agent runner. (Recommend: keep as designed.)
2. **Refresh policy hosting.** Added a tiny `practice_card_refresh_runs` table + a minimal env-configured single-topic cron, not a full `refresh_policies` table. **Confirm** no per-workspace multi-topic policies needed yet.
3. **`memory_chunks` CHECK widening** drops/recreates a constraint in `0026` on an existing shared table. Low risk (idempotent). **Confirm** acceptable; alternative `practice_card_chunks` table rejected (forks the search path, loses `VectorStore` reuse).
4. **Embedding dimension consistency.** Cards reuse the workspace's embedding config (default Ollama 768d into `vector(1536)` — already how the engine works). Provider change → re-embed via existing `/re-embed`. Not a blocker.
5. **Auth gap in existing `knowledge.ts`.** All current knowledge routes are unauthenticated. New card routes are gated. **Should we retrofit auth onto existing routes in this PR**, or file a separate hardening issue? (Recommend separate issue to keep this PR focused; flagged to Security.)
6. **Compliance honesty.** MVP heuristic returns many `unknown`s. **Confirm** acceptable for a "thin first cut"; we must not surface false `followed`/`violated`.
7. **`TRIGGER_SECRET_KEY` for the signal path.** The `github_event` subsystem is disabled if `TRIGGER_SECRET_KEY` is absent (`server/routes.ts`). Cadence path has no such dependency; signal path inherits it. Note for D4.
8. **Source versioning granularity.** HashiCorp docs are unversioned pages; changelog has releases. Proposal: store the Terraform release tag for changelog-derived cards; `fetched_at` + `etag`/`last-modified` for doc pages. **Confirm** granularity.

---

## Deploying the schema

This repo materializes the database schema with **`npm run db:push`** (`drizzle-kit push`), driving the live DB from the drizzle definitions in `shared/schema.ts` (`drizzle.config.ts` → `schema: ./shared/schema.ts`, `out: ./migrations`).

- **`drizzle migrate` is journal-gated at `0012`.** `migrations/meta/_journal.json` lists tags only through `0012_memory_published`, so the journalled-migrate path stops there. The loose, hand-authored `.sql` files after it (e.g. `0026_practice_cards.sql`) are **records of intent + hardening** rather than journalled steps. They are applied via `npm run db:push` (the drizzle definitions are the source of truth) or directly via `psql` for the parts push can't express.
- **What `0026` carries** for the Active Knowledge Base:
  - The two new tables `practice_cards` and `practice_card_refresh_runs` (materialized by `db:push` from `shared/schema.ts`).
  - The `practice_cards.ingested_by_user_id` **NOT NULL** hardening (the adversarial-gate invariant) — also expressed in the schema, so `db:push` enforces it.
  - The `memory_chunks` `source_type` **CHECK** widening to include `'practice_card'`. drizzle does not model raw CHECK constraints, so this is applied by the `.sql` file / `psql` and recorded there for reproducibility.
- **Deploy steps (host):** with `DATABASE_URL` exported (see `scripts/dev-host.sh`), run `npm run db:push`. For the `memory_chunks` CHECK widening, apply the relevant statement from `migrations/0026_practice_cards.sql` via `psql` (it is idempotent — drop-if-exists + recreate).
- **Verified against the live local DB (2026-06-08):** `db:push` reports **no destructive changes** for these tables. The one prompt it raises is to add `practice_cards_content_hash_uq`; the uniqueness already exists as a `CREATE UNIQUE INDEX`, while the schema declares it via drizzle's `unique()` (a table-constraint form), so push offers to add the constraint representation. This is answered **"No, add the constraint without truncating the table"** — it is non-destructive and never requires truncation (the seeded rows have distinct content hashes). All Active-Knowledge tables/columns/CHECK are present and correct (`ingested_by_user_id` is `NOT NULL`; the `memory_chunks` CHECK includes `practice_card`).

### Seeding the example dataset

A real, idempotent example dataset of ~14 genuine Terraform module best-practice cards ships in `server/knowledge/seed-terraform-cards.ts`.

- **On startup:** seeded only when `KB_SEED_EXAMPLE=true` (off by default — no surprise seeding in prod), following the `DEFAULT_MODELS` seed pattern in `server/routes.ts`.
- **As a script:** `DATABASE_URL=... npx tsx script/seed-knowledge-example.ts` (source `.env` as `scripts/dev-host.sh` does). It prints the example workspace id and how many cards were created.
- **Idempotent + best-effort:** re-runs create no duplicates (content-hash dedupe); the example workspace owner is resolved to a real admin user (FK-valid) or left `NULL`; projection into `memory_chunks` is best-effort — if the embedding provider (Ollama) is unreachable the cards still persist and projection is skipped with a hint to run `/re-embed` later.

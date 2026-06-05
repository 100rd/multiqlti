# Memory Architecture: Omniscience for world-knowledge, native lessons for agent-experience

**Status**: Accepted
**Date**: 2026-06-05
**Author**: Platform Engineering
**Related**: Omniscience ADR [0015 — multiqlti as MCP consumer and source](https://github.com/100rd/Omniscience/blob/main/docs/decisions/0015-multiqlti-as-mcp-consumer-and-source.md)

---

## Context

multiqlti runs multi-model pipelines across 7 SDLC teams. It currently carries its own
retrieval memory: `server/memory/` (chunker → embeddings → pgvector `VectorStore` →
`Retriever`) plus `server/workspace/` incremental code indexing (#284). Separately, the
sibling project **Omniscience** (`github.com/100rd/Omniscience`) is a self-hosted,
MCP-first "Living Semantic Core" that indexes code/infra/docs/incidents into a causal,
temporal, semantic graph and exposes a `search` tool over MCP. It is **retrieval-only**
(Insight Mode) and stable at the contract level (see Omniscience ADR 0004).

Two problems motivated this decision:

1. **Duplicate indexing.** multiqlti's pgvector RAG + workspace indexer and Omniscience's
   source ingestion solve the same problem twice — two indexes, two vector stacks.
2. **Two different "memories" were conflated.** "Give the pipeline memory" actually splits
   into *world-knowledge* (what the code/infra/docs are) and *agent-experience* (what past
   runs learned). Omniscience covers the first and, by design, not the second.

## Decision

Adopt a **three-layer memory model** with single ownership per layer:

| Layer | Purpose | Owner | Read/Write |
|---|---|---|---|
| **World-knowledge** | Code, infra, docs, incidents — "what is" | **Omniscience** (MCP `search`/graph) | read-only |
| **Agent-experience (lessons)** | What past runs/stages did, what failed, decisions | **multiqlti-native (new)** | read + write |
| **Working/run memory** | Current run/session scratch context | multiqlti (existing `sessions`/`memories`) | read + write |

### 1. World-knowledge → Omniscience (no duplicate index)

- Omniscience becomes the **single owner** of source indexing and retrieval.
- multiqlti **retires** its own code/source indexing path: `server/memory` pgvector RAG and
  `server/workspace` self-indexing stop owning the index. The workspace becomes an
  **Omniscience connector** (git/fs ingestion) so each workspace is indexed once, there.
- `server/memory/Retriever` gains an `OmniscienceProvider` that calls Omniscience's MCP
  `search` tool (multiqlti already has MCP client + reverse-MCP infrastructure). Routing is
  **feature-flagged**: `local pgvector ↔ Omniscience`, with local retained as fallback until
  Omniscience is live.

### 2. Agent-experience → native lessons layer

- Omniscience is read-only and does not model the agent's own experience, so this layer is
  **built in multiqlti**. Raw material already exists: `stage_executions` (`status`,
  `error`, `output`, `rejectionReason` — note `error` was just added, #342), trace spans,
  and run outcomes.
- Captures run/stage outcomes as **lessons** (what worked/failed) and recalls relevant
  lessons at pipeline-planning time, so the pipeline improves across runs.

### 3. Closed loop

- multiqlti's **reverse-MCP** exposes run/stage/incident history as an Omniscience
  **ingestion source**. Agent experience thereby enriches world-knowledge; world-knowledge
  grounds future runs.

### 4. Contract-first, build now

- Omniscience is pre-v0.1 (its `search` is not yet live), but its MCP contract is stable
  (ADR 0004 — unknown strategies downgrade to `hybrid`). Build the integration against the
  **documented contract + a mock server**, in parallel with Omniscience reaching live
  `search`. Nothing is removed until the flag is flipped and Omniscience is verified.

## Consequences

- **Positive**: one index/vector stack instead of two; clean separation of world vs.
  experiential memory; reuse of an in-house, MCP-first product rather than re-building RAG;
  a real cross-run learning loop.
- **Negative / risks**: multiqlti gains a runtime dependency on a running Omniscience
  instance for world-knowledge retrieval (mitigated by the feature flag + local fallback
  during transition); two repos must move in coordination.
- **Migration**: additive and reversible. Phase A ships the flagged `OmniscienceProvider`
  (no behavior change by default); the workspace-indexer→connector cutover and pgvector
  retirement happen only after Omniscience `search` is verified in staging.

## Alternatives rejected

- **Port agentmemory/Omniscience capabilities natively into multiqlti** — rebuilds an
  in-house product; rejected for the world-knowledge layer (reuse Omniscience instead).
- **Keep both indexers** — the duplicate-index status quo; rejected explicitly (decision 2).
- **Use Omniscience for experience too** — impossible in v1: Omniscience is read-only Insight
  Mode and does not model agent experience.

## Rollout (tracks, all startable now)

- **Track A** (this repo): `OmniscienceProvider` behind `Retriever` + feature flag + contract
  tests against a mock. Isolated, reversible.
- **Track B** (this repo): native lessons layer over run/stage outcomes.
- **Track C** (Omniscience): advance M0→M3 to a live `hybrid search` + the workspace connector.

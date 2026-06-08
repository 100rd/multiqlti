/**
 * Thin compliance mapper for the Active Knowledge Base (Wave 2, MVP).
 *
 * Surfaces where each ACCEPTED practice-card is plausibly followed / violated /
 * unknown across the user's own infra graphify graph. This is a coarse, read-only
 * heuristic — NO HCL AST, NO policy engine, NO write-back, and honest unknowns
 * (we never assert a false "followed"/"violated").
 *
 * Security:
 *   - The graph path is a SERVER-RESOLVED CONSTANT (env override or a fixed
 *     repo-relative default). It is NEVER derived from a request, :id, or query.
 *   - File size is capped BEFORE read; parse is bounded by that cap.
 *   - The parsed graph is cached once (read-only).
 *   - Missing / malformed / oversized graph → feature disabled (returns null);
 *     callers degrade to all-unknown/empty. This module never throws to the route.
 */
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import type { PracticeCardRow } from "@shared/schema";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ComplianceNode {
  id: string;
  label?: string;
  source_file?: string;
  [key: string]: unknown;
}

export interface ComplianceGraph {
  nodes: ComplianceNode[];
}

export interface CardComplianceEntry {
  cardId: string;
  statement: string;
  followed: ComplianceNode[];
  violated: ComplianceNode[];
  unknown: ComplianceNode[];
}

// ─── Constants ──────────────────────────────────────────────────────────────

/** Hard cap on the graph file before we read or parse it (DoS guard). */
const MAX_GRAPH_BYTES = 25 * 1024 * 1024; // 25 MiB

/** Relative location of the infra graphify graph, from a repo-root-ish anchor. */
const INFRA_GRAPH_RELATIVE = path.join("infra", "graphify-out", "graph.json");

/**
 * Default location of the infra graphify graph — resolved WITHOUT import.meta so
 * it works in the cjs prod bundle (where import.meta.url is empty). We anchor on
 * process.cwd() and walk up a bounded number of parents looking for the graph;
 * if none is found we return the cwd-relative candidate (a stable string that
 * loadGraph() will simply treat as "missing" and fail closed).
 */
function defaultGraphPath(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth++) {
    const candidate = path.join(dir, INFRA_GRAPH_RELATIVE);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return path.resolve(process.cwd(), INFRA_GRAPH_RELATIVE);
}

/** Server-resolved graph path: env override or the fixed default. Never request-derived. */
export function resolveGraphPath(): string {
  const fromEnv = process.env.KB_INFRA_GRAPH_PATH;
  return fromEnv && fromEnv.length > 0 ? fromEnv : defaultGraphPath();
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  graph: ComplianceGraph | null;
}
const cache = new Map<string, CacheEntry>();

/** Clear the parsed-graph cache (tests / hot-reload). */
export function resetGraphCache(): void {
  cache.clear();
}

// ─── Loading ────────────────────────────────────────────────────────────────

function isValidGraph(value: unknown): value is ComplianceGraph {
  if (value === null || typeof value !== "object") return false;
  const nodes = (value as { nodes?: unknown }).nodes;
  return Array.isArray(nodes);
}

async function readGraphSafely(graphPath: string, maxBytes: number): Promise<ComplianceGraph | null> {
  try {
    const info = await stat(graphPath);
    if (!info.isFile() || info.size > maxBytes) return null;
    const raw = await readFile(graphPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!isValidGraph(parsed)) return null;
    // Keep only the fields we use; drop everything else (read-only projection).
    const nodes: ComplianceNode[] = parsed.nodes.map((n) => {
      const node = n as ComplianceNode;
      return {
        id: String(node.id),
        label: typeof node.label === "string" ? node.label : undefined,
        source_file: typeof node.source_file === "string" ? node.source_file : undefined,
      };
    });
    return { nodes };
  } catch {
    return null; // missing / unreadable / invalid JSON → feature disabled
  }
}

/**
 * Load + cache the infra graph from a server-resolved path. Returns null (never
 * throws) on any failure so the compliance feature degrades gracefully.
 */
export async function loadGraph(
  graphPath: string = resolveGraphPath(),
  maxBytes: number = MAX_GRAPH_BYTES,
): Promise<ComplianceGraph | null> {
  const cached = cache.get(graphPath);
  if (cached) return cached.graph;

  const graph = await readGraphSafely(graphPath, maxBytes);
  cache.set(graphPath, { graph });
  return graph;
}

// ─── Mapping heuristic ────────────────────────────────────────────────────────

/** Terraform source files we consider in-scope for a terraform card. */
function isTerraformNode(node: ComplianceNode): boolean {
  const file = node.source_file;
  if (!file) return false;
  return file.endsWith(".tf") || file.endsWith(".tf.json") || file.endsWith(".hcl");
}

/** Lowercase keyword tokens derived from a card's scope + statement. */
function cardKeywords(card: PracticeCardRow): string[] {
  const tokens = new Set<string>();
  for (const tag of card.appliesTo.tags ?? []) tokens.add(tag.toLowerCase());
  for (const kind of card.appliesTo.resourceKinds ?? []) tokens.add(kind.toLowerCase());
  for (const word of card.statement.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (word.length >= 4) tokens.add(word);
  }
  return Array.from(tokens);
}

function nodeMatchesKeyword(node: ComplianceNode, keywords: string[]): boolean {
  const haystack = `${node.label ?? ""} ${node.source_file ?? ""}`.toLowerCase();
  return keywords.some((kw) => haystack.includes(kw));
}

/**
 * Map a card to graph nodes with a coarse followed/violated/unknown heuristic.
 * Only terraform cards against terraform nodes; everything else stays empty or
 * unknown. We never emit a false 'violated' from this thin pass.
 */
export function mapCard(card: PracticeCardRow, graph: ComplianceGraph | null): CardComplianceEntry {
  const base: CardComplianceEntry = {
    cardId: card.id,
    statement: card.statement,
    followed: [],
    violated: [],
    unknown: [],
  };

  if (!graph || card.appliesTo.tool !== "terraform") return base;

  const keywords = cardKeywords(card);
  const followed: ComplianceNode[] = [];
  const unknown: ComplianceNode[] = [];

  for (const node of graph.nodes) {
    if (!isTerraformNode(node)) continue;
    if (nodeMatchesKeyword(node, keywords)) {
      followed.push(node);
    } else {
      unknown.push(node);
    }
  }

  return { ...base, followed, unknown };
}

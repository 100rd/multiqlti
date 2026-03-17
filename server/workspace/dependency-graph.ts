/**
 * DependencyGraph — Phase 6.9
 *
 * Builds a file-level dependency graph from import records in workspace_symbols.
 * In-memory LRU cache per workspace, invalidated on index completion.
 */
import path from "path";
import { db } from "../db.js";
import { workspaceSymbols } from "@shared/schema";
import { eq, and, ne } from "drizzle-orm";

// ─── Public Types ─────────────────────────────────────────────────────────────

export interface DGNode {
  id: string;
  label: string;
  importCount: number;
  importedByCount: number;
}

export interface DGEdge {
  id: string;
  source: string;
  target: string;
}

export interface DependencyGraphResponse {
  nodes: DGNode[];
  edges: DGEdge[];
}

export interface RefResult {
  file: string;
  line: number;
  col: number;
  snippet: string | null;
}

export interface SymbolDefinition {
  file: string;
  line: number;
  col: number;
  signature: string | null;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry {
  graph: DependencyGraphResponse;
  builtAt: number;
}

const MAX_CACHE_SIZE = 20;

// ─── DependencyGraph Class ────────────────────────────────────────────────────

export class DependencyGraph {
  private cache: Map<string, CacheEntry> = new Map();

  /**
   * Build and return the full dependency graph for a workspace.
   * Only includes internal (relative) imports — bare npm specifiers are excluded.
   * Results are LRU-cached per workspace (max 20 entries).
   */
  async buildGraph(workspaceId: string): Promise<DependencyGraphResponse> {
    const cached = this.cache.get(workspaceId);
    if (cached) {
      // Move to end (LRU access)
      this.cache.delete(workspaceId);
      this.cache.set(workspaceId, cached);
      return cached.graph;
    }

    // Fetch all import records for this workspace
    const importRows = await db
      .select()
      .from(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.kind, "import"),
        ),
      );

    // Build adjacency map: sourceFile → [targetFile, ...]
    const edges: DGEdge[] = [];
    const nodeSet = new Set<string>();
    const importCountMap = new Map<string, number>(); // how many files each file imports
    const importedByCountMap = new Map<string, number>(); // how many files import each file

    for (const row of importRows) {
      const specifier = row.name; // the module specifier string

      // Only include relative imports (internal deps)
      if (!specifier.startsWith(".")) continue;

      const sourceFile = row.filePath;

      // Resolve target relative to source file's directory
      const sourceDir = path.dirname(sourceFile);
      let target = path.normalize(path.join(sourceDir, specifier));

      // Normalize to forward slashes
      target = target.replace(/\\/g, "/");

      // Add extension if missing (try .ts, .tsx, .js, .jsx)
      const resolved = resolveExtension(target);

      nodeSet.add(sourceFile);
      nodeSet.add(resolved);

      const edgeId = `${sourceFile}→${resolved}`;

      // Avoid duplicate edges
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({ id: edgeId, source: sourceFile, target: resolved });

        // Update import counts
        importCountMap.set(sourceFile, (importCountMap.get(sourceFile) ?? 0) + 1);
        importedByCountMap.set(resolved, (importedByCountMap.get(resolved) ?? 0) + 1);
      }
    }

    // Build nodes
    const nodes: DGNode[] = Array.from(nodeSet).map((filePath) => ({
      id: filePath,
      label: path.basename(filePath),
      importCount: importCountMap.get(filePath) ?? 0,
      importedByCount: importedByCountMap.get(filePath) ?? 0,
    }));

    const graph: DependencyGraphResponse = { nodes, edges };

    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_CACHE_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) this.cache.delete(oldestKey);
    }

    this.cache.set(workspaceId, { graph, builtAt: Date.now() });
    return graph;
  }

  /**
   * Find all files that reference a named symbol.
   * Looks for import records where the import resolves to the file that defines the symbol.
   */
  async findReferences(workspaceId: string, symbolName: string): Promise<RefResult[]> {
    // First find the definition file for this symbol
    const defRows = await db
      .select()
      .from(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.name, symbolName),
          ne(workspaceSymbols.kind, "import"),
        ),
      );

    // Post-filter in memory (defensive — mock/cache may return unfiltered rows)
    const filteredDefRows = defRows.filter((r) => r.name === symbolName && r.kind !== "import");
    if (filteredDefRows.length === 0) return [];

    // Get the defining file (first match with lowest line number)
    const defRow = filteredDefRows.sort((a, b) => a.line - b.line)[0];
    const defFile = defRow.filePath;

    // Find all imports that import from the defining file
    const importRows = await db
      .select()
      .from(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.kind, "import"),
        ),
      );

    // Post-filter in memory (defensive)
    const filteredImportRows = importRows.filter((r) => r.kind === "import");
    const refs: RefResult[] = [];

    for (const row of filteredImportRows) {
      const specifier = row.name;
      if (!specifier.startsWith(".")) continue;

      const sourceDir = path.dirname(row.filePath);
      let resolvedTarget = path.normalize(path.join(sourceDir, specifier));
      resolvedTarget = resolvedTarget.replace(/\\/g, "/");
      const resolved = resolveExtension(resolvedTarget);

      // Check if this import resolves to the defining file
      if (resolved === defFile || resolvedTarget === defFile.replace(/\.[^.]+$/, "")) {
        refs.push({
          file: row.filePath,
          line: row.line,
          col: row.col,
          snippet: null, // snippet loading would require file re-read; omit for perf
        });
      }
    }

    return refs;
  }

  /**
   * Find the definition location of a named symbol.
   * Excludes import kind records (definition only).
   * Returns null if not found.
   */
  async findDefinition(workspaceId: string, symbolName: string): Promise<SymbolDefinition | null> {
    const rows = await db
      .select()
      .from(workspaceSymbols)
      .where(
        and(
          eq(workspaceSymbols.workspaceId, workspaceId),
          eq(workspaceSymbols.name, symbolName),
          ne(workspaceSymbols.kind, "import"),
        ),
      );

    // Post-filter in memory (defensive)
    const filtered = rows.filter((r) => r.name === symbolName && r.kind !== "import");
    if (filtered.length === 0) return null;

    // Return first match by lowest line number
    const row = filtered.sort((a, b) => a.line - b.line)[0];

    return {
      file: row.filePath,
      line: row.line,
      col: row.col,
      signature: row.signature,
    };
  }

  /**
   * Invalidate cached graph for a workspace.
   */
  invalidateCache(workspaceId: string): void {
    this.cache.delete(workspaceId);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * If target has no extension, try common TS/JS extensions.
 * Returns the target with extension if it seems like it needs one,
 * otherwise returns as-is.
 */
function resolveExtension(target: string): string {
  // If already has an extension, return as-is
  if (/\.[a-zA-Z]+$/.test(target)) return target;

  // Try adding .ts first (most common in this project)
  // For graph purposes, we use the canonical .ts form
  return `${target}.ts`;
}

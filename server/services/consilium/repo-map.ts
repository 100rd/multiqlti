/**
 * repo-map.ts — scoped "repository map" preamble for the consilium REVIEW input
 * (codegraph research recommendation, option A).
 *
 * For the files a review round's diff TOUCHES, emit a COMPACT structural map —
 * each `file → its exported/defined symbols (+ kind, cheap signature)` and its
 * 1-hop importers (`importedBy`) — so debaters + the judge can reason about
 * structural claims (blast radius, call sites) WITHOUT the whole tree. This is
 * READ-ONLY over the EXISTING workspace symbol index (`workspace_symbols`):
 * never a new dependency, never a write, watcher-maintained + nightly-rebuilt.
 *
 * BOUNDS / SAFETY (mirrors diff-context.ts):
 *   - Hard byte cap (`maxRepoMapBytes`): entries are ranked most→least important
 *     (importer count, then symbol richness) and the LEAST-referenced files are
 *     DROPPED FIRST until the render fits. It NEVER dumps the whole index.
 *   - Secret redaction: symbol signatures can embed literals, so the assembled
 *     map is run through the SAME `redactSecrets` pass the diff uses BEFORE it is
 *     returned (defence-in-depth: diff-context redacts it again on assembly).
 *   - Best-effort: an unindexed / non-TS-JS repo, an empty touched-file set, or
 *     any git/index failure yields `null` (the caller omits the section) — it
 *     NEVER throws and NEVER fails a review round.
 *
 * The BUILDER (`buildRepoMap`) is a pure function over an injected `RepoMapSource`
 * so it is unit-testable with a mocked symbol set; `createDbRepoMapSource` is the
 * thin real adapter over `workspace_symbols` + the existing `DependencyGraph`.
 */
import simpleGit from "simple-git";
import { db } from "../../db.js";
import { workspaceSymbols } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import type { SymbolKind } from "@shared/schema";
import { DependencyGraph } from "../../workspace/dependency-graph.js";
import { redactSecrets } from "./diff-redactor.js";
import { validateReviewRef } from "./ref-validator.js";

/** Kinds worth surfacing — DEFINITIONS/exports, never raw `import` rows. */
const MAP_SYMBOL_KINDS: readonly SymbolKind[] = [
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "export",
];

/** Hard structural caps so a single pathological file can never blow the map up. */
const MAX_FILES = 40;
const MAX_SYMBOLS_PER_FILE = 24;
const MAX_IMPORTERS_PER_FILE = 8;
const MAX_SIGNATURE_CHARS = 120;

const SHA_RE = /^[0-9a-f]{7,64}$/;

// ─── Public types ───────────────────────────────────────────────────────────

export interface RepoMapSymbol {
  name: string;
  kind: SymbolKind;
  /** Optional short type/param signature; may embed literals ⇒ redacted. */
  signature: string | null;
}

/** One touched file's entry: its defined/exported symbols + files that import it. */
export interface RepoMapFileEntry {
  filePath: string;
  symbols: RepoMapSymbol[];
  /** 1-hop importers (files that import this file). */
  importedBy: string[];
}

/**
 * Read-only view over the workspace symbol index the builder consumes. The real
 * impl (`createDbRepoMapSource`) queries `workspace_symbols` + the `DependencyGraph`;
 * unit tests inject a fake returning a fixed entry set.
 */
export interface RepoMapSource {
  /** Map entries for the touched files. Files with nothing indexed are omitted. */
  entriesFor(touchedFiles: readonly string[]): Promise<RepoMapFileEntry[]>;
}

/** Minimal git surface `listTouchedFiles` needs — lets tests inject a fake. */
export interface RepoMapGit {
  revparse(args: string[]): Promise<string>;
  diff(args: string[]): Promise<string>;
}

export interface BuildRepoMapRequest {
  /** Files touched by this round's diff (already bounded by the caller). */
  touchedFiles: readonly string[];
  /** Symbol-index adapter (real DB source, or a test fake). */
  source: RepoMapSource;
  /** Hard byte cap on the assembled map body (config.repoMap.maxRepoMapBytes). */
  maxRepoMapBytes: number;
}

// ─── Touched-file resolution (same discipline as diff-context B-1) ───────────

/**
 * Resolve the files touched by `baseline..ref` with the SAME security discipline
 * as diff-context: strict-hex baseline, `ref-validator`-validated ref, and every
 * git arg pinned behind `--end-of-options` so an option-looking value can never be
 * parsed as a flag. Best-effort: ANY failure ⇒ `[]` (the caller omits the map).
 * Never throws. Bounded to `MAX_FILES`.
 */
export async function listTouchedFiles(
  git: RepoMapGit,
  baseline: string,
  ref: string | null,
): Promise<string[]> {
  if (!SHA_RE.test(baseline)) return [];
  const headRef = ref ?? "HEAD";
  if (ref != null) {
    try {
      validateReviewRef(ref);
    } catch {
      return [];
    }
  }
  try {
    const base = (await git.revparse(["--verify", "--end-of-options", `${baseline}^{commit}`])).trim();
    const head = (await git.revparse(["--verify", "--end-of-options", `${headRef}^{commit}`])).trim();
    if (!SHA_RE.test(base) || !SHA_RE.test(head)) return [];
    const out = await git.diff(["--name-only", "--end-of-options", `${base}..${head}`]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/** Collapse whitespace + clip a signature so one field can't dominate the budget. */
function clampSignature(signature: string): string {
  const flat = signature.replace(/\s+/g, " ").trim();
  return flat.length > MAX_SIGNATURE_CHARS ? `${flat.slice(0, MAX_SIGNATURE_CHARS)}…` : flat;
}

function renderSymbol(sym: RepoMapSymbol): string {
  const sig = sym.signature ? clampSignature(sym.signature) : "";
  return `\`${sym.name}\`${sig ? ` ${sig}` : ""} [${sym.kind}]`;
}

/** Render ONE file entry to its compact markdown block (1–2 lines). */
function renderEntry(entry: RepoMapFileEntry): string {
  const shown = entry.symbols.slice(0, MAX_SYMBOLS_PER_FILE).map(renderSymbol);
  const symOverflow = entry.symbols.length - shown.length;
  const symText =
    shown.length > 0
      ? `${shown.join(", ")}${symOverflow > 0 ? `, …(+${symOverflow} more)` : ""}`
      : "_(no exported symbols indexed)_";
  const lines = [`- \`${entry.filePath}\`: ${symText}`];
  if (entry.importedBy.length > 0) {
    const imps = entry.importedBy.slice(0, MAX_IMPORTERS_PER_FILE).map((f) => `\`${f}\``);
    const impOverflow = entry.importedBy.length - imps.length;
    lines.push(`  imported by: ${imps.join(", ")}${impOverflow > 0 ? ` (+${impOverflow} more)` : ""}`);
  }
  return lines.join("\n");
}

/**
 * Importance: a file imported by MANY is structurally central (blast radius) →
 * keep it. Ties broken by symbol richness, then path for a STABLE order.
 */
function byImportance(a: RepoMapFileEntry, b: RepoMapFileEntry): number {
  if (b.importedBy.length !== a.importedBy.length) return b.importedBy.length - a.importedBy.length;
  if (b.symbols.length !== a.symbols.length) return b.symbols.length - a.symbols.length;
  return a.filePath < b.filePath ? -1 : a.filePath > b.filePath ? 1 : 0;
}

/**
 * Build the compact map BODY (the section header is added by diff-context on
 * assembly). Ranks entries most→least important, then keeps a PREFIX that fits
 * `maxRepoMapBytes` — dropping the least-referenced files first — and appends a
 * one-line omission note when any were dropped. Each block is secret-redacted
 * BEFORE it counts against the budget. Returns `null` when nothing maps (empty
 * input, or not even the single most-important entry fits).
 */
export async function buildRepoMap(req: BuildRepoMapRequest): Promise<string | null> {
  const { touchedFiles, source, maxRepoMapBytes } = req;
  if (touchedFiles.length === 0) return null;

  let entries: RepoMapFileEntry[];
  try {
    entries = await source.entriesFor(touchedFiles);
  } catch {
    return null; // best-effort: an index read failure omits the map, never throws.
  }
  if (entries.length === 0) return null;

  const ranked = [...entries].sort(byImportance);

  const blocks: string[] = [];
  let running = 0;
  for (const entry of ranked) {
    const block = redactSecrets(renderEntry(entry));
    const size = Buffer.byteLength(block, "utf8") + (blocks.length > 0 ? 1 : 0); // +"\n" join
    if (running + size > maxRepoMapBytes) break; // stop: all remaining (least important) dropped
    blocks.push(block);
    running += size;
  }
  if (blocks.length === 0) return null;

  const dropped = ranked.length - blocks.length;
  const note =
    dropped > 0
      ? `\n\n_(repository map truncated to the byte budget; ${dropped} less-referenced file(s) omitted)_`
      : "";
  return `${blocks.join("\n")}${note}`;
}

// ─── Real DB adapter (thin; not the unit-under-test) ─────────────────────────

/** Try common TS/JS forms so a `.ts` edge target matches a touched `.ts` file. */
function importerKeys(file: string): string[] {
  const noExt = file.replace(/\.[^./]+$/, "");
  return [file, `${noExt}.ts`, `${noExt}.tsx`, noExt];
}

/**
 * Real `RepoMapSource` over `workspace_symbols` + the existing `DependencyGraph`
 * (both keyed by `workspaceId`, both already used elsewhere in server/workspace).
 * Symbol rows are filtered to definition kinds; importers are read from the
 * dependency graph's edges (`source → target`, so importers of F are the sources
 * whose target is F). All paths are workspace-relative — the SAME shape git
 * `--name-only` returns for a 1:1 repo↔workspace bind.
 */
export function createDbRepoMapSource(
  workspaceId: string,
  graph: DependencyGraph = new DependencyGraph(),
): RepoMapSource {
  return {
    async entriesFor(touchedFiles) {
      const files = touchedFiles.slice(0, MAX_FILES);
      if (files.length === 0) return [];

      // 1-hop importers, computed ONCE from the (LRU-cached) dependency graph.
      const dg = await graph.buildGraph(workspaceId);
      const importersByTarget = new Map<string, string[]>();
      for (const edge of dg.edges) {
        const arr = importersByTarget.get(edge.target) ?? [];
        arr.push(edge.source);
        importersByTarget.set(edge.target, arr);
      }

      const kinds = new Set<string>(MAP_SYMBOL_KINDS);
      const entries: RepoMapFileEntry[] = [];
      for (const file of files) {
        const rows = await db
          .select()
          .from(workspaceSymbols)
          .where(and(eq(workspaceSymbols.workspaceId, workspaceId), eq(workspaceSymbols.filePath, file)));
        const symbols: RepoMapSymbol[] = rows
          .filter((r) => kinds.has(r.kind))
          .map((r) => ({ name: r.name, kind: r.kind as SymbolKind, signature: r.signature }));

        let importedBy: string[] = [];
        for (const key of importerKeys(file)) {
          const hit = importersByTarget.get(key);
          if (hit && hit.length > 0) {
            importedBy = Array.from(new Set(hit));
            break;
          }
        }

        // Nothing indexed for this file (non-TS/JS, or unindexed) → omit it.
        if (symbols.length === 0 && importedBy.length === 0) continue;
        entries.push({ filePath: file, symbols, importedBy });
      }
      return entries;
    },
  };
}

/** Build a real (allowlist-resolved) simple-git client for touched-file reads. */
export function repoMapGit(resolvedRepoPath: string): RepoMapGit {
  return simpleGit(resolvedRepoPath);
}

// re-export for callers/tests that want the file cap constant.
export const REPO_MAP_MAX_FILES = MAX_FILES;

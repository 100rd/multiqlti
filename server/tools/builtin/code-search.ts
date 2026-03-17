import fs from "fs";
import path from "path";
import type { ToolHandler } from "../registry";
import type { SymbolKind } from "@shared/schema";

const MAX_RESULTS = 20;
const MAX_FILE_SIZE_BYTES = 1_048_576; // 1 MB

interface SearchMatch {
  file: string;
  line: number;
  content: string;
}

/**
 * Returns true if the raw path string contains any ".." path component.
 *
 * We split on both "/" and "\" to handle cross-platform paths and check each
 * component rather than using path.normalize, which resolves ".." away for
 * absolute paths (e.g. "/safe/../../etc" normalizes to "/etc" with no "..").
 */
function containsTraversal(rawPath: string): boolean {
  const parts = rawPath.split(/[/\\]/);
  return parts.some((p) => p === "..");
}

/**
 * Resolves and validates a workspace path.
 * Returns the resolved absolute path or throws if path is unsafe.
 *
 * Security checks:
 * - Rejects null bytes in the path
 * - Rejects paths containing ".." components (checks raw input before normalization)
 * - Requires the path to resolve to an existing directory
 */
function resolveSafePath(workspacePath: string): string {
  // Reject null bytes
  if (workspacePath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // Reject ".." components in the raw path before normalization resolves them
  if (containsTraversal(workspacePath)) {
    throw new Error("Path traversal detected: '..' sequences are not allowed");
  }

  const resolved = path.resolve(workspacePath);

  // Ensure the resolved path is actually an existing directory
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Workspace path does not exist: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }

  return resolved;
}

/** Returns true if the filename matches a glob-like file pattern (supports * and **). */
function matchesFilePattern(filePath: string, pattern: string): boolean {
  // Escape regex metacharacters except * which we handle specially
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "<<<GLOBSTAR>>>")
    .replace(/\*/g, "[^/]*")
    .replace(/<<<GLOBSTAR>>>/g, ".*");
  const re = new RegExp(`(^|/)${escaped}$`);
  return re.test(filePath);
}

/** Recursively collect file paths under dir, respecting optional pattern. */
function collectFiles(dir: string, pattern?: string): string[] {
  const results: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    // Skip hidden directories and node_modules
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;

    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectFiles(full, pattern));
    } else if (entry.isFile()) {
      if (!pattern || matchesFilePattern(full, pattern)) {
        results.push(full);
      }
    }
  }

  return results;
}

/** Search for a text pattern inside a single file. Returns matched lines. */
function searchFileText(filePath: string, query: string): SearchMatch[] {
  let size: number;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return [];
  }

  if (size > MAX_FILE_SIZE_BYTES) return [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const matches: SearchMatch[] = [];
  const lines = content.split("\n");
  const lowerQuery = query.toLowerCase();

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matches.push({
        file: filePath,
        line: i + 1,
        content: lines[i].trimEnd(),
      });
    }
  }

  return matches;
}

/** Search for filenames matching query string. */
function searchFilenames(files: string[], query: string): SearchMatch[] {
  const lower = query.toLowerCase();
  return files
    .filter((f) => path.basename(f).toLowerCase().includes(lower))
    .map((f) => ({ file: f, line: 0, content: path.basename(f) }));
}

export const codeSearchHandler: ToolHandler = {
  definition: {
    name: "code_search",
    description:
      "Search through workspace source files. Find functions, classes, text patterns across all files.",
    source: "builtin",
    tags: ["code", "search", "workspace"],
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Text or pattern to search for",
        },
        type: {
          type: "string",
          enum: ["text", "filename", "symbol"],
          description: "Search mode: text (default), filename, or symbol",
          default: "text",
        },
        filePattern: {
          type: "string",
          description: "Glob pattern to filter files, e.g. '*.ts' or '**/*.py'",
        },
        workspacePath: {
          type: "string",
          description: "Root path to search in (used for text/filename modes)",
        },
        workspaceId: {
          type: "string",
          description: "Workspace ID for symbol mode — queries the indexed symbol table",
        },
      },
      required: ["query"],
    },
  },

  async execute(args) {
    const query = String(args.query ?? "").trim();
    if (!query) return "Query cannot be empty.";

    const searchType = String(args.type ?? "text");

    // ── Symbol mode: query workspace_symbols table via workspaceId ──────────
    if (searchType === "symbol") {
      const workspaceId = args.workspaceId ? String(args.workspaceId).trim() : null;
      if (!workspaceId) {
        return "Symbol search requires a workspaceId argument.";
      }

      // Lazy import to avoid db initialization at module load time
      const { db } = await import("../../db.js");
      const { workspaceSymbols } = await import("@shared/schema");
      const { eq } = await import("drizzle-orm");

      const rows = await db
        .select()
        .from(workspaceSymbols)
        .where(eq(workspaceSymbols.workspaceId, workspaceId));

      const lowerQuery = query.toLowerCase();
      const matched = rows
        .filter((r) => r.name.toLowerCase().includes(lowerQuery))
        .slice(0, MAX_RESULTS);

      if (matched.length === 0) {
        return `No symbols found matching "${query}" in workspace ${workspaceId}.`;
      }

      return matched
        .map(
          (s) =>
            `${s.filePath}:${s.line}: [${s.kind as SymbolKind}] ${s.name}${s.signature ? ` — ${s.signature}` : ""}`,
        )
        .join("\n");
    }

    // ── Text / filename modes: existing filesystem-based search ─────────────
    const rawWorkspace = String(args.workspacePath ?? "").trim();
    if (!rawWorkspace) {
      return "No workspace path specified.";
    }

    let safeRoot: string;
    try {
      safeRoot = resolveSafePath(rawWorkspace);
    } catch (err) {
      return `Invalid workspace path: ${(err as Error).message}`;
    }

    const filePattern = args.filePattern ? String(args.filePattern) : undefined;
    const files = collectFiles(safeRoot, filePattern);

    let matches: SearchMatch[];

    if (searchType === "filename") {
      matches = searchFilenames(files, query);
    } else {
      // "text" mode
      const allMatches: SearchMatch[] = [];
      for (const file of files) {
        if (allMatches.length >= MAX_RESULTS) break;
        const fileMatches = searchFileText(file, query);
        allMatches.push(...fileMatches);
      }
      matches = allMatches;
    }

    const limited = matches.slice(0, MAX_RESULTS);

    if (limited.length === 0) {
      return `No matches found for "${query}" in ${safeRoot}.`;
    }

    return limited
      .map((m) =>
        m.line > 0
          ? `${m.file}:${m.line}: ${m.content}`
          : `${m.file}`,
      )
      .join("\n");
  },
};

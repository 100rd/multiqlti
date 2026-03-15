import fs from "fs";
import path from "path";
import type { ToolHandler } from "../registry";

const MAX_FILE_SIZE_BYTES = 512_000; // 500 KB

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
 * Resolves a file path and validates it against path traversal.
 *
 * Security:
 * - Rejects paths containing null bytes
 * - Rejects paths with ".." components (path traversal — checks raw input before normalization)
 * - Does not restrict to a specific jail directory; authenticated callers may read any file
 *   they have OS-level permission to access.
 */
function resolveFilePath(rawPath: string): string {
  if (rawPath.includes("\0")) {
    throw new Error("Path contains null bytes");
  }

  // Reject ".." components in the raw path before any normalization
  if (containsTraversal(rawPath)) {
    throw new Error("Path traversal detected: '..' sequences are not allowed");
  }

  return path.resolve(rawPath);
}

export const fileReadHandler: ToolHandler = {
  definition: {
    name: "file_read",
    description:
      "Read the content of a file from the workspace. Returns file content as text.",
    source: "builtin",
    tags: ["file", "read", "workspace"],
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Absolute or relative file path",
        },
        startLine: {
          type: "number",
          description: "Start line to read from (1-indexed, inclusive)",
        },
        endLine: {
          type: "number",
          description: "End line to read to (1-indexed, inclusive)",
        },
      },
      required: ["path"],
    },
  },

  async execute(args) {
    const rawPath = String(args.path ?? "").trim();
    if (!rawPath) return "Path cannot be empty.";

    let filePath: string;
    try {
      filePath = resolveFilePath(rawPath);
    } catch (err) {
      return `Invalid path: ${(err as Error).message}`;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return `File not found: ${filePath}`;
    }

    if (!stat.isFile()) {
      return `Path is not a regular file: ${filePath}`;
    }

    if (stat.size > MAX_FILE_SIZE_BYTES) {
      return `File too large (${stat.size} bytes, max ${MAX_FILE_SIZE_BYTES} bytes): ${filePath}`;
    }

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch (err) {
      return `Failed to read file: ${(err as Error).message}`;
    }

    // Apply line range if specified
    const startLine =
      args.startLine !== undefined && args.startLine !== null
        ? Math.max(1, Number(args.startLine))
        : undefined;
    const endLine =
      args.endLine !== undefined && args.endLine !== null
        ? Math.max(1, Number(args.endLine))
        : undefined;

    if (startLine !== undefined || endLine !== undefined) {
      const lines = content.split("\n");
      const start = (startLine ?? 1) - 1; // convert to 0-indexed
      const end = endLine !== undefined ? endLine : lines.length; // endLine is inclusive

      if (start >= lines.length) {
        return `startLine ${startLine} exceeds file length (${lines.length} lines).`;
      }

      const sliced = lines.slice(start, end);
      return sliced.join("\n");
    }

    return content;
  },
};

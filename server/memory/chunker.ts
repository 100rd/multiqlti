/**
 * Text chunking for different source types.
 *
 * Strategy per source:
 *   code         — split on function/class boundaries (regex), fall back to sliding window
 *   pipeline_run — split on paragraph / blank-line boundaries
 *   document     — sentence-aware sliding window
 *   memory_entry — treat each entry as a single chunk (usually short)
 */

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChunkSourceType = "code" | "pipeline_run" | "document" | "memory_entry";

export interface TextChunk {
  text: string;
  /** 0-based index of this chunk within the source. */
  index: number;
  /** Character offset where the chunk starts in the original text. */
  startOffset: number;
  /** Character offset where the chunk ends in the original text (exclusive). */
  endOffset: number;
  /** Extra context attached to the chunk. */
  metadata: Record<string, unknown>;
}

export interface ChunkerOptions {
  maxChunkTokens?: number;
  overlapTokens?: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_CHUNK_TOKENS = 512;
const DEFAULT_OVERLAP_TOKENS = 64;

// Regex patterns that identify function/class start boundaries in JS/TS/Python.
const CODE_BOUNDARY_RE =
  /(?:^|\n)(?:export\s+)?(?:async\s+)?(?:function\b|class\b|const\s+\w+\s*=\s*(?:async\s+)?\(|def\s+\w+\s*[(]|class\s+\w+(?:\s*:|\s*[(]))/g;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function tokenEstimate(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function slidingWindowChunks(
  text: string,
  maxTokens: number,
  overlapTokens: number,
  baseOffset = 0,
  baseIndex = 0,
  meta: Record<string, unknown> = {},
): TextChunk[] {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;
  const chunks: TextChunk[] = [];
  let pos = 0;
  let index = baseIndex;

  while (pos < text.length) {
    const end = Math.min(pos + maxChars, text.length);
    const slice = text.slice(pos, end);
    chunks.push({
      text: slice,
      index,
      startOffset: baseOffset + pos,
      endOffset: baseOffset + end,
      metadata: { ...meta },
    });
    index++;
    // Advance by window minus overlap to maintain context continuity.
    pos += maxChars - overlapChars;
    if (pos >= text.length) break;
  }

  return chunks;
}

// ─── Source-specific chunkers ─────────────────────────────────────────────────

function chunkCode(text: string, opts: Required<ChunkerOptions>): TextChunk[] {
  const maxChars = opts.maxChunkTokens * CHARS_PER_TOKEN;
  const chunks: TextChunk[] = [];

  // Find all boundary positions (function/class starts).
  const boundaries: number[] = [0];
  let m: RegExpExecArray | null;
  CODE_BOUNDARY_RE.lastIndex = 0;
  while ((m = CODE_BOUNDARY_RE.exec(text)) !== null) {
    const pos = m.index === 0 ? 0 : m.index + 1; // skip leading newline
    if (pos > 0 && !boundaries.includes(pos)) {
      boundaries.push(pos);
    }
  }
  boundaries.push(text.length);

  let chunkIndex = 0;
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i];
    const end = boundaries[i + 1];
    const segment = text.slice(start, end);

    if (segment.length <= maxChars) {
      chunks.push({
        text: segment.trimStart(),
        index: chunkIndex++,
        startOffset: start,
        endOffset: end,
        metadata: { segmentIndex: i },
      });
    } else {
      // Segment too large — apply sliding window within it.
      const sub = slidingWindowChunks(segment, opts.maxChunkTokens, opts.overlapTokens, start, chunkIndex, { segmentIndex: i });
      chunkIndex += sub.length;
      chunks.push(...sub);
    }
  }

  return chunks.filter((c) => c.text.trim().length > 0);
}

function chunkByParagraphs(text: string, opts: Required<ChunkerOptions>): TextChunk[] {
  const paragraphs = text.split(/\n\s*\n/);
  const maxChars = opts.maxChunkTokens * CHARS_PER_TOKEN;
  const chunks: TextChunk[] = [];
  let chunkIndex = 0;
  let offset = 0;

  let buffer = "";
  let bufferStart = 0;

  for (const para of paragraphs) {
    const paraWithNewline = para + "\n\n";
    if (buffer.length > 0 && buffer.length + para.length > maxChars) {
      // Flush current buffer.
      chunks.push({
        text: buffer.trimEnd(),
        index: chunkIndex++,
        startOffset: bufferStart,
        endOffset: offset,
        metadata: {},
      });
      buffer = para + "\n\n";
      bufferStart = offset;
    } else {
      buffer += paraWithNewline;
    }
    offset += paraWithNewline.length;
  }

  if (buffer.trim().length > 0) {
    chunks.push({
      text: buffer.trimEnd(),
      index: chunkIndex++,
      startOffset: bufferStart,
      endOffset: offset,
      metadata: {},
    });
  }

  return chunks;
}

function chunkDocument(text: string, opts: Required<ChunkerOptions>): TextChunk[] {
  // Sentence-aware: split at sentence boundaries, then build sliding window.
  const sentenceRe = /(?<=[.!?])\s+/g;
  const sentences = text.split(sentenceRe);
  const maxChars = opts.maxChunkTokens * CHARS_PER_TOKEN;
  const overlapChars = opts.overlapTokens * CHARS_PER_TOKEN;

  const chunks: TextChunk[] = [];
  let chunkIndex = 0;
  let globalOffset = 0;

  let windowSentences: string[] = [];
  let windowStart = 0;
  let windowLen = 0;

  for (const sentence of sentences) {
    const sLen = sentence.length + 1; // +1 for separator

    if (windowLen + sLen > maxChars && windowSentences.length > 0) {
      const chunkText = windowSentences.join(" ");
      chunks.push({
        text: chunkText,
        index: chunkIndex++,
        startOffset: windowStart,
        endOffset: windowStart + chunkText.length,
        metadata: {},
      });

      // Keep overlap sentences.
      const overlapSentences: string[] = [];
      let overlapLen = 0;
      for (let i = windowSentences.length - 1; i >= 0; i--) {
        const candidate = windowSentences[i].length + 1;
        if (overlapLen + candidate <= overlapChars) {
          overlapSentences.unshift(windowSentences[i]);
          overlapLen += candidate;
        } else {
          break;
        }
      }

      windowSentences = overlapSentences;
      windowLen = overlapLen;
      windowStart = globalOffset - overlapLen;
    }

    windowSentences.push(sentence);
    windowLen += sLen;
    globalOffset += sLen;
  }

  if (windowSentences.length > 0 && windowSentences.join(" ").trim().length > 0) {
    const chunkText = windowSentences.join(" ");
    chunks.push({
      text: chunkText,
      index: chunkIndex++,
      startOffset: windowStart,
      endOffset: windowStart + chunkText.length,
      metadata: {},
    });
  }

  return chunks.filter((c) => c.text.trim().length > 0);
}

function chunkMemoryEntry(text: string, meta: Record<string, unknown> = {}): TextChunk[] {
  return [
    {
      text,
      index: 0,
      startOffset: 0,
      endOffset: text.length,
      metadata: meta,
    },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

export class TextChunker {
  private readonly opts: Required<ChunkerOptions>;

  constructor(options?: ChunkerOptions) {
    this.opts = {
      maxChunkTokens: options?.maxChunkTokens ?? DEFAULT_MAX_CHUNK_TOKENS,
      overlapTokens: options?.overlapTokens ?? DEFAULT_OVERLAP_TOKENS,
    };
  }

  chunk(text: string, sourceType: ChunkSourceType, meta: Record<string, unknown> = {}): TextChunk[] {
    if (!text || text.trim().length === 0) return [];

    switch (sourceType) {
      case "code":
        return chunkCode(text, this.opts).map((c) => ({ ...c, metadata: { ...meta, ...c.metadata } }));
      case "pipeline_run":
        return chunkByParagraphs(text, this.opts).map((c) => ({ ...c, metadata: { ...meta, ...c.metadata } }));
      case "document":
        return chunkDocument(text, this.opts).map((c) => ({ ...c, metadata: { ...meta, ...c.metadata } }));
      case "memory_entry":
        return chunkMemoryEntry(text, meta);
      default: {
        const _exhaustive: never = sourceType;
        throw new Error(`Unknown source type: ${String(_exhaustive)}`);
      }
    }
  }

  /** Rough token estimate for a chunk. */
  static estimateTokens(text: string): number {
    return tokenEstimate(text);
  }
}

/**
 * Unit tests for the TextChunker.
 *
 * Tests cover all four source types, overlap behavior, edge cases.
 */
import { describe, it, expect } from "vitest";
import { TextChunker } from "../../../server/memory/chunker.js";

describe("TextChunker", () => {
  const chunker = new TextChunker({ maxChunkTokens: 100, overlapTokens: 20 });

  // ─── memory_entry ──────────────────────────────────────────────────────────

  describe("memory_entry source type", () => {
    it("returns a single chunk for short text", () => {
      const chunks = chunker.chunk("A brief memory.", "memory_entry");
      expect(chunks).toHaveLength(1);
      expect(chunks[0].text).toBe("A brief memory.");
      expect(chunks[0].index).toBe(0);
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe("A brief memory.".length);
    });

    it("preserves metadata on the chunk", () => {
      const chunks = chunker.chunk("content", "memory_entry", { key: "val" });
      expect(chunks[0].metadata).toMatchObject({ key: "val" });
    });

    it("returns empty array for empty text", () => {
      expect(chunker.chunk("", "memory_entry")).toHaveLength(0);
      expect(chunker.chunk("   ", "memory_entry")).toHaveLength(0);
    });
  });

  // ─── document source type ──────────────────────────────────────────────────

  describe("document source type", () => {
    it("returns at least one chunk for non-empty text", () => {
      const text = "This is a sentence. And this is another. And yet another one here.";
      const chunks = chunker.chunk(text, "document");
      expect(chunks.length).toBeGreaterThanOrEqual(1);
    });

    it("each chunk is non-empty", () => {
      const text = Array.from({ length: 20 }, (_, i) => `Sentence ${i + 1} about something important.`).join(" ");
      const chunks = chunker.chunk(text, "document");
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it("chunk indices are sequential and zero-based", () => {
      const text = Array.from({ length: 30 }, (_, i) => `Word${i}.`).join(" ");
      const chunks = chunker.chunk(text, "document");
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it("larger text produces multiple chunks", () => {
      // Use a small chunker to force splits: 10 tokens = 40 chars
      const smallChunker = new TextChunker({ maxChunkTokens: 10, overlapTokens: 2 });
      // Create text of ~120 chars (3x the budget)
      const text = "Alpha beta gamma delta. " .repeat(5);
      const chunks = smallChunker.chunk(text, "document");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("applies metadata from options", () => {
      const chunks = chunker.chunk("Hello world.", "document", { docId: "abc" });
      for (const chunk of chunks) {
        expect(chunk.metadata).toMatchObject({ docId: "abc" });
      }
    });
  });

  // ─── pipeline_run source type ──────────────────────────────────────────────

  describe("pipeline_run source type", () => {
    it("splits on blank lines", () => {
      // Use a small chunker (10 tokens = 40 chars) so each paragraph forces a new chunk
      const smallChunker = new TextChunker({ maxChunkTokens: 10, overlapTokens: 0 });
      const text = "Paragraph one.\nStill in para one.\n\nParagraph two.\n\nParagraph three.";
      const chunks = smallChunker.chunk(text, "pipeline_run");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("returns single chunk when text fits budget", () => {
      const text = "Short decision: use TypeScript.";
      const chunks = chunker.chunk(text, "pipeline_run");
      expect(chunks).toHaveLength(1);
    });

    it("each chunk text is non-empty", () => {
      const text = "Para A.\n\nPara B.\n\nPara C.\n\n";
      const chunks = chunker.chunk(text, "pipeline_run");
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });
  });

  // ─── code source type ─────────────────────────────────────────────────────

  describe("code source type", () => {
    it("splits at function boundaries", () => {
      const code = `
function alpha() {
  return 1;
}

function beta() {
  return 2;
}

function gamma() {
  return 3;
}
`.trim();
      const chunks = chunker.chunk(code, "code");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("splits at class boundaries", () => {
      const code = `
class Foo {
  constructor() {}
}

class Bar {
  constructor() {}
}
`.trim();
      const chunks = chunker.chunk(code, "code");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("all chunk texts are non-empty", () => {
      const code = `
export async function doSomething(x: string): Promise<void> {
  console.log(x);
}

export class Worker {
  run() { return true; }
}
`.trim();
      const chunks = chunker.chunk(code, "code");
      for (const chunk of chunks) {
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it("applies sliding window when function body exceeds max tokens", () => {
      // Create a function body that's much larger than the 100 token limit
      const bigBody = Array.from({ length: 150 }, (_, i) => `  const x${i} = ${i};`).join("\n");
      const code = `function bigFn() {\n${bigBody}\n}\n`;
      const chunks = chunker.chunk(code, "code");
      expect(chunks.length).toBeGreaterThanOrEqual(2);
    });

    it("chunk indices are zero-based and sequential", () => {
      const code = `
function a() { return 1; }
function b() { return 2; }
function c() { return 3; }
`.trim();
      const chunks = chunker.chunk(code, "code");
      chunks.forEach((chunk, i) => {
        expect(chunk.index).toBe(i);
      });
    });

    it("returns empty array for empty code", () => {
      expect(chunker.chunk("", "code")).toHaveLength(0);
      expect(chunker.chunk("   \n  ", "code")).toHaveLength(0);
    });
  });

  // ─── Token estimation ──────────────────────────────────────────────────────

  describe("TextChunker.estimateTokens", () => {
    it("estimates 4 chars per token", () => {
      expect(TextChunker.estimateTokens("1234")).toBe(1);
      expect(TextChunker.estimateTokens("12345678")).toBe(2);
    });

    it("rounds up", () => {
      expect(TextChunker.estimateTokens("12345")).toBe(2);
    });
  });

  // ─── Chunk offsets ────────────────────────────────────────────────────────

  describe("chunk offset tracking", () => {
    it("startOffset and endOffset reflect position in original text", () => {
      const text = "Short text.";
      const chunks = chunker.chunk(text, "memory_entry");
      expect(chunks[0].startOffset).toBe(0);
      expect(chunks[0].endOffset).toBe(text.length);
    });
  });
});

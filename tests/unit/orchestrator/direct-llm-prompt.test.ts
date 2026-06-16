import { describe, it, expect } from "vitest";
import { parseDirectLlmResponse } from "../../../server/services/orchestrator/direct-llm-prompt.js";

describe("parseDirectLlmResponse — robust summary/output extraction", () => {
  it("parses pure JSON content", () => {
    const r = parseDirectLlmResponse(
      JSON.stringify({ summary: "clean one-liner", output: { ok: true }, decisions: ["a", "b"] }),
    );
    expect(r.summary).toBe("clean one-liner");
    expect(r.output).toEqual({ ok: true });
    expect(r.decisions).toEqual(["a", "b"]);
  });

  it("extracts the real summary from a preamble + ```json fence (the debate case)", () => {
    const content =
      "Это задача синтеза, инструменты не нужны. Привожу решение:\n\n" +
      "```json\n" +
      JSON.stringify({ summary: "Арбитр синтезирует спор", output: { verdict: "6.5/10" }, decisions: ["d1"] }, null, 2) +
      "\n```";
    const r = parseDirectLlmResponse(content);
    // NOT the preamble slice — the model's actual summary field.
    expect(r.summary).toBe("Арбитр синтезирует спор");
    expect(r.output).toEqual({ verdict: "6.5/10" });
    expect(r.decisions).toEqual(["d1"]);
  });

  it("extracts a bare {…} object that follows preamble prose (no fence)", () => {
    const content =
      'I do not need shell access. Here is my answer: ' +
      '{"summary": "headline", "output": {"k": 1}}  — done.';
    const r = parseDirectLlmResponse(content);
    expect(r.summary).toBe("headline");
    expect(r.output).toEqual({ k: 1 });
  });

  it("falls back to the de-hashed heading + full raw text for pure markdown (no JSON)", () => {
    const content = "## Открывающий анализ\n\nЯ открываю спор взвешенной оценкой по brief.";
    const r = parseDirectLlmResponse(content);
    // A markdown title makes a good summary: strip the `#` markers, keep the text.
    expect(r.summary).toBe("Открывающий анализ");
    expect(r.output).toEqual({ raw: content });
  });

  it("uses a prose fallback when JSON omits summary, and drops non-string decisions", () => {
    const content = '{"output": {"x": 1}, "decisions": ["keep", 42, null]}';
    const r = parseDirectLlmResponse(content);
    expect(r.summary.length).toBeGreaterThan(0);
    expect(r.output).toEqual({ x: 1 });
    expect(r.decisions).toEqual(["keep"]);
  });

  it("handles braces inside JSON string values without truncating the object", () => {
    const content =
      'preamble {"summary": "has a } brace in text", "output": {"nested": {"deep": true}}}';
    const r = parseDirectLlmResponse(content);
    expect(r.summary).toBe("has a } brace in text");
    expect(r.output).toEqual({ nested: { deep: true } });
  });
});

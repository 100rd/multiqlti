/**
 * Unit tests for MemoryExtractor.
 */
import { describe, it, expect } from "vitest";
import { MemoryExtractor } from "../../server/memory/extractor.js";

describe("MemoryExtractor", () => {
  const extractor = new MemoryExtractor();
  const PIPELINE_ID = 1;
  const RUN_ID = 42;

  // ─── Planning stage ──────────────────────────────────────────────────────────

  describe("planning stage", () => {
    it("extracts decisions from tasks array", async () => {
      const output = {
        tasks: [
          { id: "1", title: "Set up project", priority: "high" },
          { id: "2", title: "Define API", priority: "medium" },
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "planning",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const decisions = memories.filter((m) => m.type === "decision");
      expect(decisions.length).toBeGreaterThanOrEqual(2);
      expect(decisions.some((m) => m.content === "Set up project")).toBe(true);
      expect(decisions.some((m) => m.content === "Define API")).toBe(true);
    });

    it("extracts issues from risks array", async () => {
      const output = {
        risks: [
          { description: "External API may be slow", severity: "medium" },
        ],
        tasks: [],
      };
      const memories = await extractor.extractFromStageResult(
        "planning",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const issues = memories.filter((m) => m.type === "issue");
      expect(issues.some((m) => m.content === "External API may be slow")).toBe(true);
    });

    it("returns empty array when no tasks or risks", async () => {
      const memories = await extractor.extractFromStageResult(
        "planning",
        RUN_ID,
        PIPELINE_ID,
        {},
      );
      expect(memories).toHaveLength(0);
    });
  });

  // ─── Architecture stage ──────────────────────────────────────────────────────

  describe("architecture stage", () => {
    it("extracts techStack as individual decision entries", async () => {
      const output = {
        techStack: {
          language: "TypeScript",
          framework: "Express",
          database: "PostgreSQL",
        },
        components: [],
      };
      const memories = await extractor.extractFromStageResult(
        "architecture",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const decisions = memories.filter((m) => m.type === "decision");
      expect(decisions.some((m) => m.key === "tech-language" && m.content === "TypeScript")).toBe(true);
      expect(decisions.some((m) => m.key === "tech-framework" && m.content === "Express")).toBe(true);
      expect(decisions.some((m) => m.key === "tech-database" && m.content === "PostgreSQL")).toBe(true);
    });

    it("extracts components as facts", async () => {
      const output = {
        components: [
          { name: "API Gateway", type: "gateway" },
          { name: "Service Layer", type: "service" },
        ],
        techStack: {},
      };
      const memories = await extractor.extractFromStageResult(
        "architecture",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const facts = memories.filter((m) => m.type === "fact");
      expect(facts.some((m) => m.content === "API Gateway")).toBe(true);
      expect(facts.some((m) => m.content === "Service Layer")).toBe(true);
    });
  });

  // ─── Development stage ───────────────────────────────────────────────────────

  describe("development stage", () => {
    it("extracts dependencies", async () => {
      const output = {
        dependencies: [
          { name: "express", version: "^5.0.0" },
          { name: "zod", version: "^3.25.0" },
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "development",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const deps = memories.filter((m) => m.type === "dependency");
      expect(deps.some((m) => m.content === "express")).toBe(true);
      expect(deps.some((m) => m.content === "zod")).toBe(true);
    });

    it("returns empty array for empty dependencies", async () => {
      const memories = await extractor.extractFromStageResult(
        "development",
        RUN_ID,
        PIPELINE_ID,
        { dependencies: [] },
      );
      expect(memories.filter((m) => m.type === "dependency")).toHaveLength(0);
    });
  });

  // ─── Testing stage ───────────────────────────────────────────────────────────

  describe("testing stage", () => {
    it("extracts only critical issues", async () => {
      const output = {
        issues: [
          { description: "Critical null pointer", severity: "critical" },
          { description: "Minor style issue", severity: "low" },
          { description: "Warning about performance", severity: "warning" },
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "testing",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const issues = memories.filter((m) => m.type === "issue");
      expect(issues.some((m) => m.content === "Critical null pointer")).toBe(true);
      // Non-critical should be excluded
      expect(issues.some((m) => m.content === "Minor style issue")).toBe(false);
      expect(issues.some((m) => m.content === "Warning about performance")).toBe(false);
    });

    it("returns empty array when no critical issues", async () => {
      const memories = await extractor.extractFromStageResult(
        "testing",
        RUN_ID,
        PIPELINE_ID,
        { issues: [{ description: "Minor linting issue", severity: "low" }] },
      );
      expect(memories.filter((m) => m.type === "issue")).toHaveLength(0);
    });
  });

  // ─── Deduplication ───────────────────────────────────────────────────────────

  describe("deduplication (key uniqueness)", () => {
    it("two extractions with same teamId produce identical keys for same items", async () => {
      const output = {
        dependencies: [
          { name: "express", version: "^5.0.0" },
        ],
      };
      const r1 = await extractor.extractFromStageResult("development", 1, PIPELINE_ID, output);
      const r2 = await extractor.extractFromStageResult("development", 2, PIPELINE_ID, output);

      const key1 = r1[0].key;
      const key2 = r2[0].key;
      // Same item → same key (so storage can upsert on key+scope)
      expect(key1).toBe(key2);
    });

    it("key includes item name for dependency entries", async () => {
      const output = {
        dependencies: [
          { name: "vitest", version: "^4.0.0" },
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "development",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      expect(memories[0].key).toContain("vitest");
    });
  });

  // ─── Model hints ─────────────────────────────────────────────────────────────

  describe("model hints (memories field)", () => {
    it("extracts model-provided memory hints", async () => {
      const output = {
        memories: [
          { key: "auth-pattern", content: "Use JWT with refresh tokens", type: "decision" },
          { key: "db-choice", content: "PostgreSQL preferred", type: "fact" },
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "planning",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const hints = memories.filter((m) =>
        m.source?.startsWith("model-hints"),
      );
      expect(hints.some((m) => m.key === "auth-pattern")).toBe(true);
      expect(hints.some((m) => m.key === "db-choice")).toBe(true);
    });

    it("skips hints missing required fields", async () => {
      const output = {
        memories: [
          { key: "incomplete-hint" }, // missing content + type
          { content: "no key here", type: "fact" }, // missing key
        ],
      };
      const memories = await extractor.extractFromStageResult(
        "planning",
        RUN_ID,
        PIPELINE_ID,
        output,
      );
      const hints = memories.filter((m) => m.source?.startsWith("model-hints"));
      expect(hints).toHaveLength(0);
    });
  });

  // ─── Unknown stage ───────────────────────────────────────────────────────────

  it("returns empty array for stage with no rules (e.g. monitoring)", async () => {
    const memories = await extractor.extractFromStageResult(
      "monitoring",
      RUN_ID,
      PIPELINE_ID,
      { alerts: [{ name: "High CPU", severity: "critical" }] },
    );
    // monitoring has no STAGE_RULES entry — only model hints
    const ruleMemories = memories.filter((m) => !m.source?.startsWith("model-hints"));
    expect(ruleMemories).toHaveLength(0);
  });

  // ─── scopeId is always set to pipelineId string ──────────────────────────────

  it("all extracted memories have correct scopeId", async () => {
    const output = {
      tasks: [{ title: "Task A" }],
    };
    const memories = await extractor.extractFromStageResult(
      "planning",
      RUN_ID,
      PIPELINE_ID,
      output,
    );
    for (const m of memories) {
      if (!m.source?.startsWith("model-hints")) {
        expect(m.scopeId).toBe(String(PIPELINE_ID));
        expect(m.scope).toBe("pipeline");
      }
    }
  });
});

/**
 * spec-parser.test.ts — unit coverage for the SPEC-1 spec parser + ready-gate
 * (server/services/consilium/spec-parser.ts, spec-as-task.md §2/§3/§5).
 *
 * Pure/synchronous surface: frontmatter parse, the ready-gate reasons, the
 * body+DoD instruction builder, and the dependency-free glob matcher. YAML is
 * injected (js-yaml) so the malformed path is deterministic and NEVER throws.
 */
import { describe, it, expect } from "vitest";
import { load as jsYamlLoad } from "js-yaml";
import {
  parseSpecContent,
  readSpecFile,
  evaluateReadyGate,
  buildSpecInstruction,
  pathMatchesSpecGlobs,
  globToRegExp,
  SPEC_INSTRUCTION_MAX_BYTES,
  SPEC_MAX_FILE_BYTES,
} from "../../../server/services/consilium/spec-parser.js";

const load = (s: string) => jsYamlLoad(s);

const READY_SPEC = `---
title: "Add rate limiting"
status: ready
source: { kind: human, ref: "chat-42" }
repo: omnius
role: backend
skills: [security-review, api-design]
acceptanceCriteria:
  - "When a client exceeds 100 req/min Then requests are 429'd"
  - "When the window resets Then the client can call again"
---
## Problem
The login endpoint has no rate limit.

## Scope
Add a token-bucket limiter to the auth router.
`;

// ─── parseSpecContent ──────────────────────────────────────────────────────────

describe("parseSpecContent", () => {
  it("parses a well-formed spec into frontmatter + body (type-coerced)", () => {
    const r = parseSpecContent(READY_SPEC, load);
    expect(r.kind).toBe("spec");
    if (r.kind !== "spec") return;
    expect(r.frontmatter.title).toBe("Add rate limiting");
    expect(r.frontmatter.status).toBe("ready");
    expect(r.frontmatter.source).toEqual({ kind: "human", ref: "chat-42" });
    expect(r.frontmatter.repo).toBe("omnius");
    expect(r.frontmatter.role).toBe("backend");
    expect(r.frontmatter.skills).toEqual(["security-review", "api-design"]);
    expect(r.frontmatter.acceptanceCriteria).toHaveLength(2);
    expect(r.body).toMatch(/^## Problem/);
    expect(r.body).toMatch(/token-bucket limiter/);
  });

  it("lowercases status and drops non-string skills/criteria defensively", () => {
    const r = parseSpecContent(
      `---\nstatus: READY\nskills: [ok, 42, null]\nacceptanceCriteria: ["c1", 7]\n---\nbody`,
      load,
    );
    expect(r.kind).toBe("spec");
    if (r.kind !== "spec") return;
    expect(r.frontmatter.status).toBe("ready");
    expect(r.frontmatter.skills).toEqual(["ok"]);
    expect(r.frontmatter.acceptanceCriteria).toEqual(["c1"]);
  });

  it("returns not-a-spec (no-frontmatter) for a plain markdown file", () => {
    const r = parseSpecContent("# Just a doc\n\nno frontmatter here", load);
    expect(r).toEqual({ kind: "not-a-spec", reason: "no-frontmatter" });
  });

  it("returns not-a-spec (malformed-yaml) WITHOUT throwing on broken YAML", () => {
    const broken = `---\nstatus: ready\n  bad: : indent: [\n---\nbody`;
    expect(() => parseSpecContent(broken, load)).not.toThrow();
    expect(parseSpecContent(broken, load)).toEqual({ kind: "not-a-spec", reason: "malformed-yaml" });
  });

  it("returns not-a-spec (not-object) when the frontmatter is a scalar/array", () => {
    expect(parseSpecContent(`---\njust a string\n---\nbody`, load).kind).toBe("not-a-spec");
    expect(parseSpecContent(`---\n- a\n- b\n---\nbody`, load)).toEqual({
      kind: "not-a-spec",
      reason: "not-object",
    });
  });

  it("returns not-a-spec (empty) for empty content and (binary) for NUL content", () => {
    expect(parseSpecContent("", load)).toEqual({ kind: "not-a-spec", reason: "empty" });
    expect(parseSpecContent("---\nstatus: ready\n---\n\u0000\u0001bin", load)).toEqual({
      kind: "not-a-spec",
      reason: "binary",
    });
  });
});

// ─── readSpecFile (size/error guarded, injected io) ────────────────────────────

describe("readSpecFile", () => {
  it("rejects an oversized file as not-a-spec (too-large), never reading it", () => {
    let read = false;
    const r = readSpecFile("/x/big.md", load, {
      statSize: () => SPEC_MAX_FILE_BYTES + 1,
      readFile: () => {
        read = true;
        return "";
      },
    });
    expect(r).toEqual({ kind: "not-a-spec", reason: "too-large" });
    expect(read).toBe(false);
  });

  it("degrades a stat/read error to not-a-spec (unreadable), never throwing", () => {
    const r = readSpecFile("/gone.md", load, {
      statSize: () => {
        throw new Error("ENOENT");
      },
    });
    expect(r).toEqual({ kind: "not-a-spec", reason: "unreadable" });
  });

  it("parses a readable file through the same path as parseSpecContent", () => {
    const r = readSpecFile("/x/spec.md", load, {
      statSize: () => READY_SPEC.length,
      readFile: () => READY_SPEC,
    });
    expect(r.kind).toBe("spec");
  });
});

// ─── evaluateReadyGate (spec-as-task §3/§5) ────────────────────────────────────

describe("evaluateReadyGate", () => {
  const gate = (content: string) => evaluateReadyGate(parseSpecContent(content, load));

  it("FIRES only for status:ready WITH non-empty acceptanceCriteria", () => {
    const r = gate(READY_SPEC);
    expect(r.fire).toBe(true);
    if (!r.fire) return;
    expect(r.frontmatter.acceptanceCriteria.length).toBeGreaterThan(0);
  });

  it("draft → no-op(draft)", () => {
    expect(gate(`---\nstatus: draft\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "draft",
    });
  });

  it("in-progress → no-op(status:in-progress); done → no-op(status:done)", () => {
    expect(gate(`---\nstatus: in-progress\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "status:in-progress",
    });
    expect(gate(`---\nstatus: done\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "status:done",
    });
  });

  it("ready but NO acceptanceCriteria → no-op(no-acceptance-criteria) — NEVER fires", () => {
    expect(gate(`---\nstatus: ready\n---\nb`)).toEqual({
      fire: false,
      reason: "no-acceptance-criteria",
    });
    expect(gate(`---\nstatus: ready\nacceptanceCriteria: []\n---\nb`)).toEqual({
      fire: false,
      reason: "no-acceptance-criteria",
    });
  });

  it("frontmatter with no status → not-a-spec; unknown status → unknown-status", () => {
    expect(gate(`---\ntitle: x\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "not-a-spec",
    });
    expect(gate(`---\nstatus: wip\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "unknown-status",
    });
  });

  it("a not-a-spec parse → no-op(not-a-spec)", () => {
    expect(evaluateReadyGate({ kind: "not-a-spec", reason: "no-frontmatter" })).toEqual({
      fire: false,
      reason: "not-a-spec",
    });
  });

  // SPEC-2 (spec-as-task.md §4): `blocked` is a recognized INERT status — the target
  // a stalled terminal loop flips the spec to. It must NEVER fire (only `ready`
  // fires); a human moves `blocked → ready` after fixing to re-trigger.
  it("blocked → no-op(status:blocked) — an inert stalled spec never re-fires", () => {
    expect(gate(`---\nstatus: blocked\nacceptanceCriteria: ["c"]\n---\nb`)).toEqual({
      fire: false,
      reason: "status:blocked",
    });
  });

  // SPEC-2 re-run discipline (§4 #4) — the SAFE subset, enforced entirely by the
  // ready-gate: the system never AUTO-reopens; re-opening is a HUMAN status edit.
  it("re-run discipline: an in-progress/done/blocked spec whose BODY is edited still does NOT fire", () => {
    // Editing the prose of a spec already being worked / closed changes nothing —
    // the gate keys on `status`, so a 2nd loop is never spawned (per-spec dedup
    // also holds for in-progress). Only a human status flip to `ready` re-opens.
    expect(gate(`---\nstatus: in-progress\nacceptanceCriteria: ["c"]\n---\nEDITED BODY`).fire).toBe(false);
    expect(gate(`---\nstatus: done\nacceptanceCriteria: ["c"]\n---\nMATERIALLY CHANGED`).fire).toBe(false);
    expect(gate(`---\nstatus: blocked\nacceptanceCriteria: ["c"]\n---\nEDITED`).fire).toBe(false);
    // The re-open: a human moves a done spec back to `ready` → it fires again.
    expect(gate(`---\nstatus: ready\nacceptanceCriteria: ["c"]\n---\nreopened`).fire).toBe(true);
  });
});

// ─── buildSpecInstruction ──────────────────────────────────────────────────────

describe("buildSpecInstruction", () => {
  it("renders the fenced Definition-of-Done from the criteria + the body", () => {
    const out = buildSpecInstruction("The body.", ["do X", "do Y"]);
    expect(out).toContain("The body.");
    expect(out).toContain("Definition of Done — every criterion must be satisfied and verified:");
    expect(out).toContain("- do X");
    expect(out).toContain("- do Y");
    // The DoD list is fenced.
    expect(out).toMatch(/```[\s\S]*- do X[\s\S]*```/);
  });

  it("emits the DoD BEFORE the body (H1: survives a downstream head-keeping clamp)", () => {
    const out = buildSpecInstruction("BODY_MARKER", ["CRIT_MARKER"]);
    expect(out.indexOf("CRIT_MARKER")).toBeLessThan(out.indexOf("BODY_MARKER"));
  });

  it("surfaces the role as a header line (NOT a skill id)", () => {
    expect(buildSpecInstruction("b", ["c"], "backend")).toMatch(/^Role: backend/);
  });

  it("H1: a HUGE body cannot push the criteria out — DoD survives, total < the factory clamp", () => {
    const huge = "x".repeat(SPEC_INSTRUCTION_MAX_BYTES * 4);
    const out = buildSpecInstruction(huge, ["keep-me-1", "keep-me-2"]);
    // The whole instruction stays UNDER the 8 KiB factory objective clamp, so it is
    // never itself truncated downstream (criteria always reach the reviewers).
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SPEC_INSTRUCTION_MAX_BYTES);
    expect(out).toContain("[truncated]"); // the BODY is what gets clamped
    expect(out).toContain("- keep-me-1");
    expect(out).toContain("- keep-me-2");
  });

  it("L1: hundreds of large criteria are packed under budget with an 'omitted' note", () => {
    const many = Array.from({ length: 300 }, (_, i) => `criterion-${i} ` + "y".repeat(500));
    const out = buildSpecInstruction("body", many);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(SPEC_INSTRUCTION_MAX_BYTES);
    expect(out).toContain("- criterion-0"); // the first is always kept
    expect(out).toMatch(/more criteria omitted to fit budget/);
  });
});

// ─── glob matching (dependency-free) ───────────────────────────────────────────

describe("pathMatchesSpecGlobs / globToRegExp", () => {
  const globs = ["docs/specs/**/*.md", "docs/adr/**/*.md"];

  it("matches specs/ADRs at any depth under an absolute path", () => {
    expect(pathMatchesSpecGlobs("/repo/docs/specs/foo.md", globs)).toBe(true);
    expect(pathMatchesSpecGlobs("/repo/docs/specs/sub/dir/bar.md", globs)).toBe(true);
    expect(pathMatchesSpecGlobs("/repo/docs/adr/0001-x.md", globs)).toBe(true);
  });

  it("does NOT match non-.md, sibling dirs, or mid-segment collisions", () => {
    expect(pathMatchesSpecGlobs("/repo/docs/specs/readme.txt", globs)).toBe(false);
    expect(pathMatchesSpecGlobs("/repo/docs/notes.md", globs)).toBe(false);
    expect(pathMatchesSpecGlobs("/repo/xdocs/specs/foo.md", globs)).toBe(false);
    expect(pathMatchesSpecGlobs("/repo/docs/specsX/foo.md", globs)).toBe(false);
  });

  it("normalizes windows separators", () => {
    expect(pathMatchesSpecGlobs("C:\\r\\docs\\specs\\a.md", globs)).toBe(true);
  });

  it("globToRegExp: ** spans zero segments; * stays within a segment", () => {
    expect(globToRegExp("docs/specs/**/*.md").test("/r/docs/specs/a.md")).toBe(true);
    expect(globToRegExp("a/*.md").test("/r/a/b/c.md")).toBe(false); // * is not /
  });
});

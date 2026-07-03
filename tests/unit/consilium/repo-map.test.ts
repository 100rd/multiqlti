/**
 * Unit tests for server/services/consilium/repo-map.ts (Option A — the scoped
 * repository-map preamble for the consilium REVIEW input).
 *
 * The BUILDER is exercised with a MOCKED RepoMapSource (no DB, no index), and
 * `listTouchedFiles` with a FAKE git. Covers:
 *   - map built from a mocked symbol set: files → exported symbols (+kind, sig) +
 *     1-hop importers, compact format.
 *   - byte clamp drops the LEAST-important (fewest importers) files first + note.
 *   - secret redaction over signatures BEFORE the map is returned.
 *   - empty input / empty entries ⇒ null (caller omits the section).
 *   - listTouchedFiles: name-only parse, strict-hex baseline gate, ref-validator
 *     gate, `--end-of-options` pin, best-effort [] on failure.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildRepoMap,
  listTouchedFiles,
  type RepoMapSource,
  type RepoMapFileEntry,
  type RepoMapGit,
} from "../../../server/services/consilium/repo-map.js";

/** A source that returns a fixed entry set regardless of the touched files. */
function fakeSource(entries: RepoMapFileEntry[]): RepoMapSource {
  return { entriesFor: vi.fn(async () => entries) };
}

const entry = (over: Partial<RepoMapFileEntry> & { filePath: string }): RepoMapFileEntry => ({
  symbols: [],
  importedBy: [],
  ...over,
});

describe("buildRepoMap — assembly from a mocked symbol set", () => {
  it("renders touched files → exported symbols (+kind, signature) and 1-hop importers", async () => {
    const entries = [
      entry({
        filePath: "server/a.ts",
        symbols: [
          { name: "buildThing", kind: "function", signature: "(x: number): string" },
          { name: "Thing", kind: "interface", signature: null },
        ],
        importedBy: ["server/b.ts", "server/c.ts"],
      }),
    ];
    const map = await buildRepoMap({ touchedFiles: ["server/a.ts"], source: fakeSource(entries), maxRepoMapBytes: 4000 });
    expect(map).not.toBeNull();
    expect(map).toContain("`server/a.ts`");
    expect(map).toContain("`buildThing`");
    expect(map).toContain("[function]");
    expect(map).toContain("(x: number): string");
    expect(map).toContain("`Thing`");
    expect(map).toContain("[interface]");
    expect(map).toContain("imported by:");
    expect(map).toContain("`server/b.ts`");
    expect(map).toContain("`server/c.ts`");
  });

  it("omits the importers line when a file has no importers", async () => {
    const entries = [entry({ filePath: "x.ts", symbols: [{ name: "f", kind: "function", signature: null }] })];
    const map = await buildRepoMap({ touchedFiles: ["x.ts"], source: fakeSource(entries), maxRepoMapBytes: 4000 });
    expect(map).toContain("`x.ts`");
    expect(map).not.toContain("imported by:");
  });

  it("returns null for an empty touched-file set (no source call needed)", async () => {
    const src = fakeSource([entry({ filePath: "a.ts" })]);
    const map = await buildRepoMap({ touchedFiles: [], source: src, maxRepoMapBytes: 4000 });
    expect(map).toBeNull();
    expect(src.entriesFor).not.toHaveBeenCalled();
  });

  it("returns null when the index yields no entries (unindexed repo)", async () => {
    const map = await buildRepoMap({ touchedFiles: ["a.ts"], source: fakeSource([]), maxRepoMapBytes: 4000 });
    expect(map).toBeNull();
  });

  it("returns null (never throws) when the source read fails", async () => {
    const src: RepoMapSource = { entriesFor: vi.fn(async () => { throw new Error("db down"); }) };
    const map = await buildRepoMap({ touchedFiles: ["a.ts"], source: src, maxRepoMapBytes: 4000 });
    expect(map).toBeNull();
  });
});

describe("buildRepoMap — byte clamp drops least-important first", () => {
  it("keeps the most-imported files and drops the least-referenced, with a note", async () => {
    // Three files: importers 5 > 2 > 0. A tight budget fits only the top ~2.
    const mk = (name: string, importers: number): RepoMapFileEntry =>
      entry({
        filePath: name,
        symbols: [{ name: `sym_${name}`, kind: "function", signature: null }],
        importedBy: Array.from({ length: importers }, (_, i) => `imp_${name}_${i}.ts`),
      });
    const central = mk("central.ts", 5);
    const middle = mk("middle.ts", 2);
    const leaf = mk("leaf.ts", 0);

    // Budget = the EXACT rendered size of the top-two blocks (importance order),
    // so the least-important (leaf) can't fit and is dropped.
    const topTwo = await buildRepoMap({ touchedFiles: ["a", "b"], source: fakeSource([central, middle]), maxRepoMapBytes: 100_000 });
    const budget = Buffer.byteLength(topTwo!, "utf8");

    const map = await buildRepoMap({
      touchedFiles: ["a", "b", "c"],
      source: fakeSource([leaf, central, middle]), // deliberately unsorted
      maxRepoMapBytes: budget,
    });
    expect(map).not.toBeNull();
    // most-important two kept:
    expect(map).toContain("`central.ts`");
    expect(map).toContain("`middle.ts`");
    // least-important dropped:
    expect(map).not.toContain("`leaf.ts`");
    expect(map).toContain("less-referenced file(s) omitted");
    // body (blocks, before the note) respects the budget:
    const body = map!.split("\n\n_(repository map truncated")[0];
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(budget);
  });
});

describe("buildRepoMap — secret redaction", () => {
  it("redacts secrets embedded in a symbol signature before returning", async () => {
    const secret = "AKIAIOSFODNN7EXAMPLEKEYDATA1234567890";
    const entries = [
      entry({
        filePath: "cfg.ts",
        symbols: [
          { name: "DEFAULT", kind: "variable", signature: `AWS_SECRET_ACCESS_KEY=${secret}` },
        ],
      }),
    ];
    const map = await buildRepoMap({ touchedFiles: ["cfg.ts"], source: fakeSource(entries), maxRepoMapBytes: 4000 });
    expect(map).not.toBeNull();
    expect(map).not.toContain(secret);
    expect(map).toContain("<REDACTED:");
  });
});

describe("listTouchedFiles", () => {
  const BASE = "b".repeat(40);
  const HEAD_SHA = "a".repeat(40);
  const BASE_SHA = "b".repeat(40);

  function fakeGit(over: Partial<RepoMapGit> = {}): RepoMapGit {
    return {
      revparse: vi.fn(async (args: string[]) => {
        const ref = args[args.length - 1];
        if (ref.startsWith("a".repeat(7)) || ref === "HEAD^{commit}") return HEAD_SHA + "\n";
        return BASE_SHA + "\n";
      }),
      diff: vi.fn(async () => "server/a.ts\nserver/b.ts\n\n"),
      ...over,
    };
  }

  it("parses `git diff --name-only` into a clean file list", async () => {
    const files = await listTouchedFiles(fakeGit(), BASE, null);
    expect(files).toEqual(["server/a.ts", "server/b.ts"]);
  });

  it("pins --end-of-options and uses the resolved shas in the range", async () => {
    const git = fakeGit();
    await listTouchedFiles(git, BASE, null);
    const diffArgs = (git.diff as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[];
    expect(diffArgs).toContain("--name-only");
    expect(diffArgs).toContain("--end-of-options");
    expect(diffArgs).toContain(`${BASE_SHA}..${HEAD_SHA}`);
  });

  it("rejects a non-hex baseline WITHOUT touching git", async () => {
    const git = fakeGit();
    const files = await listTouchedFiles(git, "not-a-sha", null);
    expect(files).toEqual([]);
    expect(git.revparse).not.toHaveBeenCalled();
  });

  it("rejects an invalid review ref (ref-validator) WITHOUT touching git", async () => {
    const git = fakeGit();
    const files = await listTouchedFiles(git, BASE, "--upload-pack=evil");
    expect(files).toEqual([]);
    expect(git.revparse).not.toHaveBeenCalled();
  });

  it("returns [] (never throws) when git fails", async () => {
    const git = fakeGit({ revparse: vi.fn(async () => { throw new Error("not a repo"); }) });
    const files = await listTouchedFiles(git, BASE, null);
    expect(files).toEqual([]);
  });
});

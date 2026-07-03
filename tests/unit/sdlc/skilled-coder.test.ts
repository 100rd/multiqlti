/**
 * skilled-coder.test.ts — Stage 2a: capability-scoped coder invocation + the
 * executor's archetype → skilled-step wiring.
 *
 * Asserts:
 *   - buildCoderArgs capability scoping: read-only drops Edit/Write (Read only);
 *     worktree-write = the baseline; the default call is BYTE-FOR-BYTE the legacy
 *     arg array (no regression); a tool outside the baseline (Bash) is dropped.
 *   - buildCoderPrompt: the unskilled call is byte-for-byte the legacy prompt; a
 *     skilled `systemPrompt` is PREPENDED.
 *   - the executor threads the archetype into an ordered skilled-step run (N coder
 *     invocations per AP, each capability-scoped + role-prompted) and LAYERS a
 *     same-named skills row; an EMPTY skill set ⇒ the single unskilled coder per AP,
 *     called with ONLY `{ timeoutMs }` (byte-for-byte today's path).
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildCoderArgs,
  buildCoderPrompt,
  ALLOWED_TOOLS,
} from "../../../server/services/sdlc/coder.js";
import {
  runSdlcHandoff,
  type SdlcHandoffRequest,
} from "../../../server/services/sdlc/executor.js";
import type { ActionPoint } from "@shared/types";
import type { Skill } from "@shared/schema";

const WT = "/tmp/sdlc-wt-XXXX/tree";

describe("buildCoderArgs — Stage 2a capability scoping (NARROW only, never widen)", () => {
  it("the DEFAULT call is BYTE-FOR-BYTE the legacy arg array (no regression)", () => {
    expect(buildCoderArgs(WT)).toEqual([
      "-p",
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      "--allowedTools",
      "Edit",
      "Write",
      "Read",
      "--add-dir",
      WT,
    ]);
  });

  it("read-only ⇒ --allowedTools Read (drops Edit/Write)", () => {
    const args = buildCoderArgs(WT, ["Read"]);
    const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
    expect(tools).toEqual(["Read"]);
    expect(tools).not.toContain("Edit");
    expect(tools).not.toContain("Write");
    expect(args[args.indexOf("--add-dir") + 1]).toBe(WT); // confinement intact
  });

  it("worktree-write ⇒ the existing baseline (Edit Write Read)", () => {
    const args = buildCoderArgs(WT, [...ALLOWED_TOOLS]);
    const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
    expect(tools).toEqual(["Edit", "Write", "Read"]);
  });

  it("a tool OUTSIDE the baseline (Bash) is HARD-FILTERED away (never loosens the baseline)", () => {
    const args = buildCoderArgs(WT, ["Edit", "Write", "Read", "Bash"]);
    expect(args).not.toContain("Bash");
    const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
    expect(tools).toEqual(["Edit", "Write", "Read"]);
  });

  it("a wholly-empty/all-filtered request degrades to the baseline (fail-safe, never empty/widened)", () => {
    const args = buildCoderArgs(WT, ["Bash", "WebSearch"]); // all outside the ceiling
    const tools = args.slice(args.indexOf("--allowedTools") + 1, args.indexOf("--add-dir"));
    expect(tools).toEqual(["Edit", "Write", "Read"]);
    expect(tools).not.toContain("Bash");
  });
});

describe("buildCoderPrompt — Stage 2a skilled role prompt (prepended)", () => {
  const aps: ActionPoint[] = [{ title: "Add the redactor", priority: "P0", rationale: "leak" }];

  it("the unskilled call is BYTE-FOR-BYTE identical with or without an empty opts (no regression)", () => {
    expect(buildCoderPrompt(aps)).toBe(buildCoderPrompt(aps, {}));
    // No role marker leaks into the legacy prompt.
    expect(buildCoderPrompt(aps)).not.toContain("ROLE:");
    expect(buildCoderPrompt(aps)).toMatch(/ISOLATED git worktree/);
  });

  it("a skilled systemPrompt is PREPENDED before the standard instruction", () => {
    const prompt = buildCoderPrompt(aps, { systemPrompt: "ROLE: TEST AUTHOR. Write tests only." });
    expect(prompt.startsWith("ROLE: TEST AUTHOR. Write tests only.")).toBe(true);
    // The standard agent rules still follow.
    expect(prompt).toMatch(/ISOLATED git worktree/);
    expect(prompt).toMatch(/Do NOT run `git commit`/);
    expect(prompt).toContain("Add the redactor");
  });
});

// ─── executor wiring: archetype → skilled steps ──────────────────────────────

const LOOP = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const REPO = "/allowlisted/omniscience";
const BRANCH = `consilium/loop-${LOOP}/round-2`;
const APS: ActionPoint[] = [
  { title: "Fix the parser", priority: "P0", rationale: "bug" },
  { title: "Add the redactor", priority: "P1" },
];

const baseReq = (over: Partial<SdlcHandoffRequest> = {}): SdlcHandoffRequest => ({
  repoPath: REPO,
  loopId: LOOP,
  round: 2,
  actionPoints: APS,
  allowedRepoPaths: ["/allowlisted"],
  ...over,
});

const FAKE_WT = { worktreeDir: WT, baseDir: "/tmp/sdlc-wt-XXXX", branch: BRANCH, baseRef: "main" };

function makeGitRaw() {
  return vi.fn(async (_repo: string, args: string[]) => {
    if (args[0] === "status") return " M server/x.ts\n";
    if (args[0] === "rev-parse") return "headsha000\n";
    return "";
  });
}

function makeDeps(over: Record<string, unknown> = {}) {
  return {
    createWorktree: vi.fn(async () => FAKE_WT),
    removeWorktree: vi.fn(async () => undefined),
    resolveDefaultBranchFn: vi.fn(async () => "main"),
    runCoder: vi.fn(async () => ({ ok: true, summary: "edited", tokensUsed: 5 })),
    push: vi.fn(async () => ({ ok: true as const, branch: BRANCH })),
    openPr: vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/9" })),
    gitRaw: makeGitRaw(),
    ...over,
  };
}

function makeSkill(over: Partial<Skill>): Skill {
  return {
    projectId: null, id: "s1", name: "coder", description: "", teamId: "t1",
    systemPromptOverride: "", tools: [], modelPreference: null, outputSchema: null,
    tags: [], isBuiltin: false, isPublic: true, createdBy: "system", version: "1.0.0",
    sharing: "public", usageCount: 0, forkedFrom: null, sourceType: "manual",
    gitSourceId: null, externalSource: null, externalId: null, externalVersion: null,
    installedAt: null, autoUpdate: null, createdAt: new Date(), updatedAt: new Date(),
    ...over,
  } as Skill;
}

describe("runSdlcHandoff — archetype → SKILLED steps wiring", () => {
  it("repo-assessment runs TWO ordered coder invocations PER action point (test-author → coder), each capability-scoped + role-prompted", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(baseReq({ archetype: "repo-assessment" }), deps as never);

    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    // 2 steps × 2 action points = 4 coder invocations.
    expect(calls).toHaveLength(2 * APS.length);
    // Per AP the steps run in order: a test-author prompt then a coder prompt, both
    // worktree-write (the baseline tool set), all confined to the worktree.
    for (const call of calls) {
      const [dir, aps, opts] = call;
      expect(dir).toBe(WT);
      expect(aps).toHaveLength(1);
      expect(opts.allowedTools).toEqual([...ALLOWED_TOOLS]); // worktree-write baseline
      expect(typeof opts.systemPrompt).toBe("string");
      expect(opts.systemPrompt.length).toBeGreaterThan(0); // a role prompt was injected
      expect(opts.timeoutMs).toBeUndefined(); // none set on baseReq → undefined, as before
    }
    // The first step for AP0 is the TEST AUTHOR, the second is the IMPLEMENTER.
    expect(calls[0][2].systemPrompt).toMatch(/TEST AUTHOR/i);
    expect(calls[1][2].systemPrompt).toMatch(/IMPLEMENTER/i);
  });

  it("records the skilled steps that ran in the Draft-PR body (audit), without changing the result contract", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    const res = await runSdlcHandoff(baseReq({ archetype: "repo-assessment" }), deps as never);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9"); // unchanged contract
    const [, opts] = (deps.openPr as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(opts.body).toContain("skills: test-author -> coder");
  });

  it("LAYERS a same-named skills row's systemPromptOverride into that step's prompt", async () => {
    const row = makeSkill({ name: "coder", systemPromptOverride: "PREFER pytest fixtures." });
    const deps = makeDeps({ getSkills: vi.fn(async () => [row]) });
    await runSdlcHandoff(baseReq({ archetype: "repo-assessment" }), deps as never);

    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    // The 'coder' step (2nd per AP) carries the layered override; 'test-author' does not.
    expect(calls[1][2].systemPrompt).toContain("PREFER pytest fixtures.");
    expect(calls[0][2].systemPrompt).not.toContain("PREFER pytest fixtures.");
  });

  it("EMPTY skill set (archetype null) ⇒ the SINGLE unskilled coder per AP, called with ONLY { timeoutMs } (byte-for-byte today's path)", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(baseReq({ archetype: null, coderTimeoutMs: 999 }), deps as never);

    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(APS.length); // one coder per AP — UNCHANGED
    for (const call of calls) {
      const opts = call[2];
      expect(opts).toEqual({ timeoutMs: 999 }); // NO allowedTools / systemPrompt keys
    }
    // getSkills is never even consulted for an empty skill set.
    expect(deps.getSkills).not.toHaveBeenCalled();
  });

  it("a non-skilled archetype (research) ⇒ the single unskilled coder per AP", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(baseReq({ archetype: "research" }), deps as never);
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(APS.length);
    expect(deps.getSkills).not.toHaveBeenCalled();
  });

  it("a getSkills failure falls back to baked-in step defaults (never fails the round)", async () => {
    const deps = makeDeps({
      getSkills: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    const res = await runSdlcHandoff(baseReq({ archetype: "repo-assessment" }), deps as never);
    // Steps still run on their baked-in defaults; the round still opens its PR.
    expect((deps.runCoder as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2 * APS.length);
    expect(res.prRef).toBe("https://github.com/x/y/pull/9");
  });
});

describe("runSdlcHandoff — operator-pinned coderModel threaded ONCE at the seam", () => {
  it("threads req.coderModel into EVERY coder invocation of the UNSKILLED path", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(
      baseReq({ archetype: null, coderTimeoutMs: 999, coderModel: "sonnet" }),
      deps as never,
    );
    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(APS.length); // one coder per AP — UNCHANGED count
    for (const call of calls) {
      // Every call carries the model AND preserves the existing opts (timeoutMs).
      expect(call[2]).toEqual({ timeoutMs: 999, model: "sonnet" });
    }
  });

  it("threads req.coderModel into ALL of the SKILLED multi-step invocations (shared seam)", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(
      baseReq({ archetype: "repo-assessment", coderModel: "gemini-pro" }),
      deps as never,
    );
    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(2 * APS.length); // test-author → coder, per AP
    // Every invocation — test-author AND implementer, every AP — carries the model,
    // while the per-step allowedTools/systemPrompt are still set as before.
    for (const call of calls) {
      expect(call[2].model).toBe("gemini-pro");
      expect(call[2].allowedTools).toEqual([...ALLOWED_TOOLS]);
      expect(typeof call[2].systemPrompt).toBe("string");
    }
  });

  it("ABSENT coderModel ⇒ opts carry NO model key (byte-for-byte today's invocation)", async () => {
    const deps = makeDeps({ getSkills: vi.fn(async () => [] as Skill[]) });
    await runSdlcHandoff(baseReq({ archetype: null, coderTimeoutMs: 999 }), deps as never);
    const calls = (deps.runCoder as ReturnType<typeof vi.fn>).mock.calls;
    for (const call of calls) {
      expect(call[2]).toEqual({ timeoutMs: 999 });
      expect("model" in call[2]).toBe(false); // no model key was folded in
    }
  });
});

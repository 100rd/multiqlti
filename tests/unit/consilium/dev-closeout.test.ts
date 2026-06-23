/**
 * dev-closeout.test.ts — D.5 unit coverage for `DevPrCloseout` (design §14.2 /
 * §14.7). Drives the close-out over a FAKE WorkspaceManager + FAKE pr-wrapper
 * (push/openDraftPr) + FAKE workspace-bind + a FAKE stage-only git — no real
 * repo, no `gh` binary, no network.
 *
 * Asserts:
 *   - happy path → `{ prRef: <url>, headCommit }`.
 *   - `openDraftPr` typed-fail → branch-only `{ prRef: null, error }` (loop NOT
 *     failed — the close-out never throws).
 *   - push fail → branch-only `{ prRef: null, error }`.
 *   - **B-5: a pre-existing dirty/untracked `secret.env` in the fake tree is NOT
 *     staged — `git.add` is called with the EXPLICIT pathspec
 *     `["--", "CONSILIUM_ROUND_<n>.md"]`, NEVER `"."`.** This is the load-bearing
 *     guarantee that the close-out commits only its own artifact, not the
 *     Omniscience checkout's ~7 unrelated dirty files.
 *   - B-3: the branch name is the server-derived `consilium/loop-<id>/round-<n>`.
 */
import { describe, it, expect, vi } from "vitest";
import {
  DevPrCloseout,
  closeoutBranchName,
  closeoutArtifactName,
  renderArtifact,
  type CloseoutManager,
  type CloseoutGit,
  type DevCloseoutRequest,
} from "../../../server/services/consilium/dev-closeout.js";
import type { ActionPoint } from "@shared/types";

const LOOP = "11111111-2222-3333-4444-555555555555";
const REPO = "/allowlisted/omniscience";
const ROOTS = ["/allowlisted"];

const APS: ActionPoint[] = [
  { title: "Fix the FSM cap precedence", priority: "P0" },
  { title: "Add the redactor", priority: "P0" },
];

const baseReq = (over: Partial<DevCloseoutRequest> = {}): DevCloseoutRequest => ({
  loopId: LOOP,
  round: 2,
  repoPath: REPO,
  ownerId: "user1",
  allowedRepoPaths: ROOTS,
  openActionPoints: APS,
  ...over,
});

/** A workspace row the binder returns (its `path` is the local checkout root). */
const WS = { id: "ws1", type: "local" as const, path: REPO, branch: "main" };

/** Fake WorkspaceManager: records branch + write calls, never touches disk. */
function fakeManager(over: Partial<CloseoutManager> = {}): CloseoutManager & {
  gitBranch: ReturnType<typeof vi.fn>;
  switchBranch: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
} {
  return {
    gitBranch: vi.fn(async () => undefined),
    switchBranch: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    ...over,
  } as never;
}

/**
 * Fake stage-only git. The `add` mock is the B-5 sentinel: the test asserts
 * EXACTLY which pathspec it is handed. A dirty `secret.env` lives in this fake
 * "tree" only conceptually — the guarantee is purely that `add` is never given
 * `"."`, so an untracked file can never enter the staged set.
 */
function fakeGit(over: Partial<CloseoutGit> = {}): CloseoutGit & {
  add: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  revparse: ReturnType<typeof vi.fn>;
} {
  return {
    add: vi.fn(async () => undefined),
    commit: vi.fn(async () => undefined),
    revparse: vi.fn(async () => "headsha000\n"),
    ...over,
  } as never;
}

const okPush = vi.fn(async () => ({ ok: true as const, branch: closeoutBranchName(LOOP, 2) }));
const okStorage = { getWorkspaces: vi.fn(), createWorkspace: vi.fn() } as never;

function make(over: {
  manager?: CloseoutManager;
  git?: CloseoutGit;
  push?: ReturnType<typeof vi.fn>;
  openPr?: ReturnType<typeof vi.fn>;
} = {}) {
  const manager = over.manager ?? fakeManager();
  const git = over.git ?? fakeGit();
  const closeout = new DevPrCloseout({
    manager,
    storage: okStorage,
    resolveWorkspace: vi.fn(async () => WS) as never,
    push: (over.push ?? okPush) as never,
    openPr: (over.openPr ??
      vi.fn(async () => ({ ok: true as const, prUrl: "https://github.com/x/y/pull/7" }))) as never,
    gitFor: () => git,
  });
  return { closeout, manager, git };
}

describe("pure helpers", () => {
  it("closeoutBranchName is the server-derived B-3 shape", () => {
    expect(closeoutBranchName(LOOP, 2)).toBe(`consilium/loop-${LOOP}/round-2`);
  });
  it("closeoutArtifactName is a write-allowlisted .md", () => {
    expect(closeoutArtifactName(2)).toBe("CONSILIUM_ROUND_2.md");
  });
  it("renderArtifact lists titles + priority only (H-4: no diff, no secrets)", () => {
    const body = renderArtifact(2, APS);
    expect(body).toContain("(P0) Fix the FSM cap precedence");
    expect(body).toContain("(P0) Add the redactor");
    expect(body).not.toMatch(/diff|secret|password|PRIVATE KEY/i);
  });
});

describe("DevPrCloseout.run", () => {
  it("happy path → { prRef:<url>, headCommit }", async () => {
    const { closeout, manager } = make();
    const res = await closeout.run(baseReq());
    expect(res.prRef).toBe("https://github.com/x/y/pull/7");
    expect(res.headCommit).toBe("headsha000");
    expect(res.error).toBeUndefined();
    // B-3: the branch handed to gitBranch is server-derived.
    expect(manager.gitBranch).toHaveBeenCalledWith(WS, `consilium/loop-${LOOP}/round-2`);
    // The artifact written is the bounded .md.
    expect(manager.writeFile).toHaveBeenCalledWith(WS, "CONSILIUM_ROUND_2.md", expect.stringContaining("(P0)"));
  });

  it("B-5: stages ONLY the artifact via the explicit pathspec — NEVER `.` (no secret.env)", async () => {
    // Conceptually the fake tree carries a dirty/untracked `secret.env`. The
    // guarantee: `add` is called with the EXACT one-file pathspec, so an
    // untracked file can never be swept into the commit (which `git add .` would).
    const { closeout, git } = make();
    await closeout.run(baseReq());
    expect(git.add).toHaveBeenCalledTimes(1);
    expect(git.add).toHaveBeenCalledWith(["--", "CONSILIUM_ROUND_2.md"]);
    // The load-bearing negative assertions: no broad pathspec EVER reaches add.
    for (const call of git.add.mock.calls) {
      const spec = call[0] as string[];
      expect(spec).toEqual(["--", "CONSILIUM_ROUND_2.md"]);
      expect(spec).not.toContain(".");
      expect(spec).not.toContain("secret.env");
      expect(spec).not.toContain("-A");
      expect(spec).not.toContain("--all");
    }
    // Commit happens AFTER the staged-only add (so only the artifact is committed).
    expect(git.commit).toHaveBeenCalledTimes(1);
  });

  it("openDraftPr typed-fail → branch-only { prRef:null, error } (loop NOT failed, no throw)", async () => {
    const openPr = vi.fn(async () => ({ ok: false as const, kind: "gh-failed" as const, message: "gh unauthenticated" }));
    const { closeout } = make({ openPr });
    const res = await closeout.run(baseReq());
    expect(res.prRef).toBeNull();
    expect(res.headCommit).toBe("headsha000"); // head still captured before push/PR
    expect(res.error).toContain("open PR manually");
    // The branch WAS pushed — the chain still produced a reviewable branch.
    expect(okPush).toHaveBeenCalled();
  });

  it("push fail → branch-only { prRef:null, error } (never throws)", async () => {
    const push = vi.fn(async () => ({ ok: false as const, kind: "unknown" as const, message: "no remote" }));
    const openPr = vi.fn();
    const { closeout } = make({ push, openPr });
    const res = await closeout.run(baseReq());
    expect(res.prRef).toBeNull();
    expect(res.error).toContain("push failed");
    expect(openPr).not.toHaveBeenCalled(); // never attempt the PR if push failed
  });

  it("M-6: an existing branch (gitBranch throws) → switchBranch, still succeeds", async () => {
    const manager = fakeManager({
      gitBranch: vi.fn(async () => {
        throw new Error("branch already exists");
      }) as never,
    });
    const { closeout } = make({ manager });
    const res = await closeout.run(baseReq());
    expect((manager as never as { switchBranch: ReturnType<typeof vi.fn> }).switchBranch).toHaveBeenCalledWith(
      WS,
      `consilium/loop-${LOOP}/round-2`,
    );
    expect(res.prRef).toBe("https://github.com/x/y/pull/7");
  });

  it("writeFile throwing → { prRef:null, error } before any push (never throws)", async () => {
    const manager = fakeManager({
      writeFile: vi.fn(async () => {
        throw new Error("disk full at /allowlisted/omniscience/CONSILIUM_ROUND_2.md");
      }) as never,
    });
    const push = vi.fn();
    const { closeout } = make({ manager, push });
    const res = await closeout.run(baseReq());
    expect(res.prRef).toBeNull();
    expect(res.error).toBeDefined();
    expect(res.error).not.toContain("/allowlisted"); // scrubbed fs layout
    expect(push).not.toHaveBeenCalled();
  });
});

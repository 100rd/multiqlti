/**
 * dev-closeout.ts — D.5 of the consilium loop (design §14.2).
 *
 * The controller runs this on the DEVELOPING→AWAITING_MERGE side effect, AFTER
 * the (now non-blocking, D.1) DEV handoff group settles. No pipeline can write
 * the repo or open a PR (§14.1), so the loop OWNS a deterministic, bounded
 * branch + Draft PR step built on the EXISTING primitives:
 *   resolveLoopWorkspace (D.3) → gitBranch → writeFile → stage-only commit →
 *   pushBranch (D.4) → openDraftPr (D.4).
 *
 * The artifact is a single bounded `.md` checklist of the still-open action
 * points (already length-bounded by A1's L-2) — NO diff body, NO secrets (H-4).
 *
 * NEVER THROWS. Returns `{ prRef, headCommit, error? }`:
 *   - happy path → `prRef = <PR URL>`.
 *   - `gh` absent/unauth/failure (typed `WrapFail`) → branch-only fallback:
 *     `prRef = null`, `error = "pushed branch <b>; open PR manually"` — the loop
 *     is NEVER failed (§14.2 Lead decision, H-6).
 *   - any VCS failure before push → `prRef = null` + scrubbed error.
 *
 * Security (BINDING, Security has VETO — §14.6):
 *   B-3  `branchName` is built ONLY from server-controlled `loopId` + `round`
 *        (`consilium/loop-<uuid>/round-<n>`); the regex gate lives in pr-wrapper
 *        but we construct it correctly here — NEVER from action-point text.
 *   B-4  push/PR target only `origin` of the allowlisted `repoPath`; the only
 *        write is the one bounded `.md` artifact.
 *   B-5  **stage ONLY the artifact** — we do NOT use `manager.gitCommit` (it runs
 *        `git add .` and would commit unrelated dirty files). We stage exactly
 *        one file via an explicit pathspec `add(["--", fileName])` then commit.
 *   H-5  workspace bind re-runs `assertAllowedRepoPath` + realpath (in D.3).
 *   H-4  the artifact carries only titles + priorities; no diff, no secrets.
 *   M-6  branch/PR idempotency is handled in pr-wrapper (existing-PR reuse) and
 *        here by tolerating an already-existing branch (switch instead of fail).
 */
import { simpleGit } from "simple-git";
import type { WorkspaceRow } from "@shared/schema";
import type { ActionPoint, ResearchReport } from "@shared/types";
import { resolveLoopWorkspace } from "./workspace-bind.js";
import { pushBranch, openDraftPr } from "./pr-wrapper.js";

// ─── Result (never-throw) ────────────────────────────────────────────────────

export interface DevCloseoutResult {
  /** Draft PR URL, or null on the branch-only fallback / any VCS failure. */
  prRef: string | null;
  /** HEAD sha of the new branch after the commit; "" when unreadable. */
  headCommit: string;
  /** Scrubbed error/fallback note — present on any non-happy path. */
  error?: string;
  /**
   * Stage 2b: the aggregated per-criterion test summary for the round, surfaced by
   * the SDLC executor when verification ran (kill-switch on). The controller persists
   * it to `consilium_loop_rounds.testSummary` so the NEXT review round grounds its
   * convergence verdict in REAL test results. Undefined ⇒ verification did not run
   * (Stage-2a / kill-switch off) — nothing to persist.
   */
  testSummary?: string;
  /**
   * Stage 3 (research archetype): the structured research report produced by
   * `runResearchHandoff` INSTEAD of code + a Draft PR. Present ONLY on a research
   * close-out; undefined for the SDLC/coder path (so that result shape is unchanged).
   * The controller persists it out-of-band to `consilium_loop_rounds.report` on the
   * same settle wire as `testSummary`.
   */
  report?: ResearchReport;
}

// ─── Injectable seams (unit tests inject fakes — no real repo / gh) ──────────

/** The subset of `WorkspaceManager` the close-out drives (branch + write). */
export interface CloseoutManager {
  gitBranch(workspace: WorkspaceRow, branchName: string): Promise<void>;
  switchBranch(workspace: WorkspaceRow, branchName: string): Promise<void>;
  writeFile(workspace: WorkspaceRow, filePath: string, content: string): Promise<void>;
}

/** Minimal git surface for the stage-only commit + HEAD read (B-5). */
export interface CloseoutGit {
  add(pathspec: string[]): Promise<unknown>;
  commit(message: string): Promise<unknown>;
  revparse(args: string[]): Promise<string>;
}

export interface DevPrCloseoutDeps {
  manager: CloseoutManager;
  /** Workspace binder (D.3). Defaults to the real `resolveLoopWorkspace`. */
  resolveWorkspace?: typeof resolveLoopWorkspace;
  /** D.4 push. Defaults to the real `pushBranch`. */
  push?: typeof pushBranch;
  /** D.4 Draft-PR opener. Defaults to the real `openDraftPr`. */
  openPr?: typeof openDraftPr;
  /** Factory for the stage-only git client at a repo path (B-5 testability). */
  gitFor?: (repoPath: string) => CloseoutGit;
  /** The workspace-bind storage seam (getWorkspaces/createWorkspace). */
  storage: Parameters<typeof resolveLoopWorkspace>[0];
}

/** The per-run inputs the controller hands the close-out. */
export interface DevCloseoutRequest {
  loopId: string;
  round: number;
  repoPath: string;
  ownerId: string;
  allowedRepoPaths: readonly string[];
  openActionPoints: readonly ActionPoint[];
  /** Default PR base; falls back to "main" (the repo's main branch). */
  base?: string;
}

const ARTIFACT_TITLE_MAX = 200;

/** Build the deterministic, server-derived branch name (B-3). */
export function closeoutBranchName(loopId: string, round: number): string {
  return `consilium/loop-${loopId}/round-${round}`;
}

/** Build the deterministic artifact file name (`.md` is write-allowlisted). */
export function closeoutArtifactName(round: number): string {
  return `CONSILIUM_ROUND_${round}.md`;
}

/**
 * Render the open action points as a bounded markdown checklist (H-4: titles +
 * priority only — NO diff body, NO secrets). Already length-bounded upstream by
 * A1's L-2; we re-clamp each title defensively.
 */
export function renderArtifact(round: number, aps: readonly ActionPoint[]): string {
  const lines = aps.map((ap) => {
    const title = ap.title.slice(0, ARTIFACT_TITLE_MAX);
    const priority = ap.priority ?? "-";
    return `- [ ] (${priority}) ${title}`;
  });
  return [
    `# Consilium round ${round} — open action points`,
    "",
    "Open action points from the consilium verdict. Implement and merge to close the round.",
    "",
    ...lines,
    "",
  ].join("\n");
}

/** Scrub fs layout from an error string before returning it (mirror pr-wrapper). */
function scrub(raw: string): string {
  return raw.replace(/\/[^\s'"]+/g, "<path>").replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * `DevPrCloseout` — orchestrates branch→write→(stage-only)commit→push→Draft PR.
 * Each method is <30 lines; the public `run` never throws (branch-only fallback
 * on any VCS failure, §14.2).
 */
export class DevPrCloseout {
  constructor(private readonly deps: DevPrCloseoutDeps) {}

  private get resolveWorkspace() {
    return this.deps.resolveWorkspace ?? resolveLoopWorkspace;
  }
  private get push() {
    return this.deps.push ?? pushBranch;
  }
  private get openPr() {
    return this.deps.openPr ?? openDraftPr;
  }
  private gitFor(repoPath: string): CloseoutGit {
    return this.deps.gitFor ? this.deps.gitFor(repoPath) : simpleGit(repoPath);
  }

  /**
   * Run the close-out. Returns `{ prRef, headCommit, error? }`; NEVER throws.
   * Steps 1-7 of §14.2.
   */
  async run(req: DevCloseoutRequest): Promise<DevCloseoutResult> {
    const branchName = closeoutBranchName(req.loopId, req.round); // B-3.
    const fileName = closeoutArtifactName(req.round);
    let ws: WorkspaceRow;
    try {
      // Step 1: bind the workspace (D.3 re-runs H-5 allowlist + realpath).
      ws = await this.resolveWorkspace(
        this.deps.storage,
        req.repoPath,
        req.ownerId,
        req.allowedRepoPaths,
      );
      // Steps 2-4: branch → write artifact → STAGE-ONLY commit (B-5).
      await this.prepareBranch(ws, branchName, fileName, req);
    } catch (err) {
      return { prRef: null, headCommit: "", error: scrub(errMsg(err)) };
    }
    // Step 7 (HEAD) is read after the commit, before push, so it is captured
    // even if push/PR then fail (the branch-only fallback still has a real sha).
    const headCommit = await this.readHead(ws.path);
    // Steps 5-6: push + Draft PR (each typed-fail → branch-only fallback).
    return this.pushAndOpen(req, branchName, headCommit);
  }

  /**
   * Steps 2-4: create/switch the branch, write the bounded artifact, then commit
   * ONLY that file. B-5: explicit pathspec `add(["--", fileName])` — NEVER
   * `git add .` (which `manager.gitCommit` does and would sweep in unrelated
   * dirty files such as a pre-existing `secret.env`).
   */
  private async prepareBranch(
    ws: WorkspaceRow,
    branchName: string,
    fileName: string,
    req: DevCloseoutRequest,
  ): Promise<void> {
    await this.checkoutBranch(ws, branchName); // M-6: tolerate an existing branch.
    await this.deps.manager.writeFile(ws, fileName, renderArtifact(req.round, req.openActionPoints));
    const git = this.gitFor(ws.path);
    await git.add(["--", fileName]); // B-5: stage EXACTLY the one artifact.
    await git.commit(`consilium round ${req.round}: open action points`);
  }

  /** M-6: a re-driven round may already hold the branch — switch, don't fail. */
  private async checkoutBranch(ws: WorkspaceRow, branchName: string): Promise<void> {
    try {
      await this.deps.manager.gitBranch(ws, branchName);
    } catch {
      await this.deps.manager.switchBranch(ws, branchName);
    }
  }

  /** Resolve the new branch HEAD; "" when unreadable (best-effort, never throws). */
  private async readHead(repoPath: string): Promise<string> {
    try {
      return (await this.gitFor(repoPath).revparse(["HEAD"])).trim();
    } catch {
      return "";
    }
  }

  /**
   * Steps 5-6: push the branch then open a Draft PR. A push failure or a `gh`
   * typed-failure both degrade to the branch-only fallback (`prRef: null`); the
   * loop is NEVER failed (§14.2, H-6).
   */
  private async pushAndOpen(
    req: DevCloseoutRequest,
    branchName: string,
    headCommit: string,
  ): Promise<DevCloseoutResult> {
    const pushed = await this.push(req.repoPath, branchName);
    if (!pushed.ok) {
      return { prRef: null, headCommit, error: scrub(`push failed: ${pushed.message}`) };
    }
    const base = req.base ?? "main"; // default branch when not easily resolvable.
    const pr = await this.openPr(req.repoPath, {
      base,
      head: branchName,
      title: `Consilium round ${req.round}: open action points`,
      body: renderArtifact(req.round, req.openActionPoints),
    });
    if (!pr.ok) {
      return { prRef: null, headCommit, error: `pushed branch ${branchName}; open PR manually` };
    }
    return { prRef: pr.prUrl, headCommit };
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}


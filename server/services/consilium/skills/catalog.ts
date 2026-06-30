/**
 * catalog.ts — Stage 2a skill catalog (code-side, ZERO migration).
 *
 * A thin SELECTION + BINDING layer over the EXISTING skills system. It turns the
 * loop's Stage-1 `archetype` into an ordered list of SKILLED coder steps so the
 * SDLC develop phase can run an archetype-aware, multi-step coder instead of the
 * single unskilled coder. It is a strict SUPERSET of today's behavior:
 *
 *   - An archetype that maps to NO steps (`research` / `infra` / `null` / anything
 *     unrecognised) returns `[]`, and the executor falls back to TODAY'S single
 *     unskilled-coder-per-action-point path — BYTE-FOR-BYTE unchanged. Stage 2a
 *     REGRESSES NOTHING.
 *   - `repo-assessment` maps to an ordered TDD pair: a TEST AUTHOR then a CODER.
 *
 * Stage 2a executes NOTHING new: each `SkilledStep` only RECORDS the verification
 * method it WOULD use (`test-run`) — the sandboxed test runner that consumes it is
 * Stage 2b. No tests run, no network, no live env here.
 *
 * SECURITY (Stage 2a is low-risk — NO new execution):
 *   - The coder baseline (isolated worktree, env allowlist, no Bash, Draft-PR-only)
 *     is UNCHANGED. A step's `capability` can only ever NARROW the tool surface
 *     (`read-only` ⇒ Read only); it can NEVER widen it (see `capabilityTools`).
 *   - Step system prompts are CODE-TRUST (baked-in below). A same-named row in the
 *     existing `skills` table MAY layer its `systemPromptOverride` (user-authored,
 *     already in the platform) and INTERSECT its `tools` — intersection can only
 *     narrow, so a skill row can never grant a tool outside the capability ceiling.
 */
import type { Archetype } from "@shared/types";
import type { Skill } from "@shared/schema";
import { ALLOWED_TOOLS } from "../../sdlc/coder.js";

/**
 * What a skilled step is allowed to touch. `read-only` confines the coder to the
 * `Read` tool (no Edit/Write); `worktree-write` is the EXISTING coder baseline
 * (Edit/Write/Read inside the isolated worktree). `deploy-live` is Stage 3 — it is
 * deliberately NOT a member here.
 */
export type SkillCapability = "read-only" | "worktree-write";

/**
 * How a step's output WOULD be verified. Stage 2a only RECORDS this for the round
 * audit / Stage 2b; it does NOT execute any verification.
 */
export type VerificationMethod = "test-run" | "judge" | "none";

/**
 * One ordered step of a skilled implement run. `skillName` is the lookup key into
 * the existing `skills` table (optional layering); `systemPrompt` is the baked-in
 * DEFAULT so the step works against an EMPTY skills table.
 */
export interface SkilledStep {
  /** Stable id (archetype-scoped) for logs / the round audit. */
  id: string;
  /** Lookup key into the existing `skills` table for OPTIONAL layering. */
  skillName: string;
  /** Tool-surface ceiling for this step. Only ever NARROWS the coder baseline. */
  capability: SkillCapability;
  /** The verification method Stage 2b WOULD run. Stage 2a records it, never runs it. */
  verification: VerificationMethod;
  /** Baked-in DEFAULT system prompt (works against an EMPTY skills table). */
  systemPrompt: string;
}

/**
 * A {@link SkilledStep} resolved against the skills table: the effective system
 * prompt + the capability-scoped, skill-narrowed tool allowlist handed to the
 * coder invocation.
 */
export interface BoundSkillStep {
  /** The catalog step this binding came from. */
  step: SkilledStep;
  /** Effective system prompt: baked-in default, plus a skill row override if present. */
  systemPrompt: string;
  /** Effective `--allowedTools`: capability base, narrowed by the skill row's tools. */
  allowedTools: readonly string[];
  /** The skills-table row id that was layered, or null (baked-in default only). */
  boundSkillId: string | null;
}

// ─── Baked-in DEFAULT step prompts (code-trust) ──────────────────────────────

const TEST_AUTHOR_PROMPT = [
  "ROLE: TEST AUTHOR (test-driven development, RED step).",
  "For the action point(s) below, write or update AUTOMATED TESTS that encode the",
  "expected behavior / acceptance criteria as executable checks. Author ONLY tests",
  "— do NOT implement the production code; a later step writes the implementation.",
  "Place tests beside the project's existing test suite, following its conventions.",
  "The tests should FAIL against the current code (red) and pass once the",
  "implementation lands. Do NOT run the tests — the server runs them later.",
].join("\n");

const CODER_PROMPT = [
  "ROLE: IMPLEMENTER (test-driven development, GREEN step).",
  "Make the production code/spec edits that satisfy the action point(s) and that",
  "would make the authored tests pass. Prefer the SMALLEST correct change. Do not",
  "weaken or delete tests to make them pass; fix the implementation instead.",
].join("\n");

/**
 * Select the ordered skilled steps for an archetype. The ONLY wired archetype in
 * Stage 2a is `repo-assessment` (a TDD test-author → coder pair). Every other
 * value — `research`, `infra`, `null`, or anything unrecognised — returns `[]`, so
 * the executor falls back to today's single unskilled coder (NO regression).
 *
 * `params` (the loop's `archetype_params`) is carried for forward-compatibility;
 * Stage 2a does not branch on it.
 */
export function selectSkillSet(
  archetype: Archetype | null,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  params?: Record<string, string> | null,
): SkilledStep[] {
  switch (archetype) {
    case "repo-assessment":
      return [
        {
          id: "repo-assessment/test-author",
          skillName: "test-author",
          capability: "worktree-write",
          verification: "test-run",
          systemPrompt: TEST_AUTHOR_PROMPT,
        },
        {
          id: "repo-assessment/coder",
          skillName: "coder",
          capability: "worktree-write",
          verification: "test-run",
          systemPrompt: CODER_PROMPT,
        },
      ];
    // research / infra → deferred to Stage 3; null / unknown → today's path.
    default:
      return [];
  }
}

/**
 * The tool-surface CEILING for a capability. `read-only` ⇒ just `Read`;
 * `worktree-write` ⇒ the EXISTING coder baseline ({@link ALLOWED_TOOLS}). Both are
 * subsets of the baseline — a capability can only ever NARROW the coder, never
 * widen it. Returns a fresh array so callers cannot mutate the shared baseline.
 */
export function capabilityTools(capability: SkillCapability): readonly string[] {
  switch (capability) {
    case "read-only":
      return ["Read"];
    case "worktree-write":
      return [...ALLOWED_TOOLS];
  }
}

/**
 * Bind a catalog step to an OPTIONAL same-named skills-table row.
 *
 *   - System prompt: the baked-in default, plus the row's `systemPromptOverride`
 *     appended when present (the override REFINES the code-trust default).
 *   - Tools: the capability base, INTERSECTED with the row's `tools` when the row
 *     lists any. Intersection can only NARROW (never widen past the capability
 *     ceiling). A row whose tools are DISJOINT from the ceiling (e.g. lists only
 *     `Bash`) imposes no usable constraint, so the capability base is kept rather
 *     than stripping the step to zero tools — a skill row can WEAKEN but never
 *     GRANT a capability.
 */
export function bindSkillStep(step: SkilledStep, skillRow: Skill | undefined): BoundSkillStep {
  const base = capabilityTools(step.capability);

  let systemPrompt = step.systemPrompt;
  const override = (skillRow?.systemPromptOverride ?? "").trim();
  if (override) systemPrompt = `${step.systemPrompt}\n\n${override}`;

  let allowedTools = base;
  const rowTools = skillRow?.tools ?? [];
  if (rowTools.length > 0) {
    const narrowed = base.filter((t) => rowTools.includes(t));
    // Disjoint row tools ⇒ keep the capability base (no widening, no zeroing).
    allowedTools = narrowed.length > 0 ? narrowed : base;
  }

  return { step, systemPrompt, allowedTools, boundSkillId: skillRow?.id ?? null };
}

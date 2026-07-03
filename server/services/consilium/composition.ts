/**
 * composition.ts — the read-only, computed "who does what" of a consilium loop
 * (Observability GAP 2). It answers a question the loop row alone cannot: WHICH
 * models/tools fill each role of a round — the dispute debaters + judge (from the
 * review-factory preset panel), the intent planner, the judge-timeout fallback,
 * the SDLC coder (provider/CLI), the Stage-B per-criterion verifier, and the
 * active verification config (commands/timeouts/gates).
 *
 * It is ADDITIVE and READ-ONLY: surfaced as the `composition` block on
 * GET /api/consilium-loops/:id and rendered as the "Composition" card. Nothing
 * downstream branches on it.
 *
 * SECURITY (the ONLY hard rule here): this is a **strict allowlist** of NAMES and
 * BOOLEANS. It reads model slugs (server constants), kill-switch flags, timeouts,
 * and operator-configured test/lint COMMANDS — the same names already surfaced in
 * PR bodies / round `testSummary`. It NEVER reads a secret: no `apiKey`, no
 * `encryption.key`, no `clusterSecret`, no token. Do not spread config; every
 * field below is picked explicitly by name so a future secret added to the config
 * schema can never leak through here.
 */
import type { AppConfig } from "../../config/schema.js";
import { effectiveVerificationEnabled } from "../../config/schema.js";
import { PRESET_PANELS, type ConsiliumPanel } from "./review-factory.js";
import { CONSILIUM_REVIEW_PRESETS, type ConsiliumReviewPreset } from "@shared/types";

/** One role in the round → the model/tool that fills it. */
export interface CompositionRole {
  /** Machine role key ("debater" | "judge" | "planner" | "coder" | "verifier"). */
  readonly role: string;
  /** Human display label (e.g. "Opus", "Judge", "SDLC coder"). */
  readonly label: string;
  /** Catalog model slug, or null when the role runs on a tool rather than a slug. */
  readonly model: string | null;
  /** The tool/provider a role runs through (e.g. "claude CLI (local)"), when applicable. */
  readonly tool?: string | null;
  /** For a gated role: whether the kill-switch that arms it is on. */
  readonly enabled?: boolean;
}

/** The active verification config — names + booleans only (no secrets). */
export interface CompositionVerification {
  readonly implementEnabled: boolean;
  readonly perCriterionMethodEnabled: boolean;
  readonly verificationEnabled: boolean;
  /** The gated truth (verification.enabled AND sandbox/trusted-repo ack). */
  readonly effectiveVerificationEnabled: boolean;
  readonly finalVerificationEnabled: boolean;
  readonly testCommand: string | null;
  readonly lintCommand: string | null;
  readonly testRunTimeoutMs: number;
  readonly sdlcTimeoutMs: number;
  readonly maxFixIterations: number;
}

/** The computed composition block surfaced on the loop GET. */
export interface LoopComposition {
  /** The review preset (recovered from the group name), or null when unknown. */
  readonly preset: ConsiliumReviewPreset | null;
  /** The cross-review dispute participants (one per panel seat). */
  readonly debaters: CompositionRole[];
  /** The synthesizing judge. */
  readonly judge: CompositionRole;
  /** Judge-timeout resilience: bounded single-retry + optional fallback model. */
  readonly judgeRetry: { readonly enabled: boolean; readonly fallbackModel: string | null };
  /** The intent→archetype planner. */
  readonly planner: CompositionRole;
  /** The SDLC coder (provider/CLI that implements action points). */
  readonly coder: CompositionRole;
  /** The Stage-B `judge`-method per-criterion verifier. */
  readonly verifier: CompositionRole;
  /** The active verification config. */
  readonly verification: CompositionVerification;
}

const GROUP_NAME_PRESET_RE = /^\[consilium-review:([a-z0-9-]+)\]/i;

/**
 * Recover the review preset from a consilium group's NAME (the factory names the
 * group `[consilium-review:<preset>] <repo>`). Returns null for a name that does
 * not match or names an unknown preset — the caller renders the panel from the
 * default (all presets share the proven 2-model panel today) and simply omits the
 * preset label. Pure + defensive: never throws on a malformed/absent name.
 */
export function parseConsiliumPreset(
  groupName: string | null | undefined,
): ConsiliumReviewPreset | null {
  if (!groupName) return null;
  const m = GROUP_NAME_PRESET_RE.exec(groupName);
  const candidate = m?.[1];
  if (!candidate) return null;
  return (CONSILIUM_REVIEW_PRESETS as readonly string[]).includes(candidate)
    ? (candidate as ConsiliumReviewPreset)
    : null;
}

/**
 * Build the loop's composition from the (recovered) preset + the parsed config.
 * PURE — no I/O, no side effects. The panel is the preset's panel when known, else
 * the canonical cross-review panel (every preset shares it today, so a null preset
 * still yields the correct debaters/judge). Every config read is an explicit,
 * name-by-name allowlist pick — see the file header security note.
 */
export function buildLoopComposition(
  preset: ConsiliumReviewPreset | null,
  config: AppConfig,
): LoopComposition {
  const panel: ConsiliumPanel =
    (preset && PRESET_PANELS[preset]) || PRESET_PANELS["sdlc-cross-review"];

  const loopCfg = config.pipeline.consiliumLoop;
  const impl = loopCfg.implement;

  const debaters: CompositionRole[] = panel.reviewers.map((r) => ({
    role: "debater",
    label: r.name,
    model: r.modelSlug,
  }));

  const judge: CompositionRole = {
    role: "judge",
    label: "Judge",
    model: panel.judgeModelSlug,
  };

  const planner: CompositionRole = {
    role: "planner",
    label: "Intent planner",
    model: loopCfg.planner.model,
    enabled: loopCfg.planner.enabled,
  };

  // The SDLC coder runs through the Anthropic provider: "cli" mode = the local
  // `claude` CLI (subscription-backed, 0 API tokens); "api" = the billed Anthropic
  // API. Only the MODE, the resulting tool NAME, and the (operator-pinned) model
  // slug are exposed — never the apiKey. When the operator pins
  // `implement.coderModel` it is surfaced VERBATIM (the coder spawns `--model
  // <slug>`); absent ⇒ the coder runs on the CLI's OWN default (cli mode shows the
  // known default slug, api mode has no slug).
  const cliMode = config.providers.anthropic.mode === "cli";
  const coder: CompositionRole = {
    role: "coder",
    label: "SDLC coder",
    model: impl.coderModel ?? (cliMode ? "claude-opus" : null),
    tool: cliMode ? "claude CLI (local)" : "Anthropic API",
  };

  const verifier: CompositionRole = {
    role: "verifier",
    label: "Stage-B verifier",
    model: impl.perCriterionMethod.judgeModel,
    enabled: impl.perCriterionMethod.enabled,
  };

  const verification: CompositionVerification = {
    implementEnabled: impl.enabled,
    perCriterionMethodEnabled: impl.perCriterionMethod.enabled,
    verificationEnabled: impl.verification.enabled,
    effectiveVerificationEnabled: effectiveVerificationEnabled(config),
    finalVerificationEnabled: impl.finalVerification.enabled,
    testCommand: impl.testCommand,
    lintCommand: impl.lintCommand,
    testRunTimeoutMs: impl.testRunTimeoutMs,
    sdlcTimeoutMs: loopCfg.sdlcTimeoutMs,
    maxFixIterations: impl.maxFixIterations,
  };

  return {
    preset,
    debaters,
    judge,
    judgeRetry: {
      enabled: loopCfg.judgeRetry.enabled,
      fallbackModel: loopCfg.judgeRetry.fallbackModel ?? null,
    },
    planner,
    coder,
    verifier,
    verification,
  };
}

/**
 * infra-refresh.ts — ADR-003 §D1/§D4 Phase 3c: read-only infra reconcile step.
 *
 * At the `reviewing` stage, an OPT-IN loop may run a READ/PLAN-ONLY infra command
 * (e.g. `terraform plan -refresh-only`, `kubectl diff`) against the live target,
 * using secrets LEASED for the reviewing phase, to reconcile remembered vs. actual
 * infrastructure. Only the SCRUBBED, bounded summary is returned — it feeds the
 * dispute context. The raw secret is delivered ONLY to this controlled subprocess,
 * NEVER to a reviewer/debater LLM prompt or env.
 *
 * Security invariants:
 *   - NEVER mutating: the command argv is a fixed read/plan-only allowlist, and a
 *     defense-in-depth deny-guard rejects any mutating token (apply/destroy/…).
 *   - No shell: argv-array `execFile` only — no interpolation, no injection.
 *   - Fail-soft: any error (binary missing, no creds, timeout, non-zero exit) yields
 *     a bounded note, never throws — the review proceeds without a drift summary.
 *   - Output is value-scrubbed with the per-run leased set before it leaves here.
 */
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { scrubSecrets } from "../../gateway/secret-scrub.js";

export type InfraRepoKind = "terraform" | "kubernetes";

export interface InfraRefreshResult {
  /** True when a read-only command actually ran (regardless of drift found). */
  ran: boolean;
  kind?: InfraRepoKind;
  /** Scrubbed, bounded drift/plan summary for the dispute context ("" when not run). */
  summary: string;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_SUMMARY_CHARS = 4_000;

/** Binary per repo kind. */
const BINARY: Record<InfraRepoKind, string> = {
  terraform: "terraform",
  kubernetes: "kubectl",
};

/**
 * READ/PLAN-ONLY command sequence per repo kind (ADR-003 §D4 — never apply/destroy).
 * Each entry is a full argv (no shell). Steps run in order; a non-zero exit is
 * captured as best-effort output, not thrown (e.g. `kubectl diff` exits 1 on drift).
 * The exact incantation is infra-specific and may need per-repo tuning by the
 * operator; the security guarantee (read-only) is enforced here regardless.
 */
export const READ_ONLY_STEPS: Record<
  InfraRepoKind,
  readonly (readonly string[])[]
> = {
  terraform: [
    ["init", "-input=false", "-no-color", "-lock=false"],
    ["plan", "-refresh-only", "-input=false", "-no-color", "-lock=false"],
  ],
  kubernetes: [["diff", "-R", "-f", "."]],
};

/**
 * Defense-in-depth: reject any mutating token even though the argv is a fixed
 * allowlist above. A single match aborts the whole refresh (fail-closed on intent).
 */
const MUTATION_DENY =
  /^(apply|destroy|delete|replace|patch|edit|create|rollout|scale|drain|cordon|uncordon|taint|annotate|label|set|exec|cp|attach|port-forward|--?auto-approve)$/i;

export function assertReadOnly(argv: readonly string[]): void {
  for (const tok of argv) {
    if (MUTATION_DENY.test(tok)) {
      throw new Error(
        `infra-refresh: refusing mutating token "${tok}" — read/plan-only only`,
      );
    }
  }
}

/**
 * Best-effort repo-kind detection. Conservative: returns null (⇒ no refresh) unless
 * a clear marker is present at the repo root. `.tf` ⇒ terraform; a kustomization ⇒
 * kubernetes. Never throws.
 */
export async function detectRepoKind(
  repoDir: string,
): Promise<InfraRepoKind | null> {
  let entries: string[];
  try {
    entries = await readdir(repoDir);
  } catch {
    return null;
  }
  if (entries.some((f) => f.endsWith(".tf"))) return "terraform";
  if (
    entries.some((f) => f === "kustomization.yaml" || f === "kustomization.yml")
  ) {
    return "kubernetes";
  }
  return null;
}

function execReadOnly(
  binary: string,
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...argv],
      { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, shell: false },
      (err, stdout, stderr) => {
        // Non-zero exit (err set) still carries useful drift output (e.g. kubectl
        // diff exits 1 when drift exists). Capture both streams either way.
        resolve({
          stdout: stdout?.toString() ?? "",
          stderr: stderr?.toString() ?? (err ? String(err.message ?? err) : ""),
        });
      },
    );
  });
}

/**
 * Run the read-only reconcile for a repo, delivering `env` (leased secrets layered
 * by the caller over a sanitized allowlist) to the subprocess. Returns a scrubbed,
 * bounded summary. Fail-soft: never throws.
 */
export async function runInfraRefresh(p: {
  repoDir: string;
  /** Env for the subprocess — caller layers leased secrets over a sanitized base. */
  env: NodeJS.ProcessEnv;
  /** Per-run leased secret values to scrub from the summary (ADR-003 §D). */
  scrubValues: readonly string[];
  kindOverride?: InfraRepoKind;
  timeoutMs?: number;
}): Promise<InfraRefreshResult> {
  try {
    const kind = p.kindOverride ?? (await detectRepoKind(p.repoDir));
    if (!kind) return { ran: false, summary: "" };

    const steps = READ_ONLY_STEPS[kind];
    const timeout = p.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    let raw = "";
    for (const argv of steps) {
      assertReadOnly(argv); // fail-closed on any mutating token
      const { stdout, stderr } = await execReadOnly(
        BINARY[kind],
        argv,
        p.repoDir,
        p.env,
        timeout,
      );
      raw += `$ ${BINARY[kind]} ${argv.join(" ")}\n${stdout}${stderr ? `\n${stderr}` : ""}\n`;
    }

    const scrubbed = scrubSecrets(raw, p.scrubValues).trim();
    const summary =
      scrubbed.length > MAX_SUMMARY_CHARS
        ? `${scrubbed.slice(0, MAX_SUMMARY_CHARS)}\n… [truncated]`
        : scrubbed;
    return { ran: true, kind, summary };
  } catch (err: unknown) {
    // Fail-soft: the review proceeds without a drift summary. Scrub the message too.
    const msg = scrubSecrets(
      err instanceof Error ? err.message : String(err),
      p.scrubValues,
    );
    return { ran: false, summary: `infra-refresh unavailable: ${msg}` };
  }
}

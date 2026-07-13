/**
 * typed-secret.ts — ADR-003 §D3 Phase 3b: typed secret shaping.
 *
 * A secret carries a `type`; its decrypted `value` is interpreted accordingly and
 * shaped into the delivery form the exec-time consumer expects:
 *   - `static`     → a single env var keyed by the secret name (today's behavior).
 *   - `aws`        → JSON `{ accessKeyId, secretAccessKey, sessionToken?, region? }`
 *                    → the standard AWS_* env vars (ADR-003 §D4).
 *   - `kubernetes` → the kubeconfig YAML → written by the caller to a per-run 0600
 *                    temp file with `KUBECONFIG=<path>` (the caller owns the file's
 *                    lifecycle: create in the sandbox, remove in `finally`).
 *
 * PURE: no fs / no env access. The caller (deliverLeasedEnv) materializes any
 * kubeconfig temp file and threads `scrubExtra` into the run's dynamic scrubber so
 * a typed value that never sat in process.env is still redacted from run output.
 */
import { z } from "zod";

export const SECRET_TYPES = ["static", "aws", "kubernetes"] as const;
export type SecretType = (typeof SECRET_TYPES)[number];

export interface ShapedSecret {
  /** Env vars to layer OVER the sanitized allowlist. */
  env: Record<string, string>;
  /**
   * Kubernetes only: kubeconfig YAML the caller must write to a per-run temp file
   * (mode 0600) and expose as `KUBECONFIG=<path>`, removing it in `finally`.
   */
  kubeconfig?: string;
  /** Raw secret material for the per-run dynamic scrub set (ADR-003 §D). */
  scrubExtra: string[];
}

const AwsCredsSchema = z.object({
  accessKeyId: z.string().min(1),
  secretAccessKey: z.string().min(1),
  sessionToken: z.string().min(1).optional(),
  region: z.string().min(1).optional(),
});

/**
 * Shape a decrypted secret value into its typed delivery form. Throws on a malformed
 * typed payload (e.g. non-JSON / missing fields for `aws`) — the caller
 * (deliverLeasedEnv) is fail-soft and drops the offending secret rather than the run.
 */
export function shapeTypedSecret(p: {
  name: string;
  type: SecretType;
  value: string;
}): ShapedSecret {
  switch (p.type) {
    case "static":
      return { env: { [p.name]: p.value }, scrubExtra: [p.value] };

    case "aws": {
      let parsed: unknown;
      try {
        parsed = JSON.parse(p.value);
      } catch {
        throw new Error(`typed-secret "${p.name}" (aws): value is not valid JSON`);
      }
      const creds = AwsCredsSchema.parse(parsed);
      const env: Record<string, string> = {
        AWS_ACCESS_KEY_ID: creds.accessKeyId,
        AWS_SECRET_ACCESS_KEY: creds.secretAccessKey,
      };
      if (creds.sessionToken) env.AWS_SESSION_TOKEN = creds.sessionToken;
      if (creds.region) env.AWS_DEFAULT_REGION = creds.region;
      // Region is not secret; the key material is. Scrub the credential parts.
      const scrubExtra = [creds.accessKeyId, creds.secretAccessKey];
      if (creds.sessionToken) scrubExtra.push(creds.sessionToken);
      return { env, scrubExtra };
    }

    case "kubernetes":
      // The value IS the kubeconfig YAML; the caller writes it to a temp file.
      return { env: {}, kubeconfig: p.value, scrubExtra: [p.value] };
  }
}

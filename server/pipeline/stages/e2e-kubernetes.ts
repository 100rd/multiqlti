/**
 * Ephemeral Kubernetes Test Environment Stage (issue #272).
 *
 * Stage type: e2e_kubernetes
 *
 * Lifecycle:
 *   1. Validate inputs + guardrails
 *   2. Create namespace `mq-run-<runId>` with labels (ephemeral=true, ttl=hours)
 *   3. Apply namespace-level ResourceQuota + NetworkPolicy (default-deny egress)
 *   4. Deploy app via Helm (workspace chart or bundled generic chart)
 *   5. Wait for rollout readiness (deployment rollout, endpoints, custom command)
 *   6. Run test command in a test pod — capture stdout/stderr + exit code
 *   7. Collect artifacts: test logs, rendered Helm manifest, pod events on failure
 *   8. Teardown:  success → delete immediately (configurable)
 *                 failure → leave namespace with TTL annotation for janitor
 *
 * Security guardrails (enforced before any cluster interaction):
 *   - No privileged containers
 *   - No hostNetwork
 *   - No hostPath volumes
 *   - Egress locked to default-deny unless `allowedEgressHosts` declared
 *
 * All cluster commands are executed via `child_process.spawn` — no shell
 * interpolation, no string-concatenated kubectl/helm arguments.
 *
 * The `CommandRunner` interface allows injecting a test double for unit tests
 * without needing to mock the `child_process` module.
 */

import { spawn } from "child_process";
import type {
  E2eKubernetesStageConfig,
  E2eKubernetesResult,
  E2eKubernetesArtifacts,
} from "@shared/types";

// ─── Command runner abstraction ───────────────────────────────────────────────

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Dependency-injectable command runner.
 * Production code uses `defaultCommandRunner`; tests inject a fake.
 */
export interface CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts?: { stdinData?: string; timeoutMs?: number },
  ): Promise<CommandResult>;
}

/** Production command runner backed by child_process.spawn. */
export class SpawnCommandRunner implements CommandRunner {
  run(
    cmd: string,
    args: string[],
    opts: { stdinData?: string; timeoutMs?: number } = {},
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
      proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            proc.kill("SIGKILL");
          }, opts.timeoutMs)
        : null;

      proc.on("close", (code) => {
        if (timer) clearTimeout(timer);
        if (timedOut) {
          resolve({ stdout, stderr: `Timed out after ${opts.timeoutMs}ms`, exitCode: 124 });
        } else {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        }
      });

      proc.on("error", (err) => {
        if (timer) clearTimeout(timer);
        resolve({ stdout, stderr: err.message, exitCode: 1 });
      });

      if (opts.stdinData !== undefined) {
        proc.stdin.write(opts.stdinData);
      }
      proc.stdin.end();
    });
  }
}

/** Singleton production runner. Tests pass their own instance. */
export const defaultCommandRunner: CommandRunner = new SpawnCommandRunner();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function kubectlArgs(kubeconfigPath: string | undefined, ...rest: string[]): string[] {
  return kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...rest] : [...rest];
}

function helmArgs(kubeconfigPath: string | undefined, ...rest: string[]): string[] {
  return kubeconfigPath ? ["--kubeconfig", kubeconfigPath, ...rest] : [...rest];
}

/**
 * Validate a Kubernetes namespace name.
 * DNS label rules: lowercase alphanumeric and hyphens, 1–253 chars.
 */
function validateNamespaceName(ns: string): void {
  if (!/^[a-z0-9][a-z0-9-]{0,251}[a-z0-9]$|^[a-z0-9]$/.test(ns)) {
    throw new E2eKubernetesError(
      `Invalid namespace name "${ns}". Must match Kubernetes DNS label rules.`,
    );
  }
}

/**
 * Sanitize a pipeline run ID into a safe Kubernetes name segment.
 * Keep lowercase alphanumeric and hyphens only, truncate to 50 chars.
 */
export function buildNamespaceName(runId: string): string {
  const sanitized = runId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 50);

  return `mq-run-${sanitized}`;
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class E2eKubernetesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2eKubernetesError";
  }
}

export class E2eGuardrailError extends E2eKubernetesError {
  constructor(violation: string) {
    super(`Security guardrail violation: ${violation}`);
    this.name = "E2eGuardrailError";
  }
}

export class E2eReadinessTimeoutError extends E2eKubernetesError {
  constructor(check: string, timeoutMs: number) {
    super(`Readiness check "${check}" did not pass within ${timeoutMs}ms`);
    this.name = "E2eReadinessTimeoutError";
  }
}

// ─── Guardrail Validation ─────────────────────────────────────────────────────

/**
 * Validate the stage config against security guardrails before any cluster
 * interaction. Throws E2eGuardrailError on the first violation found.
 *
 * Guardrails enforced:
 *   - testPodSpec.securityContext.privileged must not be true
 *   - testPodSpec.hostNetwork must not be true
 *   - testPodSpec.volumes must not contain hostPath entries
 */
export function enforceGuardrails(cfg: E2eKubernetesStageConfig): void {
  const pod = cfg.testPodSpec;
  if (!pod) return;

  // Privileged container check
  const containers = [
    ...(pod.containers ?? []),
    ...(pod.initContainers ?? []),
  ];
  for (const container of containers) {
    const privileged = container?.securityContext?.privileged;
    if (privileged === true) {
      throw new E2eGuardrailError(
        `Container "${container.name ?? "(unnamed)"}" requests privileged mode — denied.`,
      );
    }
  }

  // Host network check
  if (pod.hostNetwork === true) {
    throw new E2eGuardrailError("hostNetwork: true is not permitted in ephemeral test pods.");
  }

  // hostPath volume check
  const volumes = pod.volumes ?? [];
  for (const vol of volumes) {
    if (vol?.hostPath !== undefined && vol.hostPath !== null) {
      throw new E2eGuardrailError(
        `Volume "${vol.name ?? "(unnamed)"}" uses hostPath — denied.`,
      );
    }
  }
}

// ─── Namespace manifest builders ──────────────────────────────────────────────

/** Builds the Namespace manifest YAML with ephemeral labels and TTL annotation. */
export function buildNamespaceManifest(
  namespace: string,
  runId: string,
  ttlHours: number,
): string {
  const deleteAfter = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  return [
    "apiVersion: v1",
    "kind: Namespace",
    "metadata:",
    `  name: ${namespace}`,
    "  labels:",
    "    ephemeral: \"true\"",
    `    mq-run-id: "${runId}"`,
    `    ttl-hours: "${ttlHours}"`,
    "  annotations:",
    `    multiqlti.io/delete-after: "${deleteAfter}"`,
  ].join("\n");
}

/**
 * Builds a ResourceQuota manifest for the namespace.
 * Defaults: 2 CPU, 2Gi memory, 10 pods.
 */
export function buildResourceQuotaManifest(
  namespace: string,
  quota: E2eKubernetesStageConfig["resourceQuota"],
): string {
  const cpu = quota?.limitCpu ?? "2";
  const memory = quota?.limitMemory ?? "2Gi";
  const pods = quota?.maxPods ?? 10;

  return [
    "apiVersion: v1",
    "kind: ResourceQuota",
    "metadata:",
    "  name: mq-ephemeral-quota",
    `  namespace: ${namespace}`,
    "spec:",
    "  hard:",
    `    limits.cpu: "${cpu}"`,
    `    limits.memory: "${memory}"`,
    `    pods: "${pods}"`,
  ].join("\n");
}

/**
 * Builds a default-deny egress NetworkPolicy.
 * If allowedEgressHosts contains entries they become Egress rules.
 * Ingress is unrestricted within the namespace to allow pod-to-pod communication.
 */
export function buildNetworkPolicyManifest(
  namespace: string,
  allowedEgressHosts: string[] = [],
): string {
  const lines = [
    "apiVersion: networking.k8s.io/v1",
    "kind: NetworkPolicy",
    "metadata:",
    "  name: mq-default-deny-egress",
    `  namespace: ${namespace}`,
    "spec:",
    "  podSelector: {}",
    "  policyTypes:",
    "  - Egress",
  ];

  if (allowedEgressHosts.length > 0) {
    lines.push("  egress:");
    for (const host of allowedEgressHosts) {
      lines.push("  - to:");
      lines.push("    - ipBlock:");
      lines.push(`        cidr: ${host}`);
    }
  }
  // When allowedEgressHosts is empty, no egress stanza = block all egress.

  return lines.join("\n");
}

// ─── Kubernetes operations ─────────────────────────────────────────────────────

/** Create the namespace and apply the quota + network policy. */
async function bootstrapNamespace(
  namespace: string,
  runId: string,
  cfg: E2eKubernetesStageConfig,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<void> {
  const nsManifest = buildNamespaceManifest(namespace, runId, cfg.ttlHours ?? 4);
  const quotaManifest = buildResourceQuotaManifest(namespace, cfg.resourceQuota);
  const netpolManifest = buildNetworkPolicyManifest(
    namespace,
    cfg.allowedEgressHosts ?? [],
  );

  const combined = [nsManifest, "---", quotaManifest, "---", netpolManifest].join("\n");

  const result = await runner.run(
    "kubectl",
    kubectlArgs(kubeconfigPath, "apply", "-f", "-"),
    { stdinData: combined },
  );

  if (result.exitCode !== 0) {
    throw new E2eKubernetesError(
      `Failed to bootstrap namespace "${namespace}": ${result.stderr}`,
    );
  }
}

/** Deploy via Helm chart. Returns rendered manifest (helm get manifest). */
async function helmDeploy(
  namespace: string,
  releaseName: string,
  chart: string,
  valuesYaml: string | undefined,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
  timeoutMs = 120_000,
): Promise<string> {
  const args = [
    "upgrade", "--install",
    releaseName, chart,
    "--namespace", namespace,
    "--wait",
    "--timeout", `${Math.ceil(timeoutMs / 1000)}s`,
  ];

  const result = await runner.run(
    "helm",
    helmArgs(kubeconfigPath, ...args),
    { stdinData: valuesYaml, timeoutMs: timeoutMs + 10_000 },
  );

  if (result.exitCode !== 0) {
    throw new E2eKubernetesError(
      `Helm deploy failed for release "${releaseName}": ${result.stderr}`,
    );
  }

  // Capture rendered manifest for artifacts
  const manifestResult = await runner.run(
    "helm",
    helmArgs(kubeconfigPath, "get", "manifest", releaseName, "--namespace", namespace),
  );

  return manifestResult.exitCode === 0 ? manifestResult.stdout : "(manifest unavailable)";
}

/**
 * Wait for rollout of a deployment to complete.
 * Uses `kubectl rollout status` which blocks until ready or times out.
 */
async function waitForRollout(
  namespace: string,
  deploymentName: string,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
  timeoutMs: number,
): Promise<void> {
  const result = await runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "rollout", "status",
      `deployment/${deploymentName}`,
      "--namespace", namespace,
      "--timeout", `${Math.ceil(timeoutMs / 1000)}s`,
    ),
    { timeoutMs: timeoutMs + 5_000 },
  );

  if (result.exitCode !== 0) {
    throw new E2eReadinessTimeoutError("deployment rollout", timeoutMs);
  }
}

/**
 * Verify at least one ready endpoint exists for a given service.
 */
async function waitForEndpoints(
  namespace: string,
  serviceName: string,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
  pollIntervalMs: number,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const result = await runner.run(
      "kubectl",
      kubectlArgs(
        kubeconfigPath,
        "get", "endpoints", serviceName,
        "--namespace", namespace,
        "-o", "jsonpath={.subsets[0].addresses[0].ip}",
      ),
    );

    if (result.exitCode === 0 && result.stdout.trim().length > 0) {
      return;
    }

    await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  }

  throw new E2eReadinessTimeoutError("service endpoints", timeoutMs);
}

/**
 * Execute the custom readiness command in a test pod.
 * Returns when the command exits 0.
 */
async function runReadinessCommand(
  namespace: string,
  image: string,
  command: string[],
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
  timeoutMs: number,
): Promise<void> {
  const result = await runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "run", "mq-readiness-check",
      `--image=${image}`,
      "--namespace", namespace,
      "--restart=Never",
      "--rm",
      "--attach",
      "--command", "--",
      ...command,
    ),
    { timeoutMs },
  );

  if (result.exitCode !== 0) {
    throw new E2eReadinessTimeoutError("custom command", timeoutMs);
  }
}

/**
 * Run the test command in a short-lived test pod.
 * Returns stdout, stderr, and exitCode.
 */
async function runTestPod(
  namespace: string,
  testImage: string,
  testCommand: string[],
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
  timeoutMs: number,
): Promise<CommandResult> {
  const podName = `mq-test-${Date.now().toString(36)}`;

  return runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "run", podName,
      `--image=${testImage}`,
      "--namespace", namespace,
      "--restart=Never",
      "--rm",
      "--attach",
      "--command", "--",
      ...testCommand,
    ),
    { timeoutMs },
  );
}

/** Collect pod events for the namespace — useful for failure diagnostics. */
async function getPodEvents(
  namespace: string,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<string> {
  const result = await runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "get", "events",
      "--namespace", namespace,
      "--sort-by=.lastTimestamp",
    ),
  );
  return result.stdout || "(no events)";
}

/** Delete the namespace immediately. */
async function deleteNamespace(
  namespace: string,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<void> {
  await runner.run(
    "kubectl",
    kubectlArgs(kubeconfigPath, "delete", "namespace", namespace, "--ignore-not-found"),
  );
}

/** Annotate the namespace with a delete-after timestamp (TTL mode). */
async function annotateWithTtl(
  namespace: string,
  ttlHours: number,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<void> {
  const deleteAfter = new Date(Date.now() + ttlHours * 60 * 60 * 1000).toISOString();
  await runner.run(
    "kubectl",
    kubectlArgs(
      kubeconfigPath,
      "annotate", "namespace", namespace,
      `multiqlti.io/delete-after=${deleteAfter}`,
      "--overwrite",
    ),
  );
}

// ─── Readiness orchestration ──────────────────────────────────────────────────

async function waitForReadiness(
  namespace: string,
  cfg: E2eKubernetesStageConfig,
  kubeconfigPath: string | undefined,
  runner: CommandRunner,
): Promise<void> {
  const readiness = cfg.readiness;
  if (!readiness) return;

  const timeoutMs = readiness.timeoutMs ?? 120_000;
  const pollIntervalMs = readiness.pollIntervalMs ?? 3_000;

  if (readiness.deploymentName) {
    await waitForRollout(namespace, readiness.deploymentName, kubeconfigPath, runner, timeoutMs);
  }

  if (readiness.serviceName) {
    await waitForEndpoints(namespace, readiness.serviceName, kubeconfigPath, runner, pollIntervalMs, timeoutMs);
  }

  if (readiness.command && readiness.command.length > 0) {
    const image = readiness.commandImage ?? cfg.testImage;
    await runReadinessCommand(namespace, image, readiness.command, kubeconfigPath, runner, timeoutMs);
  }
}

// ─── Stage entry point ─────────────────────────────────────────────────────────

/**
 * Run an ephemeral Kubernetes test environment stage.
 *
 * @param runId          Pipeline run ID used to derive the namespace name
 * @param cfg            Stage configuration
 * @param kubeconfigPath Path to kubeconfig file (undefined = use in-cluster config)
 * @param runner         Command runner (defaults to spawn-backed production runner)
 */
export async function runE2eKubernetesStage(
  runId: string,
  cfg: E2eKubernetesStageConfig,
  kubeconfigPath?: string,
  runner: CommandRunner = defaultCommandRunner,
): Promise<E2eKubernetesResult> {
  // ── 1. Validate inputs ─────────────────────────────────────────────────────
  if (!cfg.imageRef?.trim()) {
    throw new E2eKubernetesError("imageRef is required for e2e_kubernetes stage.");
  }
  if (!cfg.testImage?.trim()) {
    throw new E2eKubernetesError("testImage is required for e2e_kubernetes stage.");
  }
  if (!cfg.testCommand || cfg.testCommand.length === 0) {
    throw new E2eKubernetesError("testCommand must be a non-empty array.");
  }

  // ── 2. Enforce security guardrails ─────────────────────────────────────────
  enforceGuardrails(cfg);

  // ── 3. Derive namespace name ───────────────────────────────────────────────
  const namespace = buildNamespaceName(runId);
  validateNamespaceName(namespace);

  const ttlHours = cfg.ttlHours ?? 4;
  const helmChart = cfg.helmChart ?? "stable/nginx";
  const releaseName =
    cfg.releaseName ??
    `mq-${runId
      .slice(0, 20)
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")}`;
  const helmTimeoutMs = cfg.helmTimeoutMs ?? 120_000;
  const testTimeoutMs = cfg.testTimeoutMs ?? 60_000;

  let helmManifest = "(not captured)";
  let testStdout = "";
  let testStderr = "";
  let testExitCode = -1;
  let podEvents: string | undefined;
  let success = false;

  try {
    // ── 4. Bootstrap namespace (NS + ResourceQuota + NetworkPolicy) ───────────
    await bootstrapNamespace(namespace, runId, cfg, kubeconfigPath, runner);

    // ── 5. Deploy via Helm ────────────────────────────────────────────────────
    helmManifest = await helmDeploy(
      namespace,
      releaseName,
      helmChart,
      cfg.helmValues,
      kubeconfigPath,
      runner,
      helmTimeoutMs,
    );

    // ── 6. Wait for readiness ─────────────────────────────────────────────────
    await waitForReadiness(namespace, cfg, kubeconfigPath, runner);

    // ── 7. Run test command in test pod ───────────────────────────────────────
    const testResult = await runTestPod(
      namespace,
      cfg.testImage,
      cfg.testCommand,
      kubeconfigPath,
      runner,
      testTimeoutMs,
    );

    testStdout = testResult.stdout;
    testStderr = testResult.stderr;
    testExitCode = testResult.exitCode;
    success = testExitCode === 0;

    // ── 8a. Collect pod events on failure ─────────────────────────────────────
    if (!success) {
      podEvents = await getPodEvents(namespace, kubeconfigPath, runner);
    }
  } catch (err) {
    // Capture events for any unexpected error during setup
    podEvents = await getPodEvents(namespace, kubeconfigPath, runner).catch(
      () => "(events unavailable)",
    );

    // Re-throw so the pipeline can record the failure
    throw err;
  } finally {
    // ── 8b. Teardown ──────────────────────────────────────────────────────────
    if (success) {
      const deleteOnSuccess = cfg.deleteOnSuccess !== false; // default true
      if (deleteOnSuccess) {
        await deleteNamespace(namespace, kubeconfigPath, runner).catch(() => {
          // Non-fatal: janitor will clean it up
        });
      } else {
        await annotateWithTtl(namespace, ttlHours, kubeconfigPath, runner).catch(() => {});
      }
    } else {
      // Failure: leave namespace alive with TTL annotation for debugging
      await annotateWithTtl(namespace, ttlHours, kubeconfigPath, runner).catch(() => {});
    }
  }

  // ── 9. Build artifact record ───────────────────────────────────────────────
  const artifacts: E2eKubernetesArtifacts = {
    testLogs: testStdout + (testStderr ? `\n--- stderr ---\n${testStderr}` : ""),
    helmManifest,
    ...(podEvents !== undefined ? { podEvents } : {}),
  };

  return {
    namespace,
    success,
    testExitCode,
    testStdout,
    testStderr,
    artifacts,
    ttlHours,
  };
}

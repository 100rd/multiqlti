/**
 * Comprehensive unit tests for the ephemeral Kubernetes test environment stage
 * and the ephemeral janitor (issue #272).
 *
 * All kubectl/helm invocations are intercepted by an injected `FakeRunner` so no
 * cluster is needed.
 *
 * Sections:
 *  1.  buildNamespaceName — safe namespace name derivation
 *  2.  enforceGuardrails — privileged, hostNetwork, hostPath rejections
 *  3.  buildNamespaceManifest — correct labels and TTL annotation
 *  4.  buildResourceQuotaManifest — CPU/memory/pod defaults and overrides
 *  5.  buildNetworkPolicyManifest — default-deny and allowed-egress
 *  6.  runE2eKubernetesStage — validation (missing fields, guardrail rejection)
 *  7.  runE2eKubernetesStage — success lifecycle
 *  8.  runE2eKubernetesStage — failure lifecycle
 *  9.  runE2eKubernetesStage — teardown behaviour
 * 10.  runE2eKubernetesStage — artifact capture
 * 11.  runEphemeralJanitor — expired namespace deleted, non-expired preserved
 * 12.  runEphemeralJanitor — dry-run mode
 * 13.  runEphemeralJanitor — label selector safety
 * 14.  runEphemeralJanitor — error handling
 * 15.  startScheduledJanitor — stop/lastResult lifecycle
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Module under test ────────────────────────────────────────────────────────

import {
  buildNamespaceName,
  enforceGuardrails,
  buildNamespaceManifest,
  buildResourceQuotaManifest,
  buildNetworkPolicyManifest,
  runE2eKubernetesStage,
  E2eGuardrailError,
  E2eKubernetesError,
} from "../../server/pipeline/stages/e2e-kubernetes";

import type { CommandRunner, CommandResult } from "../../server/pipeline/stages/e2e-kubernetes";

import {
  runEphemeralJanitor,
  startScheduledJanitor,
} from "../../server/maintenance/ephemeral-janitor";

import type {
  E2eKubernetesStageConfig,
  EphemeralPodSpec,
} from "@shared/types";

// ─── Fake command runner ──────────────────────────────────────────────────────

/**
 * A fake CommandRunner that returns pre-programmed responses in order.
 * Also records all calls for assertion.
 */
class FakeRunner implements CommandRunner {
  private responses: CommandResult[];
  private index = 0;
  readonly calls: Array<{ cmd: string; args: string[]; stdinData?: string }> = [];

  constructor(responses: CommandResult[] = []) {
    this.responses = responses;
  }

  run(cmd: string, args: string[], opts?: { stdinData?: string }): Promise<CommandResult> {
    this.calls.push({ cmd, args: [...args], stdinData: opts?.stdinData });
    const resp = this.responses[Math.min(this.index, this.responses.length - 1)] ?? {
      stdout: "",
      stderr: "",
      exitCode: 0,
    };
    this.index++;
    return Promise.resolve({ ...resp });
  }

  /** Convenience: check whether a call with given cmd+arg was made. */
  wasCalledWith(cmd: string, ...args: string[]): boolean {
    return this.calls.some(
      (c) => c.cmd === cmd && args.every((a) => c.args.includes(a)),
    );
  }
}

/** Create a runner that returns `ok` (exitCode 0) for every call. */
function okRunner(n = 20): FakeRunner {
  return new FakeRunner(
    Array.from({ length: n }, () => ({ stdout: "ok", stderr: "", exitCode: 0 })),
  );
}

/** Build a minimal valid stage config with optional overrides. */
function makeStageCfg(overrides: Partial<E2eKubernetesStageConfig> = {}): E2eKubernetesStageConfig {
  return {
    imageRef: "registry/myapp:sha256-abc",
    testImage: "alpine:3.18",
    testCommand: ["sh", "-c", "echo test-passed"],
    helmChart: "stable/nginx",
    ttlHours: 2,
    ...overrides,
  };
}

// ─── 1. buildNamespaceName ────────────────────────────────────────────────────

describe("buildNamespaceName()", () => {
  it("prefixes with mq-run-", () => {
    expect(buildNamespaceName("abc123")).toMatch(/^mq-run-/);
  });

  it("lowercases the runId", () => {
    const result = buildNamespaceName("RunABC-123");
    expect(result).toBe(result.toLowerCase());
  });

  it("replaces non-alphanumeric non-hyphen chars with hyphens", () => {
    const result = buildNamespaceName("run_id.with.dots_and_underscores");
    expect(result).not.toMatch(/[._]/);
  });

  it("collapses consecutive hyphens into one", () => {
    const result = buildNamespaceName("run---multiple---hyphens");
    expect(result).not.toMatch(/--/);
  });

  it("truncates long runIds so the final name fits within Kubernetes limits", () => {
    const longId = "a".repeat(200);
    const result = buildNamespaceName(longId);
    // "mq-run-" (7) + max 50 chars = 57
    expect(result.length).toBeLessThanOrEqual(60);
  });

  it("produces a valid Kubernetes DNS label from a UUID-like ID", () => {
    const result = buildNamespaceName("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toMatch(/^mq-run-[a-z0-9][a-z0-9-]*[a-z0-9]$/);
  });

  it("preserves existing lowercase alphanumeric chars", () => {
    const result = buildNamespaceName("run123");
    expect(result).toBe("mq-run-run123");
  });
});

// ─── 2. enforceGuardrails ─────────────────────────────────────────────────────

describe("enforceGuardrails()", () => {
  function makeCfg(podSpec?: EphemeralPodSpec): E2eKubernetesStageConfig {
    return {
      imageRef: "registry/app:latest",
      testImage: "alpine:3.18",
      testCommand: ["echo", "ok"],
      testPodSpec: podSpec,
    };
  }

  it("passes when no testPodSpec is supplied", () => {
    expect(() => enforceGuardrails({ imageRef: "x", testImage: "x", testCommand: ["x"] })).not.toThrow();
  });

  it("passes for a safe minimal pod spec", () => {
    expect(() => enforceGuardrails(makeCfg({ containers: [{ name: "app" }] }))).not.toThrow();
  });

  it("rejects a container with privileged: true", () => {
    const cfg = makeCfg({
      containers: [{ name: "exploit", securityContext: { privileged: true } }],
    });
    expect(() => enforceGuardrails(cfg)).toThrow(E2eGuardrailError);
    expect(() => enforceGuardrails(cfg)).toThrow(/privileged/i);
  });

  it("rejects an initContainer with privileged: true", () => {
    const cfg = makeCfg({
      initContainers: [{ name: "init-evil", securityContext: { privileged: true } }],
    });
    expect(() => enforceGuardrails(cfg)).toThrow(E2eGuardrailError);
  });

  it("passes when privileged is explicitly false", () => {
    const cfg = makeCfg({
      containers: [{ name: "app", securityContext: { privileged: false } }],
    });
    expect(() => enforceGuardrails(cfg)).not.toThrow();
  });

  it("rejects hostNetwork: true", () => {
    const cfg = makeCfg({ hostNetwork: true });
    expect(() => enforceGuardrails(cfg)).toThrow(E2eGuardrailError);
    expect(() => enforceGuardrails(cfg)).toThrow(/hostNetwork/i);
  });

  it("passes when hostNetwork is false", () => {
    const cfg = makeCfg({ hostNetwork: false });
    expect(() => enforceGuardrails(cfg)).not.toThrow();
  });

  it("rejects a hostPath volume", () => {
    const cfg = makeCfg({
      volumes: [{ name: "host-vol", hostPath: { path: "/etc" } }],
    });
    expect(() => enforceGuardrails(cfg)).toThrow(E2eGuardrailError);
    expect(() => enforceGuardrails(cfg)).toThrow(/hostPath/i);
  });

  it("passes for emptyDir volumes", () => {
    const cfg = makeCfg({
      volumes: [{ name: "tmp", emptyDir: {} }],
    });
    expect(() => enforceGuardrails(cfg)).not.toThrow();
  });

  it("error message includes the container name on privileged violation", () => {
    try {
      enforceGuardrails(
        makeCfg({ containers: [{ name: "badactor", securityContext: { privileged: true } }] }),
      );
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as Error).message).toContain("badactor");
    }
  });

  it("E2eGuardrailError is a subclass of E2eKubernetesError", () => {
    const cfg = makeCfg({ hostNetwork: true });
    try {
      enforceGuardrails(cfg);
    } catch (err) {
      expect(err).toBeInstanceOf(E2eKubernetesError);
      expect(err).toBeInstanceOf(E2eGuardrailError);
    }
  });
});

// ─── 3. buildNamespaceManifest ────────────────────────────────────────────────

describe("buildNamespaceManifest()", () => {
  it("includes the ephemeral=true label", () => {
    expect(buildNamespaceManifest("mq-run-abc", "abc", 4)).toContain('ephemeral: "true"');
  });

  it("includes the mq-run-id label with the runId", () => {
    expect(buildNamespaceManifest("mq-run-abc", "abc", 4)).toContain('mq-run-id: "abc"');
  });

  it("includes the ttl-hours label", () => {
    expect(buildNamespaceManifest("mq-run-abc", "abc", 8)).toContain('ttl-hours: "8"');
  });

  it("includes a future delete-after annotation", () => {
    const before = Date.now();
    const yaml = buildNamespaceManifest("mq-run-abc", "abc", 4);
    const match = yaml.match(/multiqlti\.io\/delete-after: "(.+)"/);
    expect(match).not.toBeNull();
    const deleteAfter = new Date(match![1]).getTime();
    expect(deleteAfter).toBeGreaterThan(before);
    expect(deleteAfter).toBeLessThanOrEqual(before + 4 * 60 * 60 * 1000 + 5_000);
  });

  it("sets the namespace name correctly", () => {
    expect(buildNamespaceManifest("mq-run-xyz", "xyz", 2)).toContain("name: mq-run-xyz");
  });

  it("produces valid YAML kind: Namespace", () => {
    expect(buildNamespaceManifest("mq-run-abc", "abc", 1)).toContain("kind: Namespace");
  });
});

// ─── 4. buildResourceQuotaManifest ───────────────────────────────────────────

describe("buildResourceQuotaManifest()", () => {
  it("uses default CPU limit of 2", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", undefined)).toContain('limits.cpu: "2"');
  });

  it("uses default memory limit of 2Gi", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", undefined)).toContain('limits.memory: "2Gi"');
  });

  it("uses default pod count of 10", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", undefined)).toContain('pods: "10"');
  });

  it("respects custom CPU limit", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", { limitCpu: "500m" })).toContain('limits.cpu: "500m"');
  });

  it("respects custom memory limit", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", { limitMemory: "512Mi" })).toContain('limits.memory: "512Mi"');
  });

  it("respects custom max pod count", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", { maxPods: 5 })).toContain('pods: "5"');
  });

  it("scopes the quota to the given namespace", () => {
    expect(buildResourceQuotaManifest("mq-run-xyz", undefined)).toContain("namespace: mq-run-xyz");
  });

  it("produces kind: ResourceQuota", () => {
    expect(buildResourceQuotaManifest("mq-run-ns", undefined)).toContain("kind: ResourceQuota");
  });
});

// ─── 5. buildNetworkPolicyManifest ───────────────────────────────────────────

describe("buildNetworkPolicyManifest()", () => {
  it("creates a default-deny Egress policyType with no egress stanza", () => {
    const yaml = buildNetworkPolicyManifest("mq-run-ns");
    expect(yaml).toContain("- Egress");
    expect(yaml).not.toContain("  egress:");
  });

  it("includes an egress stanza when hosts are provided", () => {
    const yaml = buildNetworkPolicyManifest("mq-run-ns", ["10.0.0.0/8"]);
    expect(yaml).toContain("10.0.0.0/8");
    expect(yaml).toContain("  egress:");
  });

  it("includes multiple CIDRs when multiple hosts are provided", () => {
    const yaml = buildNetworkPolicyManifest("mq-run-ns", ["10.0.0.0/8", "172.16.0.0/12"]);
    expect(yaml).toContain("10.0.0.0/8");
    expect(yaml).toContain("172.16.0.0/12");
  });

  it("scopes the policy to the given namespace", () => {
    expect(buildNetworkPolicyManifest("mq-run-abc")).toContain("namespace: mq-run-abc");
  });

  it("applies to all pods via empty podSelector", () => {
    expect(buildNetworkPolicyManifest("mq-run-ns")).toContain("podSelector: {}");
  });

  it("produces kind: NetworkPolicy", () => {
    expect(buildNetworkPolicyManifest("mq-run-ns")).toContain("kind: NetworkPolicy");
  });
});

// ─── 6. runE2eKubernetesStage — validation ───────────────────────────────────

describe("runE2eKubernetesStage() input validation", () => {
  it("throws E2eKubernetesError when imageRef is missing", async () => {
    await expect(
      runE2eKubernetesStage("run-001", { ...makeStageCfg(), imageRef: "" }, undefined, okRunner()),
    ).rejects.toThrow(E2eKubernetesError);
  });

  it("throws E2eKubernetesError when imageRef is whitespace", async () => {
    await expect(
      runE2eKubernetesStage("run-001", { ...makeStageCfg(), imageRef: "   " }, undefined, okRunner()),
    ).rejects.toThrow(E2eKubernetesError);
  });

  it("throws E2eKubernetesError when testImage is missing", async () => {
    await expect(
      runE2eKubernetesStage("run-001", { ...makeStageCfg(), testImage: "" }, undefined, okRunner()),
    ).rejects.toThrow(E2eKubernetesError);
  });

  it("throws E2eKubernetesError when testCommand is empty", async () => {
    await expect(
      runE2eKubernetesStage("run-001", { ...makeStageCfg(), testCommand: [] }, undefined, okRunner()),
    ).rejects.toThrow(E2eKubernetesError);
  });

  it("throws E2eGuardrailError when privileged container is configured", async () => {
    const cfg = makeStageCfg({
      testPodSpec: { containers: [{ name: "evil", securityContext: { privileged: true } }] },
    });
    await expect(
      runE2eKubernetesStage("run-001", cfg, undefined, okRunner()),
    ).rejects.toThrow(E2eGuardrailError);
  });

  it("throws E2eGuardrailError when hostNetwork is true", async () => {
    await expect(
      runE2eKubernetesStage(
        "run-001",
        makeStageCfg({ testPodSpec: { hostNetwork: true } }),
        undefined,
        okRunner(),
      ),
    ).rejects.toThrow(E2eGuardrailError);
  });

  it("throws E2eGuardrailError when hostPath volume is configured", async () => {
    const cfg = makeStageCfg({
      testPodSpec: { volumes: [{ name: "host", hostPath: { path: "/" } }] },
    });
    await expect(
      runE2eKubernetesStage("run-001", cfg, undefined, okRunner()),
    ).rejects.toThrow(E2eGuardrailError);
  });

  it("guardrail errors are thrown before any command is run", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const cfg = makeStageCfg({ testPodSpec: { hostNetwork: true } });
    await expect(
      runE2eKubernetesStage("run-001", cfg, undefined, runner),
    ).rejects.toThrow(E2eGuardrailError);
    // No commands should have been issued
    expect(runner.calls).toHaveLength(0);
  });
});

// ─── 7. runE2eKubernetesStage — success lifecycle ────────────────────────────

describe("runE2eKubernetesStage() success lifecycle", () => {
  function makeSuccessRunner(): FakeRunner {
    return new FakeRunner([
      { exitCode: 0, stdout: "", stderr: "" },           // kubectl apply (bootstrap)
      { exitCode: 0, stdout: "deployed", stderr: "" },   // helm upgrade --install
      { exitCode: 0, stdout: "MANIFEST_YAML", stderr: "" }, // helm get manifest
      { exitCode: 0, stdout: "test-passed\n", stderr: "" }, // kubectl run test pod
      { exitCode: 0, stdout: "", stderr: "" },           // kubectl delete namespace
    ]);
  }

  it("returns success=true when test command exits 0", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.success).toBe(true);
  });

  it("returns testExitCode=0 on success", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.testExitCode).toBe(0);
  });

  it("captures test stdout in testStdout", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.testStdout).toContain("test-passed");
  });

  it("namespace name is derived from runId with mq-run- prefix", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.namespace).toMatch(/^mq-run-/);
    expect(result.namespace).toContain("run-success");
  });

  it("uses the configured ttlHours in the result", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    ]);
    const result = await runE2eKubernetesStage(
      "run-ttl",
      makeStageCfg({ ttlHours: 8 }),
      undefined,
      runner,
    );
    expect(result.ttlHours).toBe(8);
  });

  it("captures Helm manifest in artifacts.helmManifest", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.artifacts.helmManifest).toContain("MANIFEST_YAML");
  });

  it("does not include podEvents in artifacts on success", async () => {
    const result = await runE2eKubernetesStage("run-success", makeStageCfg(), undefined, makeSuccessRunner());
    expect(result.artifacts.podEvents).toBeUndefined();
  });

  it("calls bootstrap (kubectl apply) before helm", async () => {
    const runner = makeSuccessRunner();
    await runE2eKubernetesStage("run-order", makeStageCfg(), undefined, runner);
    const [first, second] = runner.calls;
    expect(first.cmd).toBe("kubectl");
    expect(first.args).toContain("apply");
    expect(second.cmd).toBe("helm");
  });
});

// ─── 8. runE2eKubernetesStage — failure lifecycle ─────────────────────────────

describe("runE2eKubernetesStage() failure lifecycle", () => {
  function makeFailureRunner(): FakeRunner {
    return new FakeRunner([
      { exitCode: 0, stdout: "", stderr: "" },              // bootstrap
      { exitCode: 0, stdout: "", stderr: "" },              // helm upgrade
      { exitCode: 0, stdout: "", stderr: "" },              // helm get manifest
      { exitCode: 1, stdout: "", stderr: "ASSERTION_FAIL" }, // test pod fails
      { exitCode: 0, stdout: "EVENT_LIST", stderr: "" },    // kubectl get events
      { exitCode: 0, stdout: "", stderr: "" },              // kubectl annotate TTL
    ]);
  }

  it("returns success=false when test command exits non-zero", async () => {
    const result = await runE2eKubernetesStage("run-fail", makeStageCfg(), undefined, makeFailureRunner());
    expect(result.success).toBe(false);
  });

  it("returns the actual exit code from the test pod", async () => {
    const result = await runE2eKubernetesStage("run-fail", makeStageCfg(), undefined, makeFailureRunner());
    expect(result.testExitCode).toBe(1);
  });

  it("captures stderr from test pod in testStderr", async () => {
    const result = await runE2eKubernetesStage("run-fail", makeStageCfg(), undefined, makeFailureRunner());
    expect(result.testStderr).toContain("ASSERTION_FAIL");
  });

  it("includes podEvents in artifacts on failure", async () => {
    const result = await runE2eKubernetesStage("run-fail", makeStageCfg(), undefined, makeFailureRunner());
    expect(result.artifacts.podEvents).toContain("EVENT_LIST");
  });

  it("throws E2eKubernetesError when namespace bootstrap fails", async () => {
    const runner = new FakeRunner([
      { exitCode: 1, stdout: "", stderr: "forbidden: cannot create namespace" },
    ]);
    await expect(
      runE2eKubernetesStage("run-bootstrap-fail", makeStageCfg(), undefined, runner),
    ).rejects.toThrow(E2eKubernetesError);
  });

  it("throws E2eKubernetesError when Helm deploy fails", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "", stderr: "" },             // bootstrap ok
      { exitCode: 1, stdout: "", stderr: "chart not found" }, // helm fails
      { exitCode: 0, stdout: "", stderr: "" },             // annotate (teardown)
    ]);
    await expect(
      runE2eKubernetesStage("run-helm-fail", makeStageCfg(), undefined, runner),
    ).rejects.toThrow(E2eKubernetesError);
  });
});

// ─── 9. Teardown behaviour ────────────────────────────────────────────────────

describe("runE2eKubernetesStage() teardown", () => {
  it("calls kubectl delete namespace on success (deleteOnSuccess=true by default)", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },  // bootstrap
      { exitCode: 0, stdout: "" },  // helm upgrade
      { exitCode: 0, stdout: "" },  // helm get manifest
      { exitCode: 0, stdout: "" },  // test pod
      { exitCode: 0, stdout: "" },  // delete namespace
    ]);

    await runE2eKubernetesStage("run-del", makeStageCfg(), undefined, runner);

    expect(runner.wasCalledWith("kubectl", "delete", "namespace")).toBe(true);
  });

  it("calls kubectl annotate with TTL on success when deleteOnSuccess=false", async () => {
    const runner = okRunner();

    await runE2eKubernetesStage(
      "run-keep",
      makeStageCfg({ deleteOnSuccess: false }),
      undefined,
      runner,
    );

    expect(runner.wasCalledWith("kubectl", "annotate", "namespace")).toBe(true);
    const annotateCall = runner.calls.find(
      (c) => c.cmd === "kubectl" && c.args.includes("annotate") && c.args.some((a) => a.includes("delete-after")),
    );
    expect(annotateCall).toBeDefined();
  });

  it("annotates with TTL on failure instead of deleting", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },   // bootstrap
      { exitCode: 0, stdout: "" },   // helm upgrade
      { exitCode: 0, stdout: "" },   // helm get manifest
      { exitCode: 2, stdout: "" },   // test pod fails
      { exitCode: 0, stdout: "" },   // kubectl get events
      { exitCode: 0, stdout: "" },   // annotate TTL
    ]);

    const result = await runE2eKubernetesStage("run-fail-ttl", makeStageCfg(), undefined, runner);
    expect(result.success).toBe(false);

    const annotateCall = runner.calls.find(
      (c) => c.cmd === "kubectl" && c.args.includes("annotate") && c.args.some((a) => a.includes("delete-after")),
    );
    expect(annotateCall).toBeDefined();

    // No hard delete should have occurred
    expect(runner.wasCalledWith("kubectl", "delete", "namespace")).toBe(false);
  });

  it("passes kubeconfig path to all kubectl calls when provided", async () => {
    const runner = okRunner();
    await runE2eKubernetesStage("run-kc", makeStageCfg(), "/home/user/.kube/config", runner);

    for (const call of runner.calls) {
      if (call.cmd === "kubectl") {
        expect(call.args).toContain("--kubeconfig");
      }
    }
  });
});

// ─── 10. Artifact capture ─────────────────────────────────────────────────────

describe("runE2eKubernetesStage() artifact capture", () => {
  it("testLogs includes both stdout and stderr from the test pod", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: "TEST_OUT", stderr: "TEST_ERR" },
      { exitCode: 0, stdout: "events" },
      { exitCode: 0, stdout: "" },
    ]);

    const result = await runE2eKubernetesStage("run-logs", makeStageCfg(), undefined, runner);
    expect(result.artifacts.testLogs).toContain("TEST_OUT");
    expect(result.artifacts.testLogs).toContain("TEST_ERR");
  });

  it("helmManifest falls back gracefully when helm get manifest fails", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 1, stdout: "", stderr: "no manifest" }, // helm get manifest fails
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
    ]);

    const result = await runE2eKubernetesStage("run-manifest-fail", makeStageCfg(), undefined, runner);
    expect(result.success).toBe(true);
    // Should have a non-empty fallback string
    expect(result.artifacts.helmManifest.length).toBeGreaterThan(0);
  });

  it("testLogs combines stdout and stderr with a separator", async () => {
    const runner = new FakeRunner([
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "" },
      { exitCode: 0, stdout: "STDOUT_CONTENT", stderr: "STDERR_CONTENT" },
      { exitCode: 0, stdout: "" },
    ]);

    const result = await runE2eKubernetesStage("run-combined", makeStageCfg(), undefined, runner);
    expect(result.artifacts.testLogs).toContain("STDOUT_CONTENT");
    expect(result.artifacts.testLogs).toContain("STDERR_CONTENT");
    expect(result.artifacts.testLogs).toContain("--- stderr ---");
  });
});

// ─── 11. runEphemeralJanitor — expired / non-expired ─────────────────────────

describe("runEphemeralJanitor()", () => {
  function makeListOutput(
    entries: Array<{ name: string; deleteAfter: string; created?: string }>,
  ): string {
    return entries
      .map((e) => `${e.name}|${e.deleteAfter}|${e.created ?? new Date().toISOString()}`)
      .join("\n") + "\n";
  }

  it("deletes namespaces whose delete-after is in the past", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: makeListOutput([{ name: "mq-run-expired", deleteAfter: past }]), stderr: "" },
      { exitCode: 0, stdout: "deleted", stderr: "" }, // delete call
    ]);

    const result = await runEphemeralJanitor({ runner });
    expect(result.deleted).toContain("mq-run-expired");
    expect(result.errors).toHaveLength(0);
    expect(result.scanned).toBe(1);
  });

  it("does not delete namespaces whose delete-after is in the future", async () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: makeListOutput([{ name: "mq-run-alive", deleteAfter: future }]), stderr: "" },
    ]);

    const result = await runEphemeralJanitor({ runner });
    expect(result.deleted).not.toContain("mq-run-alive");
    expect(runner.calls).toHaveLength(1); // only the list call
    const entry = result.namespacesByAge.find((n) => n.namespace === "mq-run-alive");
    expect(entry?.expired).toBe(false);
  });

  it("handles a mix of expired and non-expired namespaces", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const runner = new FakeRunner([
      {
        exitCode: 0,
        stdout: makeListOutput([
          { name: "mq-run-old", deleteAfter: past },
          { name: "mq-run-new", deleteAfter: future },
        ]),
        stderr: "",
      },
      { exitCode: 0, stdout: "deleted", stderr: "" }, // delete mq-run-old
    ]);

    const result = await runEphemeralJanitor({ runner });
    expect(result.deleted).toContain("mq-run-old");
    expect(result.deleted).not.toContain("mq-run-new");
  });

  it("populates namespacesByAge with correct age and expired flag", async () => {
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const created = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: makeListOutput([{ name: "mq-run-old", deleteAfter: past, created }]), stderr: "" },
      { exitCode: 0, stdout: "deleted", stderr: "" },
    ]);

    const result = await runEphemeralJanitor({ runner });
    const entry = result.namespacesByAge.find((n) => n.namespace === "mq-run-old");
    expect(entry).toBeDefined();
    expect(entry!.expired).toBe(true);
    expect(entry!.ageHours).toBeGreaterThan(2);
  });

  it("returns empty result when no ephemeral namespaces exist", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const result = await runEphemeralJanitor({ runner });
    expect(result.scanned).toBe(0);
    expect(result.deleted).toHaveLength(0);
    expect(result.namespacesByAge).toHaveLength(0);
  });

  it("records ranAt timestamp close to now", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const before = new Date();
    const result = await runEphemeralJanitor({ runner });
    expect(result.ranAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });
});

// ─── 12. runEphemeralJanitor — dry-run mode ───────────────────────────────────

describe("runEphemeralJanitor() dry-run mode", () => {
  it("reports expired namespaces in deleted list without calling kubectl delete", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const runner = new FakeRunner([
      {
        exitCode: 0,
        stdout: `mq-run-expired|${past}|${new Date().toISOString()}\n`,
        stderr: "",
      },
      // This would be the delete response — it should never be reached
      { exitCode: 1, stdout: "", stderr: "should not have been called" },
    ]);

    const result = await runEphemeralJanitor({ dryRun: true, runner });

    expect(result.dryRun).toBe(true);
    expect(result.deleted).toContain("mq-run-expired");
    // Only the list call should have been made
    expect(runner.calls).toHaveLength(1);
  });

  it("dryRun=false (default) actually performs deletion", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: `mq-run-stale|${past}|${new Date().toISOString()}\n`, stderr: "" },
      { exitCode: 0, stdout: "deleted", stderr: "" },
    ]);

    const result = await runEphemeralJanitor({ runner });
    expect(result.dryRun).toBe(false);
    expect(runner.calls).toHaveLength(2); // list + delete
  });
});

// ─── 13. runEphemeralJanitor — label selector safety ─────────────────────────

describe("runEphemeralJanitor() label selector safety", () => {
  it("passes the default label selector 'ephemeral=true' to kubectl", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    await runEphemeralJanitor({ runner });

    const listCall = runner.calls.find((c) => c.args.includes("get") && c.args.includes("namespaces"));
    expect(listCall).toBeDefined();
    const selectorIndex = listCall!.args.indexOf("--selector");
    expect(selectorIndex).toBeGreaterThan(-1);
    expect(listCall!.args[selectorIndex + 1]).toBe("ephemeral=true");
  });

  it("uses a custom label selector when provided", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    await runEphemeralJanitor({ runner, labelSelector: "managed-by=my-tool" });

    const listCall = runner.calls.find((c) => c.args.includes("get") && c.args.includes("namespaces"));
    const selectorIndex = listCall!.args.indexOf("--selector");
    expect(listCall!.args[selectorIndex + 1]).toBe("managed-by=my-tool");
  });

  it("passes kubeconfig to kubectl when provided", async () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    await runEphemeralJanitor({ runner, kubeconfigPath: "/etc/kube/config" });

    const listCall = runner.calls[0];
    expect(listCall.args).toContain("--kubeconfig");
    expect(listCall.args).toContain("/etc/kube/config");
  });
});

// ─── 14. runEphemeralJanitor — error handling ─────────────────────────────────

describe("runEphemeralJanitor() error handling", () => {
  it("throws when listing namespaces fails", async () => {
    const runner = new FakeRunner([
      { exitCode: 1, stdout: "", stderr: "connection refused" },
    ]);
    await expect(runEphemeralJanitor({ runner })).rejects.toThrow(/Failed to list ephemeral namespaces/);
  });

  it("records failed deletions in errors without aborting remaining deletes", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const listOutput = [
      `mq-run-failme|${past}|${new Date().toISOString()}`,
      `mq-run-ok|${past}|${new Date().toISOString()}`,
    ].join("\n") + "\n";

    const runner = new FakeRunner([
      { exitCode: 0, stdout: listOutput, stderr: "" },  // list
      { exitCode: 1, stdout: "", stderr: "forbidden" }, // first delete fails
      { exitCode: 0, stdout: "ok", stderr: "" },        // second delete ok
    ]);

    const result = await runEphemeralJanitor({ runner });

    expect(result.errors.length + result.deleted.length).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.deleted).toHaveLength(1);
  });

  it("error entry includes the namespace name and error message", async () => {
    const past = new Date(Date.now() - 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: `mq-run-forbidden|${past}|${new Date().toISOString()}\n`, stderr: "" },
      { exitCode: 1, stdout: "", stderr: "permission denied" },
    ]);

    const result = await runEphemeralJanitor({ runner });
    expect(result.errors[0].namespace).toBe("mq-run-forbidden");
    expect(result.errors[0].error).toContain("permission denied");
  });
});

// ─── 15. startScheduledJanitor ────────────────────────────────────────────────

describe("startScheduledJanitor()", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a handle with stop() and lastResult()", () => {
    const runner = new FakeRunner([{ exitCode: 0, stdout: "", stderr: "" }]);
    const handle = startScheduledJanitor({ intervalMs: 60_000, runner });
    expect(typeof handle.stop).toBe("function");
    expect(typeof handle.lastResult).toBe("function");
    handle.stop();
  });

  it("lastResult() is null before the first async run completes", () => {
    // Use a runner whose Promise never resolves during the synchronous test
    const neverRunner: CommandRunner = {
      run: () => new Promise(() => { /* never resolves */ }),
    };
    const handle = startScheduledJanitor({ intervalMs: 60_000, runner: neverRunner });
    // Synchronously, the result is still null
    expect(handle.lastResult()).toBeNull();
    handle.stop();
  });

  it("does not issue new runs after stop() is called", async () => {
    let runCount = 0;
    const countingRunner: CommandRunner = {
      run: () => {
        runCount++;
        return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
      },
    };

    const handle = startScheduledJanitor({ intervalMs: 1_000, runner: countingRunner });
    handle.stop();
    const countAfterStop = runCount;

    vi.advanceTimersByTime(10_000);
    // Allow any synchronously scheduled microtasks to run
    await Promise.resolve();

    expect(runCount).toBe(countAfterStop);
  });

  it("lastResult() reflects completed run data after first run finishes", async () => {
    // Real timers: this test uses actual async resolution
    vi.useRealTimers();
    const past = new Date(Date.now() - 1000).toISOString();
    const runner = new FakeRunner([
      { exitCode: 0, stdout: `mq-run-x|${past}|${new Date().toISOString()}\n`, stderr: "" },
      { exitCode: 0, stdout: "deleted", stderr: "" },
    ]);

    const handle = startScheduledJanitor({ intervalMs: 60_000, runner });

    // Poll until lastResult() is populated (the initial run is async)
    await new Promise<void>((resolve) => {
      const check = () => {
        if (handle.lastResult() !== null) { resolve(); return; }
        setTimeout(check, 5);
      };
      check();
    });

    const result = handle.lastResult();
    expect(result).not.toBeNull();
    expect(result!.scanned).toBe(1);
    handle.stop();
  });
});

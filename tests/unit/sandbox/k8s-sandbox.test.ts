/**
 * Tests for server/sandbox/k8s-sandbox.ts
 *
 * Sections:
 *  1.  buildK8sNamespace — correct labels and pod-security
 *  2.  buildK8sPodManifest — runtimeClassName gvisor when useGvisor=true
 *  3.  buildK8sPodManifest — runtimeClassName absent when useGvisor=false
 *  4.  buildK8sPodManifest — security context (no privilege escalation, caps dropped)
 *  5.  buildK8sPodManifest — seccomp annotation present by default
 *  6.  buildK8sPodManifest — AppArmor annotation added when applyAppArmor=true + runc
 *  7.  buildK8sPodManifest — AppArmor NOT added when useGvisor=true
 *  8.  buildK8sPodManifest — env vars passed through
 *  9.  buildK8sPodManifest — resource limits applied
 * 10.  buildK8sPodManifest — automountServiceAccountToken=false
 * 11.  buildK8sPodManifest — hostNetwork/hostPID/hostIPC=false
 * 12.  buildK8sSandboxManifests — all manifest types present
 * 13.  buildK8sSandboxManifests — NetworkPolicy embedded
 * 14.  buildK8sSandboxManifests — ResourceQuota embedded
 * 15.  buildK8sSandboxManifests — validates egress allow-list (throws on bad entry)
 * 16.  buildGvisorRuntimeClass — correct handler and name
 */

import { describe, it, expect } from "vitest";
import {
  buildK8sNamespace,
  buildK8sPodManifest,
  buildK8sSandboxManifests,
  buildGvisorRuntimeClass,
  GVISOR_RUNTIME_CLASS_NAME,
  SANDBOX_APPARMOR_PROFILE,
} from "../../../server/sandbox/k8s-sandbox";
import type { SandboxConfig, SandboxHardeningConfig } from "@shared/types";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const baseConfig: SandboxConfig = {
  enabled: true,
  image: "python:3.12-slim",
  command: "python3 main.py",
  workdir: "/workspace",
  memoryLimit: "512m",
  cpuLimit: 1,
  networkEnabled: false,
};

const baseHardening: SandboxHardeningConfig = {
  runtime: "runsc",
  egressAllowList: [],
  applySeccomp: true,
  applyAppArmor: false,
};

// ─── 1. buildK8sNamespace ─────────────────────────────────────────────────────

describe("buildK8sNamespace", () => {
  it("has correct apiVersion and kind", () => {
    const ns = buildK8sNamespace("mq-sandbox-abc");
    expect(ns.apiVersion).toBe("v1");
    expect(ns.kind).toBe("Namespace");
  });

  it("sets the namespace name", () => {
    const ns = buildK8sNamespace("mq-sandbox-abc");
    const meta = ns.metadata as Record<string, unknown>;
    expect(meta.name).toBe("mq-sandbox-abc");
  });

  it("includes managed-by label", () => {
    const ns = buildK8sNamespace("mq-sandbox-abc");
    const labels = (ns.metadata as Record<string, Record<string, string>>).labels;
    expect(labels["app.kubernetes.io/managed-by"]).toBe("multiqlti");
  });

  it("includes pod-security enforce label", () => {
    const ns = buildK8sNamespace("mq-sandbox-abc");
    const labels = (ns.metadata as Record<string, Record<string, string>>).labels;
    expect(labels["pod-security.kubernetes.io/enforce"]).toBe("restricted");
  });
});

// ─── 2. buildK8sPodManifest — runtimeClassName gvisor ───────────────────────

describe("buildK8sPodManifest — runtimeClassName", () => {
  it("sets runtimeClassName to gvisor when useGvisor=true", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: true,
    });
    const spec = pod.spec as Record<string, unknown>;
    expect(spec.runtimeClassName).toBe(GVISOR_RUNTIME_CLASS_NAME);
  });

  it("omits runtimeClassName when useGvisor=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const spec = pod.spec as Record<string, unknown>;
    expect(spec.runtimeClassName).toBeUndefined();
  });
});

// ─── 3. buildK8sPodManifest — security context ───────────────────────────────

describe("buildK8sPodManifest — security context", () => {
  it("sets allowPrivilegeEscalation=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const firstContainer = containers[0] as Record<string, Record<string, unknown>>;
    expect(firstContainer.securityContext.allowPrivilegeEscalation).toBe(false);
  });

  it("drops all capabilities", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const ctx = (containers[0] as Record<string, unknown>).securityContext as Record<string, unknown>;
    const caps = ctx.capabilities as Record<string, unknown>;
    expect(caps.drop).toContain("ALL");
  });

  it("sets runAsNonRoot=true", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const ctx = (containers[0] as Record<string, Record<string, unknown>>).securityContext;
    expect(ctx.runAsNonRoot).toBe(true);
  });

  it("sets runAsUser to 65534 (nobody)", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const ctx = (containers[0] as Record<string, Record<string, unknown>>).securityContext;
    expect(ctx.runAsUser).toBe(65534);
  });
});

// ─── 4. buildK8sPodManifest — seccomp annotation ─────────────────────────────

describe("buildK8sPodManifest — seccomp", () => {
  it("includes seccompProfile in container securityContext when applySeccomp=true", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: { ...baseHardening, applySeccomp: true },
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const ctx = (containers[0] as Record<string, Record<string, unknown>>).securityContext;
    expect(ctx.seccompProfile).toBeDefined();
    const seccomp = ctx.seccompProfile as Record<string, string>;
    expect(seccomp.type).toBe("Localhost");
  });

  it("omits seccompProfile when applySeccomp=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: { ...baseHardening, applySeccomp: false },
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const ctx = (containers[0] as Record<string, Record<string, unknown>>).securityContext;
    expect(ctx.seccompProfile).toBeUndefined();
  });
});

// ─── 5. buildK8sPodManifest — AppArmor annotation ────────────────────────────

describe("buildK8sPodManifest — AppArmor", () => {
  it("adds AppArmor annotation when applyAppArmor=true and useGvisor=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: { ...baseHardening, applyAppArmor: true },
      useGvisor: false,
    });
    const annotations = (pod.metadata as Record<string, Record<string, string>>).annotations;
    const hasAppArmor = Object.values(annotations).some((v) =>
      v.includes(SANDBOX_APPARMOR_PROFILE),
    );
    expect(hasAppArmor).toBe(true);
  });

  it("does NOT add AppArmor annotation when useGvisor=true", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: { ...baseHardening, applyAppArmor: true },
      useGvisor: true,
    });
    const annotations = (pod.metadata as Record<string, Record<string, string>>).annotations;
    const hasAppArmor = Object.values(annotations).some((v) =>
      v.includes(SANDBOX_APPARMOR_PROFILE),
    );
    expect(hasAppArmor).toBe(false);
  });

  it("does NOT add AppArmor annotation when applyAppArmor=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: { ...baseHardening, applyAppArmor: false },
      useGvisor: false,
    });
    const annotations = (pod.metadata as Record<string, Record<string, string>>).annotations;
    const hasAppArmor = Object.values(annotations ?? {}).some((v) =>
      v.includes(SANDBOX_APPARMOR_PROFILE),
    );
    expect(hasAppArmor).toBe(false);
  });
});

// ─── 6. buildK8sPodManifest — env vars ───────────────────────────────────────

describe("buildK8sPodManifest — env vars", () => {
  it("passes env vars to the container", () => {
    const config: SandboxConfig = { ...baseConfig, env: { FOO: "bar", BAZ: "qux" } };
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config,
      hardening: baseHardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const envArray = (containers[0] as Record<string, Array<{ name: string; value: string }>>).env;
    expect(envArray.some((e) => e.name === "FOO" && e.value === "bar")).toBe(true);
    expect(envArray.some((e) => e.name === "BAZ" && e.value === "qux")).toBe(true);
  });
});

// ─── 7. buildK8sPodManifest — resource limits ────────────────────────────────

describe("buildK8sPodManifest — resource limits", () => {
  it("applies resource quota to container limits", () => {
    const hardening: SandboxHardeningConfig = {
      ...baseHardening,
      resourceQuota: { limitCpu: "2", limitMemory: "1Gi" },
    };
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening,
      useGvisor: false,
    });
    const containers = (pod.spec as Record<string, unknown[]>).containers;
    const resources = (containers[0] as Record<string, Record<string, Record<string, string>>>)
      .resources;
    expect(resources.limits.cpu).toBe("2");
    expect(resources.limits.memory).toBe("1Gi");
  });
});

// ─── 8. buildK8sPodManifest — automount / host access ────────────────────────

describe("buildK8sPodManifest — automount and host access", () => {
  it("sets automountServiceAccountToken=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const spec = pod.spec as Record<string, unknown>;
    expect(spec.automountServiceAccountToken).toBe(false);
  });

  it("sets hostNetwork=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    expect((pod.spec as Record<string, unknown>).hostNetwork).toBe(false);
  });

  it("sets hostPID=false", () => {
    const pod = buildK8sPodManifest({
      namespaceName: "ns",
      podName: "sandbox",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    expect((pod.spec as Record<string, unknown>).hostPID).toBe(false);
  });
});

// ─── 9. buildK8sSandboxManifests — all manifest types present ─────────────────

describe("buildK8sSandboxManifests — all manifest types present", () => {
  it("returns namespace, resourceQuota, networkPolicy, pod, appArmorProfile, seccompProfile", () => {
    const result = buildK8sSandboxManifests({
      namespaceName: "mq-sandbox-xyz",
      podName: "sandbox-pod",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: true,
    });
    expect(result.namespace).toBeDefined();
    expect(result.resourceQuota).toBeDefined();
    expect(result.networkPolicy).toBeDefined();
    expect(result.pod).toBeDefined();
    expect(result.appArmorProfile).toBeTruthy();
    expect(result.seccompProfile).toBeTruthy();
  });
});

// ─── 10. buildK8sSandboxManifests — NetworkPolicy embedded ───────────────────

describe("buildK8sSandboxManifests — NetworkPolicy", () => {
  it("embeds a NetworkPolicy with the correct namespace", () => {
    const result = buildK8sSandboxManifests({
      namespaceName: "mq-sandbox-xyz",
      podName: "sandbox-pod",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const meta = result.networkPolicy.metadata as Record<string, string>;
    expect(meta.namespace).toBe("mq-sandbox-xyz");
  });

  it("NetworkPolicy has deny-all ingress", () => {
    const result = buildK8sSandboxManifests({
      namespaceName: "mq-sandbox-xyz",
      podName: "sandbox-pod",
      config: baseConfig,
      hardening: { ...baseHardening, egressAllowList: [] },
      useGvisor: false,
    });
    const spec = result.networkPolicy.spec as Record<string, unknown>;
    expect(spec.ingress).toEqual([]);
  });
});

// ─── 11. buildK8sSandboxManifests — ResourceQuota embedded ───────────────────

describe("buildK8sSandboxManifests — ResourceQuota", () => {
  it("embeds a ResourceQuota with the correct namespace", () => {
    const result = buildK8sSandboxManifests({
      namespaceName: "mq-sandbox-xyz",
      podName: "sandbox-pod",
      config: baseConfig,
      hardening: baseHardening,
      useGvisor: false,
    });
    const meta = result.resourceQuota.metadata as Record<string, string>;
    expect(meta.namespace).toBe("mq-sandbox-xyz");
  });
});

// ─── 12. buildK8sSandboxManifests — egress validation ────────────────────────

describe("buildK8sSandboxManifests — egress validation", () => {
  it("throws EgressValidationError on invalid allow-list entry", () => {
    expect(() =>
      buildK8sSandboxManifests({
        namespaceName: "ns",
        podName: "pod",
        config: baseConfig,
        hardening: { ...baseHardening, egressAllowList: [{ host: "", port: 443 }] },
        useGvisor: false,
      }),
    ).toThrow("empty host");
  });
});

// ─── 13. buildGvisorRuntimeClass ─────────────────────────────────────────────

describe("buildGvisorRuntimeClass", () => {
  it("is a RuntimeClass kind", () => {
    const rc = buildGvisorRuntimeClass();
    expect(rc.kind).toBe("RuntimeClass");
  });

  it("has name gvisor", () => {
    const rc = buildGvisorRuntimeClass();
    const meta = rc.metadata as Record<string, string>;
    expect(meta.name).toBe(GVISOR_RUNTIME_CLASS_NAME);
  });

  it("sets handler to runsc", () => {
    const rc = buildGvisorRuntimeClass();
    expect(rc.handler).toBe("runsc");
  });
});

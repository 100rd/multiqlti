/**
 * Kubernetes-mode sandbox execution.
 *
 * Creates an ephemeral Pod in an isolated namespace with:
 *  - runtimeClassName: gvisor  (when gVisor support is available in the cluster)
 *  - NetworkPolicy: default-deny ingress + declared-egress-only
 *  - ResourceQuota scoped to the sandbox namespace
 *  - AppArmor + seccomp annotations on the Pod
 *
 * This module produces Kubernetes manifest objects (plain JS objects).
 * Callers are responsible for applying them via kubectl or the K8s API.
 *
 * No live cluster calls are made here — the module is pure and fully testable.
 */

import type {
  SandboxConfig,
  SandboxHardeningConfig,
  EgressAllowEntry,
} from "@shared/types";

import { RUNTIME_RUNSC } from "./runtime";
import { generateSeccompProfile, generateAppArmorProfile } from "./seccomp";
import {
  validateEgressAllowList,
  generateK8sNetworkPolicy,
  generateK8sResourceQuota,
  SANDBOX_QUOTA_DEFAULTS,
} from "./network-policy";

// ─── Constants ────────────────────────────────────────────────────────────────

export const GVISOR_RUNTIME_CLASS_NAME = "gvisor";
export const SANDBOX_APPARMOR_PROFILE = "multiqlti-sandbox";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface K8sSandboxManifests {
  /** Namespace manifest. */
  namespace: Record<string, unknown>;
  /** ResourceQuota manifest. */
  resourceQuota: Record<string, unknown>;
  /** NetworkPolicy manifest. */
  networkPolicy: Record<string, unknown>;
  /** Pod manifest. */
  pod: Record<string, unknown>;
  /** AppArmor profile text (apply with apparmor_parser on each node). */
  appArmorProfile: string;
  /** Seccomp profile JSON string (store as ConfigMap or node file). */
  seccompProfile: string;
}

// ─── Manifest builders ────────────────────────────────────────────────────────

/**
 * Build the Namespace manifest for a sandbox run.
 */
export function buildK8sNamespace(namespaceName: string): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "Namespace",
    metadata: {
      name: namespaceName,
      labels: {
        "app.kubernetes.io/managed-by": "multiqlti",
        "multiqlti/component": "sandbox",
        "pod-security.kubernetes.io/enforce": "restricted",
        "pod-security.kubernetes.io/enforce-version": "latest",
      },
    },
  };
}

/**
 * Build the Pod manifest for a sandbox run.
 *
 * Security posture:
 *  - runtimeClassName: gvisor  (when useGvisor is true)
 *  - seccompProfile: Localhost/<…>  (custom profile)
 *  - AppArmor annotation
 *  - readOnlyRootFilesystem + allowPrivilegeEscalation=false
 *  - Drops ALL capabilities
 *  - runAsNonRoot: true, runAsUser: 65534 (nobody)
 *  - Resource requests + limits
 */
export function buildK8sPodManifest(options: {
  namespaceName: string;
  podName: string;
  config: SandboxConfig;
  hardening: SandboxHardeningConfig;
  useGvisor: boolean;
}): Record<string, unknown> {
  const { namespaceName, podName, config, hardening, useGvisor } = options;

  const quota = hardening.resourceQuota ?? SANDBOX_QUOTA_DEFAULTS;
  const applyAppArmor = hardening.applyAppArmor !== false && !useGvisor;
  const applySeccomp = hardening.applySeccomp !== false;

  const containerSecurityContext: Record<string, unknown> = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: false, // /tmp/sandbox needs writes
    runAsNonRoot: true,
    runAsUser: 65534,
    capabilities: { drop: ["ALL"] },
  };

  if (applySeccomp) {
    containerSecurityContext.seccompProfile = {
      type: "Localhost",
      localhostProfile: "multiqlti-sandbox.json",
    };
  }

  const podAnnotations: Record<string, string> = {};
  if (applyAppArmor) {
    podAnnotations[`container.apparmor.security.beta.kubernetes.io/${podName}`] =
      `localhost/${SANDBOX_APPARMOR_PROFILE}`;
  }

  const env: Array<{ name: string; value: string }> = Object.entries(config.env ?? {}).map(
    ([name, value]) => ({ name, value }),
  );

  const manifest: Record<string, unknown> = {
    apiVersion: "v1",
    kind: "Pod",
    metadata: {
      name: podName,
      namespace: namespaceName,
      annotations: podAnnotations,
      labels: {
        "app.kubernetes.io/managed-by": "multiqlti",
        "multiqlti/component": "sandbox",
      },
    },
    spec: {
      restartPolicy: "Never",
      ...(useGvisor ? { runtimeClassName: GVISOR_RUNTIME_CLASS_NAME } : {}),
      securityContext: {
        runAsNonRoot: true,
        runAsUser: 65534,
        fsGroup: 65534,
      },
      containers: [
        {
          name: "sandbox",
          image: config.image,
          command: ["sh", "-c", config.command],
          workingDir: config.workdir ?? "/workspace",
          env,
          resources: {
            requests: {
              cpu: "100m",
              memory: "128Mi",
            },
            limits: {
              cpu: quota.limitCpu ?? SANDBOX_QUOTA_DEFAULTS.limitCpu,
              memory: quota.limitMemory ?? SANDBOX_QUOTA_DEFAULTS.limitMemory,
            },
          },
          securityContext: containerSecurityContext,
          volumeMounts: [
            {
              name: "sandbox-tmp",
              mountPath: "/tmp/sandbox",
            },
          ],
        },
      ],
      volumes: [
        {
          name: "sandbox-tmp",
          emptyDir: {
            sizeLimit: "256Mi",
          },
        },
      ],
      // No service account token automounting
      automountServiceAccountToken: false,
      // No host network/PID/IPC access
      hostNetwork: false,
      hostPID: false,
      hostIPC: false,
    },
  };

  return manifest;
}

// ─── Full manifest set ────────────────────────────────────────────────────────

/**
 * Build the complete set of Kubernetes manifests for a sandbox run.
 *
 * @param namespaceName  Unique namespace name (e.g. "mq-sandbox-<runId>")
 * @param podName        Pod name within the namespace
 * @param config         Core sandbox configuration
 * @param hardening      Hardening options (runtime, egress list, etc.)
 * @param useGvisor      Whether the cluster has gVisor runtime available
 */
export function buildK8sSandboxManifests(options: {
  namespaceName: string;
  podName: string;
  config: SandboxConfig;
  hardening: SandboxHardeningConfig;
  useGvisor: boolean;
}): K8sSandboxManifests {
  const { namespaceName, config, hardening, useGvisor } = options;

  const egressAllowList: EgressAllowEntry[] = hardening.egressAllowList ?? [];
  const normalisedEgress = validateEgressAllowList(egressAllowList);
  const allowNetworkSyscalls = normalisedEgress.length > 0;

  return {
    namespace: buildK8sNamespace(namespaceName),
    resourceQuota: generateK8sResourceQuota(namespaceName, hardening.resourceQuota),
    networkPolicy: generateK8sNetworkPolicy(namespaceName, normalisedEgress),
    pod: buildK8sPodManifest({ ...options, config, hardening, useGvisor }),
    appArmorProfile: generateAppArmorProfile(SANDBOX_APPARMOR_PROFILE),
    seccompProfile: generateSeccompProfile({ allowNetworkSyscalls }),
  };
}

// ─── Runtime class manifest ───────────────────────────────────────────────────

/**
 * Generate the RuntimeClass manifest to register gVisor in the cluster.
 * This is a one-time cluster-level resource; not per-run.
 */
export function buildGvisorRuntimeClass(): Record<string, unknown> {
  return {
    apiVersion: "node.k8s.io/v1",
    kind: "RuntimeClass",
    metadata: {
      name: GVISOR_RUNTIME_CLASS_NAME,
    },
    handler: RUNTIME_RUNSC,
  };
}

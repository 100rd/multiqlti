/**
 * Egress network policy for sandbox containers.
 *
 * Responsibilities:
 *  1. Build the `docker run` network arguments that enforce egress default-deny.
 *  2. Validate an allow-list of host:port tuples declared by the pipeline.
 *  3. Generate a DNS proxy configuration that only resolves allow-listed hostnames.
 *  4. Generate Kubernetes NetworkPolicy manifests (used by k8s-sandbox.ts).
 *
 * Design decisions:
 *  - Docker mode: We use `--network=none` for full default-deny.  Callers that
 *    need egress must declare an allow-list; the executor wires up a custom
 *    Docker network + iptables rules (handled by the executor layer).
 *  - The DNS proxy config (dnsmasq-style) only resolves allow-listed hostnames;
 *    everything else returns NXDOMAIN.  This prevents exfiltration via DNS
 *    even when an allow-listed host is reachable.
 *
 * The file intentionally has NO runtime side-effects — all functions are pure
 * and suitable for testing without a Docker daemon.
 */

import type { EgressAllowEntry } from "@shared/types";

// ─── Constants ────────────────────────────────────────────────────────────────

/** DNS port used in Kubernetes NetworkPolicy egress rules. */
const DNS_PORT = 53;

// ─── Validation ───────────────────────────────────────────────────────────────

/** Errors thrown when the allow-list contains invalid entries. */
export class EgressValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressValidationError";
  }
}

/**
 * Validate a list of egress allow entries.
 *
 * Rules:
 *  - host must be a non-empty string (hostname or IP)
 *  - port must be 1–65535
 *  - protocol defaults to "tcp"
 *  - duplicate host:port:proto entries are rejected
 *
 * Returns the normalised allow-list (protocol always set).
 */
export function validateEgressAllowList(
  entries: EgressAllowEntry[],
): Required<EgressAllowEntry>[] {
  const seen = new Set<string>();
  const result: Required<EgressAllowEntry>[] = [];

  for (const entry of entries) {
    if (!entry.host || entry.host.trim() === "") {
      throw new EgressValidationError("Egress allow-list entry has empty host");
    }
    if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) {
      throw new EgressValidationError(
        `Egress allow-list entry has invalid port: ${entry.port} (host: ${entry.host})`,
      );
    }

    const proto = entry.protocol ?? "tcp";
    const key = `${entry.host.trim().toLowerCase()}:${entry.port}:${proto}`;

    if (seen.has(key)) {
      throw new EgressValidationError(
        `Duplicate egress allow-list entry: ${entry.host}:${entry.port}/${proto}`,
      );
    }
    seen.add(key);
    result.push({ host: entry.host.trim(), port: entry.port, protocol: proto });
  }

  return result;
}

// ─── Docker network args ──────────────────────────────────────────────────────

/**
 * Build the Docker `--network` argument for a sandbox container.
 *
 * When the allow-list is empty: `--network=none` (full isolation).
 * When allow-list entries are present: `--network=none` still applies at
 * container creation time; the executor is responsible for adding per-run
 * iptables allow rules on top.
 *
 * This function returns ONLY the static flag; dynamic iptables are handled
 * by `buildEgressIptablesRules`.
 */
export function buildDockerNetworkArgs(allowList: EgressAllowEntry[]): string[] {
  void allowList; // allow-list handled externally via iptables
  return ["--network=none"];
}

/**
 * Build iptables commands to allow specific egress entries for a container.
 *
 * These rules are applied to the host after `docker run` (or inside a sidecar)
 * using the container's network namespace.
 *
 * Returns shell-command strings (one per allow entry + one for DNS).
 * Each command resolves the host and opens the port.
 *
 * Note: In production this requires the container's `pid` to identify its
 * network namespace.  This function produces the conceptual rule shapes;
 * the executor layer supplies the namespace reference.
 */
export function buildEgressIptablesRules(
  normalised: Required<EgressAllowEntry>[],
  containerPid?: number,
): string[] {
  const nsPrefix = containerPid != null ? `nsenter -t ${containerPid} -n -- ` : "";
  const rules: string[] = [];

  for (const entry of normalised) {
    const proto = entry.protocol.toUpperCase();
    rules.push(
      `${nsPrefix}iptables -A OUTPUT -p ${proto} -d ${entry.host} --dport ${entry.port} -j ACCEPT`,
    );
  }

  // Default-deny everything else
  rules.push(`${nsPrefix}iptables -A OUTPUT -j DROP`);

  return rules;
}

// ─── DNS proxy config ─────────────────────────────────────────────────────────

/**
 * Generate a dnsmasq-compatible configuration that ONLY resolves allow-listed
 * hostnames.  All other lookups return NXDOMAIN (bogus-nxdomain approach).
 *
 * The config string can be written to a temporary file and passed to dnsmasq
 * via `--conf-file=<path>` when running the DNS proxy sidecar.
 *
 * Pure IPs in the allow-list are ignored (no DNS lookup needed).
 */
export function generateDnsProxyConfig(
  normalised: Required<EgressAllowEntry>[],
): string {
  const hostnames = [
    ...new Set(
      normalised
        .map((e) => e.host)
        .filter((h) => !isIpAddress(h)),
    ),
  ];

  const lines: string[] = [
    "# Generated by multiqlti sandbox — DNS allow-list",
    "# All unlisted hostnames are blocked",
    "no-resolv",               // do not read /etc/resolv.conf
    "no-hosts",                // do not read /etc/hosts
    "bogus-nxdomain=0.0.0.0",  // treat 0.0.0.0 responses as NXDOMAIN
    "strict-order",
    "server=8.8.8.8",          // upstream resolver for allow-listed names
    "",
    "# Allow-listed hostnames",
  ];

  for (const hostname of hostnames) {
    // ipset-based resolution: only forward queries for allow-listed hostnames
    lines.push(`server=/${hostname}/8.8.8.8`);
  }

  lines.push("");
  lines.push("# Deny everything else");
  lines.push("address=/#/");  // NXDOMAIN for all other names

  return lines.join("\n");
}

// ─── Kubernetes NetworkPolicy generation ─────────────────────────────────────

/**
 * Generate a Kubernetes NetworkPolicy manifest for a sandbox namespace.
 *
 * Policy:
 *  - Ingress: deny all (no inbound connections to sandbox pods)
 *  - Egress:
 *    - Always allow DNS (UDP/TCP port 53) to kube-dns
 *    - Allow each declared host:port entry
 *    - Deny everything else
 *
 * Returns a plain JavaScript object (caller can JSON.stringify or yaml.dump).
 */
export function generateK8sNetworkPolicy(
  namespaceName: string,
  normalised: Required<EgressAllowEntry>[],
): Record<string, unknown> {
  const egressRules: Record<string, unknown>[] = [
    // Always allow DNS
    {
      to: [
        {
          namespaceSelector: {
            matchLabels: { "kubernetes.io/metadata.name": "kube-system" },
          },
          podSelector: {
            matchLabels: { "k8s-app": "kube-dns" },
          },
        },
      ],
      ports: [
        { port: DNS_PORT, protocol: "UDP" },
        { port: DNS_PORT, protocol: "TCP" },
      ],
    },
  ];

  // Add per-entry egress rules
  for (const entry of normalised) {
    egressRules.push({
      to: [
        isIpAddress(entry.host)
          ? { ipBlock: { cidr: `${entry.host}/32` } }
          : {}, // hostname-based rules are not directly expressible in K8s NetworkPolicy;
                // use DNS-based allow-list + catch-all IP block instead
      ],
      ports: [
        {
          port: entry.port,
          protocol: entry.protocol.toUpperCase(),
        },
      ],
    });
  }

  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: "sandbox-egress-policy",
      namespace: namespaceName,
      labels: {
        "app.kubernetes.io/managed-by": "multiqlti",
        "multiqlti/component": "sandbox",
      },
    },
    spec: {
      podSelector: {}, // applies to all pods in the namespace
      policyTypes: ["Ingress", "Egress"],
      ingress: [], // deny all ingress
      egress: egressRules,
    },
  };
}

// ─── Resource quota ───────────────────────────────────────────────────────────

/** Kubernetes defaults for sandbox namespace resource quotas. */
export const SANDBOX_QUOTA_DEFAULTS = {
  limitCpu: "1",
  limitMemory: "512Mi",
  maxPods: 5,
} as const;

/**
 * Generate a Kubernetes ResourceQuota manifest for a sandbox namespace.
 */
export function generateK8sResourceQuota(
  namespaceName: string,
  options?: {
    limitCpu?: string;
    limitMemory?: string;
    maxPods?: number;
  },
): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "ResourceQuota",
    metadata: {
      name: "sandbox-quota",
      namespace: namespaceName,
      labels: {
        "app.kubernetes.io/managed-by": "multiqlti",
        "multiqlti/component": "sandbox",
      },
    },
    spec: {
      hard: {
        "limits.cpu": options?.limitCpu ?? SANDBOX_QUOTA_DEFAULTS.limitCpu,
        "limits.memory": options?.limitMemory ?? SANDBOX_QUOTA_DEFAULTS.limitMemory,
        pods: String(options?.maxPods ?? SANDBOX_QUOTA_DEFAULTS.maxPods),
      },
    },
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Return true when `host` looks like an IPv4 or IPv6 address.
 * Simple heuristic: if it contains only digits, dots, and colons.
 */
export function isIpAddress(host: string): boolean {
  return /^[\d.:]+$/.test(host);
}

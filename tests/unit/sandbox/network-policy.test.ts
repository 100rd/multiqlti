/**
 * Tests for server/sandbox/network-policy.ts
 *
 * Sections:
 *  1.  validateEgressAllowList — valid entries
 *  2.  validateEgressAllowList — invalid entries (empty host, bad port)
 *  3.  validateEgressAllowList — duplicate detection
 *  4.  validateEgressAllowList — protocol defaulting
 *  5.  buildDockerNetworkArgs — default-deny
 *  6.  buildEgressIptablesRules — rules shape
 *  7.  buildEgressIptablesRules — default-deny rule appended
 *  8.  generateDnsProxyConfig — allow-listed hostnames resolved
 *  9.  generateDnsProxyConfig — undeclared hostnames blocked (address=/#/)
 * 10.  generateDnsProxyConfig — IPs not emitted as server= lines
 * 11.  generateK8sNetworkPolicy — deny-all ingress
 * 12.  generateK8sNetworkPolicy — DNS egress always present
 * 13.  generateK8sNetworkPolicy — declared port in egress
 * 14.  generateK8sNetworkPolicy — empty allow-list → DNS only
 * 15.  generateK8sResourceQuota — defaults applied
 * 16.  generateK8sResourceQuota — overrides respected
 * 17.  isIpAddress — correctly identifies IPs vs hostnames
 */

import { describe, it, expect } from "vitest";
import {
  validateEgressAllowList,
  buildDockerNetworkArgs,
  buildEgressIptablesRules,
  generateDnsProxyConfig,
  generateK8sNetworkPolicy,
  generateK8sResourceQuota,
  SANDBOX_QUOTA_DEFAULTS,
  EgressValidationError,
  isIpAddress,
} from "../../../server/sandbox/network-policy";

// ─── 1. validateEgressAllowList — valid entries ───────────────────────────────

describe("validateEgressAllowList — valid entries", () => {
  it("accepts a single valid entry with defaults", () => {
    const result = validateEgressAllowList([{ host: "api.example.com", port: 443 }]);
    expect(result).toHaveLength(1);
    expect(result[0].host).toBe("api.example.com");
    expect(result[0].port).toBe(443);
    expect(result[0].protocol).toBe("tcp");
  });

  it("accepts mixed tcp/udp entries", () => {
    const result = validateEgressAllowList([
      { host: "log.example.com", port: 514, protocol: "udp" },
      { host: "api.example.com", port: 443, protocol: "tcp" },
    ]);
    expect(result[0].protocol).toBe("udp");
    expect(result[1].protocol).toBe("tcp");
  });

  it("trims whitespace from host names", () => {
    const result = validateEgressAllowList([{ host: "  api.example.com  ", port: 443 }]);
    expect(result[0].host).toBe("api.example.com");
  });

  it("accepts IP addresses", () => {
    const result = validateEgressAllowList([{ host: "10.0.0.1", port: 8080 }]);
    expect(result[0].host).toBe("10.0.0.1");
  });

  it("accepts boundary ports 1 and 65535", () => {
    const result = validateEgressAllowList([
      { host: "a.com", port: 1 },
      { host: "b.com", port: 65535 },
    ]);
    expect(result).toHaveLength(2);
  });

  it("returns empty array for empty input", () => {
    const result = validateEgressAllowList([]);
    expect(result).toHaveLength(0);
  });
});

// ─── 2. validateEgressAllowList — invalid entries ─────────────────────────────

describe("validateEgressAllowList — invalid entries", () => {
  it("throws on empty host string", () => {
    expect(() => validateEgressAllowList([{ host: "", port: 443 }])).toThrow(
      EgressValidationError,
    );
  });

  it("throws on whitespace-only host", () => {
    expect(() => validateEgressAllowList([{ host: "   ", port: 443 }])).toThrow(
      EgressValidationError,
    );
  });

  it("throws on port 0", () => {
    expect(() => validateEgressAllowList([{ host: "a.com", port: 0 }])).toThrow(
      EgressValidationError,
    );
  });

  it("throws on port 65536", () => {
    expect(() => validateEgressAllowList([{ host: "a.com", port: 65536 }])).toThrow(
      EgressValidationError,
    );
  });

  it("throws on negative port", () => {
    expect(() => validateEgressAllowList([{ host: "a.com", port: -1 }])).toThrow(
      EgressValidationError,
    );
  });

  it("throws on fractional port", () => {
    expect(() => validateEgressAllowList([{ host: "a.com", port: 80.5 }])).toThrow(
      EgressValidationError,
    );
  });
});

// ─── 3. validateEgressAllowList — duplicate detection ─────────────────────────

describe("validateEgressAllowList — duplicate detection", () => {
  it("throws on duplicate host:port:proto entries", () => {
    expect(() =>
      validateEgressAllowList([
        { host: "api.com", port: 443 },
        { host: "api.com", port: 443 },
      ]),
    ).toThrow(EgressValidationError);
  });

  it("allows same host on different ports", () => {
    const result = validateEgressAllowList([
      { host: "api.com", port: 443 },
      { host: "api.com", port: 80 },
    ]);
    expect(result).toHaveLength(2);
  });

  it("allows same host:port with different protocols", () => {
    const result = validateEgressAllowList([
      { host: "log.com", port: 514, protocol: "tcp" },
      { host: "log.com", port: 514, protocol: "udp" },
    ]);
    expect(result).toHaveLength(2);
  });
});

// ─── 4. validateEgressAllowList — protocol defaulting ─────────────────────────

describe("validateEgressAllowList — protocol defaulting", () => {
  it("defaults protocol to tcp when not specified", () => {
    const result = validateEgressAllowList([{ host: "a.com", port: 80 }]);
    expect(result[0].protocol).toBe("tcp");
  });
});

// ─── 5. buildDockerNetworkArgs — default-deny ─────────────────────────────────

describe("buildDockerNetworkArgs", () => {
  it("always returns --network=none (default-deny)", () => {
    const args = buildDockerNetworkArgs([]);
    expect(args).toContain("--network=none");
  });

  it("returns --network=none even when allow-list is populated", () => {
    const args = buildDockerNetworkArgs([{ host: "api.com", port: 443 }]);
    expect(args).toContain("--network=none");
  });
});

// ─── 6. buildEgressIptablesRules — rules shape ────────────────────────────────

describe("buildEgressIptablesRules — rules shape", () => {
  it("produces one ACCEPT rule per allow-list entry", () => {
    const normalised = validateEgressAllowList([
      { host: "api.com", port: 443 },
      { host: "log.com", port: 514, protocol: "udp" },
    ]);
    const rules = buildEgressIptablesRules(normalised);
    const acceptRules = rules.filter((r) => r.includes("-j ACCEPT"));
    expect(acceptRules).toHaveLength(2);
  });

  it("rule for tcp entry contains -p TCP and the port", () => {
    const normalised = validateEgressAllowList([{ host: "api.com", port: 443 }]);
    const rules = buildEgressIptablesRules(normalised);
    expect(rules[0]).toContain("-p TCP");
    expect(rules[0]).toContain("--dport 443");
    expect(rules[0]).toContain("api.com");
  });

  it("rule for udp entry contains -p UDP", () => {
    const normalised = validateEgressAllowList([
      { host: "log.com", port: 514, protocol: "udp" },
    ]);
    const rules = buildEgressIptablesRules(normalised);
    expect(rules[0]).toContain("-p UDP");
  });

  it("includes nsenter prefix when containerPid is provided", () => {
    const normalised = validateEgressAllowList([{ host: "api.com", port: 443 }]);
    const rules = buildEgressIptablesRules(normalised, 1234);
    expect(rules[0]).toContain("nsenter -t 1234 -n");
  });
});

// ─── 7. buildEgressIptablesRules — default-deny rule ─────────────────────────

describe("buildEgressIptablesRules — default-deny rule", () => {
  it("always appends a final DROP rule", () => {
    const normalised = validateEgressAllowList([{ host: "api.com", port: 443 }]);
    const rules = buildEgressIptablesRules(normalised);
    const lastRule = rules[rules.length - 1];
    expect(lastRule).toContain("-j DROP");
  });

  it("DROP rule is the only rule when allow-list is empty", () => {
    const rules = buildEgressIptablesRules([]);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain("-j DROP");
  });
});

// ─── 8. generateDnsProxyConfig — allow-listed hostnames ─────────────────────

describe("generateDnsProxyConfig — allow-listed hostnames resolved", () => {
  it("includes server= line for each allow-listed hostname", () => {
    const normalised = validateEgressAllowList([
      { host: "api.example.com", port: 443 },
    ]);
    const config = generateDnsProxyConfig(normalised);
    expect(config).toContain("server=/api.example.com/");
  });

  it("deduplicates hostname entries", () => {
    const normalised = validateEgressAllowList([
      { host: "api.com", port: 443 },
      { host: "api.com", port: 80 },
    ]);
    const config = generateDnsProxyConfig(normalised);
    const occurrences = (config.match(/server=\/api\.com\//g) ?? []).length;
    expect(occurrences).toBe(1);
  });
});

// ─── 9. generateDnsProxyConfig — undeclared hostnames blocked ─────────────────

describe("generateDnsProxyConfig — default-deny DNS", () => {
  it("contains address=/#/ to block all undeclared names", () => {
    const config = generateDnsProxyConfig([]);
    expect(config).toContain("address=/#/");
  });

  it("has no-resolv to avoid reading /etc/resolv.conf", () => {
    const config = generateDnsProxyConfig([]);
    expect(config).toContain("no-resolv");
  });
});

// ─── 10. generateDnsProxyConfig — IPs not emitted as server= lines ───────────

describe("generateDnsProxyConfig — IPs excluded from server= lines", () => {
  it("does not emit server= line for IP address entries", () => {
    const normalised = validateEgressAllowList([{ host: "10.0.0.1", port: 8080 }]);
    const config = generateDnsProxyConfig(normalised);
    expect(config).not.toContain("server=/10.0.0.1/");
  });
});

// ─── 11. generateK8sNetworkPolicy — deny-all ingress ─────────────────────────

describe("generateK8sNetworkPolicy — deny-all ingress", () => {
  it("sets ingress to empty array (deny all)", () => {
    const policy = generateK8sNetworkPolicy("sandbox-ns", []);
    expect(policy.spec).toBeDefined();
    const spec = policy.spec as Record<string, unknown>;
    expect(spec.ingress).toEqual([]);
  });

  it("includes both Ingress and Egress in policyTypes", () => {
    const policy = generateK8sNetworkPolicy("sandbox-ns", []);
    const spec = policy.spec as Record<string, unknown>;
    const types = spec.policyTypes as string[];
    expect(types).toContain("Ingress");
    expect(types).toContain("Egress");
  });
});

// ─── 12. generateK8sNetworkPolicy — DNS egress always present ─────────────────

describe("generateK8sNetworkPolicy — DNS egress always present", () => {
  it("first egress rule always allows DNS (port 53 UDP)", () => {
    const policy = generateK8sNetworkPolicy("sandbox-ns", []);
    const spec = policy.spec as Record<string, unknown>;
    const egress = spec.egress as Record<string, unknown>[];
    expect(egress.length).toBeGreaterThan(0);
    const dnsRule = egress[0];
    const ports = dnsRule.ports as Array<{ port: number; protocol: string }>;
    const hasUdp53 = ports.some((p) => p.port === 53 && p.protocol === "UDP");
    expect(hasUdp53).toBe(true);
  });
});

// ─── 13. generateK8sNetworkPolicy — declared port in egress ──────────────────

describe("generateK8sNetworkPolicy — declared port in egress", () => {
  it("adds an egress rule for each allow-list entry", () => {
    const normalised = validateEgressAllowList([
      { host: "1.2.3.4", port: 443 },
    ]);
    const policy = generateK8sNetworkPolicy("sandbox-ns", normalised);
    const spec = policy.spec as Record<string, unknown>;
    const egress = spec.egress as Record<string, unknown>[];
    // First rule is DNS; second is the declared entry
    expect(egress.length).toBe(2);
    const rule443 = egress[1];
    const ports = rule443.ports as Array<{ port: number; protocol: string }>;
    expect(ports[0].port).toBe(443);
  });
});

// ─── 14. generateK8sNetworkPolicy — empty allow-list → DNS only ───────────────

describe("generateK8sNetworkPolicy — empty allow-list", () => {
  it("produces exactly one egress rule (DNS) when allow-list is empty", () => {
    const policy = generateK8sNetworkPolicy("sandbox-ns", []);
    const spec = policy.spec as Record<string, unknown>;
    const egress = spec.egress as Record<string, unknown>[];
    expect(egress).toHaveLength(1);
  });
});

// ─── 15. generateK8sResourceQuota — defaults applied ─────────────────────────

describe("generateK8sResourceQuota — defaults", () => {
  it("applies SANDBOX_QUOTA_DEFAULTS when no overrides given", () => {
    const quota = generateK8sResourceQuota("sandbox-ns");
    const spec = quota.spec as Record<string, unknown>;
    const hard = spec.hard as Record<string, string>;
    expect(hard["limits.cpu"]).toBe(SANDBOX_QUOTA_DEFAULTS.limitCpu);
    expect(hard["limits.memory"]).toBe(SANDBOX_QUOTA_DEFAULTS.limitMemory);
    expect(hard.pods).toBe(String(SANDBOX_QUOTA_DEFAULTS.maxPods));
  });

  it("sets namespace in metadata", () => {
    const quota = generateK8sResourceQuota("my-sandbox-ns");
    const metadata = quota.metadata as Record<string, unknown>;
    expect(metadata.namespace).toBe("my-sandbox-ns");
  });
});

// ─── 16. generateK8sResourceQuota — overrides respected ──────────────────────

describe("generateK8sResourceQuota — overrides", () => {
  it("uses provided CPU limit", () => {
    const quota = generateK8sResourceQuota("ns", { limitCpu: "2" });
    const hard = (quota.spec as Record<string, Record<string, string>>).hard;
    expect(hard["limits.cpu"]).toBe("2");
  });

  it("uses provided memory limit", () => {
    const quota = generateK8sResourceQuota("ns", { limitMemory: "1Gi" });
    const hard = (quota.spec as Record<string, Record<string, string>>).hard;
    expect(hard["limits.memory"]).toBe("1Gi");
  });

  it("uses provided maxPods", () => {
    const quota = generateK8sResourceQuota("ns", { maxPods: 3 });
    const hard = (quota.spec as Record<string, Record<string, string>>).hard;
    expect(hard.pods).toBe("3");
  });
});

// ─── 17. isIpAddress ─────────────────────────────────────────────────────────

describe("isIpAddress", () => {
  it("returns true for IPv4", () => {
    expect(isIpAddress("192.168.1.1")).toBe(true);
  });

  it("returns true for IPv6 loopback", () => {
    expect(isIpAddress("::1")).toBe(true);
  });

  it("returns false for hostnames", () => {
    expect(isIpAddress("api.example.com")).toBe(false);
  });

  it("returns false for hostnames with hyphens", () => {
    expect(isIpAddress("my-api.example.com")).toBe(false);
  });
});

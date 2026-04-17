/**
 * Tests for server/sandbox/seccomp.ts
 *
 * Sections:
 *  1. generateSeccompProfile — valid JSON structure
 *  2. generateSeccompProfile — dangerous syscalls are denied
 *  3. generateSeccompProfile — socket syscall behaviour (network flag)
 *  4. generateSeccompProfile — idempotent (same input → same output)
 *  5. generateAppArmorProfile — valid profile text
 *  6. generateAppArmorProfile — write restrictions
 *  7. generateAppArmorProfile — custom profile name
 */

import { describe, it, expect } from "vitest";
import {
  generateSeccompProfile,
  generateAppArmorProfile,
  DENIED_SYSCALLS,
} from "../../../server/sandbox/seccomp";

// ─── 1. generateSeccompProfile — valid JSON structure ─────────────────────────

describe("generateSeccompProfile — JSON structure", () => {
  it("produces valid JSON", () => {
    expect(() => JSON.parse(generateSeccompProfile())).not.toThrow();
  });

  it("has defaultAction SCMP_ACT_ALLOW", () => {
    const profile = JSON.parse(generateSeccompProfile());
    expect(profile.defaultAction).toBe("SCMP_ACT_ALLOW");
  });

  it("includes x86_64 architecture", () => {
    const profile = JSON.parse(generateSeccompProfile());
    expect(profile.architectures).toContain("SCMP_ARCH_X86_64");
  });

  it("has a non-empty syscalls array", () => {
    const profile = JSON.parse(generateSeccompProfile());
    expect(Array.isArray(profile.syscalls)).toBe(true);
    expect(profile.syscalls.length).toBeGreaterThan(0);
  });

  it("deny rule uses SCMP_ACT_ERRNO action", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const denyRule = profile.syscalls[0];
    expect(denyRule.action).toBe("SCMP_ACT_ERRNO");
  });
});

// ─── 2. generateSeccompProfile — dangerous syscalls denied ────────────────────

describe("generateSeccompProfile — dangerous syscalls blocked", () => {
  it("denies ptrace", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("ptrace");
  });

  it("denies clone3", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("clone3");
  });

  it("denies reboot", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("reboot");
  });

  it("denies kexec_load", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("kexec_load");
  });

  it("denies bpf", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("bpf");
  });

  it("denies mount", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("mount");
  });

  it("DENIED_SYSCALLS constant contains all required entries", () => {
    const required = ["ptrace", "clone3", "reboot", "bpf", "mount", "init_module"];
    for (const syscall of required) {
      expect(DENIED_SYSCALLS).toContain(syscall);
    }
  });
});

// ─── 3. generateSeccompProfile — socket syscall behaviour ─────────────────────

describe("generateSeccompProfile — socket syscall", () => {
  it("includes socket in deny-list when allowNetworkSyscalls is false (default)", () => {
    const profile = JSON.parse(generateSeccompProfile());
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("socket");
  });

  it("excludes socket from deny-list when allowNetworkSyscalls is true", () => {
    const profile = JSON.parse(generateSeccompProfile({ allowNetworkSyscalls: true }));
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).not.toContain("socket");
  });

  it("still denies ptrace when allowNetworkSyscalls is true", () => {
    const profile = JSON.parse(generateSeccompProfile({ allowNetworkSyscalls: true }));
    const deniedNames: string[] = profile.syscalls[0].names;
    expect(deniedNames).toContain("ptrace");
  });
});

// ─── 4. generateSeccompProfile — idempotent ───────────────────────────────────

describe("generateSeccompProfile — idempotent", () => {
  it("produces identical output on repeated calls with same options", () => {
    const a = generateSeccompProfile({ allowNetworkSyscalls: false });
    const b = generateSeccompProfile({ allowNetworkSyscalls: false });
    expect(a).toBe(b);
  });

  it("produces different output for different network flag values", () => {
    const withNetwork = generateSeccompProfile({ allowNetworkSyscalls: true });
    const withoutNetwork = generateSeccompProfile({ allowNetworkSyscalls: false });
    expect(withNetwork).not.toBe(withoutNetwork);
  });
});

// ─── 5. generateAppArmorProfile — valid profile text ─────────────────────────

describe("generateAppArmorProfile — structure", () => {
  it("starts with #include <tunables/global>", () => {
    const profile = generateAppArmorProfile();
    expect(profile.trimStart()).toMatch(/^#include <tunables\/global>/);
  });

  it("includes the default profile name", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("multiqlti-sandbox");
  });

  it("includes the attach_disconnected flag", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("attach_disconnected");
  });
});

// ─── 6. generateAppArmorProfile — write restrictions ─────────────────────────

describe("generateAppArmorProfile — write restrictions", () => {
  it("allows full access under /tmp/sandbox", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("/tmp/sandbox/");
    // rwmklix = read, write, make (create dir), kill, link, inherit, exec
    expect(profile).toMatch(/\/tmp\/sandbox\/\*\*.+rwmklix/);
  });

  it("denies writes to /etc", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("deny /etc/** w");
  });

  it("denies writes to /root", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("deny /root/** w");
  });

  it("denies writes to /proc", () => {
    const profile = generateAppArmorProfile();
    expect(profile).toContain("deny /proc/** w");
  });
});

// ─── 7. generateAppArmorProfile — custom profile name ────────────────────────

describe("generateAppArmorProfile — custom profile name", () => {
  it("uses the provided profile name", () => {
    const profile = generateAppArmorProfile("my-custom-profile");
    expect(profile).toContain("profile my-custom-profile");
  });

  it("does not contain the default name when overridden", () => {
    const profile = generateAppArmorProfile("my-custom-profile");
    expect(profile).not.toContain("multiqlti-sandbox");
  });
});

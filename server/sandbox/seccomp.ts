/**
 * Seccomp profile generation for sandbox containers.
 *
 * Produces a Docker-compatible seccomp profile that:
 *  - Starts from the Docker default allow-list
 *  - Explicitly DENIES syscalls that are dangerous for untrusted code:
 *    clone3, ptrace, reboot, and a curated list of kernel-manipulation syscalls
 *  - Returns a JSON string suitable for `--security-opt seccomp=<json>`
 *
 * References:
 *  - https://docs.docker.com/engine/security/seccomp/
 *  - https://github.com/moby/moby/blob/master/profiles/seccomp/default.json
 */

// ─── Denied syscall list ─────────────────────────────────────────────────────

/**
 * Syscalls explicitly blocked for sandbox containers.
 * These are either:
 *  (a) Not needed by any legitimate workload in a code sandbox
 *  (b) Commonly used in container escape / privilege escalation paths
 */
export const DENIED_SYSCALLS: readonly string[] = [
  // Process tracing — allows inspecting / injecting into other processes
  "ptrace",

  // New clone interface — preferred path for creating user namespaces in modern kernels
  "clone3",

  // System control — no legitimate need in a code sandbox
  "reboot",
  "kexec_load",
  "kexec_file_load",

  // Raw kernel module loading
  "init_module",
  "finit_module",
  "delete_module",

  // Kernel keyring — potential privilege escalation vector
  "add_key",
  "request_key",
  "keyctl",

  // BPF — can be used to monitor/modify kernel behaviour
  "bpf",

  // Perf events — can leak sensitive kernel data
  "perf_event_open",

  // Time namespace manipulation — can confuse monitoring
  "clock_adjtime",
  "adjtimex",

  // Unshare can be used to gain new capabilities in user namespaces
  "unshare",

  // Mount / unmount — should not be needed in a code-only sandbox
  "mount",
  "umount",
  "umount2",
  "pivot_root",

  // Raw sockets that bypass network policies
  "socket",      // will be added back selectively if networkEnabled; handled by executor
] as const;

// ─── Profile generation ───────────────────────────────────────────────────────

/**
 * Generate a minimal but safe seccomp profile.
 *
 * Strategy: `defaultAction = SCMP_ACT_ALLOW` (Docker default) with an
 * explicit `SCMP_ACT_ERRNO` deny-list applied first.
 *
 * We intentionally use the Docker "default" base approach (allow-all +
 * explicit denies) rather than a strict allow-list for two reasons:
 *  1. A strict allow-list frequently breaks legitimate workloads and is hard
 *     to maintain across kernel/libc versions.
 *  2. The primary threat model for these sandboxes is code that attempts
 *     container escape or resource abuse — the deny-list covers the most
 *     critical attack paths while remaining operationally stable.
 *
 * When `allowNetworkSyscalls` is false (the default, matching default-deny
 * network policy) the `socket` syscall is included in the deny-list.
 * When true, `socket` is removed so TCP/UDP connections are possible
 * (the network policy is the outer control layer).
 */
export function generateSeccompProfile(options?: {
  allowNetworkSyscalls?: boolean;
}): string {
  const allowNetwork = options?.allowNetworkSyscalls ?? false;

  const deniedSyscalls = allowNetwork
    ? DENIED_SYSCALLS.filter((s) => s !== "socket")
    : DENIED_SYSCALLS;

  const profile = {
    defaultAction: "SCMP_ACT_ALLOW",
    architectures: ["SCMP_ARCH_X86_64", "SCMP_ARCH_X86", "SCMP_ARCH_X32"],
    syscalls: [
      {
        names: [...deniedSyscalls],
        action: "SCMP_ACT_ERRNO",
        errnoRet: 1, // EPERM
      },
    ],
  };

  return JSON.stringify(profile);
}

// ─── AppArmor profile generation ─────────────────────────────────────────────

/**
 * Generate an AppArmor profile that restricts filesystem writes to /tmp/sandbox.
 *
 * The profile:
 *  - Allows read access to the full filesystem (needed for /usr/bin, /lib, etc.)
 *  - Allows write/exec only under /tmp/sandbox/**
 *  - Denies write access everywhere else
 *  - Allows standard network operations (controlled separately at the network layer)
 *
 * Returns the AppArmor profile text.
 * Use with `--security-opt apparmor=multiqlti-sandbox`
 * (profile must be loaded into the kernel with `apparmor_parser -r`)
 */
export function generateAppArmorProfile(profileName = "multiqlti-sandbox"): string {
  return `
#include <tunables/global>

profile ${profileName} flags=(attach_disconnected,mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # Allow reading entire filesystem (needed for runtime libraries)
  / r,
  /** r,

  # Allow full access under the sandbox working directory
  /tmp/sandbox/ rw,
  /tmp/sandbox/** rwmklix,

  # Allow execution of common runtimes
  /usr/bin/** ix,
  /usr/local/bin/** ix,
  /usr/lib/** ix,
  /usr/local/lib/** ix,
  /lib/** ix,
  /lib64/** ix,
  /bin/** ix,
  /sbin/** ix,

  # Allow process control signals
  signal (send, receive) peer=${profileName},

  # Deny writes outside /tmp/sandbox
  deny /etc/** w,
  deny /root/** w,
  deny /home/** w,
  deny /var/** w,
  deny /proc/** w,
  deny /sys/** w,
  deny /dev/** w,

  # Allow standard network (egress controlled by network policy)
  network tcp,
  network udp,
}
`.trimStart();
}

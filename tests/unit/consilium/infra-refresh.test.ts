/**
 * infra-refresh.test.ts — ADR-003 §D4 Phase 3c read-only reconcile runner.
 * fs + child_process are mocked, so no live infra / binaries are needed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fsState = vi.hoisted(() => ({
  entries: [] as string[],
  throwOnRead: false,
}));
vi.mock("node:fs/promises", () => ({
  readdir: vi.fn(async () => {
    if (fsState.throwOnRead) throw new Error("readdir failed");
    return fsState.entries;
  }),
}));

const execState = vi.hoisted(() => ({
  impl: null as
    | null
    | ((
        binary: string,
        argv: string[],
        opts: unknown,
        cb: (e: Error | null, o: string, s: string) => void,
      ) => void),
}));
vi.mock("node:child_process", () => ({
  execFile: (
    binary: string,
    argv: string[],
    opts: unknown,
    cb: (e: Error | null, o: string, s: string) => void,
  ) => {
    if (execState.impl) return execState.impl(binary, argv, opts, cb);
    cb(new Error("spawn ENOENT"), "", "");
  },
}));

import {
  assertReadOnly,
  READ_ONLY_STEPS,
  detectRepoKind,
  runInfraRefresh,
} from "../../../server/services/consilium/infra-refresh.js";

beforeEach(() => {
  fsState.entries = [];
  fsState.throwOnRead = false;
  execState.impl = null;
});

describe("infra-refresh — read-only guard (ADR-003 §D4)", () => {
  it("every shipped command is read/plan-only (no mutating token)", () => {
    for (const steps of Object.values(READ_ONLY_STEPS)) {
      for (const argv of steps) {
        expect(() => assertReadOnly(argv)).not.toThrow();
      }
    }
  });

  it.each(["apply", "destroy", "delete", "replace", "patch", "-auto-approve"])(
    "rejects the mutating token %s",
    (tok) => {
      expect(() => assertReadOnly(["plan", tok])).toThrow(/read\/plan-only/);
    },
  );
});

describe("infra-refresh — detectRepoKind", () => {
  it("detects terraform from a .tf file", async () => {
    fsState.entries = ["main.tf", "README.md"];
    expect(await detectRepoKind("/repo")).toBe("terraform");
  });

  it("detects kubernetes from a kustomization.yaml", async () => {
    fsState.entries = ["kustomization.yaml"];
    expect(await detectRepoKind("/repo")).toBe("kubernetes");
  });

  it("returns null with no infra marker", async () => {
    fsState.entries = ["src", "package.json"];
    expect(await detectRepoKind("/repo")).toBeNull();
  });

  it("returns null (fail-soft) when the dir cannot be read", async () => {
    fsState.throwOnRead = true;
    expect(await detectRepoKind("/repo")).toBeNull();
  });
});

describe("infra-refresh — runInfraRefresh", () => {
  it("does not run and returns an empty summary when no infra marker is present", async () => {
    fsState.entries = ["package.json"];
    const r = await runInfraRefresh({ repoDir: "/repo", env: {}, scrubValues: [] });
    expect(r).toEqual({ ran: false, summary: "" });
  });

  it("scrubs a leased value from the command output", async () => {
    const secret = "leased-tf-secret-value-987";
    execState.impl = (_b, _a, _o, cb) => cb(null, `Plan token ${secret} here`, "");
    const r = await runInfraRefresh({
      repoDir: "/repo",
      env: {},
      scrubValues: [secret],
      kindOverride: "terraform",
    });
    expect(r.ran).toBe(true);
    expect(r.summary).not.toContain(secret);
    expect(r.summary).toContain("[REDACTED]");
  });

  it("is fail-soft: never throws when the binary/exec errors", async () => {
    execState.impl = (_b, _a, _o, cb) =>
      cb(new Error("spawn terraform ENOENT"), "", "");
    const r = await runInfraRefresh({
      repoDir: "/repo",
      env: {},
      scrubValues: [],
      kindOverride: "kubernetes",
    });
    expect(typeof r.summary).toBe("string"); // returned instead of throwing
  });
});

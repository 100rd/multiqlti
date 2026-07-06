/**
 * command-auth.test.ts — TRACK-6 (task-tracker-triggers.md §8): commenter authorisation
 * is verified via the tracker API, fail-closed. Adversarial: an unauthorized commenter
 * must never be granted authority; a degraded API must never grant authority; a hostile
 * login shape must never reach a `gh` path as a flag.
 */
import { describe, it, expect, vi } from "vitest";
import type { ExecFileFn } from "../../../../server/services/github-status.js";
import { isAuthorizedCommenter } from "../../../../server/services/consilium/trackers/command-auth.js";

interface GhOpts {
  assignees?: Array<{ login?: string }>;
  permission?: string;
  /** args→throw to simulate a gh outage. */
  throwOn?: (args: string[]) => boolean;
}

function fakeGh(opts: GhOpts): { run: ExecFileFn; argv: string[][] } {
  const argv: string[][] = [];
  const run: ExecFileFn = vi.fn(async (_file: string, args: string[]) => {
    argv.push(args);
    if (opts.throwOn?.(args)) throw new Error("gh boom");
    const json = (o: unknown) => ({ stdout: JSON.stringify(o), stderr: "" });
    if (args[0] === "issue" && args[1] === "view") return json({ assignees: opts.assignees ?? [] });
    if (args[0] === "api" && String(args[1]).includes("/collaborators/")) {
      if (opts.permission === undefined) throw new Error("404 Not Found"); // not a collaborator
      return json({ permission: opts.permission });
    }
    return { stdout: "", stderr: "" };
  });
  return { run, argv };
}

const base = { repo: "acme/widget", issueNumber: 42, login: "alice" };

describe("isAuthorizedCommenter", () => {
  it("authorises the ticket ASSIGNEE", async () => {
    const { run } = fakeGh({ assignees: [{ login: "alice" }] });
    expect(await isAuthorizedCommenter(base, run)).toBe(true);
  });

  it("authorises a MAINTAINER (write/admin/maintain permission)", async () => {
    for (const permission of ["admin", "maintain", "write"]) {
      const { run } = fakeGh({ assignees: [], permission });
      expect(await isAuthorizedCommenter(base, run)).toBe(true);
    }
  });

  it("REJECTS a non-assignee, non-maintainer (read/none/not-a-collaborator)", async () => {
    expect(await isAuthorizedCommenter(base, fakeGh({ assignees: [], permission: "read" }).run)).toBe(false);
    expect(await isAuthorizedCommenter(base, fakeGh({ assignees: [] }).run)).toBe(false); // 404
  });

  it("fails closed on a gh outage (degraded API never grants authority)", async () => {
    const { run } = fakeGh({ throwOn: () => true });
    expect(await isAuthorizedCommenter(base, run)).toBe(false);
  });

  it("rejects a hostile login shape without ever calling the permission endpoint", async () => {
    const { run, argv } = fakeGh({ assignees: [], permission: "admin" });
    expect(await isAuthorizedCommenter({ ...base, login: "--flag" }, run)).toBe(false);
    expect(await isAuthorizedCommenter({ ...base, login: "a/../b" }, run)).toBe(false);
    // Never reached the collaborators endpoint with an invalid login.
    expect(argv.some((a) => a[0] === "api" && String(a[1]).includes("/collaborators/"))).toBe(false);
  });

  it("rejects a bad repo shape / non-positive issue number", async () => {
    const { run } = fakeGh({ assignees: [{ login: "alice" }], permission: "admin" });
    expect(await isAuthorizedCommenter({ ...base, repo: "not-a-repo" }, run)).toBe(false);
    expect(await isAuthorizedCommenter({ ...base, issueNumber: 0 }, run)).toBe(false);
  });
});

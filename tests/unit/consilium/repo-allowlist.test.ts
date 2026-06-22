/**
 * Unit tests for server/services/consilium/repo-allowlist.ts (Phase A2, H-1).
 *
 * Proves the defense-in-depth confinement: realpath resolution, fail-closed
 * empty allowlist, `../` traversal rejection, symlink-escape rejection, and the
 * system-critical denylist — byte-mirroring file-watcher's validateWatchPath.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { assertAllowedRepoPath } from "../../../server/services/consilium/repo-allowlist.js";

describe("assertAllowedRepoPath", () => {
  let tmp: string;
  let allowed: string;
  let outside: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "consilium-allow-"));
    allowed = await fs.realpath(await mk(path.join(tmp, "allowed")));
    outside = await fs.realpath(await mk(path.join(tmp, "outside")));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  async function mk(p: string): Promise<string> {
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  it("accepts the root itself and returns the realpath'd path", async () => {
    expect(assertAllowedRepoPath(allowed, [allowed])).toBe(allowed);
  });

  it("accepts a child of an allowed root", async () => {
    const child = await mk(path.join(allowed, "sub", "repo"));
    expect(assertAllowedRepoPath(child, [allowed])).toBe(await fs.realpath(child));
  });

  it("fails closed on an empty allowlist", () => {
    expect(() => assertAllowedRepoPath(allowed, [])).toThrow(/fail-closed/i);
  });

  it("rejects a sibling path outside every allowed root", () => {
    expect(() => assertAllowedRepoPath(outside, [allowed])).toThrow(/outside/i);
  });

  it("rejects a ../ traversal that escapes the root", () => {
    const escape = path.join(allowed, "..", "outside");
    expect(() => assertAllowedRepoPath(escape, [allowed])).toThrow();
  });

  it("rejects a symlink that escapes the allowed root", async () => {
    const link = path.join(allowed, "escape-link");
    await fs.symlink(outside, link, "dir");
    // realpath follows the link to `outside`, which is not under `allowed`.
    expect(() => assertAllowedRepoPath(link, [allowed])).toThrow(/outside/i);
  });

  it("rejects system-critical denylisted paths even if somehow allowed", () => {
    // /proc and /sys do not exist on macOS, so realResolve keeps them lexical
    // and the denylist catches them (on Linux they realpath to themselves).
    expect(() => assertAllowedRepoPath("/proc", ["/"])).toThrow(/denied/i);
    expect(() => assertAllowedRepoPath("/sys/kernel", ["/"])).toThrow(/denied/i);
  });
});

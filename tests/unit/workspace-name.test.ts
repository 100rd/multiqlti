import { describe, it, expect } from "vitest";
import {
  normalizePath,
  repoBasename,
  resolveWorkspaceName,
} from "../../client/src/lib/workspace-name.js";
import type { WorkspaceRow } from "@shared/schema";

/** Minimal WorkspaceRow factory — only the fields the resolver reads. */
function ws(name: string, path: string, type = "local"): WorkspaceRow {
  return { name, path, type } as unknown as WorkspaceRow;
}

describe("normalizePath", () => {
  it("strips trailing slashes so /repo and /repo/ compare equal", () => {
    expect(normalizePath("/a/b/")).toBe("/a/b");
    expect(normalizePath("/a/b///")).toBe("/a/b");
    expect(normalizePath("/a/b")).toBe("/a/b");
  });
});

describe("repoBasename", () => {
  it("returns the last path segment", () => {
    expect(repoBasename("/x/y/iac")).toBe("iac");
    expect(repoBasename("/x/y/iac/")).toBe("iac");
  });
  it("falls back to the raw input when there is no segment", () => {
    expect(repoBasename("")).toBe("");
  });
});

describe("resolveWorkspaceName", () => {
  const workspaces = [
    ws("multiqlti-smoke-test", "/Users/dev/project/multiqlti"),
    ws("iac", "/Users/dev/project/werush/iac"),
    ws("remote-thing", "/Users/dev/project/multiqlti", "remote"),
  ];

  it("returns the workspace NAME when the loop path matches by path", () => {
    // Name deliberately differs from the basename ("multiqlti") — proves we use
    // the workspace's own name, not the repo folder.
    expect(resolveWorkspaceName("/Users/dev/project/multiqlti", workspaces)).toBe(
      "multiqlti-smoke-test",
    );
    expect(resolveWorkspaceName("/Users/dev/project/werush/iac", workspaces)).toBe("iac");
  });

  it("matches trailing-slash-insensitively", () => {
    expect(resolveWorkspaceName("/Users/dev/project/werush/iac/", workspaces)).toBe("iac");
  });

  it("ignores non-local workspaces at the same path", () => {
    // Only the `local` row (multiqlti-smoke-test) should ever match a repoPath;
    // the remote row sharing the path must not win.
    expect(resolveWorkspaceName("/Users/dev/project/multiqlti", [workspaces[2]])).toBe(
      "multiqlti",
    );
  });

  it("falls back to the repo basename when no workspace matches", () => {
    expect(resolveWorkspaceName("/Users/dev/project/unregistered", workspaces)).toBe(
      "unregistered",
    );
  });

  it("falls back to the basename when the workspace list is undefined", () => {
    expect(resolveWorkspaceName("/Users/dev/project/werush/iac", undefined)).toBe("iac");
  });
});

/**
 * gitlab-connector.test.ts — TRACK-4 GitLab dialect with a FAKE GitLab HTTP transport
 * (no network). Covers: the project ref is sanitised + URL-encoded (path-escape proof);
 * the label is a plain query param; watch/read mapping to the normalised Ticket;
 * idempotent note write-back (marker dedup, no double-post); the pickup label add
 * (GitLab's "transition"); and the deterministic `spec/gitlab-<iid>` naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  GitlabTrackerConnector,
  sanitizeProjectRef,
  sanitizeIid,
  gitlabSpecBranchName,
  gitlabSpecFilePath,
  type GitlabConnectorConfig,
} from "../../../../server/services/consilium/trackers/gitlab-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { GitlabHttpFn, GitlabHttpResult } from "../../../../server/services/consilium/trackers/gitlab-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeHttp(handler: (call: Call) => GitlabHttpResult): { http: GitlabHttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: GitlabHttpFn = vi.fn(async (req) => {
    const call: Call = { method: req.method, url: req.url, body: req.body };
    calls.push(call);
    return handler(call);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): GitlabHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: GitlabConnectorConfig = {
  baseUrl: "https://gitlab.com",
  project: "group/widget",
  label: "agent",
};

function connector(cfg: Partial<GitlabConnectorConfig>, handler: (c: Call) => GitlabHttpResult) {
  const { http, calls } = fakeHttp(handler);
  const conn = new GitlabTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { token: "secret-token" },
    log: () => {},
  });
  return { conn, calls };
}

/** True for the ISSUES LIST url (`.../issues` with no trailing id segment). */
const isList = (u: string) => new URL(u).pathname.endsWith("/issues");
const isNotes = (u: string) => new URL(u).pathname.endsWith("/notes");
const isSingle = (u: string) => /\/issues\/\d+$/.test(new URL(u).pathname);

describe("naming + id sanitisation", () => {
  it("derives a shape-safe branch/path from the iid", () => {
    expect(gitlabSpecBranchName("42")).toBe("spec/gitlab-42");
    expect(isValidSpecBranch(gitlabSpecBranchName("42"))).toBe(true);
    expect(gitlabSpecFilePath("42", "Add Rate Limiting!")).toBe("docs/specs/gitlab-42-add-rate-limiting.md");
  });

  it("strips non-digits so a hostile iid can never escape", () => {
    expect(sanitizeIid("../../etc/passwd")).toBe("");
    expect(sanitizeIid("42abc")).toBe("42");
    expect(() => gitlabSpecBranchName("../7")).not.toThrow(); // sanitises to "7"
    expect(gitlabSpecBranchName("../7")).toBe("spec/gitlab-7");
  });

  it("throws on an iid that sanitises to empty", () => {
    expect(() => gitlabSpecBranchName("abc")).toThrow();
  });

  it("sanitises a project ref to a URL-safe path (no escape, no traversal)", () => {
    expect(sanitizeProjectRef("group/sub/widget")).toBe("group/sub/widget");
    expect(sanitizeProjectRef("42")).toBe("42");
    expect(sanitizeProjectRef("../../../etc")).toBe("etc"); // dots+slashes collapse, no `..`
    expect(sanitizeProjectRef("a\\b`c;d")).toBe("abcd");
  });
});

describe("pollTickets — query construction + mapping", () => {
  const ISSUE = {
    iid: 7,
    title: "Add rate limiting",
    description: "## Acceptance Criteria\n- returns 429",
    labels: ["agent", "backend"],
    web_url: "https://gitlab.com/group/widget/-/issues/7",
    updated_at: "2026-01-02T10:00:00.000Z",
  };

  it("filters by label + opened state and encodes the project path", async () => {
    let listUrl = "";
    const { conn } = connector({}, (c) => {
      if (isList(c.url)) {
        listUrl = c.url;
        return json([ISSUE]);
      }
      return json({});
    });
    const tickets = await conn.pollTickets();
    const u = new URL(listUrl);
    expect(u.pathname).toBe("/api/v4/projects/group%2Fwidget/issues");
    expect(u.searchParams.get("labels")).toBe("agent");
    expect(u.searchParams.get("state")).toBe("opened");
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "7",
      title: "Add rate limiting",
      body: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "backend"],
      url: "https://gitlab.com/group/widget/-/issues/7",
    });
  });

  it("passes an ISO watermark as updated_after, ignores garbage", async () => {
    const urls: string[] = [];
    const { conn } = connector({}, (c) => {
      if (isList(c.url)) { urls.push(c.url); return json([]); }
      return json({});
    });
    await conn.pollTickets("2026-01-01T00:00:00.000Z");
    expect(new URL(urls[0]).searchParams.get("updated_after")).toBe("2026-01-01T00:00:00.000Z");

    await conn.pollTickets("not-a-date");
    expect(new URL(urls[1]).searchParams.get("updated_after")).toBeNull(); // garbage watermark dropped
  });

  it("returns null on a degraded search (HTTP 500) and on unconfigured auth", async () => {
    const { conn } = connector({}, (c) => (isList(c.url) ? { status: 500, body: "boom" } : json({})));
    expect(await conn.pollTickets()).toBeNull();

    const { http } = fakeHttp(() => json([ISSUE]));
    const noAuth = new GitlabTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await noAuth.pollTickets()).toBeNull();
  });

  it("readTicket fetches one issue by iid", async () => {
    const { conn, calls } = connector({}, (c) => (isSingle(c.url) ? json(ISSUE) : json({})));
    const t = await conn.readTicket("7");
    expect(t?.id).toBe("7");
    expect(calls.some((c) => c.method === "GET" && new URL(c.url).pathname.endsWith("/issues/7"))).toBe(true);
  });
});

describe("write-back — note idempotency + pickup label", () => {
  it("posts a note when the marker is absent", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (isNotes(c.url) && c.method === "GET") return json([]);
      if (isNotes(c.url) && c.method === "POST") return { status: 201, body: "{}" };
      return json({});
    });
    const res = await conn.writeback.comment("7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const post = calls.find((c) => isNotes(c.url) && c.method === "POST");
    expect(post!.body).toContain("<!-- marker -->");
    expect(post!.body).toContain("picked up");
  });

  it("does NOT double-post when a note already carries the marker", async () => {
    const { conn, calls } = connector({}, (c) =>
      isNotes(c.url) && c.method === "GET" ? json([{ body: "<!-- marker -->\npicked up earlier" }]) : json({}),
    );
    const res = await conn.writeback.comment("7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does NOT post when notes are unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, (c) =>
      isNotes(c.url) && c.method === "GET" ? { status: 503, body: "" } : json({}),
    );
    const res = await conn.writeback.comment("7", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("adds a label via PUT add_labels (the pickup transition); blank → no-op", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "PUT" && isSingle(c.url) ? { status: 200, body: "{}" } : json({}),
    );
    const ok = await conn.writeback.transition!("7", "in-progress");
    expect(ok.posted).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put!.body).toContain('"add_labels":"in-progress"');

    const noop = await conn.writeback.transition!("7", "   ");
    expect(noop.posted).toBe(false);
    expect(noop.reason).toBe("no-label");
  });
});

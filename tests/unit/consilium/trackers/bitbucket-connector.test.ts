/**
 * bitbucket-connector.test.ts — TRACK-4 Bitbucket dialect with a FAKE Bitbucket HTTP
 * transport (no network). Covers: the BBQL `q` is built from a SANITISED, quoted
 * component literal (injection-proof) + active-state filter; workspace/slug sanitisation;
 * watch/read mapping (component→labels) to the normalised Ticket; idempotent comment
 * write-back (marker dedup); the pickup state change (allowlisted states only); and the
 * deterministic `spec/bitbucket-<id>` naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  BitbucketTrackerConnector,
  sanitizeSlug,
  sanitizeIssueId,
  bbqlLiteral,
  bitbucketSpecBranchName,
  bitbucketSpecFilePath,
  type BitbucketConnectorConfig,
} from "../../../../server/services/consilium/trackers/bitbucket-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { BitbucketHttpFn, BitbucketHttpResult } from "../../../../server/services/consilium/trackers/bitbucket-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeHttp(handler: (call: Call) => BitbucketHttpResult): { http: BitbucketHttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: BitbucketHttpFn = vi.fn(async (req) => {
    const call: Call = { method: req.method, url: req.url, body: req.body };
    calls.push(call);
    return handler(call);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): BitbucketHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: BitbucketConnectorConfig = {
  workspace: "acme",
  repoSlug: "widget",
  label: "agent",
};

function connector(cfg: Partial<BitbucketConnectorConfig>, handler: (c: Call) => BitbucketHttpResult) {
  const { http, calls } = fakeHttp(handler);
  const conn = new BitbucketTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { username: "bot", appPassword: "secret-pw" },
    log: () => {},
  });
  return { conn, calls };
}

const qOf = (url: string) => new URL(url).searchParams.get("q") ?? "";
const isList = (u: string) => new URL(u).pathname.endsWith("/issues");
const isComments = (u: string) => new URL(u).pathname.endsWith("/comments");
const isSingle = (u: string) => /\/issues\/\d+$/.test(new URL(u).pathname);

const ISSUE = {
  id: 42,
  title: "Add rate limiting",
  content: { raw: "## Acceptance Criteria\n- returns 429" },
  state: "new",
  kind: "task",
  priority: "major",
  component: { name: "agent" },
  updated_on: "2026-01-02T10:00:00.000000+00:00",
  links: { html: { href: "https://bitbucket.org/acme/widget/issues/42" } },
};

describe("naming + id sanitisation", () => {
  it("derives a shape-safe branch/path from the id", () => {
    expect(bitbucketSpecBranchName("42")).toBe("spec/bitbucket-42");
    expect(isValidSpecBranch(bitbucketSpecBranchName("42"))).toBe(true);
    expect(bitbucketSpecFilePath("42", "Add Rate Limiting!")).toBe("docs/specs/bitbucket-42-add-rate-limiting.md");
  });

  it("strips non-digits / hostile slugs", () => {
    expect(sanitizeIssueId("../../etc")).toBe("");
    expect(sanitizeIssueId("42x")).toBe("42");
    expect(sanitizeSlug("acme/../evil")).toBe("acme..evil"); // slashes gone (URL-encoded as one segment)
    expect(sanitizeSlug("a`b;c")).toBe("abc");
  });

  it("throws on an id that sanitises to empty", () => {
    expect(() => bitbucketSpecBranchName("abc")).toThrow();
  });
});

describe("bbqlLiteral — injection-proof", () => {
  it("drops quotes/backslashes/controls so it cannot break out of the quoted term", () => {
    expect(bbqlLiteral('agent" OR state="open')).toBe("agent OR state=open");
    expect(bbqlLiteral("a\\b")).toBe("ab");
  });
});

describe("pollTickets — BBQL construction + mapping", () => {
  it("builds a quoted component + active-state query and encodes the repo path", async () => {
    let listUrl = "";
    const { conn } = connector({}, (c) => {
      if (isList(c.url)) { listUrl = c.url; return json({ values: [ISSUE] }); }
      return json({});
    });
    const tickets = await conn.pollTickets();
    expect(new URL(listUrl).pathname).toBe("/2.0/repositories/acme/widget/issues");
    expect(qOf(listUrl)).toBe('component = "agent" AND (state = "new" OR state = "open")');
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "42",
      title: "Add rate limiting",
      body: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "task", "major"], // component + kind + priority (defence-in-depth gate)
      url: "https://bitbucket.org/acme/widget/issues/42",
    });
  });

  it("a hostile label cannot inject a BBQL clause", async () => {
    let listUrl = "";
    const { conn } = connector({ label: 'agent" OR 1=1 --' }, (c) => {
      if (isList(c.url)) { listUrl = c.url; return json({ values: [] }); }
      return json({});
    });
    await conn.pollTickets();
    expect(qOf(listUrl)).toBe('component = "agent OR 1=1 --" AND (state = "new" OR state = "open")');
    expect(qOf(listUrl)).not.toContain('""');
  });

  it("appends an ISO watermark; drops garbage", async () => {
    const urls: string[] = [];
    const { conn } = connector({}, (c) => {
      if (isList(c.url)) { urls.push(c.url); return json({ values: [] }); }
      return json({});
    });
    await conn.pollTickets("2026-01-01T00:00:00.000Z");
    expect(qOf(urls[0])).toContain('updated_on > "2026-01-01T00:00:00.000Z"');
    await conn.pollTickets("nope");
    expect(qOf(urls[1])).not.toContain("updated_on");
  });

  it("returns null on degrade and on unconfigured auth", async () => {
    const { conn } = connector({}, (c) => (isList(c.url) ? { status: 500, body: "boom" } : json({})));
    expect(await conn.pollTickets()).toBeNull();
    const { http } = fakeHttp(() => json({ values: [ISSUE] }));
    const noAuth = new BitbucketTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await noAuth.pollTickets()).toBeNull();
  });

  it("readTicket fetches one issue by id", async () => {
    const { conn, calls } = connector({}, (c) => (isSingle(c.url) ? json(ISSUE) : json({})));
    const t = await conn.readTicket("42");
    expect(t?.id).toBe("42");
    expect(calls.some((c) => c.method === "GET" && new URL(c.url).pathname.endsWith("/issues/42"))).toBe(true);
  });
});

describe("write-back — comment idempotency + state change", () => {
  it("posts a comment when the marker is absent", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (isComments(c.url) && c.method === "GET") return json({ values: [] });
      if (isComments(c.url) && c.method === "POST") return { status: 201, body: "{}" };
      return json({});
    });
    const res = await conn.writeback.comment("42", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const post = calls.find((c) => isComments(c.url) && c.method === "POST");
    expect(post!.body).toContain("<!-- marker -->");
    expect(post!.body).toContain("picked up");
  });

  it("does NOT double-post when a comment already carries the marker", async () => {
    const { conn, calls } = connector({}, (c) =>
      isComments(c.url) && c.method === "GET"
        ? json({ values: [{ content: { raw: "<!-- marker -->\nearlier" } }] })
        : json({}),
    );
    const res = await conn.writeback.comment("42", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does NOT post when comments are unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, (c) =>
      isComments(c.url) && c.method === "GET" ? { status: 503, body: "" } : json({}),
    );
    const res = await conn.writeback.comment("42", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sets an allowlisted state via PUT; an unknown state is a no-op", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "PUT" && isSingle(c.url) ? { status: 200, body: "{}" } : json({}),
    );
    const ok = await conn.writeback.transition!("42", "Open");
    expect(ok.posted).toBe(true);
    const put = calls.find((c) => c.method === "PUT");
    expect(put!.body).toContain('"state":"open"');

    const miss = await conn.writeback.transition!("42", "in-progress"); // not a Bitbucket state
    expect(miss.posted).toBe(false);
    expect(miss.reason).toBe("no-such-state");
  });
});

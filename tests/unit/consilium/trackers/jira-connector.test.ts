/**
 * jira-connector.test.ts — TRACK-3 Jira dialect with a FAKE Jira HTTP transport (no
 * network). Covers: JQL is built from SANITISED, quoted literals (injection-proof);
 * ADF description flattening; watch/read mapping to the normalised Ticket; idempotent
 * comment write-back (marker dedup, no double-post); transition name→id resolution;
 * and the deterministic `spec/jira-<KEY>` naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  JiraTrackerConnector,
  adfToText,
  textToAdf,
  sanitizeIssueKey,
  jiraSpecBranchName,
  jiraSpecFilePath,
  type JiraConnectorConfig,
} from "../../../../server/services/consilium/trackers/jira-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { JiraHttpFn, JiraHttpResult } from "../../../../server/services/consilium/trackers/jira-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

/** A fake Jira transport routed by method + url path; records every call. */
function fakeHttp(
  handler: (call: Call) => JiraHttpResult,
): { http: JiraHttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: JiraHttpFn = vi.fn(async (req) => {
    const call: Call = { method: req.method, url: req.url, body: req.body };
    calls.push(call);
    return handler(call);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): JiraHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: JiraConnectorConfig = {
  baseUrl: "https://acme.atlassian.net",
  project: "ACME",
  label: "agent",
};

function connector(cfg: Partial<JiraConnectorConfig>, handler: (c: Call) => JiraHttpResult) {
  const { http, calls } = fakeHttp(handler);
  const conn = new JiraTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { email: "a@b.co", token: "secret-token" },
    log: () => {},
  });
  return { conn, calls };
}

const jqlOf = (url: string) => new URL(url).searchParams.get("jql") ?? "";

describe("adfToText", () => {
  it("flattens an ADF doc to plain text with paragraph breaks", () => {
    const doc = {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Hello " }, { type: "text", text: "world" }] },
        { type: "paragraph", content: [{ type: "text", text: "line2" }] },
      ],
    };
    expect(adfToText(doc)).toBe("Hello world\nline2");
  });

  it("passes a string description through (Jira Server / v2)", () => {
    expect(adfToText("## Acceptance Criteria\n- a")).toBe("## Acceptance Criteria\n- a");
  });

  it("returns empty for null/garbage and is depth/length bounded", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText({ type: "doc" })).toBe("");
    const big = { type: "doc", content: [{ type: "text", text: "x".repeat(50_000) }] };
    expect(adfToText(big, 100).length).toBeLessThanOrEqual(100);
  });
});

describe("naming + key sanitisation", () => {
  it("derives a shape-safe branch/path from the Jira key", () => {
    expect(jiraSpecBranchName("ACME-123")).toBe("spec/jira-ACME-123");
    expect(isValidSpecBranch(jiraSpecBranchName("ACME-123"))).toBe(true);
    expect(jiraSpecFilePath("ACME-123", "Add Rate Limiting!")).toBe(
      "docs/specs/jira-ACME-123-add-rate-limiting.md",
    );
  });

  it("strips path separators / leading dots so a hostile key can never escape", () => {
    expect(sanitizeIssueKey("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeIssueKey("-ACME/../x")).toBe("ACMEx");
    expect(isValidSpecBranch(jiraSpecBranchName("ACME-9"))).toBe(true);
  });

  it("throws on a key that sanitises to empty", () => {
    expect(() => jiraSpecBranchName("///")).toThrow();
  });
});

describe("buildJql (via pollTickets) — injection-proof", () => {
  it("embeds sanitised, quoted literals (quotes/controls stripped)", async () => {
    let seen = "";
    const { conn } = connector({ project: "ACME", label: 'agent"; DROP' }, (c) => {
      if (c.url.includes("/search")) {
        seen = jqlOf(c.url);
        return json({ issues: [] });
      }
      return json({});
    });
    await conn.pollTickets();
    // The injected double-quote is gone → cannot break out of the quoted term.
    expect(seen).toBe('project = "ACME" AND labels = "agent; DROP" ORDER BY updated ASC');
    expect(seen).not.toContain('""');
  });

  it("ANDs a trusted operator extraJql in parens", async () => {
    let seen = "";
    const { conn } = connector({ extraJql: "priority = High" }, (c) => {
      if (c.url.includes("/search")) {
        seen = jqlOf(c.url);
        return json({ issues: [] });
      }
      return json({});
    });
    await conn.pollTickets();
    expect(seen).toBe('project = "ACME" AND labels = "agent" AND (priority = High) ORDER BY updated ASC');
  });
});

describe("pollTickets / readTicket mapping", () => {
  const ISSUE = {
    key: "ACME-7",
    fields: {
      summary: "Add rate limiting",
      description: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "backend"],
      updated: "2026-01-02T10:00:00.000+0000",
    },
  };

  it("maps a JQL result to normalised tickets (browse url + flattened body)", async () => {
    const { conn } = connector({}, (c) =>
      c.url.includes("/search") ? json({ issues: [ISSUE] }) : json({}),
    );
    const tickets = await conn.pollTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "ACME-7",
      title: "Add rate limiting",
      body: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "backend"],
      url: "https://acme.atlassian.net/browse/ACME-7",
    });
  });

  it("returns null when the search is degraded (HTTP 500)", async () => {
    const { conn } = connector({}, (c) =>
      c.url.includes("/search") ? { status: 500, body: "boom" } : json({}),
    );
    expect(await conn.pollTickets()).toBeNull();
  });

  it("returns null when auth is unconfigured (fail-closed)", async () => {
    const { http } = fakeHttp(() => json({ issues: [ISSUE] }));
    const conn = new JiraTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await conn.pollTickets()).toBeNull();
  });

  it("readTicket fetches one issue by key", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.url.includes("/issue/ACME-7") ? json(ISSUE) : json({}),
    );
    const t = await conn.readTicket("ACME-7");
    expect(t?.id).toBe("ACME-7");
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/rest/api/3/issue/ACME-7"))).toBe(true);
  });
});

describe("write-back — comment idempotency + transition", () => {
  it("posts an ADF comment when the marker is absent", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (c.method === "GET" && c.url.includes("/comment")) return json({ comments: [] });
      if (c.method === "POST" && c.url.includes("/comment")) return { status: 201, body: "{}" };
      return json({});
    });
    const res = await conn.writeback.comment("ACME-7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/comment"));
    expect(post).toBeTruthy();
    expect(post!.body).toContain("<!-- marker -->");
    expect(post!.body).toContain("picked up");
  });

  it("does NOT double-post when a comment already carries the marker", async () => {
    const existing = { body: textToAdf(["<!-- marker -->", "picked up earlier"]) };
    const { conn, calls } = connector({}, (c) => {
      if (c.method === "GET" && c.url.includes("/comment")) return json({ comments: [existing] });
      return json({});
    });
    const res = await conn.writeback.comment("ACME-7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does NOT post when comments are unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "GET" && c.url.includes("/comment") ? { status: 503, body: "" } : json({}),
    );
    const res = await conn.writeback.comment("ACME-7", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("resolves a transition by name and POSTs its id; unknown → no-op", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (c.method === "GET" && c.url.includes("/transitions")) {
        return json({ transitions: [{ id: "31", name: "In Progress" }] });
      }
      if (c.method === "POST" && c.url.includes("/transitions")) return { status: 204, body: "" };
      return json({});
    });
    const ok = await conn.writeback.transition!("ACME-7", "in progress");
    expect(ok.posted).toBe(true);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/transitions"));
    expect(post!.body).toContain('"id":"31"');

    const miss = await conn.writeback.transition!("ACME-7", "Done");
    expect(miss.posted).toBe(false);
    expect(miss.reason).toBe("no-such-transition");
  });
});

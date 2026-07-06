/**
 * clickup-connector.test.ts — TRACK-5 ClickUp dialect with a FAKE ClickUp HTTP transport
 * (no network). Covers: the tag rides as a `tags[]` query param set via URLSearchParams
 * (a value cannot inject extra params); the ISO watermark is converted to epoch-ms
 * `date_updated_gt`; watch/read mapping to normalised Tickets; idempotent comment
 * write-back (marker dedup, no double-post, unreadable ⇒ no post); status PUT; and the
 * deterministic `spec/clickup-<id>` naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  ClickUpTrackerConnector,
  sanitizeClickUpId,
  clickupSpecBranchName,
  clickupSpecFilePath,
  type ClickUpConnectorConfig,
} from "../../../../server/services/consilium/trackers/clickup-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { ClickUpHttpFn, ClickUpHttpResult } from "../../../../server/services/consilium/trackers/clickup-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeHttp(handler: (call: Call) => ClickUpHttpResult): { http: ClickUpHttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: ClickUpHttpFn = vi.fn(async (req) => {
    const call: Call = { method: req.method, url: req.url, body: req.body };
    calls.push(call);
    return handler(call);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): ClickUpHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: ClickUpConnectorConfig = { listId: "9001", tag: "agent" };

function connector(cfg: Partial<ClickUpConnectorConfig>, handler: (c: Call) => ClickUpHttpResult) {
  const { http, calls } = fakeHttp(handler);
  const conn = new ClickUpTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { token: "pk_secret" },
    log: () => {},
  });
  return { conn, calls };
}

const TASK = {
  id: "abc123",
  name: "Add rate limiting",
  text_content: "## Acceptance Criteria\n- returns 429",
  tags: [{ name: "agent" }, { name: "backend" }],
  date_updated: "1767225600000",
  url: "https://app.clickup.com/t/abc123",
};

describe("naming + id sanitisation", () => {
  it("derives a shape-safe branch/path from the task id", () => {
    expect(clickupSpecBranchName("abc123")).toBe("spec/clickup-abc123");
    expect(isValidSpecBranch(clickupSpecBranchName("abc123"))).toBe(true);
    expect(clickupSpecFilePath("abc123", "Add Rate Limiting!")).toBe(
      "docs/specs/clickup-abc123-add-rate-limiting.md",
    );
  });
  it("strips separators / leading dash / traversal from a hostile id", () => {
    expect(sanitizeClickUpId("a/b\\c")).toBe("abc");
    expect(sanitizeClickUpId("-abc")).toBe("abc");
  });
  it("throws on an id that sanitises to empty", () => {
    expect(() => clickupSpecBranchName("//")).toThrow();
  });
});

describe("pollTickets — tag param + watermark", () => {
  it("sets the tag as a tags[] query param and converts the ISO watermark to epoch ms", async () => {
    let seenUrl = "";
    const { conn } = connector({}, (c) => {
      if (c.url.includes("/task")) {
        seenUrl = c.url;
        return json({ tasks: [] });
      }
      return json({});
    });
    await conn.pollTickets("2026-01-01T00:00:00.000Z");
    const u = new URL(seenUrl);
    expect(u.searchParams.get("tags[]")).toBe("agent");
    expect(u.searchParams.get("date_updated_gt")).toBe(String(Date.parse("2026-01-01T00:00:00.000Z")));
    expect(u.pathname).toContain("/list/9001/task");
  });

  it("maps tasks to normalised tickets", async () => {
    const { conn } = connector({}, (c) => (c.url.includes("/task") ? json({ tasks: [TASK] }) : json({})));
    const tickets = await conn.pollTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "abc123",
      title: "Add rate limiting",
      body: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "backend"],
      url: "https://app.clickup.com/t/abc123",
    });
  });

  it("returns null on a degraded list (HTTP 500) and when auth is unconfigured", async () => {
    const { conn } = connector({}, () => ({ status: 500, body: "boom" }));
    expect(await conn.pollTickets()).toBeNull();

    const { http } = fakeHttp(() => json({ tasks: [TASK] }));
    const noAuth = new ClickUpTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await noAuth.pollTickets()).toBeNull();
  });

  it("readTicket fetches one task by id", async () => {
    const { conn, calls } = connector({}, (c) => (c.url.includes("/task/abc123") ? json(TASK) : json({})));
    const t = await conn.readTicket("abc123");
    expect(t?.id).toBe("abc123");
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/task/abc123"))).toBe(true);
  });
});

describe("write-back — comment idempotency + status", () => {
  it("posts a comment when the marker is absent", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (c.method === "GET" && c.url.includes("/comment")) return json({ comments: [] });
      if (c.method === "POST" && c.url.includes("/comment")) return { status: 200, body: "{}" };
      return json({});
    });
    const res = await conn.writeback.comment("abc123", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/comment"));
    expect(post!.body).toContain("<!-- marker -->");
    expect(post!.body).toContain("picked up");
  });

  it("does NOT double-post when a comment already carries the marker", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "GET" && c.url.includes("/comment")
        ? json({ comments: [{ comment_text: "<!-- marker -->\nearlier" }] })
        : json({}),
    );
    const res = await conn.writeback.comment("abc123", "x", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does NOT post when comments are unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "GET" && c.url.includes("/comment") ? { status: 503, body: "" } : json({}),
    );
    const res = await conn.writeback.comment("abc123", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sets task status via PUT", async () => {
    const { conn, calls } = connector({}, (c) => (c.method === "PUT" ? { status: 200, body: "{}" } : json({})));
    const res = await conn.writeback.transition!("abc123", "in progress");
    expect(res.posted).toBe(true);
    const put = calls.find((c) => c.method === "PUT" && c.url.includes("/task/abc123"));
    expect(put!.body).toContain("in progress");
  });
});

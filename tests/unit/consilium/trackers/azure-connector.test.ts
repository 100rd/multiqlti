/**
 * azure-connector.test.ts — TRACK-5 Azure DevOps dialect with a FAKE Azure HTTP transport
 * (no network). Covers: WIQL is built from the `@project` macro + SANITISED, quoted tag
 * literals (injection-proof — a `'` in the tag is stripped, cannot break the quoted term);
 * HTML description flattening; tag-string parsing; watch (WIQL → id list → batch read)
 * mapping to normalised Tickets; idempotent comment write-back; `System.State` JSON-patch
 * transition; and the deterministic `spec/azure-<id>` (digits-only) naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  AzureTrackerConnector,
  htmlToText,
  parseTags,
  sanitizeWorkItemId,
  azureSpecBranchName,
  azureSpecFilePath,
  type AzureConnectorConfig,
} from "../../../../server/services/consilium/trackers/azure-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { AzureHttpFn, AzureHttpResult } from "../../../../server/services/consilium/trackers/azure-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeHttp(handler: (call: Call) => AzureHttpResult): { http: AzureHttpFn; calls: Call[] } {
  const calls: Call[] = [];
  const http: AzureHttpFn = vi.fn(async (req) => {
    const call: Call = { method: req.method, url: req.url, body: req.body };
    calls.push(call);
    return handler(call);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): AzureHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: AzureConnectorConfig = { org: "acme", project: "Widget", tag: "agent" };

function connector(cfg: Partial<AzureConnectorConfig>, handler: (c: Call) => AzureHttpResult) {
  const { http, calls } = fakeHttp(handler);
  const conn = new AzureTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { pat: "secret-pat" },
    log: () => {},
  });
  return { conn, calls };
}

const wiqlOf = (body?: string) => (body ? (JSON.parse(body) as { query: string }).query : "");

const WORKITEM = {
  id: 42,
  fields: {
    "System.Title": "Add rate limiting",
    "System.Description": "<div>## Acceptance Criteria</div><ul><li>returns 429</li></ul>",
    "System.Tags": "agent; backend",
    "System.ChangedDate": "2026-01-02T10:00:00Z",
  },
};

describe("htmlToText / parseTags", () => {
  it("flattens HTML to text and decodes entities", () => {
    expect(htmlToText("<p>Hello&nbsp;<b>world</b></p><p>line2</p>")).toBe("Hello world\nline2");
    expect(htmlToText("a &amp; b &lt;c&gt;")).toBe("a & b <c>");
    expect(htmlToText(null)).toBe("");
  });
  it("splits the System.Tags string into a label array", () => {
    expect(parseTags("agent; backend ; ")).toEqual(["agent", "backend"]);
    expect(parseTags(undefined)).toEqual([]);
  });
});

describe("naming + id sanitisation", () => {
  it("derives a digits-only branch/path from the work-item id", () => {
    expect(azureSpecBranchName("42")).toBe("spec/azure-42");
    expect(isValidSpecBranch(azureSpecBranchName("42"))).toBe(true);
    expect(azureSpecFilePath("42", "Add Rate Limiting!")).toBe("docs/specs/azure-42-add-rate-limiting.md");
  });
  it("reduces a hostile id to digits (no separators / traversal)", () => {
    expect(sanitizeWorkItemId("../../7")).toBe("7");
    expect(sanitizeWorkItemId("42; DROP")).toBe("42");
  });
  it("throws on an id that sanitises to empty", () => {
    expect(() => azureSpecBranchName("abc")).toThrow();
  });
});

describe("buildWiql (via pollTickets) — injection-proof", () => {
  it("uses the @project macro and a sanitised, quoted tag literal (single-quote stripped)", async () => {
    let seen = "";
    const { conn } = connector({ tag: "agent'; DROP" }, (c) => {
      if (c.url.includes("/wiql")) {
        seen = wiqlOf(c.body);
        return json({ workItems: [] });
      }
      return json({});
    });
    await conn.pollTickets();
    expect(seen).toContain("[System.TeamProject] = @project");
    expect(seen).toContain("[System.Tags] CONTAINS 'agent; DROP'");
    expect(seen).not.toContain("''"); // the injected quote is gone.
  });

  it("ANDs a ChangedDate watermark + area path when present", async () => {
    let seen = "";
    const { conn } = connector({ areaPath: "Widget\\Team A" }, (c) => {
      if (c.url.includes("/wiql")) {
        seen = wiqlOf(c.body);
        return json({ workItems: [] });
      }
      return json({});
    });
    await conn.pollTickets("2026-01-01T00:00:00Z");
    expect(seen).toContain("[System.AreaPath] UNDER 'Widget\\Team A'");
    expect(seen).toContain("[System.ChangedDate] > '2026-01-01T00:00:00Z'");
  });
});

describe("pollTickets / readTicket mapping", () => {
  it("maps a WIQL id list + batch read to normalised tickets", async () => {
    const { conn } = connector({}, (c) => {
      if (c.url.includes("/wiql")) return json({ workItems: [{ id: 42 }] });
      if (c.url.includes("/workitems") && c.method === "GET") return json({ value: [WORKITEM] });
      return json({});
    });
    const tickets = await conn.pollTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "42",
      title: "Add rate limiting",
      labels: ["agent", "backend"],
      url: "https://dev.azure.com/acme/Widget/_workitems/edit/42",
    });
    expect(tickets![0].body).toContain("returns 429");
  });

  it("returns [] when the WIQL matches nothing (no batch call)", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.url.includes("/wiql") ? json({ workItems: [] }) : json({}),
    );
    expect(await conn.pollTickets()).toEqual([]);
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/workitems"))).toBe(false);
  });

  it("returns null when the WIQL is degraded (HTTP 500)", async () => {
    const { conn } = connector({}, (c) =>
      c.url.includes("/wiql") ? { status: 500, body: "boom" } : json({}),
    );
    expect(await conn.pollTickets()).toBeNull();
  });

  it("returns null when auth is unconfigured (fail-closed)", async () => {
    const { http } = fakeHttp(() => json({ workItems: [{ id: 42 }] }));
    const conn = new AzureTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await conn.pollTickets()).toBeNull();
  });

  it("readTicket fetches one work item by id", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.url.includes("/workitems/42") ? json(WORKITEM) : json({}),
    );
    const t = await conn.readTicket("42");
    expect(t?.id).toBe("42");
    expect(calls.some((c) => c.method === "GET" && c.url.includes("/_apis/wit/workitems/42"))).toBe(true);
  });
});

describe("write-back — comment idempotency + state", () => {
  it("posts a comment when the marker is absent", async () => {
    const { conn, calls } = connector({}, (c) => {
      if (c.method === "GET" && c.url.includes("/comments")) return json({ comments: [] });
      if (c.method === "POST" && c.url.includes("/comments")) return { status: 200, body: "{}" };
      return json({});
    });
    const res = await conn.writeback.comment("42", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const post = calls.find((c) => c.method === "POST" && c.url.includes("/comments"));
    expect(post!.body).toContain("<!-- marker -->");
    expect(post!.body).toContain("picked up");
  });

  it("does NOT double-post when a comment already carries the marker", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "GET" && c.url.includes("/comments")
        ? json({ comments: [{ text: "<!-- marker -->\nearlier" }] })
        : json({}),
    );
    const res = await conn.writeback.comment("42", "x", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("does NOT post when comments are unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "GET" && c.url.includes("/comments") ? { status: 503, body: "" } : json({}),
    );
    const res = await conn.writeback.comment("42", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("sets System.State via a JSON-patch PATCH", async () => {
    const { conn, calls } = connector({}, (c) =>
      c.method === "PATCH" ? { status: 200, body: "{}" } : json({}),
    );
    const res = await conn.writeback.transition!("42", "Active");
    expect(res.posted).toBe(true);
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch!.body).toContain("/fields/System.State");
    expect(patch!.body).toContain("Active");
  });
});

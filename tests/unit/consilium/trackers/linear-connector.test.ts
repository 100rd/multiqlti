/**
 * linear-connector.test.ts — TRACK-5 Linear dialect with a FAKE Linear GraphQL transport
 * (no network). Covers: the query is STATIC + all runtime values travel as GraphQL
 * variables (injection-proof — a hostile label lands in `variables`, never in the query
 * text); watch/read mapping to the normalised Ticket; idempotent comment write-back (marker
 * dedup via the issue's existing comments, no double-post; unreadable ⇒ no post); state
 * transition name→id resolution; a GraphQL `errors` payload degrades to null; and the
 * deterministic `spec/linear-<ID>` naming.
 */
import { describe, it, expect, vi } from "vitest";
import {
  LinearTrackerConnector,
  sanitizeIdentifier,
  linearSpecBranchName,
  linearSpecFilePath,
  type LinearConnectorConfig,
} from "../../../../server/services/consilium/trackers/linear-connector.js";
import { isValidSpecBranch } from "../../../../server/services/consilium/trackers/spec-writer.js";
import type { LinearHttpFn, LinearHttpResult } from "../../../../server/services/consilium/trackers/linear-exec.js";

interface Call {
  method: string;
  url: string;
  body?: string;
}

function fakeHttp(handler: (parsed: { query: string; variables: Record<string, unknown> }) => LinearHttpResult): {
  http: LinearHttpFn;
  calls: Array<Call & { query: string; variables: Record<string, unknown> }>;
} {
  const calls: Array<Call & { query: string; variables: Record<string, unknown> }> = [];
  const http: LinearHttpFn = vi.fn(async (req) => {
    const parsed = JSON.parse(req.body ?? "{}") as { query: string; variables: Record<string, unknown> };
    calls.push({ method: req.method, url: req.url, body: req.body, ...parsed });
    return handler(parsed);
  });
  return { http, calls };
}

const json = (obj: unknown, status = 200): LinearHttpResult => ({ status, body: JSON.stringify(obj) });

const CFG: LinearConnectorConfig = { label: "agent" };

function connector(cfg: Partial<LinearConnectorConfig>, handler: Parameters<typeof fakeHttp>[0]) {
  const { http, calls } = fakeHttp(handler);
  const conn = new LinearTrackerConnector({ ...CFG, ...cfg }, {
    http,
    auth: { token: "lin_api_secret" },
    log: () => {},
  });
  return { conn, calls };
}

const ISSUE_NODE = {
  id: "uuid-1",
  identifier: "ENG-7",
  title: "Add rate limiting",
  description: "## Acceptance Criteria\n- returns 429",
  labels: { nodes: [{ name: "agent" }, { name: "backend" }] },
  updatedAt: "2026-01-02T10:00:00.000Z",
  url: "https://linear.app/acme/issue/ENG-7",
};

describe("naming + identifier sanitisation", () => {
  it("derives a shape-safe branch/path from the Linear identifier", () => {
    expect(linearSpecBranchName("ENG-123")).toBe("spec/linear-ENG-123");
    expect(isValidSpecBranch(linearSpecBranchName("ENG-123"))).toBe(true);
    expect(linearSpecFilePath("ENG-123", "Add Rate Limiting!")).toBe(
      "docs/specs/linear-ENG-123-add-rate-limiting.md",
    );
  });

  it("strips path separators / leading dashes / traversal so a hostile id can never escape", () => {
    expect(sanitizeIdentifier("../../etc/passwd")).toBe("etcpasswd");
    expect(sanitizeIdentifier("-ENG/../x")).toBe("ENG.x");
    expect(isValidSpecBranch(linearSpecBranchName("ENG-9"))).toBe(true);
  });

  it("throws on an identifier that sanitises to empty", () => {
    expect(() => linearSpecBranchName("///")).toThrow();
  });
});

describe("pollTickets — injection-proof (variables, not interpolation)", () => {
  it("passes a hostile label as a GraphQL variable, never into the query text", async () => {
    let seen: { query: string; variables: Record<string, unknown> } | null = null;
    const { conn } = connector({ label: 'agent") { evil }' }, (p) => {
      seen = p;
      return json({ data: { issues: { nodes: [] } } });
    });
    await conn.pollTickets("2026-01-01T00:00:00.000Z");
    expect(seen).toBeTruthy();
    // The query is static — the hostile label text is NOT in it.
    expect(seen!.query).not.toContain("evil");
    // The label rode in as a variable (control chars stripped, quotes preserved as data).
    const filter = seen!.variables.filter as { labels: { name: { eq: string } }; updatedAt?: { gt: string } };
    expect(filter.labels.name.eq).toContain("evil");
    expect(filter.updatedAt?.gt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("scopes to a team when teamId is configured", async () => {
    let seen: { variables: Record<string, unknown> } | null = null;
    const { conn } = connector({ teamId: "team-123" }, (p) => {
      seen = p;
      return json({ data: { issues: { nodes: [] } } });
    });
    await conn.pollTickets();
    const filter = seen!.variables.filter as { team?: { id: { eq: string } } };
    expect(filter.team?.id.eq).toBe("team-123");
  });
});

describe("pollTickets / readTicket mapping", () => {
  it("maps GraphQL issue nodes to normalised tickets", async () => {
    const { conn } = connector({}, () => json({ data: { issues: { nodes: [ISSUE_NODE] } } }));
    const tickets = await conn.pollTickets();
    expect(tickets).toHaveLength(1);
    expect(tickets![0]).toMatchObject({
      id: "ENG-7",
      title: "Add rate limiting",
      body: "## Acceptance Criteria\n- returns 429",
      labels: ["agent", "backend"],
      url: "https://linear.app/acme/issue/ENG-7",
    });
  });

  it("returns null on a GraphQL errors payload (HTTP 200 but errors)", async () => {
    const { conn } = connector({}, () => json({ errors: [{ message: "nope" }] }));
    expect(await conn.pollTickets()).toBeNull();
  });

  it("returns null when auth is unconfigured (fail-closed)", async () => {
    const { http } = fakeHttp(() => json({ data: { issues: { nodes: [ISSUE_NODE] } } }));
    const conn = new LinearTrackerConnector(CFG, { http, auth: null, log: () => {} });
    expect(await conn.pollTickets()).toBeNull();
  });

  it("readTicket fetches one issue by identifier", async () => {
    const { conn, calls } = connector({}, () => json({ data: { issue: ISSUE_NODE } }));
    const t = await conn.readTicket("ENG-7");
    expect(t?.id).toBe("ENG-7");
    expect(calls[0].variables.id).toBe("ENG-7");
  });
});

describe("write-back — comment idempotency + transition", () => {
  it("posts a comment when the marker is absent (resolves uuid + no existing marker)", async () => {
    const { conn, calls } = connector({}, (p) => {
      if (p.query.includes("comments(")) {
        return json({ data: { issue: { id: "uuid-1", comments: { nodes: [] }, team: { states: { nodes: [] } } } } });
      }
      if (p.query.includes("commentCreate")) return json({ data: { commentCreate: { success: true } } });
      return json({ data: {} });
    });
    const res = await conn.writeback.comment("ENG-7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(true);
    const mutation = calls.find((c) => c.query.includes("commentCreate"));
    expect(mutation).toBeTruthy();
    expect(mutation!.variables.issueId).toBe("uuid-1");
    expect(String(mutation!.variables.body)).toContain("<!-- marker -->");
    expect(String(mutation!.variables.body)).toContain("picked up");
  });

  it("does NOT double-post when a comment already carries the marker", async () => {
    const { conn, calls } = connector({}, (p) => {
      if (p.query.includes("comments(")) {
        return json({
          data: { issue: { id: "uuid-1", comments: { nodes: [{ body: "<!-- marker -->\nearlier" }] } } },
        });
      }
      return json({ data: {} });
    });
    const res = await conn.writeback.comment("ENG-7", "picked up", "<!-- marker -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("does NOT post when the issue is unreadable (safety over liveness)", async () => {
    const { conn, calls } = connector({}, () => json({ errors: [{ message: "boom" }] }));
    const res = await conn.writeback.comment("ENG-7", "x", "<!-- m -->");
    expect(res.posted).toBe(false);
    expect(calls.some((c) => c.query.includes("commentCreate"))).toBe(false);
  });

  it("resolves a workflow state by name and issueUpdates it; unknown → no-op", async () => {
    const states = { nodes: [{ id: "state-31", name: "In Progress" }] };
    const { conn, calls } = connector({}, (p) => {
      if (p.query.includes("comments(")) {
        return json({ data: { issue: { id: "uuid-1", comments: { nodes: [] }, team: { states } } } });
      }
      if (p.query.includes("issueUpdate")) return json({ data: { issueUpdate: { success: true } } });
      return json({ data: {} });
    });
    const ok = await conn.writeback.transition!("ENG-7", "in progress");
    expect(ok.posted).toBe(true);
    const mut = calls.find((c) => c.query.includes("issueUpdate"));
    expect(mut!.variables.stateId).toBe("state-31");

    const miss = await conn.writeback.transition!("ENG-7", "Done");
    expect(miss.posted).toBe(false);
    expect(miss.reason).toBe("no-such-state");
  });
});

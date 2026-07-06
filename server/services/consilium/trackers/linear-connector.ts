/**
 * linear-connector.ts — TRACK-5: the Linear implementation of `TrackerConnector`. It is
 * PURELY the Linear DIALECT (watch = GraphQL `issues(filter:…)`, read = `issue(id)`,
 * write-back = `commentCreate` + `issueUpdate` state + `attachmentCreate` link, naming =
 * `spec/linear-<ID>`); the synth, the spec-PR, the provenance, and the crystallise/dedup
 * machinery are the SHARED modules (`issue-spec.ts`, `spec-writer.ts`, `spec-intake.ts`)
 * that GitHub + Jira use too. Adding this connector changes NOTHING shared.
 *
 * SECURITY
 *   - INJECTION-PROOF BY CONSTRUCTION: every GraphQL query is a STATIC string; the label,
 *     team id, ticket id, comment body and state all travel as GraphQL **variables**
 *     (linear-exec sends them in a separate JSON field), so a hostile config/ticket value
 *     can never reshape the query. Values are still control-stripped (defence in depth).
 *   - Every read/write goes through the fail-closed, never-logging `linear-exec` seam.
 *   - `specBranchName`/`specFilePath` sanitise the Linear identifier to `[A-Za-z0-9._-]`
 *     so it is shape-safe for the branch (matches `SPEC_BRANCH_RE`) and the filename
 *     (no path separator, no leading dash, no `..`).
 *   - The ticket title/description are UNTRUSTED — the shared synth fences them before any
 *     prompt and the shared renderer quotes them in YAML.
 *
 * ID MODEL: the connector's public ticket id is the human Linear **identifier**
 * (`ENG-123`) — stable, used for the branch/path/dedup and `source.ref`. Write-back
 * mutations need the internal UUID, so each write-back method first resolves the UUID via
 * `issue(id: identifier)` (Linear's `issue` query accepts either form) in the same read
 * it uses to check idempotency.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { linearQuery, linearMutate, type LinearExecDeps } from "./linear-exec.js";

/** Control-strip + clamp an (untrusted or config) scalar before it becomes a variable. */
function cleanScalar(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // drop C0 / DEL control chars.
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Sanitise a Linear identifier for a branch/filename (`ENG-123` → `ENG-123`). Drops any
 * char outside `[A-Za-z0-9._-]`, then any leading dash and any `..` sequence, clamps —
 * so the branch is free of a path separator / leading flag / traversal (matches
 * `SPEC_BRANCH_RE`).
 */
export function sanitizeIdentifier(id: string): string {
  return id
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/^[-.]+/, "")
    .slice(0, 80);
}

/** The Linear spec dedup branch: `spec/linear-<ID>` (matches spec-writer's SPEC_BRANCH_RE). */
export function linearSpecBranchName(id: string): string {
  const safe = sanitizeIdentifier(id);
  if (safe.length === 0) throw new Error(`linear-connector: invalid identifier ${JSON.stringify(id)}`);
  return `spec/linear-${safe}`;
}

/** The committed spec path: `docs/specs/linear-<ID>-<slug>.md`. */
export function linearSpecFilePath(id: string, title: string): string {
  const safe = sanitizeIdentifier(id);
  if (safe.length === 0) throw new Error(`linear-connector: invalid identifier ${JSON.stringify(id)}`);
  return `docs/specs/linear-${safe}-${slugify(title)}.md`;
}

// ─── Linear GraphQL shapes (only the fields we request) ───────────────────────

interface LinearLabelConn {
  nodes?: Array<{ name?: string }>;
}
interface LinearIssueNode {
  id?: string;
  identifier?: string;
  title?: string;
  description?: string | null;
  labels?: LinearLabelConn;
  updatedAt?: string;
  url?: string;
}
interface LinearIssuesResult {
  issues?: { nodes?: LinearIssueNode[] };
}
interface LinearIssueResult {
  issue?: LinearIssueNode | null;
}
interface LinearIssueForWriteback {
  issue?: {
    id?: string;
    comments?: { nodes?: Array<{ body?: string }> };
    team?: { states?: { nodes?: Array<{ id?: string; name?: string }> } };
  } | null;
}

const ISSUE_FIELDS = "id identifier title description updatedAt url labels { nodes { name } }";
const DESCRIPTION_MAX = 16_000;

export interface LinearConnectorConfig {
  /** The consent label (§3.1) — REQUIRED at fire time by the poller. */
  label: string;
  /** Optional Linear team id to scope the search (workspace-wide otherwise). */
  teamId?: string;
  /** Optional workflow-state name/id to move the ticket to on pickup (best-effort). */
  transitionTo?: string;
}

/** Map a Linear issue node → the normalised `Ticket`. `null` if it has no identifier. */
function toTicket(node: LinearIssueNode | null | undefined): Ticket | null {
  if (!node) return null;
  const id = typeof node.identifier === "string" ? node.identifier : "";
  if (id.length === 0) return null;
  const labels = Array.isArray(node.labels?.nodes)
    ? node.labels!.nodes!.map((l) => l?.name).filter((n): n is string => typeof n === "string")
    : [];
  return {
    id,
    title: typeof node.title === "string" ? node.title : "",
    body: typeof node.description === "string" ? node.description.slice(0, DESCRIPTION_MAX) : "",
    labels,
    updatedAt: typeof node.updatedAt === "string" ? node.updatedAt : undefined,
    url: typeof node.url === "string" ? node.url : undefined,
  };
}

export class LinearTrackerConnector implements TrackerConnector {
  readonly kind = "linear";
  readonly writeback: TrackerWriteback;
  private readonly cfg: LinearConnectorConfig;
  private readonly exec: LinearExecDeps;

  constructor(cfg: LinearConnectorConfig, exec: LinearExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    this.writeback = {
      comment: (ticketId, body, marker) => this.postComment(ticketId, body, marker),
      transition: (ticketId, state) => this.doTransition(ticketId, state),
      link: (ticketId, url, title) => this.addLink(ticketId, url, title),
    };
  }

  /**
   * WATCH: GraphQL-search the workspace/team for labelled issues changed since the
   * watermark. All runtime values are VARIABLES (injection-proof). `null` on any degrade
   * so the poller skips the cycle without touching its watermark.
   */
  async pollTickets(sinceWatermark?: string): Promise<Ticket[] | null> {
    const filter: Record<string, unknown> = {
      labels: { name: { eq: cleanScalar(this.cfg.label) } },
    };
    if (this.cfg.teamId && this.cfg.teamId.trim().length > 0) {
      filter.team = { id: { eq: cleanScalar(this.cfg.teamId) } };
    }
    if (sinceWatermark && sinceWatermark.trim().length > 0) {
      filter.updatedAt = { gt: sinceWatermark };
    }
    const query =
      `query Issues($filter: IssueFilter) { issues(filter: $filter, first: 100, ` +
      `orderBy: updatedAt) { nodes { ${ISSUE_FIELDS} } } }`;
    const data = await linearQuery<LinearIssuesResult>(this.exec, query, { filter });
    if (!data || !Array.isArray(data.issues?.nodes)) return null;
    const tickets: Ticket[] = [];
    for (const node of data.issues!.nodes!) {
      const t = toTicket(node);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one issue by identifier (Linear's `issue` accepts the identifier). */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const id = sanitizeIdentifier(ticketId);
    if (id.length === 0) return null;
    const query = `query Issue($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`;
    const data = await linearQuery<LinearIssueResult>(this.exec, query, { id });
    if (!data) return null;
    return toTicket(data.issue);
  }

  specBranchName(ticketId: string): string {
    return linearSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return linearSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /** Resolve the internal UUID (+ comments/states) for an identifier, for a write-back. */
  private async loadForWriteback(ticketId: string): Promise<LinearIssueForWriteback["issue"] | null> {
    const id = sanitizeIdentifier(ticketId);
    if (id.length === 0) return null;
    const query =
      `query IssueWb($id: String!) { issue(id: $id) { id ` +
      `comments(first: 200) { nodes { body } } ` +
      `team { states { nodes { id name } } } } }`;
    const data = await linearQuery<LinearIssueForWriteback>(this.exec, query, { id });
    return data?.issue ?? null;
  }

  /**
   * Post a comment IDEMPOTENTLY: resolve the issue (uuid + existing comments), skip if any
   * already carries `marker`, else `commentCreate`. Best-effort — a degrade returns
   * `{ posted: false }`, never throws. When the issue cannot be read we do NOT post
   * (safety over liveness — a blind post could double-comment).
   */
  private async postComment(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const issue = await this.loadForWriteback(ticketId);
    if (!issue || typeof issue.id !== "string" || issue.id.length === 0) {
      return { posted: false, reason: "issue-unreadable" };
    }
    const existing = issue.comments?.nodes ?? [];
    const already = existing.some((c) => typeof c.body === "string" && c.body.includes(marker));
    if (already) return { posted: false, reason: "already-commented" };
    const mutation =
      `mutation Comment($issueId: String!, $body: String!) { ` +
      `commentCreate(input: { issueId: $issueId, body: $body }) { success } }`;
    const res = await linearMutate(this.exec, mutation, { issueId: issue.id, body: `${marker}\n${body}` });
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /**
   * Move the issue to `state` (workflow-state name or id), best-effort. Resolves the
   * state id from the issue's team states (a state not offered ⇒ no-op) then `issueUpdate`.
   */
  private async doTransition(ticketId: string, state: string): Promise<WritebackResult> {
    const wanted = cleanScalar(state);
    if (wanted.length === 0) return { posted: false, reason: "no-state" };
    const issue = await this.loadForWriteback(ticketId);
    if (!issue || typeof issue.id !== "string") return { posted: false, reason: "issue-unreadable" };
    const states = issue.team?.states?.nodes ?? [];
    const match = states.find(
      (s) => s.id === wanted || (s.name ?? "").toLowerCase() === wanted.toLowerCase(),
    );
    if (!match?.id) return { posted: false, reason: "no-such-state" };
    const mutation =
      `mutation Move($id: String!, $stateId: String!) { ` +
      `issueUpdate(id: $id, input: { stateId: $stateId }) { success } }`;
    const res = await linearMutate(this.exec, mutation, { id: issue.id, stateId: match.id });
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /** Attach a URL to the issue (`attachmentCreate`), best-effort. */
  private async addLink(ticketId: string, url: string, title?: string): Promise<WritebackResult> {
    const issue = await this.loadForWriteback(ticketId);
    if (!issue || typeof issue.id !== "string") return { posted: false, reason: "issue-unreadable" };
    const safeUrl = cleanScalar(url, 2000);
    if (!/^https?:\/\//i.test(safeUrl)) return { posted: false, reason: "bad-url" };
    const mutation =
      `mutation Attach($issueId: String!, $url: String!, $title: String!) { ` +
      `attachmentCreate(input: { issueId: $issueId, url: $url, title: $title }) { success } }`;
    const res = await linearMutate(this.exec, mutation, {
      issueId: issue.id,
      url: safeUrl,
      title: cleanScalar(title ?? "spec", 200) || "spec",
    });
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

/**
 * bitbucket-connector.ts — TRACK-4: the Bitbucket Cloud Issues implementation of
 * `TrackerConnector`. PURELY the Bitbucket DIALECT (watch = `/issues?q=…` BBQL poll,
 * read = `/issues/:id`, write-back = `/issues/:id/comments` + an optional state change,
 * naming = `spec/bitbucket-<id>`); the synth, the spec-PR, the provenance, and the
 * crystallise/dedup machinery are the SHARED modules. Nothing shared changes.
 *
 * LABELS: Bitbucket issues have NO free-form labels; their nearest equivalent is the
 * `component`. So the connector maps the consent "label" to the issue COMPONENT: the
 * watch filters `component = "<label>"` and the normalised `Ticket.labels` is built from
 * the issue's facets (kind + component + priority) so the poller's defence-in-depth
 * `labels.includes(label)` re-check works uniformly across trackers.
 *
 * SECURITY
 *   - The workspace + repo slug are sanitised to `[A-Za-z0-9._-]` then URL-encoded, so
 *     nothing can escape the `repositories/<ws>/<repo>/…` prefix.
 *   - The BBQL `q` is SERVER-BUILT from a SANITISED, QUOTED component literal
 *     (quotes/backslashes/controls dropped) so a config value can never break out of the
 *     quoted term (BBQL-injection defence). The watermark is ISO-guarded before it is
 *     embedded. UNTRUSTED ticket title/content stays untrusted (fenced by the synth,
 *     quoted by the renderer).
 *   - Every read/write goes through the fail-closed, never-logging `bitbucket-exec` seam.
 *   - `specBranchName`/`specFilePath` derive from the numeric `id` only.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { BITBUCKET_DEFAULT_BASE_URL, bitbucketGetJson, bitbucketSendJson, type BitbucketExecDeps } from "./bitbucket-exec.js";

/** Sanitise a Bitbucket workspace / repo slug for the URL: keep `[A-Za-z0-9._-]`. */
export function sanitizeSlug(slug: string): string {
  return slug.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 100);
}

/** Sanitise a Bitbucket issue id to DIGITS ONLY (issue ids are positive integers). */
export function sanitizeIssueId(id: string): string {
  return String(id).replace(/[^0-9]/g, "").slice(0, 18);
}

/**
 * Sanitise a BBQL string literal value: DROP quotes/backslashes (so it cannot break out
 * of the quoted term — BBQL-injection defence) and any C0/DEL control char, collapse
 * whitespace, clamp.
 */
export function bbqlLiteral(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // C0 / DEL control chars.
    if (ch === '"' || ch === "\\") continue; // quote-term breakout chars.
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The Bitbucket spec dedup branch: `spec/bitbucket-<id>` (matches SPEC_BRANCH_RE). */
export function bitbucketSpecBranchName(id: string): string {
  const safe = sanitizeIssueId(id);
  if (safe.length === 0) throw new Error(`bitbucket-connector: invalid issue id ${JSON.stringify(id)}`);
  return `spec/bitbucket-${safe}`;
}

/** The committed spec path: `docs/specs/bitbucket-<id>-<slug>.md`. */
export function bitbucketSpecFilePath(id: string, title: string): string {
  const safe = sanitizeIssueId(id);
  if (safe.length === 0) throw new Error(`bitbucket-connector: invalid issue id ${JSON.stringify(id)}`);
  return `docs/specs/bitbucket-${safe}-${slugify(title)}.md`;
}

// ─── Bitbucket REST shapes (only the fields we request) ───────────────────────

interface BitbucketNamed {
  name?: string;
}
interface BitbucketIssue {
  id?: number;
  title?: string;
  content?: { raw?: string } | null;
  state?: string;
  kind?: string;
  priority?: string;
  component?: BitbucketNamed | null;
  updated_on?: string;
  links?: { html?: { href?: string } };
}
interface BitbucketPage<T> {
  values?: T[];
}
interface BitbucketComment {
  content?: { raw?: string } | null;
}

export interface BitbucketConnectorConfig {
  /** API base URL — defaults to `https://api.bitbucket.org` (validated https). */
  baseUrl?: string;
  /** The Bitbucket workspace (id/slug). */
  workspace: string;
  /** The repository slug hosting the issue tracker. */
  repoSlug: string;
  /** The consent "label" — mapped to the issue COMPONENT (§ LABELS above). REQUIRED. */
  label: string;
  /** Optional state to move the ticket to on pickup (e.g. `open`); best-effort. */
  stateOnPickup?: string;
}

/** Facet-derived labels so the uniform `labels.includes(<component>)` gate works. */
function facetLabels(issue: BitbucketIssue): string[] {
  const out: string[] = [];
  const push = (v: unknown): void => {
    if (typeof v === "string" && v.trim().length > 0) out.push(v);
  };
  push(issue.component?.name);
  push(issue.kind);
  push(issue.priority);
  return out;
}

/** Map a Bitbucket REST issue → the normalised `Ticket`. */
function toTicket(issue: BitbucketIssue): Ticket | null {
  const id = typeof issue.id === "number" && Number.isInteger(issue.id) ? String(issue.id) : "";
  if (id.length === 0) return null;
  return {
    id,
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.content?.raw === "string" ? issue.content.raw : "",
    labels: facetLabels(issue),
    updatedAt: typeof issue.updated_on === "string" ? issue.updated_on : undefined,
    url: typeof issue.links?.html?.href === "string" ? issue.links.html.href : undefined,
  };
}

/** A conservative ISO-8601-ish guard so a watermark can be safely echoed into BBQL. */
function isIsoish(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(value);
}

export class BitbucketTrackerConnector implements TrackerConnector {
  readonly kind = "bitbucket";
  readonly writeback: TrackerWriteback;
  private readonly cfg: BitbucketConnectorConfig;
  private readonly exec: BitbucketExecDeps;
  private readonly baseUrl: string;
  private readonly workspace: string;
  private readonly repoSlug: string;

  constructor(cfg: BitbucketConnectorConfig, exec: BitbucketExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    this.baseUrl = (cfg.baseUrl ?? BITBUCKET_DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.workspace = sanitizeSlug(cfg.workspace);
    this.repoSlug = sanitizeSlug(cfg.repoSlug);
    this.writeback = {
      comment: (ticketId, body, marker) => this.postComment(ticketId, body, marker),
      transition: (ticketId, state) => this.setState(ticketId, state),
    };
  }

  /** URL-encoded `2.0/repositories/<ws>/<repo>` prefix (both slugs pre-sanitised). */
  private repoPath(): string {
    return `2.0/repositories/${encodeURIComponent(this.workspace)}/${encodeURIComponent(this.repoSlug)}`;
  }

  /** Build the server-side BBQL: quoted component + ISO watermark + active states. */
  private buildQuery(sinceWatermark?: string): string {
    const terms = [`component = "${bbqlLiteral(this.cfg.label)}"`, `(state = "new" OR state = "open")`];
    if (isIsoish(sinceWatermark)) terms.push(`updated_on > "${sinceWatermark}"`);
    return terms.join(" AND ");
  }

  /**
   * WATCH: BBQL-search the repo's issue tracker for component-matched, active issues.
   * Returns normalised tickets or `null` on any degrade so the poller skips the cycle.
   */
  async pollTickets(sinceWatermark?: string): Promise<Ticket[] | null> {
    if (this.workspace.length === 0 || this.repoSlug.length === 0) return null;
    const page = await bitbucketGetJson<BitbucketPage<BitbucketIssue>>(
      this.exec,
      this.baseUrl,
      `${this.repoPath()}/issues`,
      { q: this.buildQuery(sinceWatermark), sort: "updated_on", pagelen: "50" },
    );
    if (!page || !Array.isArray(page.values)) return null;
    const tickets: Ticket[] = [];
    for (const issue of page.values) {
      const t = toTicket(issue);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one issue by id. `null` ⇒ not found / degraded. */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const id = sanitizeIssueId(ticketId);
    if (id.length === 0) return null;
    const issue = await bitbucketGetJson<BitbucketIssue>(
      this.exec,
      this.baseUrl,
      `${this.repoPath()}/issues/${id}`,
    );
    if (!issue) return null;
    return toTicket({ ...issue, id: issue.id ?? Number(id) });
  }

  specBranchName(ticketId: string): string {
    return bitbucketSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return bitbucketSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /**
   * Post a COMMENT idempotently: read existing comments, skip if any already carries
   * `marker`, else POST `{ content: { raw: "marker\n body" } }`. Best-effort — a degrade
   * returns `{ posted: false }`, never throws. When comments cannot be read (degrade) we
   * do NOT post (safety over liveness).
   */
  private async postComment(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const id = sanitizeIssueId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const existing = await bitbucketGetJson<BitbucketPage<BitbucketComment>>(
      this.exec,
      this.baseUrl,
      `${this.repoPath()}/issues/${id}/comments`,
      { pagelen: "100" },
    );
    if (!existing || !Array.isArray(existing.values)) return { posted: false, reason: "comments-unreadable" };
    const already = existing.values.some(
      (c) => typeof c.content?.raw === "string" && c.content.raw.includes(marker),
    );
    if (already) return { posted: false, reason: "already-commented" };

    const res = await bitbucketSendJson(
      this.exec,
      "POST",
      this.baseUrl,
      `${this.repoPath()}/issues/${id}/comments`,
      { content: { raw: `${marker}\n${body}` } },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /**
   * Move the ticket to `state` (Bitbucket's pickup "transition"), best-effort. Only a
   * known Bitbucket issue state is sent; anything else is a no-op (never an arbitrary
   * PUT of attacker-shaped state).
   */
  private async setState(ticketId: string, state: string): Promise<WritebackResult> {
    const id = sanitizeIssueId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const wanted = (state ?? "").trim().toLowerCase();
    const ALLOWED = new Set(["new", "open", "resolved", "on hold", "invalid", "duplicate", "wontfix", "closed"]);
    if (!ALLOWED.has(wanted)) return { posted: false, reason: "no-such-state" };
    const res = await bitbucketSendJson(
      this.exec,
      "PUT",
      this.baseUrl,
      `${this.repoPath()}/issues/${id}`,
      { state: wanted },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

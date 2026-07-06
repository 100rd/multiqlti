/**
 * jira-connector.ts — TRACK-3: the Jira Cloud implementation of `TrackerConnector`.
 * It is PURELY the Jira DIALECT (watch = JQL search, read = `/issue/{key}`, write-back
 * = `/issue/{key}/comment` + optional transition, naming = `spec/jira-<KEY>`); the
 * synth, the spec-PR, the provenance, and the crystallise/dedup machinery are the
 * SHARED modules (`issue-spec.ts`, `spec-writer.ts`, `spec-intake.ts`) that GitHub
 * uses too. Adding TRACK-4/5 is another file like this — nothing shared changes.
 *
 * SECURITY
 *   - JQL is SERVER-BUILT: `project`/`label` are sanitised to a safe charset and
 *     embedded as QUOTED literals (double-quotes/backslashes stripped) so a config
 *     value can never break out of the quoted term (JQL-injection defence). The optional
 *     operator `extraJql` is TRUSTED config (a saved filter), wrapped in parens. The
 *     UNTRUSTED ticket title/body never touches JQL.
 *   - Every read/write goes through the fail-closed, never-logging `jira-exec` seam.
 *   - `specBranchName`/`specFilePath` sanitise the Jira key to `[A-Za-z0-9._-]` so it is
 *     shape-safe for the branch (matches `SPEC_BRANCH_RE`) and the filename.
 *   - The ticket description is flattened from ADF and stays UNTRUSTED — the shared
 *     synth fences it before any prompt and the shared renderer quotes it in YAML.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { jiraGetJson, jiraPostJson, type JiraExecDeps } from "./jira-exec.js";

/**
 * Sanitise a JQL string literal value: DROP quotes/backslashes (so it cannot break
 * out of the quoted term — JQL-injection defence) and any C0/DEL control char,
 * collapse whitespace, clamp. Char-code filtered (no control-char regex literal).
 */
function jqlLiteral(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue; // C0 / DEL control chars.
    if (ch === '"' || ch === "\\") continue; // quote-term breakout chars.
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** A valid Jira project key charset (upper alnum + underscore); rejects anything else. */
function sanitizeProjectKey(project: string): string {
  return project.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
}

/**
 * Sanitise a Jira issue key for a branch/filename (`ACME-123` → `ACME-123`). Jira keys
 * are `PROJ-<n>` (alnum + underscore + one dash), so DOTS are dropped — that also keeps
 * the branch free of a `..` sequence git would reject as an invalid ref, and free of
 * any path separator / leading dash (flag-injection / traversal defence).
 */
export function sanitizeIssueKey(key: string): string {
  return key.replace(/[^A-Za-z0-9_-]/g, "").replace(/^-+/, "").slice(0, 80);
}

/** The Jira spec dedup branch: `spec/jira-<KEY>` (matches spec-writer's SPEC_BRANCH_RE). */
export function jiraSpecBranchName(key: string): string {
  const safe = sanitizeIssueKey(key);
  if (safe.length === 0) throw new Error(`jira-connector: invalid issue key ${JSON.stringify(key)}`);
  return `spec/jira-${safe}`;
}

/** The committed spec path: `docs/specs/jira-<KEY>-<slug>.md`. */
export function jiraSpecFilePath(key: string, title: string): string {
  const safe = sanitizeIssueKey(key);
  if (safe.length === 0) throw new Error(`jira-connector: invalid issue key ${JSON.stringify(key)}`);
  return `docs/specs/jira-${safe}-${slugify(title)}.md`;
}

// ─── ADF (Atlassian Document Format) → plain text ─────────────────────────────

/**
 * Flatten a Jira Cloud ADF `description` (a nested `{ type, content, text }` doc) into
 * plain text. A string description (Jira Server / v2) passes through. Bounded so a
 * pathological doc cannot blow the stack / memory (depth + total length caps).
 */
export function adfToText(description: unknown, maxLen = 16_000): string {
  if (typeof description === "string") return description.slice(0, maxLen);
  if (!description || typeof description !== "object") return "";
  const out: string[] = [];
  let total = 0;
  const walk = (node: unknown, depth: number): void => {
    if (total >= maxLen || depth > 50 || !node || typeof node !== "object") return;
    const n = node as { type?: string; text?: string; content?: unknown };
    if (typeof n.text === "string") {
      out.push(n.text);
      total += n.text.length;
    }
    if (n.type === "paragraph" || n.type === "hardBreak" || n.type === "heading") {
      out.push("\n");
      total += 1;
    }
    if (Array.isArray(n.content)) {
      for (const child of n.content) walk(child, depth + 1);
    }
  };
  walk(description, 0);
  return out.join("").slice(0, maxLen).trim();
}

/** Wrap plain-text lines into a minimal ADF doc (one paragraph per line). */
export function textToAdf(lines: string[]): unknown {
  return {
    type: "doc",
    version: 1,
    content: lines.map((line) => ({
      type: "paragraph",
      content: line.length > 0 ? [{ type: "text", text: line }] : [],
    })),
  };
}

// ─── Jira REST shapes (only the fields we request) ────────────────────────────

interface JiraIssue {
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    labels?: string[];
    updated?: string;
  };
}
interface JiraSearchResult {
  issues?: JiraIssue[];
}
interface JiraComment {
  body?: unknown;
}
interface JiraCommentsResult {
  comments?: JiraComment[];
}
interface JiraTransition {
  id?: string;
  name?: string;
}
interface JiraTransitionsResult {
  transitions?: JiraTransition[];
}

export interface JiraConnectorConfig {
  /** `https://your-domain.atlassian.net` (validated https in jira-exec). */
  baseUrl: string;
  /** Jira project key, e.g. `ACME`. */
  project: string;
  /** The consent label (§3.1) — REQUIRED at fire time by the poller. */
  label: string;
  /** Optional operator JQL predicate (TRUSTED config) ANDed into the search. */
  extraJql?: string;
  /** Optional transition name/id to move the ticket to on pickup (best-effort). */
  transitionTo?: string;
}

/** Map a Jira REST issue → the normalised `Ticket` (description flattened from ADF). */
function toTicket(issue: JiraIssue, browseBase: string): Ticket | null {
  const key = typeof issue.key === "string" ? issue.key : "";
  if (key.length === 0) return null;
  const f = issue.fields ?? {};
  return {
    id: key,
    title: typeof f.summary === "string" ? f.summary : "",
    body: adfToText(f.description),
    labels: Array.isArray(f.labels) ? f.labels.filter((l): l is string => typeof l === "string") : [],
    updatedAt: typeof f.updated === "string" ? f.updated : undefined,
    url: `${browseBase}/browse/${encodeURIComponent(key)}`,
  };
}

export class JiraTrackerConnector implements TrackerConnector {
  readonly kind = "jira";
  readonly writeback: TrackerWriteback;
  private readonly cfg: JiraConnectorConfig;
  private readonly exec: JiraExecDeps;
  private readonly browseBase: string;

  constructor(cfg: JiraConnectorConfig, exec: JiraExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    // Human browse links live at the site origin (strip any trailing slash).
    this.browseBase = cfg.baseUrl.replace(/\/+$/, "");
    this.writeback = {
      comment: (ticketId, body, marker) => this.postComment(ticketId, body, marker),
      transition: (ticketId, state) => this.doTransition(ticketId, state),
    };
  }

  /** Build the server-side JQL (quoted, sanitised literals; trusted extra ANDed). */
  private buildJql(): string {
    const project = sanitizeProjectKey(this.cfg.project);
    const label = jqlLiteral(this.cfg.label);
    const terms = [`project = "${project}"`, `labels = "${label}"`];
    const extra = (this.cfg.extraJql ?? "").trim();
    if (extra.length > 0) terms.push(`(${extra})`);
    return `${terms.join(" AND ")} ORDER BY updated ASC`;
  }

  /**
   * WATCH: JQL-search the project for labelled tickets. Returns normalised tickets or
   * `null` on any degrade (auth/outage) so the poller skips the cycle. `sinceWatermark`
   * is accepted for interface parity but dedup is handled by the poller's intake
   * watermark (one spec per ticket), exactly as the GitHub path does.
   */
  async pollTickets(_sinceWatermark?: string): Promise<Ticket[] | null> {
    const result = await jiraGetJson<JiraSearchResult>(this.exec, this.cfg.baseUrl, "rest/api/3/search", {
      jql: this.buildJql(),
      fields: "summary,description,labels,updated",
      maxResults: "100",
    });
    if (!result || !Array.isArray(result.issues)) return null;
    const tickets: Ticket[] = [];
    for (const issue of result.issues) {
      const t = toTicket(issue, this.browseBase);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one issue by key. `null` ⇒ not found / degraded. */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const key = sanitizeIssueKey(ticketId);
    if (key.length === 0) return null;
    const issue = await jiraGetJson<JiraIssue>(
      this.exec,
      this.cfg.baseUrl,
      `rest/api/3/issue/${encodeURIComponent(key)}`,
      { fields: "summary,description,labels,updated" },
    );
    if (!issue) return null;
    return toTicket({ ...issue, key: issue.key ?? key }, this.browseBase);
  }

  specBranchName(ticketId: string): string {
    return jiraSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return jiraSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /**
   * Post a comment IDEMPOTENTLY: read existing comments, skip if any already carries
   * `marker`, else POST an ADF comment `marker\n body`. Best-effort — a degrade returns
   * `{ posted: false }`, never throws. When comments cannot be read (degrade) we do NOT
   * post (safety over liveness — a blind post could double-comment).
   */
  private async postComment(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const key = sanitizeIssueKey(ticketId);
    if (key.length === 0) return { posted: false, reason: "bad-key" };
    const existing = await jiraGetJson<JiraCommentsResult>(
      this.exec,
      this.cfg.baseUrl,
      `rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { maxResults: "200" },
    );
    if (!existing || !Array.isArray(existing.comments)) {
      return { posted: false, reason: "comments-unreadable" };
    }
    const already = existing.comments.some((c) => adfToText(c.body).includes(marker));
    if (already) return { posted: false, reason: "already-commented" };

    const res = await jiraPostJson(
      this.exec,
      this.cfg.baseUrl,
      `rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { body: textToAdf([marker, body]) },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /**
   * Move the ticket to `state` (name or id), best-effort. Resolves the transition id
   * from the issue's available transitions (a state not offered ⇒ no-op) then POSTs it.
   */
  private async doTransition(ticketId: string, state: string): Promise<WritebackResult> {
    const key = sanitizeIssueKey(ticketId);
    if (key.length === 0) return { posted: false, reason: "bad-key" };
    const wanted = state.trim();
    if (wanted.length === 0) return { posted: false, reason: "no-state" };
    const avail = await jiraGetJson<JiraTransitionsResult>(
      this.exec,
      this.cfg.baseUrl,
      `rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    if (!avail || !Array.isArray(avail.transitions)) return { posted: false, reason: "transitions-unreadable" };
    const match = avail.transitions.find(
      (t) => t.id === wanted || (t.name ?? "").toLowerCase() === wanted.toLowerCase(),
    );
    if (!match?.id) return { posted: false, reason: "no-such-transition" };
    const res = await jiraPostJson(
      this.exec,
      this.cfg.baseUrl,
      `rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
      { transition: { id: match.id } },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

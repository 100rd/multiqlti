/**
 * gitlab-connector.ts — TRACK-4: the GitLab Issues implementation of `TrackerConnector`.
 * PURELY the GitLab DIALECT (watch = `/projects/:id/issues` REST poll, read =
 * `/issues/:iid`, write-back = `/issues/:iid/notes` + an optional pickup label, naming
 * = `spec/gitlab-<iid>`); the synth, the spec-PR, the provenance, and the
 * crystallise/dedup machinery are the SHARED modules (`issue-spec.ts`, `spec-writer.ts`,
 * `spec-intake.ts`) that GitHub + Jira use too. Nothing shared changes.
 *
 * SECURITY
 *   - The project id/path is sanitised to `[A-Za-z0-9._/-]` then URL-encoded, so a
 *     numeric id (`42`) or a path (`group/sub/project`) both become one path segment
 *     (`group%2Fsub%2Fproject`) that cannot escape the `api/v4/projects/…` prefix.
 *   - The label is embedded as a plain query param (URLSearchParams-encoded by the
 *     exec seam); it never enters a path, a shell, or a prompt. UNTRUSTED ticket
 *     title/description is flattened to text and stays untrusted — the shared synth
 *     fences it before any prompt and the shared renderer quotes it in YAML.
 *   - Every read/write goes through the fail-closed, never-logging `gitlab-exec` seam.
 *   - `specBranchName`/`specFilePath` derive from the numeric `iid` only, so nothing
 *     attacker-shaped (a leading dash, a path separator, a `..`) can reach `gh`.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { gitlabGetJson, gitlabSendJson, type GitlabExecDeps } from "./gitlab-exec.js";

/**
 * Sanitise a GitLab project id/path for the URL: keep `[A-Za-z0-9._/-]` (a numeric id
 * or a namespace path), then DROP any `.`/`..`/empty path segment so no traversal
 * segment survives (defence-in-depth — the `encodeURIComponent` in `projectPath()` would
 * already neutralise a slash, but we strip `..` here too), rejoin, clamp.
 */
export function sanitizeProjectRef(project: string): string {
  const kept = project.replace(/[^A-Za-z0-9._/-]/g, "");
  const segments = kept.split("/").filter((s) => s.length > 0 && s !== "." && s !== "..");
  return segments.join("/").slice(0, 200);
}

/** Sanitise a GitLab issue iid to DIGITS ONLY (iids are positive integers). */
export function sanitizeIid(iid: string): string {
  return String(iid).replace(/[^0-9]/g, "").slice(0, 18);
}

/** The GitLab spec dedup branch: `spec/gitlab-<iid>` (matches spec-writer's SPEC_BRANCH_RE). */
export function gitlabSpecBranchName(iid: string): string {
  const safe = sanitizeIid(iid);
  if (safe.length === 0) throw new Error(`gitlab-connector: invalid issue iid ${JSON.stringify(iid)}`);
  return `spec/gitlab-${safe}`;
}

/** The committed spec path: `docs/specs/gitlab-<iid>-<slug>.md`. */
export function gitlabSpecFilePath(iid: string, title: string): string {
  const safe = sanitizeIid(iid);
  if (safe.length === 0) throw new Error(`gitlab-connector: invalid issue iid ${JSON.stringify(iid)}`);
  return `docs/specs/gitlab-${safe}-${slugify(title)}.md`;
}

// ─── GitLab REST shapes (only the fields we request) ──────────────────────────

interface GitlabIssue {
  iid?: number;
  title?: string;
  description?: string | null;
  labels?: string[];
  web_url?: string;
  updated_at?: string;
}
interface GitlabNote {
  body?: string;
}

export interface GitlabConnectorConfig {
  /** GitLab base URL, e.g. `https://gitlab.com` (validated https in gitlab-exec). */
  baseUrl: string;
  /** GitLab project id (`42`) or URL path (`group/project`). */
  project: string;
  /** The consent label (§3.1) — REQUIRED at fire time by the poller. */
  label: string;
  /** Optional label to ADD to the ticket on pickup (best-effort; GitLab's "transition"). */
  labelOnPickup?: string;
}

/** Map a GitLab REST issue → the normalised `Ticket` (iid as the ref). */
function toTicket(issue: GitlabIssue): Ticket | null {
  const iid = typeof issue.iid === "number" && Number.isInteger(issue.iid) ? String(issue.iid) : "";
  if (iid.length === 0) return null;
  return {
    id: iid,
    title: typeof issue.title === "string" ? issue.title : "",
    body: typeof issue.description === "string" ? issue.description : "",
    labels: Array.isArray(issue.labels) ? issue.labels.filter((l): l is string => typeof l === "string") : [],
    updatedAt: typeof issue.updated_at === "string" ? issue.updated_at : undefined,
    url: typeof issue.web_url === "string" ? issue.web_url : undefined,
  };
}

/** A conservative ISO-8601-ish guard so a watermark can be safely echoed into the query. */
function isIsoish(value: string | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})?$/.test(value);
}

export class GitlabTrackerConnector implements TrackerConnector {
  readonly kind = "gitlab";
  readonly writeback: TrackerWriteback;
  private readonly cfg: GitlabConnectorConfig;
  private readonly exec: GitlabExecDeps;
  private readonly projectRef: string;

  constructor(cfg: GitlabConnectorConfig, exec: GitlabExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    this.projectRef = sanitizeProjectRef(cfg.project);
    this.writeback = {
      comment: (ticketId, body, marker) => this.postNote(ticketId, body, marker),
      // GitLab has no arbitrary workflow states — the pickup "transition" is a LABEL add.
      transition: (ticketId, label) => this.addLabel(ticketId, label),
    };
  }

  /** URL-encoded `api/v4/projects/<project>` prefix (project ref pre-sanitised). */
  private projectPath(): string {
    return `api/v4/projects/${encodeURIComponent(this.projectRef)}`;
  }

  /**
   * WATCH: list the project's OPEN issues carrying the consent label, updated after the
   * watermark. Returns normalised tickets or `null` on any degrade (auth/outage) so the
   * poller skips the cycle. The `updated_after` watermark narrows the query; dedup is
   * still handled by the poller's intake watermark (one spec per iid).
   */
  async pollTickets(sinceWatermark?: string): Promise<Ticket[] | null> {
    if (this.projectRef.length === 0) return null;
    const query: Record<string, string> = {
      labels: this.cfg.label,
      state: "opened",
      per_page: "100",
      order_by: "updated_at",
      sort: "asc",
    };
    if (isIsoish(sinceWatermark)) query.updated_after = sinceWatermark;
    const issues = await gitlabGetJson<GitlabIssue[]>(
      this.exec,
      this.cfg.baseUrl,
      `${this.projectPath()}/issues`,
      query,
    );
    if (!Array.isArray(issues)) return null;
    const tickets: Ticket[] = [];
    for (const issue of issues) {
      const t = toTicket(issue);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one issue by iid. `null` ⇒ not found / degraded. */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const iid = sanitizeIid(ticketId);
    if (iid.length === 0) return null;
    const issue = await gitlabGetJson<GitlabIssue>(
      this.exec,
      this.cfg.baseUrl,
      `${this.projectPath()}/issues/${iid}`,
    );
    if (!issue) return null;
    return toTicket({ ...issue, iid: issue.iid ?? Number(iid) });
  }

  specBranchName(ticketId: string): string {
    return gitlabSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return gitlabSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /**
   * Post a NOTE idempotently: read existing notes, skip if any already carries `marker`,
   * else POST `marker\n body`. Best-effort — a degrade returns `{ posted: false }`, never
   * throws. When notes cannot be read (degrade) we do NOT post (safety over liveness — a
   * blind post could double-comment).
   */
  private async postNote(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const iid = sanitizeIid(ticketId);
    if (iid.length === 0) return { posted: false, reason: "bad-iid" };
    const existing = await gitlabGetJson<GitlabNote[]>(
      this.exec,
      this.cfg.baseUrl,
      `${this.projectPath()}/issues/${iid}/notes`,
      { per_page: "100" },
    );
    if (!Array.isArray(existing)) return { posted: false, reason: "notes-unreadable" };
    const already = existing.some((n) => typeof n.body === "string" && n.body.includes(marker));
    if (already) return { posted: false, reason: "already-commented" };

    const res = await gitlabSendJson(
      this.exec,
      "POST",
      this.cfg.baseUrl,
      `${this.projectPath()}/issues/${iid}/notes`,
      { body: `${marker}\n${body}` },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /**
   * ADD a label to the issue (GitLab's pickup "transition"), best-effort. `add_labels`
   * is additive on GitLab, so this never removes existing labels. A blank label is a
   * no-op.
   */
  private async addLabel(ticketId: string, label: string): Promise<WritebackResult> {
    const iid = sanitizeIid(ticketId);
    if (iid.length === 0) return { posted: false, reason: "bad-iid" };
    const wanted = (label ?? "").trim();
    if (wanted.length === 0) return { posted: false, reason: "no-label" };
    const res = await gitlabSendJson(
      this.exec,
      "PUT",
      this.cfg.baseUrl,
      `${this.projectPath()}/issues/${iid}`,
      { add_labels: wanted },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

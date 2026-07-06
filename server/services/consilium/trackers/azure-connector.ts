/**
 * azure-connector.ts — TRACK-5: the Azure DevOps implementation of `TrackerConnector`. It
 * is PURELY the Azure DIALECT (watch = WIQL query, read = `/wit/workitems/{id}`, write-back
 * = `/comments` + `System.State` field patch + hyperlink relation, naming =
 * `spec/azure-<id>`); the synth, the spec-PR, the provenance, and the crystallise/dedup
 * machinery are the SHARED modules (`issue-spec.ts`, `spec-writer.ts`, `spec-intake.ts`).
 *
 * SECURITY
 *   - WIQL is SERVER-BUILT: `[System.TeamProject] = @project` uses the WIQL MACRO (no
 *     project interpolation); the `tag` and optional `areaPath` are sanitised to a safe
 *     charset and embedded as QUOTED literals (single-quotes/backslashes stripped) so a
 *     config value can never break out of the quoted term (WIQL-injection defence). The
 *     `changedDate` watermark is a server-generated ISO string. The UNTRUSTED work-item
 *     title/description NEVER touches WIQL.
 *   - Path segments (org/project/id) are shape-validated then `encodeURIComponent`-d;
 *     `azure-exec` re-checks the final URL stays on `baseUrl`'s origin.
 *   - Every read/write goes through the fail-closed, never-logging `azure-exec` seam.
 *   - `System.Description` is HTML → flattened to plain text and stays UNTRUSTED (the
 *     shared synth fences it before any prompt; the renderer quotes it in YAML).
 *   - `specBranchName`/`specFilePath` reduce the id to DIGITS so the branch matches
 *     `SPEC_BRANCH_RE` (`azure-[0-9]+`) and the filename is traversal-free.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { azureGetJson, azureSendJson, type AzureExecDeps } from "./azure-exec.js";

const API_VERSION = "7.0";
const COMMENTS_API_VERSION = "7.0-preview.3";
const DESCRIPTION_MAX = 16_000;

/**
 * Sanitise a WIQL single-quoted literal: DROP the single-quote (the ONLY term-breakout
 * char in a WIQL quoted string — WIQL-injection defence) and any C0/DEL control char,
 * collapse whitespace, clamp. Backslash is KEPT: WIQL treats it literally (no escape
 * sequences) and area paths legitimately use it as a hierarchy separator
 * (`Project\Area\Sub`). Char-code filtered (no control-char regex literal).
 */
function wiqlLiteral(value: string, max = 200): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === "'") continue; // quote-term breakout char.
    out += ch;
  }
  return out.replace(/\s+/g, " ").trim().slice(0, max);
}

/** Reduce a work-item id to DIGITS (Azure ids are positive integers). */
export function sanitizeWorkItemId(id: string): string {
  return String(id).replace(/[^0-9]/g, "").slice(0, 18);
}

/** Sanitise an org/project path segment: drop separators/control/`..`, clamp (encoded later). */
function sanitizeSegment(value: string, max = 100): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    if (ch === "/" || ch === "\\") continue;
    out += ch;
  }
  return out.replace(/\.\.+/g, ".").trim().slice(0, max);
}

/** The Azure spec dedup branch: `spec/azure-<id>` (matches spec-writer's SPEC_BRANCH_RE). */
export function azureSpecBranchName(id: string): string {
  const safe = sanitizeWorkItemId(id);
  if (safe.length === 0) throw new Error(`azure-connector: invalid work-item id ${JSON.stringify(id)}`);
  return `spec/azure-${safe}`;
}

/** The committed spec path: `docs/specs/azure-<id>-<slug>.md`. */
export function azureSpecFilePath(id: string, title: string): string {
  const safe = sanitizeWorkItemId(id);
  if (safe.length === 0) throw new Error(`azure-connector: invalid work-item id ${JSON.stringify(id)}`);
  return `docs/specs/azure-${safe}-${slugify(title)}.md`;
}

/**
 * Flatten a work-item HTML `System.Description` to plain text: drop tags, decode the
 * common named/numeric entities, collapse whitespace, clamp. Bounded (never runs a
 * catastrophic regex over an unbounded string — the input is clamped first).
 */
export function htmlToText(html: unknown, maxLen = DESCRIPTION_MAX): string {
  if (typeof html !== "string") return "";
  const clamped = html.slice(0, maxLen * 2);
  const noTags = clamped
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    // Render list items as markdown bullets so the shared criteria extractor
    // (`- text`) still recognises an Azure "Acceptance Criteria" HTML list.
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "");
  const decoded = noTags
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_m, d) => {
      const code = Number(d);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
    });
  return decoded.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, maxLen);
}

/** Split the `System.Tags` string (`"a; b; c"`) into a normalised label array. */
export function parseTags(tags: unknown): string[] {
  if (typeof tags !== "string") return [];
  return tags
    .split(";")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// ─── Azure REST shapes (only the fields we request) ───────────────────────────

interface AzureFields {
  "System.Title"?: string;
  "System.Description"?: string;
  "System.Tags"?: string;
  "System.ChangedDate"?: string;
}
interface AzureWorkItem {
  id?: number;
  fields?: AzureFields;
}
interface AzureWiqlResult {
  workItems?: Array<{ id?: number }>;
}
interface AzureBatchResult {
  value?: AzureWorkItem[];
}
interface AzureCommentsResult {
  comments?: Array<{ text?: string }>;
}

export interface AzureConnectorConfig {
  /** Azure organization (the `dev.azure.com/<org>` segment) — REQUIRED. */
  org: string;
  /** Azure project name — REQUIRED. */
  project: string;
  /** The consent tag (§3.1) — REQUIRED at fire time by the poller. */
  tag: string;
  /** Optional area-path filter ANDed into the WIQL (`[System.AreaPath] UNDER '<path>'`). */
  areaPath?: string;
  /** Optional `System.State` value to move the work item to on pickup (best-effort). */
  transitionTo?: string;
}

export class AzureTrackerConnector implements TrackerConnector {
  readonly kind = "azure";
  readonly writeback: TrackerWriteback;
  private readonly cfg: AzureConnectorConfig;
  private readonly exec: AzureExecDeps;
  private readonly org: string;
  private readonly project: string;
  private readonly apiBase: string;
  private readonly webBase: string;

  constructor(cfg: AzureConnectorConfig, exec: AzureExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    this.org = encodeURIComponent(sanitizeSegment(cfg.org));
    this.project = encodeURIComponent(sanitizeSegment(cfg.project));
    this.apiBase = `${this.org}/${this.project}/_apis/wit`;
    const host = (exec.baseUrl && exec.baseUrl.trim().length > 0 ? exec.baseUrl : "https://dev.azure.com").replace(/\/+$/, "");
    this.webBase = `${host}/${this.org}/${this.project}/_workitems/edit`;
    this.writeback = {
      comment: (ticketId, body, marker) => this.postComment(ticketId, body, marker),
      transition: (ticketId, state) => this.setState(ticketId, state),
      link: (ticketId, url, title) => this.addLink(ticketId, url, title),
    };
  }

  /** Build the server-side WIQL (macro project; sanitised, quoted tag/areaPath literals). */
  private buildWiql(sinceWatermark?: string): string {
    const tag = wiqlLiteral(this.cfg.tag);
    const terms = [
      "[System.TeamProject] = @project",
      `[System.Tags] CONTAINS '${tag}'`,
    ];
    const area = (this.cfg.areaPath ?? "").trim();
    if (area.length > 0) terms.push(`[System.AreaPath] UNDER '${wiqlLiteral(area)}'`);
    if (sinceWatermark && sinceWatermark.trim().length > 0) {
      terms.push(`[System.ChangedDate] > '${wiqlLiteral(sinceWatermark, 40)}'`);
    }
    return `SELECT [System.Id] FROM WorkItems WHERE ${terms.join(" AND ")} ORDER BY [System.ChangedDate] ASC`;
  }

  /** Map an Azure work item → the normalised `Ticket`. */
  private toTicket(wi: AzureWorkItem): Ticket | null {
    const id = typeof wi.id === "number" && Number.isFinite(wi.id) ? String(wi.id) : "";
    if (id.length === 0) return null;
    const f = wi.fields ?? {};
    return {
      id,
      title: typeof f["System.Title"] === "string" ? f["System.Title"]! : "",
      body: htmlToText(f["System.Description"]),
      labels: parseTags(f["System.Tags"]),
      updatedAt: typeof f["System.ChangedDate"] === "string" ? f["System.ChangedDate"] : undefined,
      url: `${this.webBase}/${id}`,
    };
  }

  /**
   * WATCH: WIQL-query the project for tagged work items, then batch-read their fields.
   * `null` on any degrade (auth/outage) so the poller skips the cycle.
   */
  async pollTickets(sinceWatermark?: string): Promise<Ticket[] | null> {
    const wiql = await azureSendJson(
      this.exec,
      "POST",
      `${this.apiBase}/wiql`,
      { query: this.buildWiql(sinceWatermark) },
      { query: { "api-version": API_VERSION } },
    );
    if (!wiql.ok) return null;
    let ids: number[] = [];
    try {
      const parsed = JSON.parse(wiql.body) as AzureWiqlResult;
      ids = (parsed.workItems ?? [])
        .map((w) => w.id)
        .filter((n): n is number => typeof n === "number" && Number.isFinite(n))
        .slice(0, 200);
    } catch {
      return null;
    }
    if (ids.length === 0) return [];
    const batch = await azureGetJson<AzureBatchResult>(this.exec, `${this.apiBase}/workitems`, {
      ids: ids.join(","),
      fields: "System.Title,System.Description,System.Tags,System.ChangedDate",
      "api-version": API_VERSION,
    });
    if (!batch || !Array.isArray(batch.value)) return null;
    const tickets: Ticket[] = [];
    for (const wi of batch.value) {
      const t = this.toTicket(wi);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one work item by id. `null` ⇒ not found / degraded. */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const id = sanitizeWorkItemId(ticketId);
    if (id.length === 0) return null;
    const wi = await azureGetJson<AzureWorkItem>(this.exec, `${this.apiBase}/workitems/${id}`, {
      fields: "System.Title,System.Description,System.Tags,System.ChangedDate",
      "api-version": API_VERSION,
    });
    if (!wi) return null;
    return this.toTicket({ ...wi, id: typeof wi.id === "number" ? wi.id : Number(id) });
  }

  specBranchName(ticketId: string): string {
    return azureSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return azureSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /**
   * Post a comment IDEMPOTENTLY: read existing comments, skip if any already carries
   * `marker`, else POST `{ text }`. Best-effort; when comments cannot be read we do NOT
   * post (safety over liveness).
   */
  private async postComment(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const id = sanitizeWorkItemId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const existing = await azureGetJson<AzureCommentsResult>(this.exec, `${this.apiBase}/workItems/${id}/comments`, {
      "api-version": COMMENTS_API_VERSION,
    });
    if (!existing || !Array.isArray(existing.comments)) {
      return { posted: false, reason: "comments-unreadable" };
    }
    const already = existing.comments.some((c) => typeof c.text === "string" && c.text.includes(marker));
    if (already) return { posted: false, reason: "already-commented" };
    const res = await azureSendJson(
      this.exec,
      "POST",
      `${this.apiBase}/workItems/${id}/comments`,
      { text: `${marker}\n${body}` },
      { query: { "api-version": COMMENTS_API_VERSION } },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /**
   * Move the work item to `state` via a `System.State` JSON-patch, best-effort. The value
   * is the operator-configured state (trusted); no resolution needed.
   */
  private async setState(ticketId: string, state: string): Promise<WritebackResult> {
    const id = sanitizeWorkItemId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const wanted = state.trim();
    if (wanted.length === 0) return { posted: false, reason: "no-state" };
    const res = await azureSendJson(
      this.exec,
      "PATCH",
      `${this.apiBase}/workitems/${id}`,
      [{ op: "add", path: "/fields/System.State", value: wanted }],
      { query: { "api-version": API_VERSION }, contentType: "application/json-patch+json" },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /** Attach a hyperlink relation to the work item (e.g. the spec/PR URL), best-effort. */
  private async addLink(ticketId: string, url: string, title?: string): Promise<WritebackResult> {
    const id = sanitizeWorkItemId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    if (!/^https?:\/\//i.test(url)) return { posted: false, reason: "bad-url" };
    const res = await azureSendJson(
      this.exec,
      "PATCH",
      `${this.apiBase}/workitems/${id}`,
      [
        {
          op: "add",
          path: "/relations/-",
          value: { rel: "Hyperlink", url, attributes: title ? { comment: title } : {} },
        },
      ],
      { query: { "api-version": API_VERSION }, contentType: "application/json-patch+json" },
    );
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

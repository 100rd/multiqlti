/**
 * clickup-connector.ts — TRACK-5: the ClickUp implementation of `TrackerConnector`. It is
 * PURELY the ClickUp DIALECT (watch = `/list/{id}/task?date_updated_gt=…` filtered by tag,
 * read = `/task/{id}`, write-back = `/task/{id}/comment` + status update, naming =
 * `spec/clickup-<id>`); the synth, the spec-PR, the provenance, and the crystallise/dedup
 * machinery are the SHARED modules (`issue-spec.ts`, `spec-writer.ts`, `spec-intake.ts`).
 *
 * SECURITY
 *   - Query params travel through `URLSearchParams` in `clickup-exec` (a value can never
 *     inject an extra param); the tag/date/id are also shape-sanitised. The UNTRUSTED task
 *     name/description never reaches a query or a path.
 *   - Every read/write goes through the fail-closed, never-logging `clickup-exec` seam.
 *   - `specBranchName`/`specFilePath` sanitise the task id to `[A-Za-z0-9._-]` so the
 *     branch matches `SPEC_BRANCH_RE` (`clickup-…`) and the filename is traversal-free.
 *   - The task name/description are UNTRUSTED — the shared synth fences them before any
 *     prompt; the shared renderer quotes them in YAML.
 */
import { slugify } from "./issue-spec.js";
import type { Ticket, TrackerConnector, TrackerWriteback, WritebackResult } from "./tracker-connector.js";
import { clickupGetJson, clickupSendJson, type ClickUpExecDeps } from "./clickup-exec.js";

const DESCRIPTION_MAX = 16_000;

/** Sanitise a ClickUp id (list/task) to `[A-Za-z0-9._-]`, drop leading dash / `..`, clamp. */
export function sanitizeClickUpId(id: string): string {
  return String(id)
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/\.\.+/g, ".")
    .replace(/^[-.]+/, "")
    .slice(0, 64);
}

/** Control-strip + clamp a tag value before it becomes a query param (defence in depth). */
function cleanTag(value: string, max = 100): string {
  let out = "";
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) continue;
    out += ch;
  }
  return out.trim().slice(0, max);
}

/** The ClickUp spec dedup branch: `spec/clickup-<id>` (matches spec-writer's SPEC_BRANCH_RE). */
export function clickupSpecBranchName(id: string): string {
  const safe = sanitizeClickUpId(id);
  if (safe.length === 0) throw new Error(`clickup-connector: invalid task id ${JSON.stringify(id)}`);
  return `spec/clickup-${safe}`;
}

/** The committed spec path: `docs/specs/clickup-<id>-<slug>.md`. */
export function clickupSpecFilePath(id: string, title: string): string {
  const safe = sanitizeClickUpId(id);
  if (safe.length === 0) throw new Error(`clickup-connector: invalid task id ${JSON.stringify(id)}`);
  return `docs/specs/clickup-${safe}-${slugify(title)}.md`;
}

// ─── ClickUp REST shapes (only the fields we request) ─────────────────────────

interface ClickUpTask {
  id?: string;
  name?: string;
  description?: string;
  text_content?: string;
  tags?: Array<{ name?: string }>;
  date_updated?: string;
  url?: string;
}
interface ClickUpTasksResult {
  tasks?: ClickUpTask[];
}
interface ClickUpCommentsResult {
  comments?: Array<{ comment_text?: string }>;
}

export interface ClickUpConnectorConfig {
  /** The ClickUp list id whose tasks are polled — REQUIRED. */
  listId: string;
  /** The consent tag (§3.1) — REQUIRED at fire time by the poller. */
  tag: string;
  /** Optional status name to move the task to on pickup (best-effort). */
  transitionTo?: string;
}

/** Map a ClickUp task → the normalised `Ticket`. `null` if it has no id. */
function toTicket(task: ClickUpTask | null | undefined): Ticket | null {
  if (!task) return null;
  const id = typeof task.id === "string" ? task.id : "";
  if (id.length === 0) return null;
  const body =
    typeof task.text_content === "string" && task.text_content.length > 0
      ? task.text_content
      : typeof task.description === "string"
        ? task.description
        : "";
  const labels = Array.isArray(task.tags)
    ? task.tags.map((t) => t?.name).filter((n): n is string => typeof n === "string")
    : [];
  return {
    id,
    title: typeof task.name === "string" ? task.name : "",
    body: body.slice(0, DESCRIPTION_MAX),
    labels,
    updatedAt: typeof task.date_updated === "string" ? task.date_updated : undefined,
    url: typeof task.url === "string" && task.url.length > 0 ? task.url : `https://app.clickup.com/t/${id}`,
  };
}

export class ClickUpTrackerConnector implements TrackerConnector {
  readonly kind = "clickup";
  readonly writeback: TrackerWriteback;
  private readonly cfg: ClickUpConnectorConfig;
  private readonly exec: ClickUpExecDeps;
  private readonly listId: string;

  constructor(cfg: ClickUpConnectorConfig, exec: ClickUpExecDeps) {
    this.cfg = cfg;
    this.exec = exec;
    this.listId = sanitizeClickUpId(cfg.listId);
    this.writeback = {
      comment: (ticketId, body, marker) => this.postComment(ticketId, body, marker),
      transition: (ticketId, state) => this.setStatus(ticketId, state),
      // `link` intentionally omitted: ClickUp attachment upload is multipart (out of scope
      // for the JSON seam); the pickup URL already lands as a comment. The interface makes
      // `link` optional, so the crystallise pipeline (comment-only) is unaffected.
    };
  }

  /**
   * WATCH: list tasks updated since the watermark, filtered by tag. The ISO watermark is
   * converted to ClickUp's epoch-ms `date_updated_gt`. `null` on any degrade so the poller
   * skips the cycle.
   */
  async pollTickets(sinceWatermark?: string): Promise<Ticket[] | null> {
    if (this.listId.length === 0) return null;
    const query: Record<string, string> = { "tags[]": cleanTag(this.cfg.tag) };
    if (sinceWatermark && sinceWatermark.trim().length > 0) {
      const ms = Date.parse(sinceWatermark);
      if (Number.isFinite(ms)) query.date_updated_gt = String(ms);
    }
    const data = await clickupGetJson<ClickUpTasksResult>(this.exec, `list/${this.listId}/task`, query);
    if (!data || !Array.isArray(data.tasks)) return null;
    const tickets: Ticket[] = [];
    for (const task of data.tasks) {
      const t = toTicket(task);
      if (t) tickets.push(t);
    }
    return tickets;
  }

  /** READ: fetch one task by id. `null` ⇒ not found / degraded. */
  async readTicket(ticketId: string): Promise<Ticket | null> {
    const id = sanitizeClickUpId(ticketId);
    if (id.length === 0) return null;
    const task = await clickupGetJson<ClickUpTask>(this.exec, `task/${id}`);
    if (!task) return null;
    return toTicket({ ...task, id: task.id ?? id });
  }

  specBranchName(ticketId: string): string {
    return clickupSpecBranchName(ticketId);
  }

  specFilePath(ticketId: string, title: string): string {
    return clickupSpecFilePath(ticketId, title);
  }

  // ─── write-back ─────────────────────────────────────────────────────────────

  /**
   * Post a comment IDEMPOTENTLY: read existing comments, skip if any already carries
   * `marker`, else POST `{ comment_text }`. Best-effort; when comments cannot be read we
   * do NOT post (safety over liveness).
   */
  private async postComment(ticketId: string, body: string, marker: string): Promise<WritebackResult> {
    const id = sanitizeClickUpId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const existing = await clickupGetJson<ClickUpCommentsResult>(this.exec, `task/${id}/comment`);
    if (!existing || !Array.isArray(existing.comments)) {
      return { posted: false, reason: "comments-unreadable" };
    }
    const already = existing.comments.some(
      (c) => typeof c.comment_text === "string" && c.comment_text.includes(marker),
    );
    if (already) return { posted: false, reason: "already-commented" };
    const res = await clickupSendJson(this.exec, "POST", `task/${id}/comment`, {
      comment_text: `${marker}\n${body}`,
    });
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }

  /** Move the task to `status` (name), best-effort. The value is trusted config. */
  private async setStatus(ticketId: string, status: string): Promise<WritebackResult> {
    const id = sanitizeClickUpId(ticketId);
    if (id.length === 0) return { posted: false, reason: "bad-id" };
    const wanted = status.trim();
    if (wanted.length === 0) return { posted: false, reason: "no-status" };
    const res = await clickupSendJson(this.exec, "PUT", `task/${id}`, { status: wanted });
    return res.ok ? { posted: true } : { posted: false, reason: res.reason };
  }
}

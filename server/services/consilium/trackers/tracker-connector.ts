/**
 * tracker-connector.ts — the UNIFORM tracker-connector surface (task-tracker-triggers
 * §2). A connector is a small per-system adapter doing exactly three things:
 *   1. WATCH  — learn of new/changed tickets   (`pollTickets(sinceWatermark)`)
 *   2. READ   — fetch a ticket's fields        (`readTicket(id)`)
 *   3. WRITE-BACK — comment / transition / link (`writeback.*`)
 * plus the two deterministic NAMING helpers the shared spec-intake needs to dedup and
 * to place the committed spec (`specBranchName`/`specFilePath`).
 *
 * WHY THIS EXISTS (TRACK-3 generalisation)
 *   TRACK-1/2 shipped a GitHub-only path. TRACK-3 adds Jira and, per §2, EVERY tracker
 *   (GitHub, Jira, GitLab, Bitbucket, Linear, Azure DevOps, ClickUp) "reduces to the
 *   same interface; only the API dialect differs." So the synth (`issue-spec.ts`), the
 *   spec-PR writer (`spec-writer.ts`), the provenance (`TicketSource`), and the
 *   crystallise pipeline (`spec-intake.ts`) are SHARED; a connector supplies ONLY the
 *   dialect (how to watch/read/write-back + how it names its spec branch/file).
 *   TRACK-4/5 are then a new `*-connector.ts` implementing this interface — no change
 *   to the shared machinery.
 *
 * SECURITY CONTRACT (every implementer MUST honour)
 *   - `pollTickets`/`readTicket` NEVER throw — a tracker outage returns `null` (skip the
 *     cycle, watermark untouched) so a degraded tracker can never crash the poll loop.
 *   - Ticket `title`/`body` are UNTRUSTED (anyone may file a ticket): the shared synth
 *     fences them before any prompt and slugifies/clamps them before any filename.
 *   - Credentials come from a secret manager / env, are NEVER logged, and are scoped to
 *     one tracker site/project (fail-closed).
 *   - `specBranchName`/`specFilePath` are SERVER-DERIVED from the validated ticket id;
 *     they must be shape-safe (no leading dash, no path separator, no `..`) and match
 *     the writer's `SPEC_BRANCH_RE`.
 */

/** A lightweight reference to a ticket (id + change cursor), from a watch/poll. */
export interface TicketRef {
  /** Tracker-native id: a GitHub issue number as a string, or a Jira key `PROJ-123`. */
  id: string;
  /** ISO timestamp of the ticket's last update (the poll watermark cursor). */
  updatedAt?: string;
  /** Canonical human URL of the ticket (for provenance + write-back links). */
  url?: string;
}

/** A ticket's read fields, normalised across trackers (what synthesis consumes). */
export interface Ticket extends TicketRef {
  /** The ticket title / summary (UNTRUSTED). */
  title: string;
  /** The ticket body / description as PLAIN TEXT (UNTRUSTED; ADF etc. flattened). */
  body: string;
  /** The ticket's labels / tags (used for the defence-in-depth consent re-check). */
  labels: string[];
}

/** Outcome of a write-back attempt — best-effort, never throws. */
export interface WritebackResult {
  posted: boolean;
  reason?: string;
}

/**
 * The write-back dialect (§4). `comment` is MANDATORY (the pickup record); `transition`
 * and `link` are OPTIONAL (a tracker without them omits them). Every method is
 * IDEMPOTENT (keyed by the caller-supplied `marker`) and best-effort.
 */
export interface TrackerWriteback {
  /** Post `body` as a ticket comment IFF no existing comment carries `marker`. */
  comment(ticketId: string, body: string, marker: string): Promise<WritebackResult>;
  /** Move the ticket to `state` (name or id). Absent on trackers without transitions. */
  transition?(ticketId: string, state: string): Promise<WritebackResult>;
  /** Attach a remote link (e.g. the spec/PR URL). Absent on trackers without links. */
  link?(ticketId: string, url: string, title?: string): Promise<WritebackResult>;
}

/**
 * A tracker connector: watch + read + write-back + naming, per §2. Implemented once
 * per tracker (`github-connector.ts`, `jira-connector.ts`, …); the shared poller +
 * `crystallizeTicket` drive it.
 */
export interface TrackerConnector {
  /** The connector's provenance kind ("github" | "jira" | …) — the spec's `source.kind`. */
  readonly kind: string;
  /**
   * WATCH: return the tickets matching the connector's filter that changed since
   * `sinceWatermark` (ISO), already normalised. `null` ⇒ the tracker is degraded
   * (outage / auth) — the poller SKIPS the cycle without touching its watermark.
   */
  pollTickets(sinceWatermark?: string): Promise<Ticket[] | null>;
  /** READ: fetch one ticket's fields by id. `null` ⇒ not found / degraded. */
  readTicket(ticketId: string): Promise<Ticket | null>;
  /** WRITE-BACK dialect. */
  readonly writeback: TrackerWriteback;
  /** The deterministic dedup spec branch for a ticket (matches `SPEC_BRANCH_RE`). */
  specBranchName(ticketId: string): string;
  /** The committed spec file path for a ticket (`docs/specs/<connector>-<id>-<slug>.md`). */
  specFilePath(ticketId: string, title: string): string;
}

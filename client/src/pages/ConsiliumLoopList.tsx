/**
 * ConsiliumLoopList — the caller's consilium loops (design §7), rendered as an
 * ITERATION/ROUND LINEAGE TREE (YAML-style nesting) instead of the prior flat
 * status/grouping pile. We keep one SECTION per workspace (header = workspace
 * name + loop count, most-active workspace first), but inside a section each
 * LOOP is a PARENT node and its ROUNDS nest beneath it, indented with a tree
 * connector (border-left). Round 1 sits on top; later rounds — the inherited
 * re-reviews — follow under the same parent.
 *
 * WHERE THE ROUNDS COME FROM: the LIST endpoint (`GET /api/consilium-loops`)
 * returns loop rows WITHOUT a `rounds[]` array. Only the DETAIL endpoint
 * (`GET /api/consilium-loops/:id`) returns `rounds`. So each loop that HAS at
 * least one round renders as a COLLAPSIBLE parent that fetches its rounds ON
 * EXPAND via the existing `useConsiliumLoop(id)` hook (id-gated `enabled`, so a
 * collapsed loop fetches nothing). Active (non-terminal) loops default expanded;
 * terminal loops default collapsed.
 *
 * CHEVRON GATING: a loop with no round yet (the list row's own `loop.round < 1`)
 * shows NO expander and is not expandable — there is nothing to nest. Only when
 * `loop.round >= 1` do we render the chevron and lazy-fetch. If a fetch then
 * returns an empty rounds array anyway, we render an INERT "No rounds recorded
 * yet" line rather than an interactive expander.
 *
 * We render only fields the endpoints actually return — `round`, `maxRounds`,
 * `state`, `openP0`, `prRef`, and per-round `round`/`converged`/`openP0`/
 * `openActionPoints`/`createdAt`. Nothing invented.
 *
 * P4 — the workspace name is a human label. Loops only carry `repoPath` (no
 * workspaceId), so we fetch the workspaces list (shared `useWorkspaces`, which
 * attaches `x-project-id`) and resolve each loop's workspace NAME via
 * `resolveWorkspaceName` (match by `path`, falling back to the repo basename).
 * Sections + the top filter bar are keyed by that resolved workspace name; the
 * bar narrows the tree to a single workspace. The first workspace's path also
 * seeds the New-review dialog.
 *
 * SECURITY: loop-derived text (repoPath, prRef) and the workspace name are
 * rendered as INERT React text; the PR link uses rel="noopener noreferrer".
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  Repeat,
  ExternalLink,
  Loader2,
  ChevronRight,
  ChevronDown,
  CheckCircle2,
} from "lucide-react";
import {
  useConsiliumLoops,
  useConsiliumLoop,
  isTerminalLoopState,
  type ConsiliumLoopListItem,
  type ConsiliumLoopRoundRow,
} from "@/hooks/use-consilium-loops";
import { LoopStateChipFor } from "@/components/consilium/loop-state";
import { NewConsiliumReviewDialog } from "@/components/consilium/new-review-dialog";
import { useWorkspaces } from "@/hooks/use-workspaces";
import { resolveWorkspaceName } from "@/lib/workspace-name";

/** Relative "2h ago" label; empty string for missing/unparseable timestamps. */
function whenLabel(ts: string | Date | null | undefined): string {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

/** Recency epoch-ms for ordering: prefer updatedAt, fall back to createdAt. */
function recencyOf(loop: ConsiliumLoopListItem): number {
  const t = new Date(loop.updatedAt ?? loop.createdAt).getTime();
  return Number.isFinite(t) ? t : 0;
}

function OpenP0({ openP0 }: { openP0: number | null | undefined }) {
  if (openP0 == null) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={`tabular-nums font-medium ${
        openP0 > 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"
      }`}
    >
      {openP0}
    </span>
  );
}

type LoopGroup = {
  name: string;
  loops: ConsiliumLoopListItem[];
  recency: number;
};

// ─── Per-round leaf (the inherited re-review signal) ──────────────────────────

/**
 * One round line in the lineage tree: round #, verdict signal, relative time.
 * Clickable — navigates to the SAME loop detail as the parent row (the detail
 * page is per-loop; we pass the round as a `#round-N` hash so a future anchor
 * can deep-link, but plain navigation to the loop is the contract).
 */
function RoundLine({
  round,
  loopId,
}: {
  round: ConsiliumLoopRoundRow;
  loopId: string;
}) {
  const [, navigate] = useLocation();
  const apCount = round.openActionPoints?.length ?? null;
  return (
    <li
      data-testid="consilium-round"
      role="button"
      tabIndex={0}
      className="flex items-center gap-2 text-xs py-0.5 px-1 -mx-1 rounded cursor-pointer hover:bg-muted/50"
      onClick={() => navigate(`/consilium-loops/${loopId}#round-${round.round}`)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate(`/consilium-loops/${loopId}#round-${round.round}`);
        }
      }}
    >
      <span className="font-medium tabular-nums shrink-0">Round {round.round}</span>
      {/* Verdict signal — converged mark, else the open-P0 count (+ AP count). */}
      {round.converged ? (
        <span className="inline-flex items-center gap-1 text-green-600 dark:text-green-400">
          <CheckCircle2 className="h-3 w-3" />
          converged
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-muted-foreground">
          P0 <OpenP0 openP0={round.openP0} />
          {apCount != null && apCount > 0 && <span>· {apCount} AP</span>}
        </span>
      )}
      <span
        className="ml-auto text-muted-foreground whitespace-nowrap"
        title={new Date(round.createdAt).toLocaleString()}
      >
        {whenLabel(round.createdAt)}
      </span>
    </li>
  );
}

// ─── Loop parent node (collapsible; rounds fetched on expand) ──────────────────

function LoopNode({ loop }: { loop: ConsiliumLoopListItem }) {
  const [, navigate] = useLocation();
  const terminal = isTerminalLoopState(loop.state);
  // CHEVRON GATING — the loop's own `round` field is the cheap signal we already
  // have on the list row: round < 1 means no round has started, so there is
  // nothing to nest and we render no expander at all.
  const hasRounds = loop.round >= 1;
  // Active loops default expanded (you want to watch them); terminal collapsed.
  // A loop with no rounds is never expanded.
  const [expanded, setExpanded] = useState(hasRounds && !terminal);

  // Rounds live only on the DETAIL endpoint — fetch them ONLY while expanded
  // (the hook is `enabled: !!id`, so an `undefined` id makes it a no-op). A
  // round-less loop never expands, so it never fetches.
  const { data: detail, isLoading } = useConsiliumLoop(expanded ? loop.id : undefined);
  // Round 1 on top — sort ascending; the endpoint order isn't guaranteed.
  const rounds = [...(detail?.rounds ?? [])].sort((a, b) => a.round - b.round);

  return (
    <div data-testid="consilium-loop-node" className="rounded-md border bg-card">
      {/* Parent row — clicking it opens the loop detail; the chevron toggles. */}
      <div
        className="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-muted/40 rounded-md"
        onClick={() => navigate(`/consilium-loops/${loop.id}`)}
      >
        {hasRounds ? (
          <button
            type="button"
            aria-label={expanded ? "Collapse rounds" : "Expand rounds"}
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation();
              setExpanded((v) => !v);
            }}
          >
            {expanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          // No rounds yet → no expander. Keep the row's left edge aligned with
          // the chevron'd rows (same 1rem slot) so the columns stay tidy.
          <span className="shrink-0 w-4" aria-hidden="true" />
        )}

        {/* Round n/maxRounds — the primary disambiguator between same-workspace loops. */}
        <span className="font-semibold tabular-nums text-sm shrink-0 w-12">
          {loop.round}/{loop.maxRounds}
        </span>

        <LoopStateChipFor loop={loop} />

        {/* Short loop id — second identity anchor; full repoPath in the tooltip. */}
        <span
          className="font-mono text-[11px] text-muted-foreground"
          title={loop.repoPath}
        >
          {loop.id.slice(0, 8)}
        </span>

        <div className="ml-auto flex items-center gap-4 text-xs">
          <span className="text-muted-foreground">
            P0 <OpenP0 openP0={loop.openP0} />
          </span>
          {loop.prRef ? (
            <a
              href={loop.prRef}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              <ExternalLink className="h-3 w-3" />
              PR
            </a>
          ) : null}
          <span
            className="text-muted-foreground whitespace-nowrap"
            title={new Date(loop.updatedAt ?? loop.createdAt).toLocaleString()}
          >
            {whenLabel(loop.updatedAt ?? loop.createdAt)}
          </span>
        </div>
      </div>

      {/* Nested rounds — YAML-style indentation with a border-left connector.
          Only rendered for a loop that actually has rounds AND is expanded. */}
      {hasRounds && expanded && (
        <div className="border-t border-border px-3 py-2">
          <ol className="ml-5 border-l border-border/70 pl-4 space-y-0.5">
            {isLoading && rounds.length === 0 && (
              <li className="flex items-center gap-2 text-xs text-muted-foreground py-0.5">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading rounds…
              </li>
            )}
            {!isLoading && rounds.length === 0 && (
              // Inert line — the loop claims a round but the detail returned none.
              <li className="text-xs text-muted-foreground py-0.5">
                No rounds recorded yet
              </li>
            )}
            {rounds.map((r) => (
              <RoundLine key={r.id} round={r} loopId={loop.id} />
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

// ─── Workspace filter bar ─────────────────────────────────────────────────────

/**
 * Horizontal chips — "All" + one per workspace that has loops. Clicking a chip
 * narrows the tree to that workspace; clicking the active chip (or "All") clears
 * it. Purely local state; the lineage tree renders unchanged inside the filter.
 */
function WorkspaceFilterBar({
  names,
  active,
  onSelect,
}: {
  names: string[];
  active: string | null;
  onSelect: (name: string | null) => void;
}) {
  if (names.length <= 1) return null; // nothing to filter with a single workspace
  const chip = (selected: boolean) =>
    `text-xs px-2.5 py-1 rounded-full border transition-colors ${
      selected
        ? "bg-primary text-primary-foreground border-primary"
        : "bg-background text-muted-foreground border-border hover:bg-muted"
    }`;
  return (
    <div
      data-testid="consilium-workspace-filter"
      className="flex flex-wrap items-center gap-2 mb-4"
    >
      <button
        type="button"
        className={chip(active === null)}
        onClick={() => onSelect(null)}
      >
        All
      </button>
      {names.map((name) => (
        <button
          key={name}
          type="button"
          className={chip(active === name)}
          title={name}
          // Toggle: clicking the active chip clears the filter.
          onClick={() => onSelect(active === name ? null : name)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

export default function ConsiliumLoopList() {
  const { data, isLoading } = useConsiliumLoops();
  const { data: workspaceData } = useWorkspaces();
  const loops = (Array.isArray(data) ? data : []) as ConsiliumLoopListItem[];

  // Active workspace filter (by resolved name); null = show all.
  const [activeWorkspace, setActiveWorkspace] = useState<string | null>(null);

  // Loop sections + filter chips are keyed by the loop's WORKSPACE NAME, resolved
  // from its repoPath against the project's workspaces (fallback: the repo
  // basename when no workspace row matches). This is the label the operator named
  // and recognizes — see resolveWorkspaceName.
  const workspaceName = (repoPath: string): string =>
    resolveWorkspaceName(repoPath, workspaceData);

  // Hand the New-review dialog the project.s workspaces so the user PICKS a repo
  // (dropdown) instead of free-typing a possibly-unallowlisted path.
  const workspaceOptions = Array.isArray(workspaceData) ? workspaceData : [];

  // Group loops by resolved workspace name. Within a group: most-recent first.
  // Group order: the workspace with the most recently active loop floats up.
  const byWorkspace = new Map<string, ConsiliumLoopListItem[]>();
  for (const loop of loops) {
    const name = workspaceName(loop.repoPath);
    const arr = byWorkspace.get(name);
    if (arr) arr.push(loop);
    else byWorkspace.set(name, [loop]);
  }
  const allGroups: LoopGroup[] = Array.from(byWorkspace.entries())
    .map(([name, ls]) => {
      const sorted = [...ls].sort((a, b) => recencyOf(b) - recencyOf(a));
      return { name, loops: sorted, recency: sorted.length ? recencyOf(sorted[0]) : 0 };
    })
    .sort((a, b) => b.recency - a.recency);

  // Filter-bar chips reflect the full set; the rendered tree is narrowed. If the
  // active workspace vanished (e.g. its last loop settled away), fall back to All.
  const workspaceNames = allGroups.map((g) => g.name);
  const filterActive =
    activeWorkspace && workspaceNames.includes(activeWorkspace) ? activeWorkspace : null;
  const groups = filterActive
    ? allGroups.filter((g) => g.name === filterActive)
    : allGroups;

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="h-16 border-b border-border flex items-center gap-2 px-6 shrink-0">
        <Repeat className="h-5 w-5 text-primary" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">Consilium Loops</h1>
          <p className="text-[11px] text-muted-foreground">
            Auto-versioned review → DEV → Draft PR → merge loops
          </p>
        </div>
        <div className="ml-auto">
          <NewConsiliumReviewDialog workspaces={workspaceOptions} />
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!isLoading && loops.length === 0 && (
          <div className="rounded-lg border border-dashed border-border py-16 text-center">
            <Repeat className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">No consilium loops yet</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Start one with “New consilium review”, against an allowlisted repo.
            </p>
          </div>
        )}

        {!isLoading && allGroups.length > 0 && (
          <>
            <WorkspaceFilterBar
              names={workspaceNames}
              active={filterActive}
              onSelect={setActiveWorkspace}
            />
            <div className="space-y-6">
              {groups.map((group) => (
                <section key={group.name} data-testid="consilium-loop-group">
                  {/* Workspace header — groups many same-target loops so focus
                      isn't lost. Full repoPath of the freshest loop in tooltip. */}
                  <div className="flex items-baseline gap-2 mb-2 px-1">
                    <h2
                      className="text-sm font-semibold truncate"
                      title={group.loops[0]?.repoPath}
                    >
                      {group.name}
                    </h2>
                    <span className="text-[11px] text-muted-foreground shrink-0">
                      {group.loops.length} {group.loops.length === 1 ? "loop" : "loops"}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {group.loops.map((loop) => (
                      <LoopNode key={loop.id} loop={loop} />
                    ))}
                  </div>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

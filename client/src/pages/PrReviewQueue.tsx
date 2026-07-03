/**
 * PrReviewQueue — "what Draft PR is waiting for my review, and which are duplicate
 * runs?". Lists the PR-bearing consilium loops (server route GET /api/pr-queue),
 * GROUPED BY REPO into duplicate clusters via the pure `clusterPrQueue` helper.
 *
 * Each repo with >1 open loop-PR is a DUPLICATE CLUSTER: the loops are shown
 * together, newest first, badged "N open PRs for this repo — newest is likely
 * current". Older loop-PRs on the same repo get a "superseded?" hint (candidates
 * to close). We NEVER auto-close anything — we surface + link. "Mark handled" is
 * LOCAL UI state (a dismissed set in this component); it hides an item from the
 * current view only and resets on reload — no persistence, no schema change.
 *
 * GITHUB-RECONCILED: each item carries a server-fetched `githubStatus`
 * (OPEN/DRAFT/MERGED/CLOSED/unknown). Items whose PR is MERGED or CLOSED are moved
 * out of the active list into a collapsed "Resolved on GitHub — loop state stale"
 * section (de-emphasized, never hidden — a non-terminal loop over a done PR is itself
 * worth surfacing). Within a duplicate cluster the live-OPEN PR is elected current
 * over a newer merged/closed one. `githubStatus:"unknown"` (no auth / GitHub
 * unreachable) is treated as ACTIVE — we only demote a PR we positively know is done.
 *
 * SECURITY: every loop-derived string (repoPath, prRef, verdictSummary,
 * triggerProvenance) is rendered as INERT React text; the PR link uses
 * rel="noopener noreferrer" and the loop link is an in-app route.
 */
import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import {
  GitPullRequest,
  GitMerge,
  ExternalLink,
  Loader2,
  Layers,
  Check,
  RotateCcw,
  ChevronRight,
} from "lucide-react";
import { usePrQueue } from "@/hooks/use-pr-queue";
import {
  clusterPrQueue,
  isResolvedGithubStatus,
  type PrQueueItem,
  type PrQueueCluster,
  type GithubPrStatus,
} from "@shared/pr-queue";
import { LoopStateBadge } from "@/components/consilium/loop-state";

/** Last path segment of a repo path, for a compact heading. */
function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  return trimmed.split("/").pop() || repoPath;
}

/** Relative "2h ago"; empty string for missing/unparseable timestamps. */
function whenLabel(ts: string | null | undefined): string {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
}

/** Visual style per live GitHub PR status. `unknown`/undefined renders nothing. */
const GITHUB_STATUS_STYLE: Record<GithubPrStatus, { label: string; className: string; title: string }> = {
  OPEN: {
    label: "GitHub: open",
    className: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    title: "The PR is open on GitHub — loop state is consistent.",
  },
  DRAFT: {
    label: "GitHub: draft",
    className: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
    title: "The PR is still a Draft on GitHub.",
  },
  MERGED: {
    label: "GitHub: merged",
    className: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
    title: "The PR is already MERGED on GitHub — this loop's non-terminal state is stale.",
  },
  CLOSED: {
    label: "GitHub: closed",
    className: "border-rose-500/40 bg-rose-500/10 text-rose-600 dark:text-rose-400",
    title: "The PR was CLOSED on GitHub without merging — this loop's state is stale.",
  },
  unknown: {
    label: "GitHub: unknown",
    className: "border-border bg-muted/40 text-muted-foreground",
    title: "Live GitHub status could not be determined (no server-side auth or GitHub unreachable).",
  },
};

/** Live GitHub PR status pill. Omitted entirely for a missing status (older wire). */
function GithubStatusBadge({ status }: { status: GithubPrStatus | null | undefined }) {
  if (!status) return null;
  const s = GITHUB_STATUS_STYLE[status];
  return (
    <span
      data-testid="pr-queue-github-status"
      data-status={status}
      className={`text-[11px] px-1.5 py-0.5 rounded border ${s.className}`}
      title={s.title}
    >
      {s.label}
    </span>
  );
}

/** Compact "P1·1 P2·2" open-remainder summary; null when nothing is open. */
function remainderLabel(item: PrQueueItem): string | null {
  const r = item.openRemainder;
  if (!r || r.total <= 0) return null;
  const parts = Object.entries(r.byPriority).map(([tier, n]) => `${tier}·${n}`);
  return parts.join(" ");
}

// ─── One PR card ──────────────────────────────────────────────────────────────

function PrCard({
  item,
  superseded,
  onDismiss,
}: {
  item: PrQueueItem;
  /** True when an older loop-PR on the same repo (a close candidate). */
  superseded: boolean;
  onDismiss: (loopId: string) => void;
}) {
  const [, navigate] = useLocation();
  const remainder = remainderLabel(item);
  return (
    <div
      data-testid="pr-queue-card"
      className="rounded-md border bg-card px-3 py-2.5 space-y-2"
    >
      <div className="flex items-center gap-3 flex-wrap">
        <LoopStateBadge state={item.state} />
        <GithubStatusBadge status={item.githubStatus} />

        {/* Round n and archetype — quick disambiguators between same-repo runs. */}
        <span className="text-xs text-muted-foreground tabular-nums shrink-0">
          round {item.round}
        </span>
        {item.archetype ? (
          <span className="text-[11px] px-1.5 py-0.5 rounded border border-border text-muted-foreground">
            {item.archetype}
          </span>
        ) : null}

        {superseded ? (
          <span
            data-testid="pr-queue-superseded"
            className="text-[11px] px-1.5 py-0.5 rounded border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            title="A newer run for this repo exists — this older PR is a candidate to close."
          >
            superseded?
          </span>
        ) : null}

        <span
          className="ml-auto text-[11px] text-muted-foreground whitespace-nowrap"
          title={new Date(item.createdAt).toLocaleString()}
        >
          {whenLabel(item.updatedAt ?? item.createdAt)}
        </span>
      </div>

      {/* Verdict / test summary — inert model text, clamped to two lines. */}
      {item.verdictSummary ? (
        <p className="text-xs text-muted-foreground line-clamp-2">{item.verdictSummary}</p>
      ) : null}

      <div className="flex items-center gap-3 text-xs">
        {remainder ? (
          <span className="text-muted-foreground">
            open: <span className="tabular-nums font-medium">{remainder}</span>
          </span>
        ) : null}
        {item.triggerProvenance ? (
          <span className="text-muted-foreground truncate" title={item.triggerProvenance}>
            via {item.triggerProvenance}
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-3">
          <a
            href={item.prRef}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-primary hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            PR
          </a>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => navigate(`/consilium-loops/${item.loopId}`)}
          >
            Loop
          </button>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-muted-foreground hover:text-foreground"
            onClick={() => onDismiss(item.loopId)}
            title="Mark handled — hides this item from the queue until reload (local only)"
          >
            <Check className="h-3 w-3" />
            Mark handled
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── One repo cluster ─────────────────────────────────────────────────────────

function RepoCluster({
  cluster,
  onDismiss,
  dimmed = false,
}: {
  cluster: PrQueueCluster;
  onDismiss: (loopId: string) => void;
  /** Resolved-on-GitHub section: de-emphasize the whole cluster (stale loop state). */
  dimmed?: boolean;
}) {
  const superseded = new Set(cluster.supersededLoopIds);
  return (
    <section
      data-testid="pr-queue-cluster"
      className={dimmed ? "opacity-60" : undefined}
    >
      <div className="flex items-baseline gap-2 mb-2 px-1">
        <h2 className="text-sm font-semibold truncate" title={cluster.repoPath}>
          {repoBasename(cluster.repoPath)}
        </h2>
        {cluster.duplicate ? (
          <span
            data-testid="pr-queue-duplicate-badge"
            className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded-full border border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400 shrink-0"
            title="Multiple open Draft PRs target this repo — newer runs likely supersede older ones."
          >
            <Layers className="h-3 w-3" />
            {cluster.items.length} open PRs for this repo — newest is likely current
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground shrink-0">1 open PR</span>
        )}
      </div>
      <div className="space-y-2">
        {cluster.items.map((item) => (
          <PrCard
            key={item.loopId}
            item={item}
            superseded={superseded.has(item.loopId)}
            onDismiss={onDismiss}
          />
        ))}
      </div>
    </section>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PrReviewQueue() {
  const { data, isLoading } = usePrQueue();
  // LOCAL "mark handled" state — dismissed loopIds are hidden until reload. No
  // persistence (no migration); a lightweight, resettable operator convenience.
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const items = (Array.isArray(data) ? data : []) as PrQueueItem[];
  const visible = items.filter((i) => !dismissed.has(i.loopId));

  // Split on LIVE GitHub status: MERGED/CLOSED PRs are "resolved" — their loop is in a
  // stale non-terminal state, so they leave the active list for a collapsed section.
  // `unknown`/OPEN/DRAFT stay ACTIVE (we only demote a PR we positively know is done).
  const { activeClusters, resolvedClusters, resolvedCount } = useMemo(() => {
    const active = visible.filter((i) => !isResolvedGithubStatus(i.githubStatus));
    const resolved = visible.filter((i) => isResolvedGithubStatus(i.githubStatus));
    return {
      activeClusters: clusterPrQueue(active),
      resolvedClusters: clusterPrQueue(resolved),
      resolvedCount: resolved.length,
    };
  }, [visible]);
  const clusters = activeClusters;
  const duplicateCount = clusters.filter((c) => c.duplicate).length;

  function dismiss(loopId: string) {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(loopId);
      return next;
    });
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <header className="h-16 border-b border-border flex items-center gap-2 px-6 shrink-0">
        <GitPullRequest className="h-5 w-5 text-primary" />
        <div className="min-w-0">
          <h1 className="text-base font-semibold leading-tight">PR Review Queue</h1>
          <p className="text-[11px] text-muted-foreground">
            Draft PRs from consilium loops awaiting review · duplicate runs grouped by repo
          </p>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {dismissed.size > 0 ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setDismissed(new Set())}
              title="Restore items you marked handled this session"
            >
              <RotateCcw className="h-3 w-3" />
              Reset handled ({dismissed.size})
            </button>
          ) : null}
          {duplicateCount > 0 ? (
            <span className="text-[11px] text-amber-600 dark:text-amber-400">
              {duplicateCount} repo{duplicateCount === 1 ? "" : "s"} with duplicate runs
            </span>
          ) : null}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto p-6">
        {/* Honesty note: status is reconciled with GitHub, best-effort. */}
        <p className="text-[11px] text-muted-foreground/80 mb-4">
          Each item is reconciled with its live GitHub PR status. Merged or closed PRs
          move to the &ldquo;Resolved on GitHub&rdquo; section below (the loop state is
          stale). When GitHub can&apos;t be reached the status reads
          &ldquo;unknown&rdquo; and the item stays in the active list.
        </p>

        {isLoading && (
          <div className="flex items-center justify-center py-16 text-muted-foreground text-sm gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading…
          </div>
        )}

        {!isLoading && clusters.length === 0 && resolvedCount === 0 && (
          <div className="rounded-lg border border-dashed border-border py-16 text-center">
            <GitPullRequest className="mx-auto h-8 w-8 text-muted-foreground/50" />
            <p className="mt-3 text-sm text-muted-foreground">No Draft PRs awaiting review</p>
            <p className="mt-1 text-xs text-muted-foreground/70">
              Draft PRs opened by consilium loops appear here, grouped by repo.
            </p>
          </div>
        )}

        {!isLoading && clusters.length > 0 && (
          <div className="space-y-6">
            {clusters.map((cluster) => (
              <RepoCluster key={cluster.repoPath} cluster={cluster} onDismiss={dismiss} />
            ))}
          </div>
        )}

        {/* Resolved on GitHub — merged/closed PRs whose loop is still non-terminal.
            Collapsed by default, de-emphasized, but SURFACED (the stale state matters). */}
        {!isLoading && resolvedCount > 0 && (
          <details data-testid="pr-queue-resolved" className="mt-8 group">
            <summary className="flex items-center gap-2 cursor-pointer select-none text-xs text-muted-foreground hover:text-foreground">
              <ChevronRight className="h-3.5 w-3.5 transition-transform group-open:rotate-90" />
              <GitMerge className="h-3.5 w-3.5" />
              Already merged/closed on GitHub — loop state stale ({resolvedCount})
            </summary>
            <div className="mt-4 space-y-6">
              {resolvedClusters.map((cluster) => (
                <RepoCluster
                  key={cluster.repoPath}
                  cluster={cluster}
                  onDismiss={dismiss}
                  dimmed
                />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

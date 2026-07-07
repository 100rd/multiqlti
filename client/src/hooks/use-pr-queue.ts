/**
 * use-pr-queue.ts — react-query surface for the PR REVIEW QUEUE (GET /api/pr-queue,
 * server route in server/routes/consilium-loops.ts).
 *
 * The endpoint returns a FLAT, newest-first list of PR-bearing consilium loops
 * (loops carrying a Draft PR in a state where it's awaiting review), each reconciled
 * server-side with its LIVE GitHub PR status (`githubStatus`: OPEN/DRAFT/MERGED/
 * CLOSED/unknown — best-effort, "unknown" when GitHub is unreachable/unauthed). The
 * page clusters it by repo with the pure `clusterPrQueue` helper (@shared/pr-queue)
 * to surface DUPLICATE runs, and moves MERGED/CLOSED items to a collapsed "resolved"
 * section (the loop state is stale relative to GitHub).
 *
 * Light 5s poll so a freshly-developed loop appears without a manual refresh — the
 * loop FSM advances server-side via the background poller, there is no WS channel.
 *
 * SECURITY: this module only fetches + types data. `repoPath`, `prRef`,
 * `verdictSummary`, and `triggerProvenance` are model/human-authored strings — the
 * consuming component renders them as INERT React text and opens `prRef` with
 * rel="noopener noreferrer".
 */
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/hooks/use-api";
import type { PrQueueItem } from "@shared/pr-queue";

export type { PrQueueItem };
export type {
  PrQueueCluster,
  GithubPrStatus,
} from "@shared/pr-queue";

const PR_QUEUE_KEY = "/api/pr-queue";

/** The caller's PR-bearing loops (flat, newest first). Light 5s live-state poll. */
export function usePrQueue() {
  return useQuery<PrQueueItem[]>({
    queryKey: [PR_QUEUE_KEY],
    queryFn: () => apiRequest("GET", PR_QUEUE_KEY),
    refetchInterval: 5000,
  });
}

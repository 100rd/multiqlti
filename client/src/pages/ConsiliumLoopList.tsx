/**
 * ConsiliumLoopList — the caller's consilium loops (design §7). One row per loop:
 * state pill, round n/maxRounds, repo basename, open P0, a Draft-PR link when set,
 * and a relative updated-time. Clicking a row opens its detail at
 * /consilium-loops/:id. The list polls lightly (5s) for live state.
 *
 * SECURITY: loop-derived text (repoPath, prRef) is rendered as INERT React text;
 * the PR link uses rel="noopener noreferrer".
 */
import { useLocation } from "wouter";
import { formatDistanceToNow } from "date-fns";
import { Repeat, ExternalLink, Loader2 } from "lucide-react";
import {
  useConsiliumLoops,
  type ConsiliumLoopListItem,
} from "@/hooks/use-consilium-loops";
import { LoopStateChip } from "@/components/consilium/loop-state";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/** Last path segment of an allowlisted repo path, for a compact display. */
function repoBasename(repoPath: string): string {
  const trimmed = repoPath.replace(/\/+$/, "");
  const seg = trimmed.split("/").pop();
  return seg || repoPath;
}

function whenLabel(ts: string | Date | null | undefined): string {
  if (!ts) return "";
  try {
    return formatDistanceToNow(new Date(ts), { addSuffix: true });
  } catch {
    return "";
  }
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

export default function ConsiliumLoopList() {
  const [, navigate] = useLocation();
  const { data, isLoading } = useConsiliumLoops();
  const loops = (Array.isArray(data) ? data : []) as ConsiliumLoopListItem[];

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
              Loops are created via the API against an allowlisted repo.
            </p>
          </div>
        )}

        {!isLoading && loops.length > 0 && (
          <div className="rounded-md border overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>State</TableHead>
                  <TableHead>Round</TableHead>
                  <TableHead>Repo</TableHead>
                  <TableHead>Open P0</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loops.map((loop) => (
                  <TableRow
                    key={loop.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/consilium-loops/${loop.id}`)}
                  >
                    <TableCell>
                      <LoopStateChip state={loop.state} />
                    </TableCell>
                    <TableCell className="tabular-nums">
                      {loop.round}/{loop.maxRounds}
                    </TableCell>
                    <TableCell
                      className="font-mono text-xs max-w-[16rem] truncate"
                      title={loop.repoPath}
                    >
                      {repoBasename(loop.repoPath)}
                    </TableCell>
                    <TableCell>
                      <OpenP0 openP0={loop.openP0} />
                    </TableCell>
                    <TableCell>
                      {loop.prRef ? (
                        <a
                          href={loop.prRef}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center gap-1 text-primary hover:underline text-xs"
                        >
                          <ExternalLink className="h-3 w-3" />
                          PR
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {whenLabel(loop.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </div>
    </div>
  );
}

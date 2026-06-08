/**
 * Review queue — the key human gate. Lists cards in reviewState='pending_review'
 * and offers Accept / Reject. Accept can pick currently-active cards to supersede.
 *
 * Only workspace owners and admins may act (mirrors the backend
 * requireOwnerOrRole(ownerId, "admin") gate). For everyone else the actions are
 * disabled and a notice explains why — the server remains the source of truth.
 */
import { useMemo, useState } from "react";
import { CheckCircle2, XCircle, Lock, Inbox } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import {
  usePracticeCards,
  useReviewPracticeCard,
  type PracticeCard,
} from "@/hooks/use-practice-cards";
import {
  pendingReviewCards,
  supersedeCandidates,
  canReview,
} from "@/lib/practice-cards";
import { CardDetail } from "./CardDetail";
import {
  CardListSkeleton,
  QueryError,
  EmptyState,
  errorMessage,
} from "./QueryStates";
import type { User } from "@shared/types";

interface ReviewQueueProps {
  workspaceId: string;
  user: User | null;
  workspaceOwnerId: string | null | undefined;
}

export function ReviewQueue({
  workspaceId,
  user,
  workspaceOwnerId,
}: ReviewQueueProps) {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = usePracticeCards(
    workspaceId,
    { reviewState: "pending_review", limit: 200 },
  );
  const review = useReviewPracticeCard(workspaceId);

  const allowed = canReview(user, workspaceOwnerId);
  const queue = useMemo(
    () => (data ? pendingReviewCards(data.cards) : []),
    [data],
  );
  const allCards = data?.cards ?? [];

  const [supersedeFor, setSupersedeFor] = useState<PracticeCard | null>(null);

  function handleReject(card: PracticeCard) {
    review.mutate(
      { cardId: card.id, decision: "reject" },
      {
        onSuccess: () =>
          toast({ title: "Card rejected", description: card.statement }),
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Reject failed",
            description: errorMessage(err),
          }),
      },
    );
  }

  function handleAccept(card: PracticeCard, supersedes: string[]) {
    review.mutate(
      {
        cardId: card.id,
        decision: "accept",
        supersedes: supersedes.length ? supersedes : undefined,
      },
      {
        onSuccess: () => {
          toast({ title: "Card accepted", description: card.statement });
          setSupersedeFor(null);
        },
        onError: (err) =>
          toast({
            variant: "destructive",
            title: "Accept failed",
            description: errorMessage(err),
          }),
      },
    );
  }

  return (
    <div className="space-y-4" data-testid="review-queue">
      {!allowed && (
        <div
          className="flex items-center gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm text-amber-600"
          role="note"
          data-testid="review-readonly-notice"
        >
          <Lock className="h-4 w-4 shrink-0" />
          <span>
            Reviewing requires workspace owner or admin access. You can browse the
            queue but cannot accept or reject cards.
          </span>
        </div>
      )}

      {isLoading ? (
        <CardListSkeleton rows={2} />
      ) : isError ? (
        <QueryError message={errorMessage(error)} onRetry={() => refetch()} />
      ) : queue.length === 0 ? (
        <EmptyState
          icon={<Inbox className="h-10 w-10" />}
          title="Review queue is empty"
          description="Cards land here once a different actor has verified them. Nothing is awaiting your decision."
        />
      ) : (
        <ul className="space-y-4">
          {queue.map((card) => (
            <li
              key={card.id}
              className="rounded-lg border border-border p-4"
              data-testid="review-queue-item"
              data-card-id={card.id}
            >
              <CardDetail card={card} />
              <Separator className="my-4" />
              <div className="flex items-center justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={!allowed || review.isPending}
                  onClick={() => handleReject(card)}
                  data-testid="review-reject"
                  className="text-destructive hover:text-destructive"
                >
                  <XCircle className="mr-2 h-4 w-4" />
                  Reject
                </Button>
                <Button
                  size="sm"
                  disabled={!allowed || review.isPending}
                  onClick={() => setSupersedeFor(card)}
                  data-testid="review-accept"
                >
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                  Accept
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <AcceptDialog
        card={supersedeFor}
        candidates={
          supersedeFor ? supersedeCandidates(allCards, supersedeFor) : []
        }
        pending={review.isPending}
        onCancel={() => setSupersedeFor(null)}
        onConfirm={handleAccept}
      />
    </div>
  );
}

// ─── Accept dialog with supersede picker ──────────────────────────────────────

function AcceptDialog({
  card,
  candidates,
  pending,
  onCancel,
  onConfirm,
}: {
  card: PracticeCard | null;
  candidates: PracticeCard[];
  pending: boolean;
  onCancel: () => void;
  onConfirm: (card: PracticeCard, supersedes: string[]) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  }

  // Reset selection whenever the dialog opens for a new card.
  const openKey = card?.id ?? null;
  const [lastKey, setLastKey] = useState<string | null>(null);
  if (openKey !== lastKey) {
    setLastKey(openKey);
    setSelected([]);
  }

  return (
    <Dialog open={!!card} onOpenChange={(open) => !open && onCancel()}>
      <DialogContent data-testid="accept-dialog">
        <DialogHeader>
          <DialogTitle>Accept practice card</DialogTitle>
          <DialogDescription>
            Accepting sets this card to active. Optionally select existing active
            cards it should supersede — those will be marked superseded.
          </DialogDescription>
        </DialogHeader>

        {candidates.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No active cards on this topic to supersede.
          </p>
        ) : (
          <ul
            className="max-h-64 space-y-2 overflow-y-auto"
            data-testid="supersede-candidates"
          >
            {candidates.map((c) => (
              <li key={c.id}>
                <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 hover:border-primary/50 transition-colors">
                  <Checkbox
                    checked={selected.includes(c.id)}
                    onCheckedChange={() => toggle(c.id)}
                    aria-label={`Supersede card ${c.statement}`}
                    data-testid="supersede-checkbox"
                  />
                  <span className="text-sm leading-snug">{c.statement}</span>
                </label>
              </li>
            ))}
          </ul>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={() => card && onConfirm(card, selected)}
            disabled={pending || !card}
            data-testid="accept-confirm"
          >
            {pending ? "Accepting…" : "Confirm accept"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

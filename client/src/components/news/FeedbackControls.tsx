/**
 * Per-item feedback controls: mark read, thumbs up, thumbs down, hide.
 *
 * Each action calls the feedback mutation (POST /news/items/:id/feedback). The
 * mutation invalidates the brief query on success so the item's new state is
 * reflected; errors surface a toast (never silently swallowed). Active feedback
 * is reflected in the button pressed-state for clear designed affordances.
 */
import { Check, ThumbsUp, ThumbsDown, EyeOff } from "lucide-react";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  useNewsFeedback,
  type NewsItem,
  type FeedbackAction,
} from "@/hooks/use-news";
import { errorMessage } from "./QueryStates";

interface FeedbackControlsProps {
  workspaceId: string;
  item: NewsItem;
}

export function FeedbackControls({ workspaceId, item }: FeedbackControlsProps) {
  const { toast } = useToast();
  const feedback = useNewsFeedback(workspaceId);

  function send(action: FeedbackAction, label: string) {
    feedback.mutate(
      { itemId: item.id, action },
      {
        onError: (err) =>
          toast({
            variant: "destructive",
            title: `Couldn't ${label}`,
            description: errorMessage(err),
          }),
      },
    );
  }

  const isRead = item.readState === "read";
  const upActive = item.feedback === "up";
  const downActive = item.feedback === "down";
  const pending = feedback.isPending;

  return (
    <div
      className="flex items-center gap-1"
      role="group"
      aria-label="Item feedback"
      data-testid="feedback-controls"
    >
      <ControlButton
        testId="feedback-read"
        label={isRead ? "Read" : "Mark read"}
        active={isRead}
        pending={pending}
        onClick={() => send("read", "mark read")}
        icon={<Check className="h-3.5 w-3.5" />}
        activeClass="text-emerald-600"
      />
      <ControlButton
        testId="feedback-up"
        label="Helpful"
        active={upActive}
        pending={pending}
        onClick={() => send("up", "rate up")}
        icon={<ThumbsUp className="h-3.5 w-3.5" />}
        activeClass="text-emerald-600"
      />
      <ControlButton
        testId="feedback-down"
        label="Not helpful"
        active={downActive}
        pending={pending}
        onClick={() => send("down", "rate down")}
        icon={<ThumbsDown className="h-3.5 w-3.5" />}
        activeClass="text-amber-600"
      />
      <ControlButton
        testId="feedback-hide"
        label="Hide"
        active={item.feedback === "hidden"}
        pending={pending}
        onClick={() => send("hidden", "hide")}
        icon={<EyeOff className="h-3.5 w-3.5" />}
        activeClass="text-destructive"
      />
    </div>
  );
}

function ControlButton({
  testId,
  label,
  active,
  pending,
  onClick,
  icon,
  activeClass,
}: {
  testId: string;
  label: string;
  active: boolean;
  pending: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  activeClass: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      aria-pressed={active}
      aria-label={label}
      title={label}
      data-testid={testId}
      data-active={active ? "true" : "false"}
      className={cn(
        "flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        active ? activeClass : "text-muted-foreground",
      )}
    >
      {icon}
    </button>
  );
}

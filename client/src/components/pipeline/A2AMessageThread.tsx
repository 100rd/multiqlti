/**
 * A2A inter-stage message thread display for trace/run UI (issue #269).
 *
 * Shows clarify/answer/timeout events in a timeline thread on a stage card.
 */
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { MessageSquare, MessageSquareReply, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import type { A2AThreadEntry } from "@shared/types";

// ─── Props ────────────────────────────────────────────────────────────────────

export interface A2AMessageThreadProps {
  entries: A2AThreadEntry[];
  currentStageId?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// ─── Component ────────────────────────────────────────────────────────────────

export function A2AMessageThread({ entries, currentStageId }: A2AMessageThreadProps) {
  if (entries.length === 0) return null;

  return (
    <div className="mt-2 flex flex-col gap-1" data-testid="a2a-message-thread">
      <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
        A2A Messages
      </h4>
      <ScrollArea className="max-h-48">
        <ul className="flex flex-col gap-1">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-start gap-2 rounded-md border bg-muted/30 p-2">
              {/* Icon */}
              <div className="mt-0.5 shrink-0">
                {entry.type === "clarify" && (
                  <MessageSquare className="h-3.5 w-3.5 text-blue-500" aria-hidden />
                )}
                {entry.type === "answer" && (
                  <MessageSquareReply className="h-3.5 w-3.5 text-emerald-500" aria-hidden />
                )}
                {entry.type === "timeout" && (
                  <Clock className="h-3.5 w-3.5 text-amber-500" aria-hidden />
                )}
              </div>

              {/* Content */}
              <div className="min-w-0 flex-1">
                {/* Header */}
                <div className="flex items-center gap-1.5 flex-wrap">
                  <TypeBadge type={entry.type} />
                  <span className="text-xs text-muted-foreground">
                    {entry.fromStageId}
                    {entry.type !== "timeout" && (
                      <>
                        {" "}
                        <span className="opacity-60">→</span> {entry.targetStageId}
                      </>
                    )}
                  </span>
                  {currentStageId && (
                    entry.fromStageId === currentStageId || entry.targetStageId === currentStageId
                  ) && (
                    <Badge variant="outline" className="text-xs py-0 h-4">
                      this stage
                    </Badge>
                  )}
                  <span className="ml-auto text-xs text-muted-foreground opacity-60">
                    {formatTime(entry.timestamp)}
                  </span>
                </div>

                {/* Message */}
                <p
                  className={cn(
                    "mt-0.5 text-xs break-words",
                    entry.type === "timeout" && "italic text-amber-700",
                  )}
                >
                  {entry.content}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </ScrollArea>
    </div>
  );
}

// ─── TypeBadge ────────────────────────────────────────────────────────────────

function TypeBadge({ type }: { type: A2AThreadEntry["type"] }) {
  if (type === "clarify") {
    return (
      <Badge variant="secondary" className="text-xs py-0 h-4 bg-blue-100 text-blue-700 border-blue-200">
        clarify
      </Badge>
    );
  }
  if (type === "answer") {
    return (
      <Badge variant="secondary" className="text-xs py-0 h-4 bg-emerald-100 text-emerald-700 border-emerald-200">
        answer
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs py-0 h-4 bg-amber-100 text-amber-700 border-amber-200">
      timeout
    </Badge>
  );
}

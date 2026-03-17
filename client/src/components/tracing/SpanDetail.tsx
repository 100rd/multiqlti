import type { TraceSpan } from "@shared/types";
import { Badge } from "@/components/ui/badge";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";

interface SpanDetailProps {
  span: TraceSpan | null;
  onClose: () => void;
}

export function SpanDetail({ span, onClose }: SpanDetailProps) {
  if (!span) return null;

  const sortedEvents = [...span.events].sort((a, b) => a.timestamp - b.timestamp);

  return (
    <div className="text-xs space-y-4">
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-semibold font-mono break-all">{span.name}</h3>
        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0" onClick={onClose}>
          <X className="h-3 w-3" />
        </Button>
      </div>

      {/* Status + duration */}
      <div className="flex items-center gap-2">
        <Badge variant={span.status === "ok" ? "default" : "destructive"} className="text-[10px]">
          {span.status}
        </Badge>
        <span className="text-muted-foreground">{span.endTime - span.startTime}ms</span>
      </div>

      {/* Span ID */}
      <div>
        <p className="text-muted-foreground mb-0.5">Span ID</p>
        <p className="font-mono break-all">{span.spanId}</p>
      </div>

      {span.parentSpanId && (
        <div>
          <p className="text-muted-foreground mb-0.5">Parent Span ID</p>
          <p className="font-mono break-all">{span.parentSpanId}</p>
        </div>
      )}

      {/* Timing */}
      <div>
        <p className="text-muted-foreground mb-0.5">Start</p>
        <p className="font-mono">{new Date(span.startTime).toISOString()}</p>
      </div>
      <div>
        <p className="text-muted-foreground mb-0.5">End</p>
        <p className="font-mono">{new Date(span.endTime).toISOString()}</p>
      </div>

      {/* Attributes */}
      {Object.keys(span.attributes).length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1 font-medium">Attributes</p>
          <table className="w-full">
            <tbody>
              {Object.entries(span.attributes).map(([key, value]) => (
                <tr key={key} className="border-b border-border last:border-0">
                  <td className="py-0.5 pr-2 text-muted-foreground font-mono align-top">{key}</td>
                  <td className="py-0.5 font-mono break-all">{String(value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Events */}
      {sortedEvents.length > 0 && (
        <div>
          <p className="text-muted-foreground mb-1 font-medium">Events</p>
          <div className="space-y-1">
            {sortedEvents.map((event, i) => (
              <div key={i} className="flex items-start gap-2 border-b border-border last:border-0 py-0.5">
                <span className="text-muted-foreground shrink-0">+{event.timestamp - span.startTime}ms</span>
                <span className="font-mono">{event.name}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

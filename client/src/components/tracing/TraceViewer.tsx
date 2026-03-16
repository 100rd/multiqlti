import type { PipelineTrace, TraceSpan } from "@shared/types";

interface TraceViewerProps {
  trace: PipelineTrace;
  onSpanSelect: (span: TraceSpan | null) => void;
  selectedSpanId?: string;
}

const STAGE_NAMES = new Set([
  "planning", "architecture", "development", "testing",
  "code_review", "deployment", "monitoring", "fact_check",
]);

function getSpanColor(name: string): string {
  if (STAGE_NAMES.has(name)) return "bg-blue-500";
  if (name.startsWith("gateway.")) return "bg-purple-500";
  if (name.startsWith("tool.")) return "bg-green-500";
  if (name.startsWith("strategy.")) return "bg-orange-500";
  if (name.startsWith("delegation.")) return "bg-yellow-500";
  return "bg-gray-400";
}

function getDepth(span: TraceSpan, spans: TraceSpan[]): number {
  let depth = 0;
  let current = span;
  while (current.parentSpanId) {
    const parent = spans.find((s) => s.spanId === current.parentSpanId);
    if (!parent) break;
    depth++;
    current = parent;
  }
  return depth;
}

export function TraceViewer({ trace, onSpanSelect, selectedSpanId }: TraceViewerProps) {
  const sorted = [...trace.spans].sort((a, b) => a.startTime - b.startTime);

  const traceStart = sorted.length > 0 ? sorted[0].startTime : 0;
  const traceEnd = sorted.length > 0
    ? Math.max(...sorted.map((s) => s.endTime || s.startTime))
    : 0;
  const totalDuration = Math.max(traceEnd - traceStart, 1);

  const timeMarkers = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    pct,
    label: pct === 0 ? "0ms" : pct === 1 ? `${totalDuration}ms` : `${Math.round(totalDuration * pct)}ms`,
  }));

  return (
    <div className="font-mono text-xs select-none">
      {/* Timeline header */}
      <div className="flex items-center mb-1">
        <div className="w-48 shrink-0" />
        <div className="flex-1 relative h-5">
          {timeMarkers.map(({ pct, label }) => (
            <span
              key={pct}
              className="absolute text-muted-foreground text-[10px] -translate-x-1/2"
              style={{ left: `${pct * 100}%` }}
            >
              {label}
            </span>
          ))}
        </div>
        <div className="w-20 shrink-0" />
      </div>

      {/* Divider */}
      <div className="flex items-center mb-1">
        <div className="w-48 shrink-0" />
        <div className="flex-1 h-px bg-border relative">
          {timeMarkers.map(({ pct }) => (
            <div
              key={pct}
              className="absolute top-0 w-px h-2 bg-border -translate-x-1/2"
              style={{ left: `${pct * 100}%` }}
            />
          ))}
        </div>
        <div className="w-20 shrink-0" />
      </div>

      {/* Span rows */}
      {sorted.map((span) => {
        const depth = getDepth(span, sorted);
        const spanStart = span.startTime - traceStart;
        const spanEnd = (span.endTime || span.startTime) - traceStart;
        const leftPct = (spanStart / totalDuration) * 100;
        const widthPct = Math.max(((spanEnd - spanStart) / totalDuration) * 100, 0.5);
        const duration = (span.endTime || span.startTime) - span.startTime;
        const color = getSpanColor(span.name);
        const isSelected = span.spanId === selectedSpanId;

        return (
          <div
            key={span.spanId}
            className="flex items-center h-7 hover:bg-muted/50 cursor-pointer rounded"
            style={{ paddingLeft: `${depth * 16}px` }}
            onClick={() => onSpanSelect(span)}
          >
            {/* Label */}
            <div className="w-48 shrink-0 pr-2 truncate text-foreground" title={span.name}>
              {span.name}
            </div>

            {/* Waterfall bar */}
            <div className="flex-1 relative h-4">
              <div
                className={`absolute h-full rounded-sm ${color} ${isSelected ? "ring-2 ring-primary" : ""}`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            </div>

            {/* Duration */}
            <div className="w-20 shrink-0 text-right text-muted-foreground pl-2">
              {duration}ms
            </div>
          </div>
        );
      })}

      {sorted.length === 0 && (
        <div className="text-center text-muted-foreground py-8">No spans recorded.</div>
      )}
    </div>
  );
}

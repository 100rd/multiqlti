import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThoughtNode, ThoughtTree as ThoughtTreeType } from "@shared/types";

interface ThoughtTreeProps {
  nodes: ThoughtTreeType;
}

type FilterType = "all" | "reasoning" | "decision" | "tool";

const NODE_ICONS: Record<ThoughtNode["type"], string> = {
  reasoning: "Brain",
  tool_call: "Search",
  tool_result: "FileText",
  decision: "CheckSquare",
  guardrail: "AlertTriangle",
  memory_recall: "MessageCircle",
  branch: "GitBranch",
  conclusion: "CheckCircle",
};

const NODE_EMOJI: Record<ThoughtNode["type"], string> = {
  reasoning: "🧠",
  tool_call: "🔍",
  tool_result: "📄",
  decision: "✅",
  guardrail: "⚠️",
  memory_recall: "💭",
  branch: "🌿",
  conclusion: "🏁",
};

const NODE_COLORS: Record<ThoughtNode["type"], string> = {
  reasoning: "border-blue-500/30 bg-blue-500/5",
  tool_call: "border-purple-500/30 bg-purple-500/5",
  tool_result: "border-slate-500/30 bg-slate-500/5",
  decision: "border-green-500/30 bg-green-500/5",
  guardrail: "border-amber-500/30 bg-amber-500/5",
  memory_recall: "border-cyan-500/30 bg-cyan-500/5",
  branch: "border-violet-500/30 bg-violet-500/5",
  conclusion: "border-emerald-500/30 bg-emerald-500/5",
};

function ThoughtNodeRow({ node, depth }: { node: ThoughtNode; depth: number }) {
  const [expanded, setExpanded] = useState(false);
  const hasContent = node.content && node.content !== node.label;

  return (
    <div style={{ marginLeft: depth * 16 }}>
      <div
        className={cn(
          "rounded-md border px-3 py-2 mb-1 cursor-pointer transition-colors",
          NODE_COLORS[node.type],
          hasContent ? "hover:brightness-110" : "cursor-default",
        )}
        onClick={() => hasContent && setExpanded(!expanded)}
      >
        <div className="flex items-start gap-2">
          <span className="text-sm shrink-0">{NODE_EMOJI[node.type]}</span>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium text-foreground truncate">
                {node.label}
              </span>
              {node.durationMs !== undefined && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {node.durationMs}ms
                </span>
              )}
              {node.metadata?.tokensUsed !== undefined && (
                <span className="text-[10px] text-muted-foreground shrink-0">
                  {node.metadata.tokensUsed} tok
                </span>
              )}
              {hasContent && (
                <span className="ml-auto shrink-0">
                  {expanded
                    ? <ChevronDown className="h-3 w-3 text-muted-foreground" />
                    : <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  }
                </span>
              )}
            </div>
            {expanded && hasContent && (
              <pre className="mt-2 text-[11px] text-muted-foreground whitespace-pre-wrap font-mono leading-relaxed">
                {node.content}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ThoughtTree({ nodes }: ThoughtTreeProps) {
  const [filter, setFilter] = useState<FilterType>("all");

  if (!nodes || nodes.length === 0) return null;

  const filtered = nodes.filter((n) => {
    if (filter === "all") return true;
    if (filter === "reasoning") return n.type === "reasoning";
    if (filter === "decision") return n.type === "decision";
    if (filter === "tool") return n.type === "tool_call" || n.type === "tool_result";
    return true;
  });

  // Build a depth map: root nodes are depth 0, children depth 1, etc.
  const idToDepth = new Map<string, number>();
  for (const node of nodes) {
    if (!node.parentId) {
      idToDepth.set(node.id, 0);
    } else {
      const parentDepth = idToDepth.get(node.parentId) ?? 0;
      idToDepth.set(node.id, parentDepth + 1);
    }
  }

  // Totals for footer
  const totalDuration = nodes.reduce((s, n) => s + (n.durationMs ?? 0), 0);
  const totalTokens = nodes.reduce((s, n) => s + (n.metadata?.tokensUsed ?? 0), 0);
  const decisionCount = nodes.filter((n) => n.type === "decision").length;
  const toolCallCount = nodes.filter((n) => n.type === "tool_call").length;

  const filters: { label: string; value: FilterType }[] = [
    { label: "All", value: "all" },
    { label: "Reasoning", value: "reasoning" },
    { label: "Decisions", value: "decision" },
    { label: "Tools", value: "tool" },
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">Thought Tree</p>
        <div className="flex gap-1">
          {filters.map((f) => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "text-[10px] px-2 py-0.5 rounded-full border transition-colors",
                filter === f.value
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="rounded-lg border border-border p-2 max-h-64 overflow-y-auto">
        {filtered.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No {filter === "all" ? "" : filter} nodes
          </p>
        ) : (
          filtered.map((node) => (
            <ThoughtNodeRow
              key={node.id}
              node={node}
              depth={idToDepth.get(node.id) ?? 0}
            />
          ))
        )}
      </div>

      <div className="flex gap-4 text-[10px] text-muted-foreground px-1">
        {totalDuration > 0 && <span>Duration: {totalDuration}ms</span>}
        {totalTokens > 0 && <span>Tokens: {totalTokens}</span>}
        {decisionCount > 0 && <span>Decisions: {decisionCount}</span>}
        {toolCallCount > 0 && <span>Tool calls: {toolCallCount}</span>}
      </div>
    </div>
  );
}

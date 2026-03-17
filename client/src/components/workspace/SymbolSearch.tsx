import { useState } from "react";
import { Search, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSymbolSearch, type SymbolKind, type SymbolSearchResult } from "@/hooks/useSymbolSearch";

// ─── Props ────────────────────────────────────────────────────────────────────

interface SymbolSearchProps {
  workspaceId: string;
  onSymbolSelect: (sym: SymbolSearchResult) => void;
}

// ─── Kind badge ───────────────────────────────────────────────────────────────

const KIND_COLORS: Record<SymbolKind | "", string> = {
  "": "",
  function: "bg-blue-500/10 text-blue-500",
  class: "bg-purple-500/10 text-purple-500",
  interface: "bg-cyan-500/10 text-cyan-500",
  type: "bg-teal-500/10 text-teal-500",
  variable: "bg-orange-500/10 text-orange-500",
  export: "bg-green-500/10 text-green-500",
  import: "bg-muted text-muted-foreground",
};

function KindBadge({ kind }: { kind: SymbolKind }) {
  return (
    <span className={cn("text-[9px] px-1 py-0.5 rounded font-mono font-medium", KIND_COLORS[kind])}>
      {kind}
    </span>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

const ALL_KINDS: Array<SymbolKind | ""> = [
  "",
  "function",
  "class",
  "interface",
  "type",
  "variable",
  "export",
];

const KIND_LABELS: Record<SymbolKind | "", string> = {
  "": "All",
  function: "fn",
  class: "class",
  interface: "iface",
  type: "type",
  variable: "var",
  export: "export",
  import: "import",
};

export function SymbolSearch({ workspaceId, onSymbolSelect }: SymbolSearchProps) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<SymbolKind | "">("");

  const { data: results, isFetching, isError } = useSymbolSearch(workspaceId, query, kind);

  return (
    <div className="flex flex-col h-full">
      {/* Search input */}
      <div className="px-3 py-2 border-b border-border space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search symbols..."
            className="w-full text-xs pl-7 pr-7 py-1.5 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {isFetching && (
            <Loader2 className="absolute right-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground animate-spin" />
          )}
        </div>

        {/* Kind filter */}
        <div className="flex flex-wrap gap-1">
          {ALL_KINDS.map((k) => (
            <button
              key={k || "_all"}
              onClick={() => setKind(k)}
              className={cn(
                "text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                kind === k
                  ? "bg-primary text-primary-foreground border-primary"
                  : "border-border text-muted-foreground hover:border-primary/50",
              )}
            >
              {KIND_LABELS[k]}
            </button>
          ))}
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {query.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
            Type to search symbols
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center h-24 text-xs text-red-500">
            Search failed
          </div>
        ) : !results || results.length === 0 ? (
          <div className="flex items-center justify-center h-24 text-xs text-muted-foreground">
            {isFetching ? "Searching..." : "No results"}
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {results.map((sym) => (
              <li key={sym.id}>
                <button
                  onClick={() => onSymbolSelect(sym)}
                  className="w-full text-left px-3 py-2 hover:bg-muted/50 transition-colors"
                >
                  <div className="flex items-center gap-1.5 mb-0.5">
                    <span className="text-xs font-mono font-medium truncate">{sym.name}</span>
                    <KindBadge kind={sym.kind} />
                    {sym.usageCount > 0 && (
                      <span className="ml-auto text-[9px] text-muted-foreground shrink-0">
                        {sym.usageCount} uses
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono">
                    <span className="truncate">{sym.file}</span>
                    <span className="shrink-0">:{sym.line}</span>
                  </div>
                  {sym.signature && (
                    <p className="mt-0.5 text-[10px] text-muted-foreground font-mono truncate">
                      {sym.signature}
                    </p>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

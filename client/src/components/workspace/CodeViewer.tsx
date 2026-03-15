import { useMemo } from "react";
import { cn } from "@/lib/utils";

interface CodeViewerProps {
  content: string;
  filePath: string;
  className?: string;
}

function getLanguageClass(filePath: string): string {
  const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "language-typescript",
    tsx: "language-typescript",
    js: "language-javascript",
    jsx: "language-javascript",
    py: "language-python",
    go: "language-go",
    rs: "language-rust",
    json: "language-json",
    yaml: "language-yaml",
    yml: "language-yaml",
    toml: "language-toml",
    css: "language-css",
    html: "language-html",
    md: "language-markdown",
  };
  return map[ext] ?? "language-plaintext";
}

export function CodeViewer({ content, filePath, className }: CodeViewerProps) {
  const lines = useMemo(() => content.split("\n"), [content]);
  const langClass = getLanguageClass(filePath);

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30 shrink-0">
        <span className="text-xs font-mono text-muted-foreground truncate">{filePath}</span>
        <span className="text-[10px] text-muted-foreground ml-2 shrink-0">
          {lines.length} lines
        </span>
      </div>

      <div className="flex-1 overflow-auto">
        <div className={cn("flex font-mono text-xs", langClass)}>
          {/* Line numbers */}
          <div
            className="select-none text-right pr-4 pl-3 py-3 text-muted-foreground/50 border-r border-border bg-muted/20 shrink-0"
            aria-hidden="true"
          >
            {lines.map((_, i) => (
              <div key={i} className="leading-5">
                {i + 1}
              </div>
            ))}
          </div>

          {/* Code content */}
          <pre className="flex-1 py-3 px-4 overflow-x-auto whitespace-pre leading-5 text-foreground">
            <code>{content}</code>
          </pre>
        </div>
      </div>
    </div>
  );
}

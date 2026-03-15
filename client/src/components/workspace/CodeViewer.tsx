import { cn } from "@/lib/utils";
import { CodeBlock } from "@/components/ui/CodeBlock";

interface CodeViewerProps {
  content: string;
  filePath: string;
  className?: string;
}

export function CodeViewer({ content, filePath, className }: CodeViewerProps) {
  const lineCount = content.split("\n").length;

  return (
    <div className={cn("flex flex-col h-full overflow-hidden", className)}>
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-border bg-muted/30 shrink-0">
        <span className="text-xs font-mono text-muted-foreground truncate">{filePath}</span>
        <span className="text-[10px] text-muted-foreground ml-2 shrink-0">
          {lineCount} lines
        </span>
      </div>

      <div className="flex-1 overflow-hidden">
        <CodeBlock
          code={content}
          filePath={filePath}
          maxHeight="100%"
          className="rounded-none border-0 h-full"
        />
      </div>
    </div>
  );
}

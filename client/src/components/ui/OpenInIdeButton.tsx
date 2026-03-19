import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePreferredIde } from "@/hooks/use-preferred-ide";

interface OpenInIdeButtonProps {
  /** Relative file path (e.g. "src/index.ts") */
  filePath: string;
  /** Absolute workspace root so we can build a full path */
  workspacePath?: string;
  line?: number;
  col?: number;
  className?: string;
}

/**
 * Small ghost button that opens a file in the user's preferred IDE.
 * Hidden when the user has disabled IDE integration (ide === "none")
 * or when there is no workspace context.
 */
export function OpenInIdeButton({
  filePath,
  workspacePath,
  line,
  col,
  className,
}: OpenInIdeButtonProps) {
  const { ide, openInIde, label } = usePreferredIde();

  if (ide === "none") return null;

  const absolutePath = workspacePath
    ? `${workspacePath.replace(/\/+$/, "")}/${filePath.replace(/^\/+/, "")}`
    : filePath;

  return (
    <Button
      variant="ghost"
      size="sm"
      className={className ?? "h-6 text-[10px]"}
      onClick={(e) => {
        e.stopPropagation();
        openInIde(absolutePath, line, col);
      }}
      title={`Open in ${label}`}
    >
      <ExternalLink className="h-3 w-3" />
    </Button>
  );
}

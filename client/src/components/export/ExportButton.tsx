import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Download, ChevronDown, Loader2, FileText, FileArchive, FileImage } from "lucide-react";
import { useToast } from "@/hooks/use-toast";

// ── Types ────────────────────────────────────────────────────────────────────

type ExportFormat = "markdown" | "pdf" | "zip";

interface ExportButtonProps {
  runId: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

const FORMAT_OPTIONS: Array<{
  value: ExportFormat;
  label: string;
  icon: typeof FileText;
}> = [
  { value: "markdown", label: "Download Markdown", icon: FileText },
  { value: "pdf", label: "Download PDF", icon: FileImage },
  { value: "zip", label: "Download ZIP", icon: FileArchive },
];

// ── Component ────────────────────────────────────────────────────────────────

export default function ExportButton({ runId }: ExportButtonProps) {
  const [loadingFormat, setLoadingFormat] = useState<ExportFormat | null>(null);
  const { toast } = useToast();

  const handleExport = async (format: ExportFormat) => {
    setLoadingFormat(format);

    try {
      const token = getAuthToken();
      const headers: Record<string, string> = {};
      if (token) headers["Authorization"] = `Bearer ${token}`;

      const res = await fetch(`/api/runs/${runId}/export?format=${format}`, {
        headers,
      });

      if (!res.ok) {
        if (res.status === 503 && format === "pdf") {
          toast({
            title: "PDF generation unavailable",
            description:
              "PDF export requires a server-side renderer that is not currently available. Try Markdown or ZIP instead.",
            variant: "destructive",
          });
          return;
        }
        const errText = await res.text().catch(() => res.statusText);
        throw new Error(errText || res.statusText);
      }

      const blob = await res.blob();
      const contentDisposition = res.headers.get("Content-Disposition") ?? "";
      const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
      const fallbackName =
        format === "zip"
          ? "export.zip"
          : format === "pdf"
            ? "report.pdf"
            : "report.md";
      const filename = filenameMatch?.[1] ?? fallbackName;

      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);

      toast({
        title: "Export downloaded",
        description: `${filename} has been saved.`,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to export run";
      toast({
        title: "Export failed",
        description: message,
        variant: "destructive",
      });
    } finally {
      setLoadingFormat(null);
    }
  };

  const isLoading = loadingFormat !== null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 text-xs gap-1"
          disabled={isLoading}
          aria-label="Export run"
        >
          {isLoading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Download className="h-3 w-3" />
          )}
          Export
          <ChevronDown className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {FORMAT_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const isCurrentLoading = loadingFormat === opt.value;
          return (
            <DropdownMenuItem
              key={opt.value}
              onClick={() => handleExport(opt.value)}
              disabled={isLoading}
            >
              {isCurrentLoading ? (
                <Loader2 className="h-3.5 w-3.5 mr-2 animate-spin" />
              ) : (
                <Icon className="h-3.5 w-3.5 mr-2" />
              )}
              {opt.label}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

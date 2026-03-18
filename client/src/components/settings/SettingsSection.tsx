import { type ReactNode, useState, useEffect, useCallback } from "react";
import { ChevronDown, Info } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

interface SettingsSectionProps {
  /** Unique key used for localStorage persistence. Derived as kebab-case of title if not provided. */
  storageKey?: string;
  title: string;
  icon: ReactNode;
  shortDescription: string;
  longDescription: string;
  defaultOpen?: boolean;
  children: ReactNode;
}

function toStorageKey(title: string): string {
  return `settings-section-${title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")}`;
}

export function SettingsSection({
  storageKey,
  title,
  icon,
  shortDescription,
  longDescription,
  defaultOpen = false,
  children,
}: SettingsSectionProps) {
  const key = storageKey ?? toStorageKey(title);

  const [open, setOpen] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem(key);
      if (stored !== null) return stored === "true";
    } catch {
      // localStorage unavailable (SSR, private mode)
    }
    return defaultOpen;
  });

  // Persist open/closed state whenever it changes
  useEffect(() => {
    try {
      localStorage.setItem(key, String(open));
    } catch {
      // ignore
    }
  }, [key, open]);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  return (
    <Collapsible open={open} onOpenChange={handleOpenChange}>
      <div className="rounded-lg border border-border bg-card shadow-sm">
        {/* Header row */}
        <div className="flex items-center gap-3 px-4 py-3">
          {/* Clickable area: takes up most of the row */}
          <CollapsibleTrigger asChild>
            <button
              type="button"
              className="flex flex-1 items-center gap-3 text-left min-w-0 group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
              aria-expanded={open}
              aria-controls={`settings-section-content-${key}`}
            >
              <span className="shrink-0 text-muted-foreground group-hover:text-foreground transition-colors">
                {icon}
              </span>
              <span className="font-semibold text-sm leading-tight">{title}</span>
              <span className="text-xs text-muted-foreground truncate min-w-0 hidden sm:block">
                {shortDescription}
              </span>
              <ChevronDown
                className={cn(
                  "ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            </button>
          </CollapsibleTrigger>

          {/* Info popover button — does NOT propagate click to collapse trigger */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 rounded"
                aria-label={`More information about ${title}`}
                onClick={(e) => e.stopPropagation()}
              >
                <Info className="h-3.5 w-3.5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              className="w-80 text-xs leading-relaxed"
              onClick={(e) => e.stopPropagation()}
            >
              <p className="font-medium mb-1">{title}</p>
              <p className="text-muted-foreground">{longDescription}</p>
            </PopoverContent>
          </Popover>
        </div>

        {/* Collapsible content */}
        <CollapsibleContent
          id={`settings-section-content-${key}`}
          className="overflow-hidden data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down"
        >
          <div className="border-t border-border">
            {children}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

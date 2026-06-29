import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Palette, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { useAccent, type AccentName } from "@/contexts/ThemeContext";

type ColorMode = "light" | "dark" | "system";

const MODES: Array<{ value: ColorMode; label: string; icon: typeof Sun }> = [
  { value: "light",  label: "Light",  icon: Sun     },
  { value: "dark",   label: "Dark",   icon: Moon    },
  { value: "system", label: "System", icon: Monitor },
];

interface ThemePickerProps {
  /** If true, renders as a compact icon-only trigger. Default: true */
  compact?: boolean;
}

export function ThemePicker({ compact = true }: ThemePickerProps) {
  const { theme, setTheme } = useTheme();
  const { accent, setAccent, accents } = useAccent();

  const currentMode = (theme as ColorMode | undefined) ?? "system";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={compact ? "icon" : "sm"}
          className={cn(
            "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
            compact ? "h-8 w-8" : "h-8 gap-2 px-2",
          )}
          aria-label="Appearance settings"
        >
          <Palette className="h-4 w-4 shrink-0" />
          {!compact && <span className="text-xs">Appearance</span>}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="right"
        align="end"
        sideOffset={8}
        className="w-56 p-3"
      >
        {/* Mode selector */}
        <div className="mb-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Mode
          </p>
          <div className="flex items-center gap-1">
            {MODES.map(({ value, label, icon: Icon }) => {
              const active = currentMode === value;
              return (
                <button
                  key={value}
                  onClick={() => setTheme(value)}
                  title={label}
                  className={cn(
                    "flex flex-1 flex-col items-center gap-1 rounded-md px-2 py-1.5 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  aria-pressed={active}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {label}
                </button>
              );
            })}
          </div>
        </div>

        <Separator className="mb-3" />

        {/* Accent color grid */}
        <div>
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Accent
          </p>
          <div className="grid grid-cols-3 gap-1.5">
            {accents.map((a) => {
              const active = accent === a.name;
              return (
                <button
                  key={a.name}
                  onClick={() => setAccent(a.name as AccentName)}
                  title={a.label}
                  aria-pressed={active}
                  className={cn(
                    "group relative flex flex-col items-center gap-1 rounded-md p-1.5 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-muted ring-2 ring-primary"
                      : "hover:bg-muted",
                    "text-foreground",
                  )}
                >
                  {/* Color swatch */}
                  <span
                    className="h-6 w-6 rounded-full ring-1 ring-black/10 dark:ring-white/10"
                    style={{
                      background: `hsl(${a.lightPrimary})`,
                    }}
                  />
                  <span className="leading-none">{a.label}</span>
                  {active && (
                    <Check
                      className="absolute right-1 top-1 h-2.5 w-2.5 text-primary"
                      strokeWidth={3}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

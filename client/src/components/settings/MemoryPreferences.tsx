import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Save, Loader2, Brain } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/hooks/use-pipeline";

const PREFERENCE_ROWS = [
  { key: "preferred-language", label: "Preferred Language", placeholder: "e.g. TypeScript, Python…" },
  { key: "error-handling-style", label: "Error Handling Style", placeholder: "e.g. throw exceptions, return Result…" },
  { key: "preferred-db", label: "Preferred Database", placeholder: "e.g. PostgreSQL, SQLite…" },
  { key: "code-style", label: "Code Style", placeholder: "e.g. functional, OOP, clean architecture…" },
  { key: "test-framework", label: "Test Framework", placeholder: "e.g. Vitest, Jest, Pytest…" },
];

interface MemoryPreferencesProps {
  /** When true, renders content only without a Card wrapper. Use inside SettingsSection. */
  noCard?: boolean;
}

export default function MemoryPreferences({ noCard = false }: MemoryPreferencesProps) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<Record<string, boolean>>({});

  const savePreference = useMutation({
    mutationFn: ({ key, value }: { key: string; value: string }) =>
      apiRequest("POST", "/api/memories", {
        scope: "global",
        type: "preference",
        key,
        content: value,
        confidence: 1.0,
      }),
    onSuccess: (_data, { key }) => {
      setSaved((prev) => ({ ...prev, [key]: true }));
      void qc.invalidateQueries({ queryKey: ["/api/memories"] });
      setTimeout(() => setSaved((prev) => ({ ...prev, [key]: false })), 2000);
    },
  });

  const inner = (
    <div className={cn("space-y-3", noCard ? "p-4" : "")}>
      <p className="text-xs text-muted-foreground">
        These preferences are stored as global memories and injected into every pipeline stage, helping the AI make consistent decisions aligned with your preferences.
      </p>
      {PREFERENCE_ROWS.map(({ key, label, placeholder }) => (
        <div key={key} className="flex items-center gap-3">
          <label className="text-xs font-medium w-44 shrink-0">{label}</label>
          <Input
            className="h-8 text-xs flex-1"
            placeholder={placeholder}
            value={values[key] ?? ""}
            onChange={(e) => setValues((prev) => ({ ...prev, [key]: e.target.value }))}
          />
          <Button
            size="sm"
            className="h-8 text-xs shrink-0"
            disabled={!values[key]?.trim() || savePreference.isPending}
            onClick={() => {
              const value = values[key]?.trim();
              if (value) savePreference.mutate({ key, value });
            }}
          >
            {saved[key] ? (
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
            ) : savePreference.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <><Save className="h-3 w-3 mr-1" /> Save</>
            )}
          </Button>
        </div>
      ))}
    </div>
  );

  if (noCard) return inner;

  // Legacy standalone card render
  return (
    <div className="rounded-lg border border-border bg-card shadow-sm">
      <div className="px-4 py-3 border-b border-border">
        <p className="text-base font-semibold flex items-center gap-2">
          <Brain className="h-4 w-4" /> Project Memory Preferences
        </p>
      </div>
      {inner}
    </div>
  );
}

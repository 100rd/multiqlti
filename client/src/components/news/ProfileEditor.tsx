/**
 * Profile editor — role, stack chips, muted categories.
 *
 * Reads the current user's news profile (GET /news/profile) and saves changes
 * (PUT /news/profile). Self-scoped: any authenticated workspace member edits
 * their own profile (canEditProfile). Loading/error states are explicit.
 *
 * Profile values feed the relevance ranker; they are the user's OWN input
 * (trusted-as-self) but still rendered as inert text.
 */
import { useEffect, useState } from "react";
import { SlidersHorizontal, X, Plus, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import {
  useNewsProfile,
  useUpdateNewsProfile,
  type NewsProfile,
  type NewsProfileRole,
} from "@/hooks/use-news";
import { ROLE_LABELS, CATEGORY_LABELS } from "@/lib/news";
import { NEWS_PROFILE_ROLES, NEWS_CATEGORIES } from "@shared/schema";
import { FeedSkeleton, QueryError, errorMessage } from "./QueryStates";

interface ProfileEditorProps {
  workspaceId: string;
  /** UI-gate: when false, controls are disabled (server is source of truth). */
  canEdit: boolean;
}

const MAX_STACK = 50;

export function ProfileEditor({ workspaceId, canEdit }: ProfileEditorProps) {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch } = useNewsProfile(workspaceId);
  const update = useUpdateNewsProfile(workspaceId);

  const [role, setRole] = useState<NewsProfileRole>("sre");
  const [stack, setStack] = useState<string[]>([]);
  const [muted, setMuted] = useState<string[]>([]);
  const [draft, setDraft] = useState("");

  // Hydrate local form when the profile loads / changes.
  useEffect(() => {
    if (data) {
      setRole(data.role);
      setStack(data.stack);
      setMuted(data.mutedCategories);
    }
  }, [data]);

  function addStack() {
    const value = draft.trim().toLowerCase();
    if (!value || stack.includes(value) || stack.length >= MAX_STACK) {
      setDraft("");
      return;
    }
    setStack((prev) => [...prev, value]);
    setDraft("");
  }

  function removeStack(value: string) {
    setStack((prev) => prev.filter((s) => s !== value));
  }

  function toggleMuted(category: string) {
    setMuted((prev) =>
      prev.includes(category)
        ? prev.filter((c) => c !== category)
        : [...prev, category],
    );
  }

  function save() {
    const next: NewsProfile = { role, stack, mutedCategories: muted };
    update.mutate(next, {
      onSuccess: () =>
        toast({
          title: "Profile saved",
          description: "Your next brief will use these preferences.",
        }),
      onError: (err) =>
        toast({
          variant: "destructive",
          title: "Couldn't save profile",
          description: errorMessage(err),
        }),
    });
  }

  return (
    <section
      className="rounded-2xl border border-border bg-card p-5"
      aria-labelledby="profile-editor-heading"
      data-testid="profile-editor"
    >
      <header className="mb-4 flex items-center gap-2">
        <SlidersHorizontal className="h-4 w-4 text-primary" />
        <h2 id="profile-editor-heading" className="text-sm font-semibold">
          Personalize your brief
        </h2>
      </header>

      {isLoading ? (
        <FeedSkeleton rows={1} />
      ) : isError ? (
        <QueryError message={errorMessage(error)} onRetry={() => refetch()} />
      ) : (
        <div className="space-y-5">
          {/* Role */}
          <div className="space-y-1.5">
            <Label htmlFor="profile-role">Role</Label>
            <Select
              value={role}
              onValueChange={(v) => setRole(v as NewsProfileRole)}
              disabled={!canEdit}
            >
              <SelectTrigger id="profile-role" className="w-[200px]" data-testid="profile-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {NEWS_PROFILE_ROLES.map((r) => (
                  <SelectItem key={r} value={r}>
                    {ROLE_LABELS[r] ?? r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Stack chips */}
          <div className="space-y-1.5">
            <Label>Your stack</Label>
            <div className="flex flex-wrap gap-1.5" data-testid="profile-stack">
              {stack.length === 0 && (
                <span className="text-xs text-muted-foreground">No stack keywords yet.</span>
              )}
              {stack.map((s) => (
                <Badge key={s} variant="secondary" className="gap-1 font-mono text-xs" data-testid="stack-chip">
                  {s}
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() => removeStack(s)}
                      aria-label={`Remove ${s}`}
                      data-testid="stack-chip-remove"
                      className="rounded-full hover:text-destructive focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </Badge>
              ))}
            </div>
            {canEdit && (
              <div className="flex items-center gap-2 pt-1">
                <Input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addStack();
                    }
                  }}
                  placeholder="Add a keyword…"
                  className="h-8 w-[200px]"
                  data-testid="stack-input"
                  aria-label="Add a stack keyword"
                />
                <Button type="button" size="sm" variant="outline" onClick={addStack} data-testid="stack-add">
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  Add
                </Button>
              </div>
            )}
          </div>

          {/* Muted categories */}
          <div className="space-y-1.5">
            <Label>Mute categories</Label>
            <div className="flex flex-wrap gap-2" data-testid="profile-muted">
              {NEWS_CATEGORIES.map((c) => {
                const active = muted.includes(c);
                return (
                  <button
                    key={c}
                    type="button"
                    onClick={() => toggleMuted(c)}
                    disabled={!canEdit}
                    aria-pressed={active}
                    data-testid={`mute-${c}`}
                    data-active={active ? "true" : "false"}
                    className={cn(
                      "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      "disabled:cursor-not-allowed disabled:opacity-50",
                      active
                        ? "border-destructive/40 bg-destructive/10 text-destructive"
                        : "border-border text-muted-foreground hover:border-primary/40",
                    )}
                  >
                    {active ? "Muted" : "Mute"} {CATEGORY_LABELS[c]}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center justify-end">
            <Button onClick={save} disabled={!canEdit || update.isPending} data-testid="profile-save">
              <Save className="mr-2 h-4 w-4" />
              {update.isPending ? "Saving…" : "Save preferences"}
            </Button>
          </div>

          {!canEdit && (
            <p className="text-xs text-amber-600" data-testid="profile-readonly-notice">
              Sign in to personalize your brief.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

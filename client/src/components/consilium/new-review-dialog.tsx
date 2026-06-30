/**
 * new-review-dialog.tsx — the "New consilium review" launcher (button + dialog)
 * for ConsiliumLoopList. Mirrors ProjectSelector's create-dialog pattern (the
 * shared Dialog primitive + a controlled form + a toast on settle).
 *
 * It POSTs `{ repoPath, preset, maxRounds?, baselineCommit? }` to
 * `/api/consilium-reviews` via the shared apiRequest transport (carries auth +
 * `x-project-id`, same as every project-scoped call).
 *
 * REPO SELECTION: instead of free-typing a path that may not be allowlisted, the
 * user PICKS from the active project's workspaces (passed in by the page, which
 * already runs the project-scoped `/api/workspaces` query). Each option labels
 * the workspace `name` and submits its `path`, defaulting to the first. Two
 * escape hatches keep it from ever being a dead end:
 *   1. NO workspaces registered → we fall back to the original free-text input
 *      (with a hint), so the project can still launch a review.
 *   2. "Advanced: enter a custom path" toggle → reveals the free-text input for a
 *      repo that is allowlisted server-side but not registered as a workspace.
 * The server still re-validates repoPath against its allowlist; a rejection comes
 * back as a 400 whose `error` text we surface VERBATIM in the failure toast (so
 * "...is not in the allowed repo paths" is actionable, not a mystery).
 *
 * On success we invalidate the loops list and, if the response carries an id
 * (id / loopId / loop.id — defensive, the exact envelope is the backend's), we
 * navigate to the new loop's detail.
 *
 * SECURITY: the only free-text the user supplies (custom repoPath / baselineCommit)
 * is sent as a JSON body to an allowlist-validated server route; nothing is
 * interpolated into a URL path or shell. The server re-validates repoPath against
 * its allowlist.
 */
import { useEffect, useState } from "react";
import { useLocation } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/hooks/use-pipeline";
import { useToast } from "@/hooks/use-toast";

/** The presets the backend accepts, with human labels (default first). */
const PRESETS = [
  { value: "sdlc-cross-review", label: "SDLC cross-review" },
  { value: "diff-pr-review", label: "Diff / PR review" },
  { value: "full-viability", label: "Full viability assessment" },
] as const;
type Preset = (typeof PRESETS)[number]["value"];

/** The slice of a workspace this dialog needs — a human `name` and a repo `path`. */
export type ReviewWorkspaceOption = { id?: string; name: string; path: string };

/** Best-effort id extraction — the exact create envelope is the backend's call. */
function createdLoopId(res: unknown): string | undefined {
  if (!res || typeof res !== "object") return undefined;
  const r = res as { id?: unknown; loopId?: unknown; loop?: { id?: unknown } };
  const id = r.id ?? r.loopId ?? r.loop?.id;
  return typeof id === "string" && id ? id : undefined;
}

export function NewConsiliumReviewDialog({
  workspaces,
}: {
  /**
   * The active project's workspaces (already fetched by the page). When present,
   * the repo control is a dropdown over these; when empty/undefined, the dialog
   * falls back to a free-text path input so it is never a dead end.
   */
  workspaces?: ReviewWorkspaceOption[];
}) {
  const wsList = workspaces ?? [];
  const hasWorkspaces = wsList.length > 0;

  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<Preset>("sdlc-cross-review");
  const [repoPath, setRepoPath] = useState(wsList[0]?.path ?? "");
  // "Advanced: enter a custom path" — reveals the free-text input even when
  // workspaces exist (for an allowlisted repo not registered as a workspace).
  const [customMode, setCustomMode] = useState(false);
  const [maxRounds, setMaxRounds] = useState("1");
  const [baselineCommit, setBaselineCommit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Whether to show the free-text input: no workspaces to pick from, or the user
  // explicitly opted into a custom path.
  const freeText = !hasWorkspaces || customMode;

  // Seed the repo path once the workspaces query resolves (it may arrive after
  // mount), but never clobber a value already chosen/typed and never override a
  // custom path. Functional update keeps repoPath out of the dep array.
  useEffect(() => {
    if (hasWorkspaces && !customMode) {
      setRepoPath((cur) => cur || wsList[0].path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasWorkspaces, customMode, wsList[0]?.path]);

  const enterCustomPath = () => {
    // Carry the current selection into the input as a starting point.
    setCustomMode(true);
  };
  const useWorkspacePicker = () => {
    setCustomMode(false);
    // If the typed path isn't one of the workspaces, snap back to the first one
    // so the dropdown always has a valid selection.
    const known = wsList.some((w) => w.path === repoPath);
    if (!known) setRepoPath(wsList[0]?.path ?? "");
  };

  const handleSubmit = async () => {
    const path = repoPath.trim();
    if (!path) return;

    const body: {
      repoPath: string;
      preset: Preset;
      maxRounds?: number;
      baselineCommit?: string;
    } = { repoPath: path, preset };

    const rounds = Number(maxRounds);
    if (Number.isInteger(rounds) && rounds > 0) body.maxRounds = rounds;
    // baseline commit is only meaningful for a diff/PR review.
    if (preset === "diff-pr-review" && baselineCommit.trim()) {
      body.baselineCommit = baselineCommit.trim();
    }

    try {
      setSubmitting(true);
      const created = await apiRequest("POST", "/api/consilium-reviews", body);
      // Refresh the list regardless of the response envelope shape.
      qc.invalidateQueries({ queryKey: ["/api/consilium-loops"] });
      toast({ title: "Consilium review started" });
      setOpen(false);
      const id = createdLoopId(created);
      if (id) navigate(`/consilium-loops/${id}`);
    } catch (e) {
      // Surface the server's message VERBATIM — apiRequest threads the 400's
      // `error` text into Error.message, so the user sees e.g. "...is not in the
      // allowed repo paths" rather than a generic failure.
      toast({
        title: "Failed to start review",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="new-consilium-review-button">
          <Plus className="h-4 w-4 mr-2" />
          New consilium review
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New consilium review</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label>Preset</Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger data-testid="new-review-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Repository</Label>
              {/* Advanced affordance — only meaningful when there ARE workspaces
                  to pick from; with none, the free-text input is already shown. */}
              {hasWorkspaces && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                  onClick={freeText ? useWorkspacePicker : enterCustomPath}
                  data-testid="new-review-toggle-custom-path"
                >
                  {freeText ? "Pick a workspace instead" : "Advanced: enter a custom path"}
                </button>
              )}
            </div>

            {freeText ? (
              <>
                <Input
                  value={repoPath}
                  onChange={(e) => setRepoPath(e.target.value)}
                  placeholder="/path/to/allowlisted/repo"
                  data-testid="new-review-repo-path"
                />
                {!hasWorkspaces && (
                  <p className="text-xs text-muted-foreground">
                    No workspaces registered for this project — enter a repo path
                    that the server allowlists.
                  </p>
                )}
              </>
            ) : (
              <Select value={repoPath} onValueChange={setRepoPath}>
                <SelectTrigger data-testid="new-review-repo-select">
                  <SelectValue placeholder="Select a workspace" />
                </SelectTrigger>
                <SelectContent>
                  {wsList.map((w, i) => (
                    <SelectItem key={w.id ?? w.path ?? i} value={w.path}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          <div className="space-y-2">
            <Label>
              Max rounds <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              type="number"
              min={1}
              value={maxRounds}
              onChange={(e) => setMaxRounds(e.target.value)}
              data-testid="new-review-max-rounds"
            />
          </div>

          {preset === "diff-pr-review" && (
            <div className="space-y-2">
              <Label>
                Baseline commit{" "}
                <span className="text-muted-foreground">(optional)</span>
              </Label>
              <Input
                value={baselineCommit}
                onChange={(e) => setBaselineCommit(e.target.value)}
                placeholder="defaults to last reviewed commit"
                data-testid="new-review-baseline-commit"
              />
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!repoPath.trim() || submitting}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Start review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

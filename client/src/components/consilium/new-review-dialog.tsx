/**
 * new-review-dialog.tsx — the "New consilium review" launcher (button + dialog)
 * for ConsiliumLoopList. Mirrors ProjectSelector's create-dialog pattern (the
 * shared Dialog primitive + a controlled form + a toast on settle).
 *
 * It POSTs `{ repoPath, preset, maxRounds?, baselineCommit? }` to
 * `/api/consilium-reviews` via the shared apiRequest transport (carries auth +
 * `x-project-id`, same as every project-scoped call). That endpoint is being
 * built by a parallel backend agent — we code against the agreed contract; a
 * runtime 404 until their PR lands is EXPECTED and surfaces as a failure toast
 * (it never blocks the page).
 *
 * On success we invalidate the loops list and, if the response carries an id
 * (id / loopId / loop.id — defensive, the exact envelope is the backend's), we
 * navigate to the new loop's detail.
 *
 * SECURITY: the only free-text the user supplies (repoPath / baselineCommit) is
 * sent as a JSON body to an allowlist-validated server route; nothing is
 * interpolated into a URL path or shell. The server re-validates repoPath
 * against its allowlist.
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

/** Best-effort id extraction — the exact create envelope is the backend's call. */
function createdLoopId(res: unknown): string | undefined {
  if (!res || typeof res !== "object") return undefined;
  const r = res as { id?: unknown; loopId?: unknown; loop?: { id?: unknown } };
  const id = r.id ?? r.loopId ?? r.loop?.id;
  return typeof id === "string" && id ? id : undefined;
}

export function NewConsiliumReviewDialog({
  defaultRepoPath,
}: {
  /** Pre-fill from the active project's first workspace path, when known. */
  defaultRepoPath?: string;
}) {
  const [open, setOpen] = useState(false);
  const [preset, setPreset] = useState<Preset>("sdlc-cross-review");
  const [repoPath, setRepoPath] = useState(defaultRepoPath ?? "");
  const [maxRounds, setMaxRounds] = useState("1");
  const [baselineCommit, setBaselineCommit] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Seed the repo path once the workspaces query resolves, but never clobber a
  // value the user has already typed (functional update keeps repoPath out of deps).
  useEffect(() => {
    if (defaultRepoPath) setRepoPath((cur) => cur || defaultRepoPath);
  }, [defaultRepoPath]);

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
            <Label>Repo path</Label>
            <Input
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/path/to/allowlisted/repo"
              data-testid="new-review-repo-path"
            />
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

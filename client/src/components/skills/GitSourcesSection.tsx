/**
 * GitSourcesSection — Git repository skill sources management.
 *
 * Displays a list of configured git sources with sync status.
 * Admin users can add, sync, and delete sources.
 * PAT can be set per source via a secure modal.
 */

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { GitBranch, Plus, RefreshCw, Trash2, Lock, AlertCircle, CheckCircle2, Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import {
  useGitSkillSources,
  useCreateGitSkillSource,
  useDeleteGitSkillSource,
  useSyncGitSkillSource,
  useSetGitSourcePat,
  type CreateGitSourcePayload,
} from "@/hooks/use-git-skill-sources";
import type { GitSkillSourceWithStats } from "@shared/types";
import { cn } from "@/lib/utils";

// ─── Add Source Dialog ────────────────────────────────────────────────────────

interface AddSourceDialogProps {
  open: boolean;
  onClose: () => void;
}

function AddSourceDialog({ open, onClose }: AddSourceDialogProps) {
  const { toast } = useToast();
  const create = useCreateGitSkillSource();

  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [path, setPath] = useState("/");
  const [syncOnStart, setSyncOnStart] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});

  function reset() {
    setName("");
    setRepoUrl("");
    setBranch("main");
    setPath("/");
    setSyncOnStart(false);
    setErrors({});
  }

  function handleClose() {
    reset();
    onClose();
  }

  function validate(): boolean {
    const e: Partial<Record<string, string>> = {};
    if (!name.trim()) e.name = "Name is required";
    if (!repoUrl.trim()) {
      e.repoUrl = "Repo URL is required";
    } else if (!/^https:\/\//i.test(repoUrl.trim()) && !/^git@[\w.-]+:/.test(repoUrl.trim())) {
      e.repoUrl = "URL must start with https:// or be a git@host:owner/repo.git SSH URL";
    }
    if (!branch.trim()) e.branch = "Branch is required";
    if (path.includes("..")) e.path = "Path must not contain ..";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleSubmit() {
    if (!validate()) return;

    const payload: CreateGitSourcePayload = {
      name: name.trim(),
      repoUrl: repoUrl.trim(),
      branch: branch.trim(),
      path: path.trim() || "/",
      syncOnStart,
    };

    try {
      await create.mutateAsync(payload);
      toast({ title: "Git source added", description: "Initial sync started in background" });
      handleClose();
    } catch (err) {
      toast({
        title: "Failed to add source",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <GitBranch className="h-4 w-4" />
            Add Git Skill Source
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1.5">
            <Label htmlFor="gs-name" className="text-xs font-medium">
              Name <span className="text-destructive">*</span>
            </Label>
            <Input
              id="gs-name"
              className="h-8 text-sm"
              placeholder="e.g. Company Skill Library"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            {errors.name && <p className="text-xs text-destructive">{errors.name}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="gs-url" className="text-xs font-medium">
              Repository URL <span className="text-destructive">*</span>
            </Label>
            <Input
              id="gs-url"
              className="h-8 text-sm font-mono"
              placeholder="https://github.com/org/skills-repo.git"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
            />
            {errors.repoUrl && <p className="text-xs text-destructive">{errors.repoUrl}</p>}
            <p className="text-[10px] text-muted-foreground">
              Supports https:// and git@ SSH URLs only
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="gs-branch" className="text-xs font-medium">
                Branch
              </Label>
              <Input
                id="gs-branch"
                className="h-8 text-sm"
                placeholder="main"
                value={branch}
                onChange={(e) => setBranch(e.target.value)}
              />
              {errors.branch && <p className="text-xs text-destructive">{errors.branch}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="gs-path" className="text-xs font-medium">
                Skills Path
              </Label>
              <Input
                id="gs-path"
                className="h-8 text-sm font-mono"
                placeholder="/skills"
                value={path}
                onChange={(e) => setPath(e.target.value)}
              />
              {errors.path && <p className="text-xs text-destructive">{errors.path}</p>}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <Switch
              id="gs-sync-start"
              checked={syncOnStart}
              onCheckedChange={setSyncOnStart}
              className="scale-75"
            />
            <Label htmlFor="gs-sync-start" className="text-xs cursor-pointer">
              Sync on server start
            </Label>
          </div>
        </div>

        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={create.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={create.isPending}>
            {create.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Adding...
              </>
            ) : (
              "Add Source"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── PAT Modal ────────────────────────────────────────────────────────────────

interface PatModalProps {
  source: GitSkillSourceWithStats | null;
  onClose: () => void;
}

function PatModal({ source, onClose }: PatModalProps) {
  const { toast } = useToast();
  const setPat = useSetGitSourcePat();
  const [pat, setPatValue] = useState("");

  function handleClose() {
    setPatValue("");
    onClose();
  }

  async function handleSubmit() {
    if (!source || !pat.trim()) return;
    try {
      await setPat.mutateAsync({ id: source.id, pat: pat.trim() });
      toast({ title: "PAT saved securely" });
      handleClose();
    } catch (err) {
      toast({
        title: "Failed to save PAT",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <Dialog open={Boolean(source)} onOpenChange={(o) => !o && handleClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-base flex items-center gap-2">
            <Lock className="h-4 w-4" />
            Private Repo Access Token
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <p className="text-xs text-muted-foreground">
            Enter a Personal Access Token for <span className="font-mono font-medium">{source?.name}</span>.
            The token is stored encrypted and never returned by the API.
          </p>
          <div className="space-y-1.5">
            <Label htmlFor="pat-input" className="text-xs font-medium">
              Personal Access Token
            </Label>
            <Input
              id="pat-input"
              type="password"
              className="h-8 text-sm font-mono"
              placeholder="ghp_xxxxxxxxxxxx"
              value={pat}
              onChange={(e) => setPatValue(e.target.value)}
              autoComplete="off"
            />
          </div>
        </div>
        <DialogFooter className="gap-2">
          <Button variant="ghost" size="sm" onClick={handleClose} disabled={setPat.isPending}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleSubmit} disabled={setPat.isPending || !pat.trim()}>
            {setPat.isPending ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Token"
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Source Card ──────────────────────────────────────────────────────────────

interface SourceCardProps {
  source: GitSkillSourceWithStats;
  onPatClick: (source: GitSkillSourceWithStats) => void;
  isAdmin: boolean;
}

function SourceCard({ source, onPatClick, isAdmin }: SourceCardProps) {
  const { toast } = useToast();
  const syncSource = useSyncGitSkillSource();
  const deleteSource = useDeleteGitSkillSource();

  async function handleSync() {
    try {
      await syncSource.mutateAsync(source.id);
      toast({ title: "Sync started", description: "Check back shortly for updated status" });
    } catch (err) {
      toast({
        title: "Sync failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function handleDelete() {
    if (!confirm(`Delete git source "${source.name}" and all its imported skills?`)) return;
    try {
      await deleteSource.mutateAsync(source.id);
      toast({ title: "Source deleted" });
    } catch (err) {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Unknown error",
        variant: "destructive",
      });
    }
  }

  const lastSynced = source.lastSyncedAt
    ? new Date(source.lastSyncedAt).toLocaleString()
    : null;

  return (
    <div className="border border-border rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <GitBranch className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-sm font-medium truncate">{source.name}</span>
          </div>
          <p className="text-xs font-mono text-muted-foreground truncate mt-0.5">
            {source.repoUrl}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {source.lastError ? (
            <Badge variant="destructive" className="text-[10px] gap-1">
              <AlertCircle className="h-2.5 w-2.5" />
              Error
            </Badge>
          ) : lastSynced ? (
            <Badge variant="secondary" className="text-[10px] gap-1 bg-green-500/10 text-green-700 dark:text-green-400">
              <CheckCircle2 className="h-2.5 w-2.5" />
              Synced
            </Badge>
          ) : (
            <Badge variant="outline" className="text-[10px]">Pending</Badge>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 text-[10px] text-muted-foreground flex-wrap">
        <span>Branch: <span className="font-mono font-medium text-foreground">{source.branch}</span></span>
        <span>Path: <span className="font-mono font-medium text-foreground">{source.path}</span></span>
        <span>{source.skillCount} skill{source.skillCount !== 1 ? "s" : ""}</span>
        {lastSynced && <span>Last synced: {lastSynced}</span>}
      </div>

      {source.lastError && (
        <p className="text-[10px] text-destructive bg-destructive/10 rounded px-2 py-1 font-mono break-all">
          {source.lastError}
        </p>
      )}

      {isAdmin && (
        <div className="flex items-center gap-2 pt-1">
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={handleSync}
            disabled={syncSource.isPending}
          >
            {syncSource.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Sync Now
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs gap-1"
            onClick={() => onPatClick(source)}
          >
            <Lock className="h-3 w-3" />
            Set PAT
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
            onClick={handleDelete}
            disabled={deleteSource.isPending}
          >
            <Trash2 className="h-3 w-3" />
            Delete
          </Button>
        </div>
      )}
    </div>
  );
}

// ─── Main Section Component ───────────────────────────────────────────────────

interface GitSourcesSectionProps {
  isAdmin: boolean;
}

export function GitSourcesSection({ isAdmin }: GitSourcesSectionProps) {
  const { data: sources = [], isLoading } = useGitSkillSources();
  const [addOpen, setAddOpen] = useState(false);
  const [patSource, setPatSource] = useState<GitSkillSourceWithStats | null>(null);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-sm flex items-center gap-2">
              <GitBranch className="h-4 w-4" />
              Git Sources
            </CardTitle>
            <CardDescription className="text-xs mt-0.5">
              Import skills from remote Git repositories
            </CardDescription>
          </div>
          {isAdmin && (
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs gap-1"
              onClick={() => setAddOpen(true)}
            >
              <Plus className="h-3 w-3" />
              Add Source
            </Button>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="text-xs text-muted-foreground">Loading...</p>
        ) : sources.length === 0 ? (
          <div className="text-center py-6">
            <GitBranch className="h-6 w-6 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-xs text-muted-foreground">
              No git sources configured.
              {isAdmin && " Add one to import skills from a remote repository."}
            </p>
          </div>
        ) : (
          sources.map((source) => (
            <SourceCard
              key={source.id}
              source={source}
              onPatClick={setPatSource}
              isAdmin={isAdmin}
            />
          ))
        )}
      </CardContent>

      {isAdmin && (
        <>
          <AddSourceDialog open={addOpen} onClose={() => setAddOpen(false)} />
          <PatModal source={patSource} onClose={() => setPatSource(null)} />
        </>
      )}
    </Card>
  );
}

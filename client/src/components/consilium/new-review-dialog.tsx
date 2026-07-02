/**
 * new-review-dialog.tsx — the "New consilium review" launcher (button + dialog)
 * for ConsiliumLoopList. Mirrors ProjectSelector's create-dialog pattern (the
 * shared Dialog primitive + a controlled form + a toast on settle).
 *
 * It POSTs `{ repoPath, preset, maxRounds?, baselineCommit?, ref?, engineerInstruction? }` to
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
 * BRANCH SELECTION: once a workspace is picked, we fetch its branches LIVE from
 * `GET /api/workspaces/:id/branches` (response `{ current, branches[] }`) via a
 * react-query keyed by the workspace id (`enabled` only when a workspace with an
 * id is selected). A branch Select sits below the workspace Select, defaulting to
 * the workspace's registered `branch` (then the endpoint's `current`, then
 * "main"). While the list loads we show a disabled "Loading branches…" control;
 * on error / empty list / custom-path (no workspace id) we fall back to a
 * free-text branch Input so the user is never stuck. The chosen branch rides
 * along as `ref`, but is OMITTED when it equals the workspace default or is empty
 * — the server treats an absent `ref` as the working-tree HEAD (back-compat).
 *
 * On success we invalidate the loops list and, if the response carries an id
 * (id / loopId / loop.id — defensive, the exact envelope is the backend's), we
 * navigate to the new loop's detail.
 *
 * SECURITY: the only free-text the user supplies (custom repoPath / baselineCommit
 * / a hand-typed branch) is sent as a JSON body to an allowlist-validated server
 * route; nothing is interpolated into a URL path or shell. The workspace id used
 * in the branches URL is a server-issued id, not user free-text. The server
 * re-validates repoPath against its allowlist.
 */
import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Textarea } from "@/components/ui/textarea";
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

/**
 * Soft cap on the optional engineer instruction (mirrors the server bound). The
 * counter warns past this; the server is the final arbiter (a 400 surfaces its
 * `error` text verbatim).
 */
const MAX_INSTRUCTION_LEN = 8000;

/**
 * The slice of a workspace this dialog needs — a human `name`, a repo `path`, the
 * server-issued `id` (keys the branches fetch) and the registered default
 * `branch`. WorkspaceRow is structurally assignable to this.
 */
export type ReviewWorkspaceOption = {
  id?: string;
  name: string;
  path: string;
  branch?: string;
};

/** The `/api/workspaces/:id/branches` envelope (manager.listBranches). */
type BranchesResponse = { current?: string; branches?: string[] };

/**
 * Normalize whatever the branches endpoint returns into a clean, de-duplicated,
 * sorted list of short branch names. Handles both the documented
 * `{ branches: string[], current }` shape AND a defensive bare-array fallback,
 * strips `remotes/<remote>/` prefixes (git branch -a) down to the branch name,
 * and drops HEAD pointers.
 */
function branchNames(data: BranchesResponse | string[] | undefined): string[] {
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(data?.branches)
      ? data.branches
      : [];
  const names = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    let name = entry.trim();
    if (!name) continue;
    const remote = name.match(/^remotes\/[^/]+\/(.+)$/);
    if (remote) name = remote[1];
    if (name === "HEAD" || name.endsWith("/HEAD")) continue;
    names.add(name);
  }
  return [...names].sort();
}

/** The live `current` branch from the endpoint, if the object shape was used. */
function currentBranch(data: BranchesResponse | string[] | undefined): string | undefined {
  if (!data || Array.isArray(data)) return undefined;
  return typeof data.current === "string" && data.current ? data.current : undefined;
}

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
  const [branch, setBranch] = useState("");
  const [maxRounds, setMaxRounds] = useState("1");
  const [baselineCommit, setBaselineCommit] = useState("");
  // Optional free-text instruction (tone / requirements for the evaluation). Sent
  // as `engineerInstruction` only when non-empty; the server fences it as data.
  const [engineerInstruction, setEngineerInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  // Whether to show the free-text REPO input: no workspaces to pick from, or the
  // user explicitly opted into a custom path.
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

  // The workspace currently selected in the dropdown (undefined in free-text
  // repo mode). Its server-issued `id` keys the branches fetch.
  const selectedWorkspace = freeText
    ? undefined
    : wsList.find((w) => w.path === repoPath);
  const selectedWorkspaceId = selectedWorkspace?.id;

  // Live branches for the selected workspace. Keyed by the workspace id and
  // enabled ONLY when a workspace with an id is selected (free-text repo mode has
  // no id → no list). Re-fetches automatically when the id in the key changes.
  const branchesQuery = useQuery<BranchesResponse>({
    queryKey: ["/api/workspaces", selectedWorkspaceId, "branches"],
    queryFn: () =>
      apiRequest("GET", `/api/workspaces/${selectedWorkspaceId}/branches`),
    enabled: !freeText && !!selectedWorkspaceId,
  });

  const liveBranches = branchNames(branchesQuery.data);
  const liveCurrent = currentBranch(branchesQuery.data);
  // The default branch for the selected workspace: its registered `branch`, then
  // the endpoint's live `current`, then "main". In free-text repo mode there is
  // no workspace default → "" (empty = HEAD on the server).
  const workspaceDefaultBranch = selectedWorkspace
    ? selectedWorkspace.branch || liveCurrent || "main"
    : "";

  // Re-seed the branch when the SELECTED WORKSPACE changes (id flips), resetting
  // it to that workspace's default. A ref guards against re-seeding on every
  // branches refetch for the SAME workspace (which would clobber a user choice),
  // while still letting the live `current` fill in once it arrives if the
  // workspace had no registered branch.
  const seededFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (seededFor.current !== selectedWorkspaceId) {
      seededFor.current = selectedWorkspaceId;
      setBranch(workspaceDefaultBranch);
    } else if (selectedWorkspace && !branch && workspaceDefaultBranch) {
      // Same workspace, branch still empty (registered branch was falsy) and the
      // live `current` just landed → adopt it without clobbering a real choice.
      setBranch(workspaceDefaultBranch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedWorkspaceId, workspaceDefaultBranch]);

  // Loading / failure / dropdown states for the branch control. A disabled query
  // (free-text repo mode) is never "loading". On error OR an empty list we fall
  // back to a free-text branch Input so the user is never stuck.
  const branchesEnabled = !freeText && !!selectedWorkspaceId;
  const branchesLoading = branchesEnabled && branchesQuery.isLoading;
  const branchesFailed =
    branchesEnabled &&
    (branchesQuery.isError ||
      (branchesQuery.isSuccess && liveBranches.length === 0));
  const branchDropdown = branchesEnabled && !branchesLoading && !branchesFailed;
  // Keep the current value selectable even if it isn't in the live list (e.g. a
  // registered default branch the remote no longer advertises).
  const branchOptions =
    branch && !liveBranches.includes(branch)
      ? [branch, ...liveBranches]
      : liveBranches;

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
      ref?: string;
      engineerInstruction?: string;
    } = { repoPath: path, preset };

    const rounds = Number(maxRounds);
    if (Number.isInteger(rounds) && rounds > 0) body.maxRounds = rounds;
    // baseline commit is only meaningful for a diff/PR review.
    if (preset === "diff-pr-review" && baselineCommit.trim()) {
      body.baselineCommit = baselineCommit.trim();
    }
    // Branch → `ref`. Omit when empty, or (in workspace mode) when it equals the
    // workspace default — the server treats an absent ref as the working-tree
    // HEAD, so this preserves the prior behavior for the unchanged-default case.
    const chosenBranch = branch.trim();
    if (
      chosenBranch &&
      !(selectedWorkspace && chosenBranch === workspaceDefaultBranch)
    ) {
      body.ref = chosenBranch;
    }
    // Optional instruction — send only when non-empty. The server validates the
    // length (≤8000) and fences the text as data; we don't hard-truncate here so
    // the soft counter, not silent loss, signals an over-limit value.
    const instruction = engineerInstruction.trim();
    if (instruction) body.engineerInstruction = instruction;

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

          {/* Branch — a Select over the workspace's live branches, with graceful
              loading / failure / free-text fallbacks so it's never a dead end. */}
          <div className="space-y-2">
            <Label>Branch</Label>
            {branchesLoading ? (
              <Select disabled value="">
                <SelectTrigger data-testid="new-review-branch-loading">
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    Loading branches…
                  </span>
                </SelectTrigger>
                <SelectContent />
              </Select>
            ) : branchDropdown ? (
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger data-testid="new-review-branch-select">
                  <SelectValue placeholder="Select a branch" />
                </SelectTrigger>
                <SelectContent>
                  {branchOptions.map((b) => (
                    <SelectItem key={b} value={b}>
                      {b}
                      {b === workspaceDefaultBranch ? " (default)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <>
                <Input
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  placeholder={
                    selectedWorkspace
                      ? workspaceDefaultBranch || "branch name"
                      : "leave empty for the repo's current branch"
                  }
                  data-testid="new-review-branch-input"
                />
                <p className="text-xs text-muted-foreground">
                  {branchesFailed
                    ? "Couldn't list this workspace's branches — type a branch name, or leave it to use the current branch."
                    : "Optional — leave empty to review the repo's current branch (HEAD)."}
                </p>
              </>
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

          {/* Optional free-text instruction for the evaluators — tone, emphasis,
              acceptance bar. Sent as `engineerInstruction`; the server fences it
              as data and bounds the length. */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="new-review-engineer-instruction">
                Instructions to the engineer{" "}
                <span className="text-muted-foreground">(tone / requirements for the evaluation)</span>
              </Label>
              <span
                className={
                  engineerInstruction.length > MAX_INSTRUCTION_LEN
                    ? "text-xs tabular-nums text-destructive"
                    : "text-xs tabular-nums text-muted-foreground"
                }
                data-testid="new-review-engineer-instruction-counter"
              >
                {engineerInstruction.length}/{MAX_INSTRUCTION_LEN}
              </span>
            </div>
            <Textarea
              id="new-review-engineer-instruction"
              value={engineerInstruction}
              onChange={(e) => setEngineerInstruction(e.target.value)}
              placeholder="E.g.: evaluate strictly on security; require tests for every P0; keep the tone concise."
              rows={3}
              data-testid="new-review-engineer-instruction"
            />
            {engineerInstruction.length > MAX_INSTRUCTION_LEN && (
              <p className="text-xs text-destructive">
                Too long — the server accepts at most {MAX_INSTRUCTION_LEN} characters.
              </p>
            )}
          </div>
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

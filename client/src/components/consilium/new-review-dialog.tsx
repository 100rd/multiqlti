/**
 * new-review-dialog.tsx — the "New consilium review" launcher (button + dialog)
 * for ConsiliumLoopList. Mirrors ProjectSelector's create-dialog pattern (the
 * shared Dialog primitive + a controlled form + a toast on settle).
 *
 * It POSTs `{ repoPath, preset, maxRounds?, baselineCommit?, ref?, engineerInstruction?,
 * skillIds? }` to `/api/consilium-reviews` via the shared apiRequest transport
 * (carries auth + `x-project-id`, same as every project-scoped call). The optional
 * `skillIds` are operator-selected skills whose directives the server appends to the
 * engineer instruction (fenced-as-data, byte-budgeted).
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
import { Checkbox } from "@/components/ui/checkbox";
import { apiRequest } from "@/hooks/use-api";
import { useSkills } from "@/hooks/use-skills";
import { useToast } from "@/hooks/use-toast";
import { parseBranchFromUrl } from "@/components/consilium/parse-branch-url";

/**
 * The presets the backend accepts, with human labels + a one-line description of
 * what each dispute actually reviews (default first). The descriptions mirror the
 * server's objective headers in review-factory.ts (SDLC_HEADER / DIFF_HEADER /
 * FULL_VIABILITY_HEADER) so the UI can't drift from what the debaters are told.
 */
const PRESETS = [
  {
    value: "sdlc-cross-review",
    label: "SDLC cross-review",
    description:
      "Reviews the repo's CURRENT state — correctness, security, design coherence, test coverage, operability.",
  },
  {
    value: "diff-pr-review",
    label: "Diff / PR review",
    description:
      "Reviews a change (baseline..HEAD) — what the diff does: regressions, security, missing tests, blast radius.",
  },
  {
    value: "full-viability",
    label: "Full viability assessment",
    description:
      "Assesses the whole system against its SPEC SET — does the implementation realise the specs, are they buildable.",
  },
] as const;
type Preset = (typeof PRESETS)[number]["value"];

/** The description for the currently-selected preset (Part A: surface the choice). */
function presetDescription(value: Preset): string {
  return PRESETS.find((p) => p.value === value)?.description ?? "";
}

/** The instruction authoring modes (design: replicate task-groups' two modes). */
type InstructionMode = "manual" | "magic";

/**
 * Soft cap on the optional engineer instruction (mirrors the server bound). The
 * counter warns past this; the server is the final arbiter (a 400 surfaces its
 * `error` text verbatim).
 */
const MAX_INSTRUCTION_LEN = 8000;

/** Max skills that may extend one review's instruction (mirrors the server bound). */
const MAX_REVIEW_SKILLS = 5;

/** The first line of a skill's description — a compact one-line hint in the picker. */
function firstLine(text: string | null | undefined): string {
  const line = (text ?? "").split("\n")[0]?.trim() ?? "";
  return line;
}

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
  // "Paste a branch URL / ref" — an additional affordance alongside the dropdown
  // (mirrors the repo `customMode` pattern). When on, the branch control becomes a
  // free-text input that accepts a GitHub/GitLab branch URL OR a bare ref;
  // `parseBranchFromUrl` derives the ref that is actually submitted.
  const [branchCustomMode, setBranchCustomMode] = useState(false);
  const [branchUrlDraft, setBranchUrlDraft] = useState("");
  const [maxRounds, setMaxRounds] = useState("1");
  // Single-verifier re-review: OPTIONAL per-loop review mode. "" = use the instance
  // default (verifyReview.enabled); otherwise pin the mode for this loop. Sent as
  // `reviewMode` only when a non-empty explicit choice is made (additive/back-compat).
  const [reviewMode, setReviewMode] = useState<"" | "full-dispute" | "single-verifier">("");
  const [baselineCommit, setBaselineCommit] = useState("");
  // Optional free-text instruction (tone / requirements for the evaluation). Sent
  // as `engineerInstruction` only when non-empty; the server fences it as data. This
  // is ALWAYS the canonical field that is submitted — in "magic" mode it is
  // pre-filled by a reformulation the operator then reviews/edits (never hidden).
  const [engineerInstruction, setEngineerInstruction] = useState("");
  // Instruction authoring mode. "manual" = write the instruction verbatim (today's
  // behavior); "magic" = write a rough want and reformulate it into a proposal.
  const [instructionMode, setInstructionMode] = useState<InstructionMode>("manual");
  // Magic mode only: the operator's rough "what I want". UNTRUSTED; sent to the
  // reformulate endpoint (which fences it as data) — never submitted directly.
  const [rawWant, setRawWant] = useState("");
  const [reformulating, setReformulating] = useState(false);
  // Optional operator-selected skills whose directives extend the instruction. Sent
  // as `skillIds` (order = priority) only when non-empty; capped at MAX_REVIEW_SKILLS.
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [, navigate] = useLocation();
  const qc = useQueryClient();
  const { toast } = useToast();

  // The active project's non-builtin skills (project-scoped via apiRequest's
  // x-project-id). Powers the optional multi-select below; absent/empty ⇒ the
  // section is hidden entirely (never a dead control).
  const skillsQuery = useSkills({ isBuiltin: false });
  const availableSkills = skillsQuery.data ?? [];
  const atSkillCap = selectedSkillIds.length >= MAX_REVIEW_SKILLS;

  // Toggle a skill in/out of the selection, enforcing the cap on add. Selection
  // order is preserved (it is the priority order the server drops from, last-first).
  const toggleSkill = (id: string) => {
    setSelectedSkillIds((cur) => {
      if (cur.includes(id)) return cur.filter((s) => s !== id);
      if (cur.length >= MAX_REVIEW_SKILLS) return cur;
      return [...cur, id];
    });
  };

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

  // The ref parsed from the pasted URL / bare ref (custom mode only). Shown as a
  // live hint and used as the submitted ref, so the operator always sees what a
  // pasted URL resolved to before starting the review.
  const parsedCustomBranch = parseBranchFromUrl(branchUrlDraft);
  // The single source of truth for the submitted branch: the pasted-URL derivation
  // in custom mode, otherwise the dropdown/free-text `branch`.
  const effectiveBranch = branchCustomMode ? parsedCustomBranch : branch;

  // Enter the paste-URL affordance, seeding the draft from the current selection
  // so a picked branch carries over as an editable starting point.
  const enterBranchCustom = () => {
    setBranchUrlDraft(branch);
    setBranchCustomMode(true);
  };
  // Return to the dropdown, carrying the derived ref back so the choice survives.
  const useBranchPicker = () => {
    setBranch(parseBranchFromUrl(branchUrlDraft));
    setBranchCustomMode(false);
  };

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

  // Magic mode: reformulate the rough want into a PROPOSED instruction. A manual
  // action only (never fires on keystroke). The proposal lands in the editable
  // engineerInstruction textarea for the operator to review + tweak; it is NOT
  // auto-submitted. Transparency by design — magic is a pre-fill, not a hidden
  // transform of what gets sent.
  const handleReformulate = async () => {
    const want = rawWant.trim();
    if (!want) return;
    const path = repoPath.trim();
    if (!path) {
      toast({ title: "Pick a repository first", variant: "destructive" });
      return;
    }
    try {
      setReformulating(true);
      const res = await apiRequest(
        "POST",
        "/api/consilium-reviews/reformulate-instruction",
        { rawWant: want, repoPath: path, preset },
      );
      const proposed =
        res && typeof res === "object" && typeof (res as { proposedInstruction?: unknown }).proposedInstruction === "string"
          ? (res as { proposedInstruction: string }).proposedInstruction
          : "";
      if (!proposed) {
        toast({ title: "No proposal returned", description: "Try again or write the instruction manually.", variant: "destructive" });
        return;
      }
      // Land the proposal in the editable instruction field. The operator reviews /
      // edits it before submitting; the FINAL textarea value is what's sent.
      setEngineerInstruction(proposed);
      toast({ title: "Proposed instruction ready", description: "Review and edit it below before starting the review." });
    } catch (e) {
      toast({
        title: "Reformulation failed",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    } finally {
      setReformulating(false);
    }
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
      skillIds?: string[];
      reviewMode?: "full-dispute" | "single-verifier";
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
    // `effectiveBranch` is the pasted-URL derivation in custom mode, else the
    // dropdown/free-text branch — the SAME `ref` field either way.
    const chosenBranch = effectiveBranch.trim();
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
    // Skills → `skillIds` (order = priority). Send only when some are selected; the
    // server resolves them project-scoped and appends their directives to the
    // instruction under a byte budget (dropping whole skills if it must).
    if (selectedSkillIds.length > 0) body.skillIds = selectedSkillIds;
    // Review mode → `reviewMode` only when an EXPLICIT choice is made; "" leaves it
    // to the server's operator default (verifyReview.enabled), preserving today's flow.
    if (reviewMode) body.reviewMode = reviewMode;

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
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>New consilium review</DialogTitle>
        </DialogHeader>
        <div className="min-w-0 space-y-4 py-4">
          {/* PRESET — the review "shape". Prominent, with a one-line description of
              each option in the dropdown AND a live description of the current choice
              below the control, so the operator always sees WHAT they picked. */}
          <div className="space-y-2">
            <Label>Preset</Label>
            <Select value={preset} onValueChange={(v) => setPreset(v as Preset)}>
              <SelectTrigger data-testid="new-review-preset">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PRESETS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    <span className="flex flex-col">
                      <span className="font-medium">{p.label}</span>
                      <span className="text-xs text-muted-foreground">{p.description}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p
              className="text-xs text-muted-foreground"
              data-testid="new-review-preset-description"
            >
              {presetDescription(preset)}
            </p>
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
              loading / failure / free-text fallbacks so it's never a dead end,
              PLUS a "paste a branch URL / ref" affordance (mirrors the repo
              customMode toggle) that derives the submitted ref from a pasted
              GitHub/GitLab URL or a bare ref. */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor={branchCustomMode ? "new-review-branch-url" : undefined}>
                Branch
              </Label>
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
                onClick={branchCustomMode ? useBranchPicker : enterBranchCustom}
                data-testid="new-review-toggle-branch-url"
              >
                {branchCustomMode ? "Pick from the list instead" : "Paste a branch URL / ref"}
              </button>
            </div>
            {branchCustomMode ? (
              <>
                <Input
                  id="new-review-branch-url"
                  value={branchUrlDraft}
                  onChange={(e) => setBranchUrlDraft(e.target.value)}
                  placeholder="https://github.com/owner/repo/tree/release/1.2 — or a bare ref"
                  data-testid="new-review-branch-url"
                />
                <p className="text-xs text-muted-foreground">
                  {parsedCustomBranch ? (
                    <>
                      Will review ref{" "}
                      <span
                        className="font-mono text-foreground"
                        data-testid="new-review-branch-url-parsed"
                      >
                        {parsedCustomBranch}
                      </span>
                      . Paste a GitHub/GitLab branch URL (…/tree/&lt;branch&gt;) or a
                      bare ref.
                    </>
                  ) : (
                    "Paste a GitHub/GitLab branch URL (…/tree/<branch>) or a bare ref — leave empty for the repo's current branch (HEAD)."
                  )}
                </p>
              </>
            ) : branchesLoading ? (
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
                {/* Bounded, scrollable list: the shared SelectContent's base
                    max-height resolves tiny when the trigger sits low in the
                    viewport-capped dialog, clipping a long branch list. A fixed
                    max-h (twMerge wins over the base var) + overflow-y keeps the
                    portal popover itself scrolling, independent of the dialog. */}
                <SelectContent className="max-h-60 overflow-y-auto">
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

          {/* Re-review mode — HOW rounds AFTER the first are run. Optional: the
              instance default (server) is used unless pinned here. Round 1 is always
              the full debate regardless of this choice. */}
          <div className="space-y-2">
            <Label>
              Re-review mode <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Select
              value={reviewMode || "default"}
              onValueChange={(v) =>
                setReviewMode(v === "default" ? "" : (v as "full-dispute" | "single-verifier"))
              }
            >
              <SelectTrigger data-testid="new-review-mode">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">
                  <span className="flex flex-col">
                    <span className="font-medium">Instance default</span>
                    <span className="text-xs text-muted-foreground">
                      Use the server's configured default for re-review rounds.
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="full-dispute">
                  <span className="flex flex-col">
                    <span className="font-medium">Full dispute (every round)</span>
                    <span className="text-xs text-muted-foreground">
                      Re-run the full debate panel (debaters + judge) every round.
                    </span>
                  </span>
                </SelectItem>
                <SelectItem value="single-verifier">
                  <span className="flex flex-col">
                    <span className="font-medium">Single verifier (confirm fixes)</span>
                    <span className="text-xs text-muted-foreground">
                      Re-review rounds run ONE fresh, independent verifier that confirms
                      the prior findings were closed. Round 1 stays the full debate.
                    </span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
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
              as data and bounds the length. TWO authoring modes (mirrors the old
              task-group flow): MANUAL writes it verbatim; MAGIC drafts a rough want
              and reformulates it into a proposal the operator then reviews + edits.
              The engineerInstruction textarea is ALWAYS the field that is submitted. */}
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label>Instructions to the engineer</Label>
              {/* Mode toggle — a compact segmented control. Switching does NOT clear
                  the instruction, so a magic proposal survives a flip to manual. */}
              <div
                className="inline-flex overflow-hidden rounded border text-xs"
                role="tablist"
                aria-label="Instruction authoring mode"
                data-testid="new-review-instruction-mode"
              >
                {(["manual", "magic"] as InstructionMode[]).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="tab"
                    aria-selected={instructionMode === m}
                    onClick={() => setInstructionMode(m)}
                    className={
                      "px-2.5 py-1 capitalize transition-colors " +
                      (instructionMode === m
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted/50")
                    }
                    data-testid={`new-review-instruction-mode-${m}`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* MAGIC mode: the rough want + a manual Reformulate action. No auto-calls
                on keystroke; the button drives the single reformulation. The proposal
                lands in the editable instruction textarea below (review + edit before
                submit) — magic never silently changes what is sent. */}
            {instructionMode === "magic" && (
              <div className="space-y-2 rounded border border-dashed p-3">
                <Label htmlFor="new-review-raw-want" className="text-xs">
                  What I want{" "}
                  <span className="text-muted-foreground">(rough — an agent will draft a precise instruction)</span>
                </Label>
                <Textarea
                  id="new-review-raw-want"
                  value={rawWant}
                  onChange={(e) => setRawWant(e.target.value)}
                  placeholder="E.g.: I mostly care that the new auth code is safe and actually tested — be tough on it."
                  rows={2}
                  data-testid="new-review-raw-want"
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    You review and edit the proposal before it is used.
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={handleReformulate}
                    disabled={!rawWant.trim() || reformulating}
                    data-testid="new-review-reformulate"
                  >
                    {reformulating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Reformulate
                  </Button>
                </div>
              </div>
            )}

            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="new-review-engineer-instruction" className="text-xs text-muted-foreground">
                {instructionMode === "magic"
                  ? "Proposed instruction — review & edit before starting"
                  : "Tone / requirements for the evaluation"}
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
              placeholder={
                instructionMode === "magic"
                  ? "The reformulated instruction will appear here — you can edit it freely."
                  : "E.g.: evaluate strictly on security; require tests for every P0; keep the tone concise."
              }
              rows={3}
              data-testid="new-review-engineer-instruction"
            />
            {engineerInstruction.length > MAX_INSTRUCTION_LEN && (
              <p className="text-xs text-destructive">
                Too long — the server accepts at most {MAX_INSTRUCTION_LEN} characters.
              </p>
            )}
          </div>

          {/* Optional SKILLS — each selected skill's directive is appended to the
              engineer instruction (server-side, fenced-as-data, byte-budgeted). Hidden
              when the project has no skills, so it is never an empty dead control. */}
          {availableSkills.length > 0 && (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between gap-2">
                <Label>
                  Skills{" "}
                  <span className="text-muted-foreground">(extend the instruction)</span>
                </Label>
                <span
                  className="text-xs tabular-nums text-muted-foreground"
                  data-testid="new-review-skills-counter"
                >
                  {selectedSkillIds.length}/{MAX_REVIEW_SKILLS}
                </span>
              </div>
              <div
                className="max-h-40 space-y-1 overflow-y-auto rounded border p-2"
                data-testid="new-review-skills"
              >
                {availableSkills.map((skill) => {
                  const checked = selectedSkillIds.includes(skill.id);
                  const disabled = !checked && atSkillCap;
                  const hint = firstLine(skill.description);
                  return (
                    <label
                      key={skill.id}
                      className={
                        "flex items-start gap-2 rounded p-1.5 text-sm " +
                        (disabled
                          ? "cursor-not-allowed opacity-50"
                          : "cursor-pointer hover:bg-muted/50")
                      }
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggleSkill(skill.id)}
                        data-testid={`new-review-skill-${skill.id}`}
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="font-medium">{skill.name}</span>
                        {hint && (
                          <span className="block truncate text-xs text-muted-foreground">
                            {hint}
                          </span>
                        )}
                      </span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                Each selected skill's directive is appended to the instruction above,
                in the order picked. At most {MAX_REVIEW_SKILLS}.
              </p>
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

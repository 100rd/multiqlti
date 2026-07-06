/**
 * Roles.tsx — the ROLE-1 Standing Roles page (standing-role.md §3/§8).
 *
 * Lists the project's Standing Roles, lets you DEFINE one (name + persona + a skills
 * multi-select from the project registry + a loop template), and manually WAKE a role
 * (asks repoPath + focus) — which spawns ONE ephemeral consilium loop and links to it.
 * No triggers/concerns (ROLE-2) and no role-scoped experience (ROLE-3) here — a wake
 * is an explicit user action (§6).
 */
import { useState } from "react";
import { useLocation } from "wouter";
import { UserCog, Plus, Trash2, Zap, Eye, Radio } from "lucide-react";
import { CONSILIUM_REVIEW_PRESETS, REVIEW_MODES } from "@shared/types";
import type { ConsiliumReviewPreset, ReviewMode, StandingRoleConcern } from "@shared/types";
import type { StandingRoleRow } from "@shared/schema";
import { useSkills } from "@/hooks/use-skills";
import {
  useRoles,
  useCreateRole,
  useDeleteRole,
  useWakeRole,
  useAddConcern,
  useDeleteConcern,
  useWokenLoops,
} from "@/hooks/use-roles";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const MAX_ROLE_SKILLS = 5;

// ─── Create-role dialog ───────────────────────────────────────────────────────

function CreateRoleDialog() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [preset, setPreset] = useState<ConsiliumReviewPreset>("sdlc-cross-review");
  const [maxRounds, setMaxRounds] = useState("1");
  const [reviewMode, setReviewMode] = useState<"" | ReviewMode>("");
  const [enabled, setEnabled] = useState(true);
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([]);

  const { toast } = useToast();
  const createRole = useCreateRole();
  const skillsQuery = useSkills({ isBuiltin: false });
  const availableSkills = skillsQuery.data ?? [];

  const toggleSkill = (id: string) => {
    setSelectedSkillIds((cur) => {
      if (cur.includes(id)) return cur.filter((s) => s !== id);
      if (cur.length >= MAX_ROLE_SKILLS) return cur;
      return [...cur, id];
    });
  };

  const reset = () => {
    setName("");
    setPersona("");
    setPreset("sdlc-cross-review");
    setMaxRounds("1");
    setReviewMode("");
    setEnabled(true);
    setSelectedSkillIds([]);
  };

  const submit = async () => {
    if (!name.trim() || !persona.trim()) {
      toast({ title: "Name and persona are required", variant: "destructive" });
      return;
    }
    const rounds = Number(maxRounds);
    try {
      await createRole.mutateAsync({
        name: name.trim(),
        persona: persona.trim(),
        skills: selectedSkillIds,
        loopTemplate: {
          preset,
          ...(Number.isInteger(rounds) && rounds > 0 ? { maxRounds: rounds } : {}),
          ...(reviewMode ? { reviewMode } : {}),
        },
        enabled,
      });
      toast({ title: "Role created" });
      reset();
      setOpen(false);
    } catch (e) {
      toast({
        title: "Failed to create role",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" data-testid="new-role-button">
          <Plus className="h-4 w-4 mr-2" />
          New Role
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Define a Standing Role</DialogTitle>
          <DialogDescription>
            A named identity (persona + skills + loop template) you can later wake to
            spawn a consilium loop.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="role-name">Name</Label>
            <Input
              id="role-name"
              data-testid="role-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="devops-reviewer"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="role-persona">Persona (standing instruction)</Label>
            <Textarea
              id="role-persona"
              data-testid="role-persona-input"
              value={persona}
              onChange={(e) => setPersona(e.target.value)}
              rows={4}
              placeholder="You are a senior DevOps reviewer. Prioritise CIS/security, cost, and breaking-change surface…"
            />
          </div>

          <div className="space-y-1.5">
            <Label>Skills {selectedSkillIds.length > 0 && `(${selectedSkillIds.length}/${MAX_ROLE_SKILLS})`}</Label>
            {availableSkills.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No project skills available. Create skills first to give the role a capability.
              </p>
            ) : (
              <div className="max-h-40 overflow-y-auto rounded-md border p-2 space-y-1.5">
                {availableSkills.map((s) => {
                  const checked = selectedSkillIds.includes(s.id);
                  const disabled = !checked && selectedSkillIds.length >= MAX_ROLE_SKILLS;
                  return (
                    <label
                      key={s.id}
                      className="flex items-center gap-2 text-sm cursor-pointer"
                      data-testid={`role-skill-${s.id}`}
                    >
                      <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={() => toggleSkill(s.id)}
                      />
                      <span>{s.name}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Preset</Label>
              <Select value={preset} onValueChange={(v) => setPreset(v as ConsiliumReviewPreset)}>
                <SelectTrigger data-testid="role-preset-select">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CONSILIUM_REVIEW_PRESETS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {p}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="role-max-rounds">Max rounds</Label>
              <Input
                id="role-max-rounds"
                type="number"
                min={1}
                max={6}
                value={maxRounds}
                onChange={(e) => setMaxRounds(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Review mode</Label>
            <Select
              value={reviewMode || "default"}
              onValueChange={(v) => setReviewMode(v === "default" ? "" : (v as ReviewMode))}
            >
              <SelectTrigger data-testid="role-review-mode-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="default">Operator default</SelectItem>
                {REVIEW_MODES.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-2">
            <Switch id="role-enabled" checked={enabled} onCheckedChange={setEnabled} />
            <Label htmlFor="role-enabled">Enabled</Label>
          </div>
        </div>

        <DialogFooter>
          <Button
            onClick={submit}
            disabled={createRole.isPending}
            data-testid="role-create-submit"
          >
            {createRole.isPending ? "Creating…" : "Create Role"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Wake dialog ────────────────────────────────────────────────────────────

function WakeRoleDialog({ role }: { role: StandingRoleRow }) {
  const [open, setOpen] = useState(false);
  const [repoPath, setRepoPath] = useState("");
  const [focus, setFocus] = useState("");
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const wake = useWakeRole();

  const submit = async () => {
    if (!repoPath.trim() || !focus.trim()) {
      toast({ title: "Repo path and focus are required", variant: "destructive" });
      return;
    }
    try {
      const loop = await wake.mutateAsync({ id: role.id, repoPath: repoPath.trim(), focus: focus.trim() });
      toast({ title: `Woke "${role.name}" — loop started` });
      setOpen(false);
      const id = typeof loop?.id === "string" ? loop.id : undefined;
      if (id) navigate(`/consilium-loops/${id}`);
    } catch (e) {
      // apiRequest threads the server's 400 message (e.g. "…not in the allowed repo
      // paths") verbatim into Error.message.
      toast({
        title: "Failed to wake role",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="secondary" data-testid={`wake-role-${role.id}`} disabled={!role.enabled}>
          <Zap className="h-4 w-4 mr-2" />
          Wake
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Wake "{role.name}"</DialogTitle>
          <DialogDescription>
            Spawns one consilium loop using this role's persona, skills, and loop template.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="wake-repo">Repo path</Label>
            <Input
              id="wake-repo"
              data-testid="wake-repo-input"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/repos/my-iac"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wake-focus">Focus</Label>
            <Textarea
              id="wake-focus"
              data-testid="wake-focus-input"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={3}
              placeholder="Review the new Terraform module version for CIS/security regressions."
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={wake.isPending} data-testid="wake-submit">
            {wake.isPending ? "Waking…" : "Wake"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Add-concern dialog (ROLE-2) ──────────────────────────────────────────────

function AddConcernDialog({ role }: { role: StandingRoleRow }) {
  const [open, setOpen] = useState(false);
  const [triggerType, setTriggerType] = useState<"file_change" | "github_event">("file_change");
  const [repoPath, setRepoPath] = useState("");
  const [focus, setFocus] = useState("");
  const [watchPath, setWatchPath] = useState("");
  const [patterns, setPatterns] = useState("");
  const [repository, setRepository] = useState("");
  const [events, setEvents] = useState("pull_request");
  const { toast } = useToast();
  const add = useAddConcern();

  const reset = () => {
    setTriggerType("file_change");
    setRepoPath("");
    setFocus("");
    setWatchPath("");
    setPatterns("");
    setRepository("");
    setEvents("pull_request");
  };

  const submit = async () => {
    if (!repoPath.trim() || !focus.trim()) {
      toast({ title: "Repo path and focus are required", variant: "destructive" });
      return;
    }
    const trigger =
      triggerType === "file_change"
        ? {
            type: "file_change" as const,
            filter: {
              watchPath: watchPath.trim() || repoPath.trim(),
              patterns: patterns.trim() ? patterns.split(",").map((p) => p.trim()).filter(Boolean) : undefined,
            },
          }
        : {
            type: "github_event" as const,
            filter: {
              repository: repository.trim(),
              events: events.trim() ? events.split(",").map((e) => e.trim()).filter(Boolean) : undefined,
            },
          };
    if (triggerType === "file_change" && !(watchPath.trim() || repoPath.trim())) {
      toast({ title: "A watch path is required", variant: "destructive" });
      return;
    }
    if (triggerType === "github_event" && !repository.trim()) {
      toast({ title: "A repository (owner/repo) is required", variant: "destructive" });
      return;
    }
    try {
      await add.mutateAsync({ roleId: role.id, repoPath: repoPath.trim(), focus: focus.trim(), trigger });
      toast({ title: "Concern added — trigger bound" });
      reset();
      setOpen(false);
    } catch (e) {
      toast({
        title: "Failed to add concern",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline" data-testid={`add-concern-${role.id}`}>
          <Radio className="h-4 w-4 mr-2" />
          Add concern
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Watch a concern</DialogTitle>
          <DialogDescription>
            Bind a trigger to "{role.name}". When it fires, the role wakes and spawns a
            review-only loop on the target repo using this focus.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Trigger type</Label>
            <Select value={triggerType} onValueChange={(v) => setTriggerType(v as "file_change" | "github_event")}>
              <SelectTrigger data-testid="concern-trigger-type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="file_change">file change</SelectItem>
                <SelectItem value="github_event">github event</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {triggerType === "file_change" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="concern-watch">Watch path</Label>
                <Input
                  id="concern-watch"
                  data-testid="concern-watch-input"
                  value={watchPath}
                  onChange={(e) => setWatchPath(e.target.value)}
                  placeholder="/repos/iac/modules"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="concern-patterns">Patterns (comma-separated, optional)</Label>
                <Input
                  id="concern-patterns"
                  value={patterns}
                  onChange={(e) => setPatterns(e.target.value)}
                  placeholder="**/*.tf, !**/.terraform/**"
                />
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="concern-repo">Repository (owner/repo)</Label>
                <Input
                  id="concern-repo"
                  data-testid="concern-repository-input"
                  value={repository}
                  onChange={(e) => setRepository(e.target.value)}
                  placeholder="my-org/iac"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="concern-events">Events (comma-separated)</Label>
                <Input
                  id="concern-events"
                  value={events}
                  onChange={(e) => setEvents(e.target.value)}
                  placeholder="pull_request, push"
                />
              </div>
            </>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="concern-repopath">Target repo path</Label>
            <Input
              id="concern-repopath"
              data-testid="concern-repopath-input"
              value={repoPath}
              onChange={(e) => setRepoPath(e.target.value)}
              placeholder="/repos/iac"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="concern-focus">Focus</Label>
            <Textarea
              id="concern-focus"
              data-testid="concern-focus-input"
              value={focus}
              onChange={(e) => setFocus(e.target.value)}
              rows={2}
              placeholder="A new or changed Terraform module version — review for CIS/security regressions."
            />
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={add.isPending} data-testid="concern-submit">
            {add.isPending ? "Adding…" : "Add concern"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Concern list + woken loops (ROLE-2) ──────────────────────────────────────

function ConcernRow({ role, concern }: { role: StandingRoleRow; concern: StandingRoleConcern }) {
  const { toast } = useToast();
  const del = useDeleteConcern();
  const remove = async () => {
    try {
      await del.mutateAsync({ roleId: role.id, concernId: concern.id });
      toast({ title: "Concern removed" });
    } catch (e) {
      toast({ title: "Failed to remove concern", description: e instanceof Error ? e.message : undefined, variant: "destructive" });
    }
  };
  return (
    <div className="flex items-start justify-between gap-2 rounded-md border p-2" data-testid={`concern-${concern.id}`}>
      <div className="min-w-0 space-y-0.5">
        <div className="flex items-center gap-1.5">
          <Badge variant="outline" className="text-xs">{concern.trigger.type}</Badge>
          {concern.enabled === false && <Badge variant="outline" className="text-xs">disabled</Badge>}
          <span className="font-mono text-xs truncate">{concern.repoPath}</span>
        </div>
        <p className="text-xs text-muted-foreground line-clamp-2">{concern.focus}</p>
      </div>
      <Button
        size="sm"
        variant="ghost"
        onClick={remove}
        disabled={del.isPending}
        data-testid={`delete-concern-${concern.id}`}
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function WokenLoops({ roleId }: { roleId: string }) {
  const { data } = useWokenLoops(roleId);
  const loops = data ?? [];
  if (loops.length === 0) {
    return <p className="text-xs text-muted-foreground">No loops woken yet.</p>;
  }
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Eye className="h-3.5 w-3.5" />
      <span data-testid={`woken-count-${roleId}`}>{loops.length} loop{loops.length === 1 ? "" : "s"} woken</span>
    </div>
  );
}

// ─── Role card ──────────────────────────────────────────────────────────────

function RoleCard({ role }: { role: StandingRoleRow }) {
  const { toast } = useToast();
  const del = useDeleteRole();
  const concerns = (role.concerns ?? []) as StandingRoleConcern[];

  const remove = async () => {
    try {
      await del.mutateAsync(role.id);
      toast({ title: "Role deleted" });
    } catch (e) {
      toast({
        title: "Failed to delete role",
        description: e instanceof Error ? e.message : undefined,
        variant: "destructive",
      });
    }
  };

  const tpl = role.loopTemplate;
  return (
    <Card data-testid={`role-card-${role.id}`}>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2">
            {role.name}
            {!role.enabled && <Badge variant="outline">disabled</Badge>}
          </CardTitle>
          <Badge variant="secondary">{tpl.preset}</Badge>
        </div>
        <CardDescription className="line-clamp-3">{role.persona}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-1">
          {role.skills.length === 0 ? (
            <span className="text-sm text-muted-foreground">No skills</span>
          ) : (
            role.skills.map((sid) => (
              <Badge key={sid} variant="outline" className="font-mono text-xs">
                {sid}
              </Badge>
            ))
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          maxRounds: {tpl.maxRounds ?? "default"} · reviewMode: {tpl.reviewMode ?? "operator default"}
        </p>

        {/* ROLE-2: concerns the role watches (each bound to a trigger) + woken loops. */}
        <div className="space-y-1.5 pt-1">
          <div className="flex items-center justify-between">
            <Label className="text-xs">Concerns ({concerns.length})</Label>
            <AddConcernDialog role={role} />
          </div>
          {concerns.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No concerns. Add one to bind a trigger — a firing wakes this role.
            </p>
          ) : (
            <div className="space-y-1.5">
              {concerns.map((c) => (
                <ConcernRow key={c.id} role={role} concern={c} />
              ))}
            </div>
          )}
          <WokenLoops roleId={role.id} />
        </div>
      </CardContent>
      <CardFooter className="gap-2">
        <WakeRoleDialog role={role} />
        <Button
          size="sm"
          variant="ghost"
          onClick={remove}
          disabled={del.isPending}
          data-testid={`delete-role-${role.id}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </CardFooter>
    </Card>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

export default function Roles() {
  const { data: roles, isLoading, isError } = useRoles();

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCog className="h-5 w-5" />
          <h1 className="text-xl font-semibold">Standing Roles</h1>
        </div>
        <CreateRoleDialog />
      </div>

      {isLoading && <p className="text-muted-foreground">Loading roles…</p>}
      {isError && <p className="text-destructive">Failed to load roles.</p>}
      {!isLoading && !isError && (roles?.length ?? 0) === 0 && (
        <p className="text-muted-foreground">
          No roles yet. Define one to save a persona + skills + loop template you can wake on demand.
        </p>
      )}

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {(roles ?? []).map((role) => (
          <RoleCard key={role.id} role={role} />
        ))}
      </div>
    </div>
  );
}

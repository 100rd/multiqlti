import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { Link } from "wouter";
import { FolderGit2, Plus, Trash2, RefreshCw, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WorkspaceRow } from "@shared/schema";
import { IndexStatusBadge } from "@/components/workspace/IndexStatusBadge";
import { useIndexTrigger } from "@/hooks/useIndexTrigger";
import type { WorkspaceIndexStatus } from "@/hooks/useWorkspaceSocket";

// WorkspaceRow extended with Phase 6.9 indexStatus field (backend adds this column)
type WorkspaceRowWithIndex = WorkspaceRow & { indexStatus?: WorkspaceIndexStatus };

// ─── API helpers ─────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

function buildAuthHeaders(): Record<string, string> {
  const token = getAuthToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: buildAuthHeaders() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...buildAuthHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error: string }).error ?? "Request failed");
  }
  return res.json();
}

// ─── Connect form ─────────────────────────────────────────────────────────────

interface ConnectFormProps {
  onDone: () => void;
}

function ConnectForm({ onDone }: ConnectFormProps) {
  const [type, setType] = useState<"local" | "remote">("local");
  const [localPath, setLocalPath] = useState("");
  const [remoteUrl, setRemoteUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const qc = useQueryClient();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsSubmitting(true);

    try {
      if (type === "local") {
        await postJson("/api/workspaces", { type: "local", path: localPath, name: name || undefined });
      } else {
        await postJson("/api/workspaces", {
          type: "remote",
          url: remoteUrl,
          branch: branch || "main",
          name: name || undefined,
        });
      }
      await qc.invalidateQueries({ queryKey: ["workspaces"] });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="flex gap-2">
        {(["local", "remote"] as const).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setType(t)}
            className={cn(
              "text-xs px-3 py-1.5 rounded border transition-colors capitalize",
              type === t
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            {t}
          </button>
        ))}
      </div>

      {type === "local" ? (
        <div>
          <label className="text-xs text-muted-foreground">Local path</label>
          <input
            type="text"
            value={localPath}
            onChange={(e) => setLocalPath(e.target.value)}
            placeholder="/Users/you/projects/myapp"
            required
            className="mt-1 w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
        </div>
      ) : (
        <>
          <div>
            <label className="text-xs text-muted-foreground">Repository URL (https://)</label>
            <input
              type="url"
              value={remoteUrl}
              onChange={(e) => setRemoteUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              required
              className="mt-1 w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Branch</label>
            <input
              type="text"
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="main"
              className="mt-1 w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
            />
          </div>
        </>
      )}

      <div>
        <label className="text-xs text-muted-foreground">Name (optional)</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="My Project"
          className="mt-1 w-full text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={isSubmitting}
          className="text-xs px-4 py-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {isSubmitting ? "Connecting..." : "Connect"}
        </button>
        <button
          type="button"
          onClick={onDone}
          className="text-xs px-4 py-2 rounded-md border border-border text-muted-foreground hover:border-primary/50 transition-colors"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

// ─── Status badge ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: WorkspaceRow["status"] }) {
  const config = {
    active: "bg-green-500/10 text-green-500",
    syncing: "bg-amber-500/10 text-amber-500",
    error: "bg-red-500/10 text-red-500",
  };
  return (
    <span className={cn("text-[10px] px-1.5 py-0.5 rounded font-medium capitalize", config[status])}>
      {status}
    </span>
  );
}

// ─── Workspace card ───────────────────────────────────────────────────────────

function WorkspaceCard({ workspace }: { workspace: WorkspaceRowWithIndex }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const indexTrigger = useIndexTrigger(workspace.id);

  const deleteMutation = useMutation({
    mutationFn: () =>
      fetch(`/api/workspaces/${workspace.id}`, { method: "DELETE", headers: buildAuthHeaders() }).then((r) => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
    onError: (err: Error) => toast({ variant: "destructive", title: "Delete failed", description: err.message }),
  });

  const syncMutation = useMutation({
    mutationFn: () => postJson(`/api/workspaces/${workspace.id}/sync`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workspaces"] }),
    onError: (err: Error) => toast({ variant: "destructive", title: "Sync failed", description: err.message }),
  });

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <FolderGit2 className="h-4 w-4 text-primary shrink-0" />
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{workspace.name}</p>
            <p className="text-xs text-muted-foreground font-mono truncate">{workspace.path}</p>
          </div>
        </div>
        <StatusBadge status={workspace.status} />
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <IndexStatusBadge
          status={workspace.indexStatus ?? "idle"}
          onTrigger={() => indexTrigger.mutate()}
          disabled={indexTrigger.isPending || workspace.indexStatus === "indexing"}
        />
      </div>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="capitalize">{workspace.type}</span>
        <span>·</span>
        <span className="font-mono">{workspace.branch}</span>
        {workspace.lastSyncAt && (
          <>
            <span>·</span>
            <span>synced {new Date(workspace.lastSyncAt).toLocaleString()}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Link href={`/workspaces/${workspace.id}`}>
          <button className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-primary text-primary hover:bg-primary/10 transition-colors">
            <ExternalLink className="h-3 w-3" />
            Open
          </button>
        </Link>

        {workspace.type === "remote" && (
          <button
            onClick={() => syncMutation.mutate()}
            disabled={syncMutation.isPending || workspace.status === "syncing"}
            className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-border text-muted-foreground hover:border-primary/50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={cn("h-3 w-3", syncMutation.isPending && "animate-spin")} />
            Sync
          </button>
        )}

        <button
          onClick={() => {
            if (confirm(`Remove workspace "${workspace.name}"?`)) deleteMutation.mutate();
          }}
          disabled={deleteMutation.isPending}
          className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded border border-border text-muted-foreground hover:border-red-500/50 hover:text-red-500 disabled:opacity-50 transition-colors ml-auto"
        >
          <Trash2 className="h-3 w-3" />
          Remove
        </button>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function WorkspaceList() {
  const [showForm, setShowForm] = useState(false);

  const { data: workspaceList, isLoading } = useQuery<WorkspaceRowWithIndex[]>({
    queryKey: ["workspaces"],
    queryFn: () => fetchJson("/api/workspaces"),
  });

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 shrink-0">
        <h1 className="text-base font-semibold">Code Workspaces</h1>
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          Connect Workspace
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {showForm && (
          <div className="rounded-lg border border-border bg-card p-5">
            <h2 className="text-sm font-medium mb-4">Connect a Workspace</h2>
            <ConnectForm onDone={() => setShowForm(false)} />
          </div>
        )}

        {isLoading ? (
          <div className="grid gap-3">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-lg border border-border bg-card p-4 animate-pulse h-28" />
            ))}
          </div>
        ) : !workspaceList || workspaceList.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-center">
            <FolderGit2 className="h-10 w-10 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">No workspaces connected yet.</p>
            <p className="text-xs text-muted-foreground mt-1">
              Connect a local path or clone a remote repository to get started.
            </p>
          </div>
        ) : (
          <div className="grid gap-3">
            {workspaceList.map((ws) => (
              <WorkspaceCard key={ws.id} workspace={ws} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

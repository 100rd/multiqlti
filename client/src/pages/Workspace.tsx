import { useState } from "react";
import { useRoute } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, GitBranch, Eye, MessageSquare, Code2, Settings2, Network, Search } from "lucide-react";
import { cn } from "@/lib/utils";
import { FileTree } from "@/components/workspace/FileTree";
import { CodeViewer } from "@/components/workspace/CodeViewer";
import { ReviewPanel } from "@/components/workspace/ReviewPanel";
import { ChatPanel } from "@/components/workspace/ChatPanel";
import { ConfigDiffView } from "@/components/workspace/ConfigDiffView";
import { DependencyGraph } from "@/components/workspace/DependencyGraph";
import { SymbolSearch } from "@/components/workspace/SymbolSearch";
import { IndexStatusBadge } from "@/components/workspace/IndexStatusBadge";
import { useIndexTrigger } from "@/hooks/useIndexTrigger";
import { useWorkspaceSocket } from "@/hooks/useWorkspaceSocket";
import type { WorkspaceRow } from "@shared/schema";
import type { FileEntry, GitStatus, ReviewResult } from "@shared/types";
import type { Model } from "@shared/schema";
import type { WorkspaceIndexStatus } from "@/hooks/useWorkspaceSocket";
import type { SymbolSearchResult } from "@/hooks/useSymbolSearch";

type WorkspaceRowWithIndex = WorkspaceRow & { indexStatus?: WorkspaceIndexStatus };

// ─── API helpers ─────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error((err as { error: string }).error ?? "Request failed");
  }
  return res.json();
}

// ─── Panel tab ────────────────────────────────────────────────────────────────

type RightPanel = "chat" | "review" | "symbols";

// ─── Status indicator ─────────────────────────────────────────────────────────

function GitStatusBadge({ status }: { status: GitStatus }) {
  const total = status.modified.length + status.staged.length + status.untracked.length;
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <GitBranch className="h-3.5 w-3.5" />
      <span className="font-mono">{status.branch}</span>
      {total > 0 && (
        <span className="bg-amber-500/10 text-amber-500 px-1.5 py-0.5 rounded text-[10px] font-semibold">
          {total} changed
        </span>
      )}
    </div>
  );
}

// ─── Model selector ───────────────────────────────────────────────────────────

interface ModelSelectorProps {
  models: Model[];
  selected: string[];
  onChange: (slugs: string[]) => void;
  single?: boolean;
}

function ModelSelector({ models, selected, onChange, single }: ModelSelectorProps) {
  const active = models.filter((m) => m.isActive);

  const toggle = (slug: string) => {
    if (single) {
      onChange([slug]);
      return;
    }
    if (selected.includes(slug)) {
      onChange(selected.filter((s) => s !== slug));
    } else {
      onChange([...selected, slug]);
    }
  };

  return (
    <div className="flex flex-wrap gap-1">
      {active.map((m) => (
        <button
          key={m.slug}
          onClick={() => toggle(m.slug)}
          className={cn(
            "text-[10px] px-2 py-0.5 rounded border transition-colors font-mono",
            selected.includes(m.slug)
              ? "bg-primary text-primary-foreground border-primary"
              : "border-border text-muted-foreground hover:border-primary/50",
          )}
        >
          {m.slug}
        </button>
      ))}
    </div>
  );
}

// ─── Main view tabs ───────────────────────────────────────────────────────────

type MainView = "files" | "graph";

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function Workspace() {
  const [, params] = useRoute<{ id: string }>("/workspaces/:id");
  const workspaceId = params?.id ?? "";

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [fileContent, setFileContent] = useState<string>("");
  const [rightPanel, setRightPanel] = useState<RightPanel>("chat");
  const [reviewModels, setReviewModels] = useState<string[]>([]);
  const [chatModel, setChatModel] = useState<string[]>([]);
  const [reviewResults, setReviewResults] = useState<Record<string, ReviewResult>>({});
  const [isReviewing, setIsReviewing] = useState(false);
  const [showConfigDiff, setShowConfigDiff] = useState(false);
  const [mainView, setMainView] = useState<MainView>("files");
  const qc = useQueryClient();

  const indexTrigger = useIndexTrigger(workspaceId);
  const { indexStatus } = useWorkspaceSocket(workspaceId);

  const { data: workspace } = useQuery<WorkspaceRowWithIndex>({
    queryKey: ["workspace", workspaceId],
    queryFn: () => fetchJson(`/api/workspaces/${workspaceId}`),
    enabled: !!workspaceId,
  });

  const { data: files } = useQuery<FileEntry[]>({
    queryKey: ["workspace-files", workspaceId],
    queryFn: () => fetchJson(`/api/workspaces/${workspaceId}/files`),
    enabled: !!workspaceId,
  });

  const { data: gitStatus } = useQuery<GitStatus>({
    queryKey: ["workspace-git-status", workspaceId],
    queryFn: () => fetchJson(`/api/workspaces/${workspaceId}/git/status`),
    enabled: !!workspaceId,
  });

  const { data: models } = useQuery<Model[]>({
    queryKey: ["models"],
    queryFn: () => fetchJson("/api/models"),
  });

  const syncMutation = useMutation({
    mutationFn: () => postJson(`/api/workspaces/${workspaceId}/sync`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workspace", workspaceId] });
      qc.invalidateQueries({ queryKey: ["workspace-files", workspaceId] });
    },
  });

  const loadDirContents = async (dirPath: string): Promise<FileEntry[]> => {
    return fetchJson(`/api/workspaces/${workspaceId}/files?path=${encodeURIComponent(dirPath)}`);
  };

  const handleFileSelect = async (filePath: string) => {
    setSelectedFile(filePath);
    try {
      const data = await fetchJson<{ path: string; content: string }>(
        `/api/workspaces/${workspaceId}/files/${encodeURIComponent(filePath)}`,
      );
      setFileContent(data.content);
    } catch {
      setFileContent("[Could not read file]");
    }
  };

  const handleReview = async () => {
    if (!selectedFile || reviewModels.length === 0) return;
    setIsReviewing(true);
    setRightPanel("review");
    try {
      const results = await postJson<Record<string, ReviewResult>>(
        `/api/workspaces/${workspaceId}/review`,
        { filePaths: [selectedFile], models: reviewModels },
      );
      setReviewResults(results);
    } finally {
      setIsReviewing(false);
    }
  };

  if (!workspace) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading workspace...</p>
      </div>
    );
  }

  const activeModels = models?.filter((m) => m.isActive) ?? [];
  const chatModelSlug = chatModel[0] ?? activeModels[0]?.slug ?? "";

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="h-14 border-b border-border flex items-center gap-4 px-4 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Code2 className="h-4 w-4 text-primary shrink-0" />
          <span className="text-sm font-semibold truncate">{workspace.name}</span>
        </div>

        {gitStatus && <GitStatusBadge status={gitStatus} />}

        {/* Main view tabs */}
        <div className="flex items-center gap-1 border border-border rounded-md p-0.5">
          <button
            onClick={() => setMainView("files")}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors",
              mainView === "files"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Code2 className="h-3 w-3" />
            Files
          </button>
          <button
            onClick={() => setMainView("graph")}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded transition-colors",
              mainView === "graph"
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Network className="h-3 w-3" />
            Dep. Graph
          </button>
        </div>

        <IndexStatusBadge
          status={indexStatus !== "idle" ? indexStatus : (workspace.indexStatus ?? "idle")}
          onTrigger={() => indexTrigger.mutate()}
          disabled={indexTrigger.isPending || indexStatus === "indexing"}
        />

        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setShowConfigDiff((v) => !v)}
            className={cn(
              "flex items-center gap-1 text-xs px-2 py-1 rounded border transition-colors",
              showConfigDiff
                ? "border-primary/50 text-primary bg-primary/5"
                : "border-border text-muted-foreground hover:border-primary/50",
            )}
          >
            <Settings2 className="h-3 w-3" />
            Config
          </button>

          {workspace.type === "remote" && (
            <button
              onClick={() => syncMutation.mutate()}
              disabled={syncMutation.isPending || workspace.status === "syncing"}
              className="flex items-center gap-1 text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:border-primary/50 disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={cn("h-3 w-3", syncMutation.isPending && "animate-spin")} />
              Sync
            </button>
          )}
        </div>
      </div>

      {/* Config diff banner */}
      {showConfigDiff && (
        <div className="border-b border-border px-4 py-3 bg-card/50">
          <ConfigDiffView
            workspaceId={workspaceId}
            onIgnore={() => setShowConfigDiff(false)}
          />
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex overflow-hidden">
        {mainView === "graph" ? (
          /* ── Dependency Graph view ── */
          <>
            <div className="flex-1 flex overflow-hidden">
              <DependencyGraph
                workspaceId={workspaceId}
                onNodeClick={handleFileSelect}
              />
            </div>
            {/* Right panel: symbol search */}
            <div className="w-80 border-l border-border flex flex-col overflow-hidden shrink-0">
              <div className="border-b border-border flex items-center gap-1 px-3 py-1.5">
                <Search className="h-3 w-3 text-muted-foreground" />
                <span className="text-xs text-muted-foreground font-medium">Symbol Search</span>
              </div>
              <div className="flex-1 overflow-hidden">
                <SymbolSearch
                  workspaceId={workspaceId}
                  onSymbolSelect={(sym: SymbolSearchResult) => handleFileSelect(sym.file)}
                />
              </div>
            </div>
          </>
        ) : (
          /* ── Files view ── */
          <>
            {/* File tree */}
            <div className="w-56 border-r border-border flex flex-col shrink-0 overflow-hidden">
              <div className="px-3 py-2 border-b border-border">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">Files</p>
              </div>
              <div className="flex-1 overflow-y-auto py-1">
                <FileTree
                  entries={files ?? []}
                  workspaceId={workspaceId}
                  selectedPath={selectedFile}
                  onSelect={handleFileSelect}
                  onLoadDir={loadDirContents}
                />
              </div>
            </div>

            {/* Code viewer */}
            <div className="flex-1 flex flex-col overflow-hidden border-r border-border">
              {selectedFile && fileContent ? (
                <CodeViewer content={fileContent} filePath={selectedFile} className="flex-1" />
              ) : (
                <div className="flex-1 flex items-center justify-center">
                  <p className="text-xs text-muted-foreground">Select a file to view</p>
                </div>
              )}
            </div>

            {/* Right panel */}
            <div className="w-96 flex flex-col overflow-hidden shrink-0">
              {/* Panel tabs */}
              <div className="border-b border-border flex items-center gap-1 px-3 py-1.5">
                <button
                  onClick={() => setRightPanel("chat")}
                  className={cn(
                    "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors",
                    rightPanel === "chat"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <MessageSquare className="h-3 w-3" />
                  Chat
                </button>
                <button
                  onClick={() => setRightPanel("review")}
                  className={cn(
                    "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors",
                    rightPanel === "review"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Eye className="h-3 w-3" />
                  Review
                </button>
                <button
                  onClick={() => setRightPanel("symbols")}
                  className={cn(
                    "flex items-center gap-1.5 text-xs px-2.5 py-1 rounded transition-colors",
                    rightPanel === "symbols"
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Search className="h-3 w-3" />
                  Symbols
                </button>
              </div>

              {/* Model pickers + review trigger (only for chat/review panels) */}
              {rightPanel !== "symbols" && (
                <div className="border-b border-border px-3 py-2 space-y-2">
                  {rightPanel === "review" ? (
                    <>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Review models</p>
                      <ModelSelector
                        models={activeModels}
                        selected={reviewModels}
                        onChange={setReviewModels}
                      />
                      <button
                        onClick={handleReview}
                        disabled={!selectedFile || reviewModels.length === 0 || isReviewing}
                        className="w-full text-xs py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {isReviewing ? "Reviewing..." : "Run Review"}
                      </button>
                    </>
                  ) : (
                    <>
                      <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Chat model</p>
                      <ModelSelector
                        models={activeModels}
                        selected={chatModel}
                        onChange={setChatModel}
                        single
                      />
                    </>
                  )}
                </div>
              )}

              {/* Panel content */}
              <div className="flex-1 overflow-hidden">
                {rightPanel === "review" ? (
                  <ReviewPanel results={reviewResults} isLoading={isReviewing} />
                ) : rightPanel === "symbols" ? (
                  <SymbolSearch
                    workspaceId={workspaceId}
                    onSymbolSelect={(sym: SymbolSearchResult) => handleFileSelect(sym.file)}
                  />
                ) : (
                  <ChatPanel
                    workspaceId={workspaceId}
                    modelSlug={chatModelSlug}
                    contextFilePaths={selectedFile ? [selectedFile] : []}
                  />
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Search, Plus, Trash2, ChevronDown, ChevronUp, X, Pencil, Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/lib/queryClient";
import MemoryPreferences from "@/components/settings/MemoryPreferences";

type MemoryScope = "global" | "workspace" | "pipeline" | "run";
type MemoryType = "decision" | "pattern" | "fact" | "preference" | "issue" | "dependency";

interface Memory {
  id: number;
  scope: MemoryScope;
  scopeId: string | null;
  type: MemoryType;
  key: string;
  content: string;
  source: string | null;
  confidence: number;
  tags: string[] | null;
  createdAt: string | null;
  updatedAt: string | null;
}

const TYPE_COLORS: Record<MemoryType, string> = {
  decision: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  pattern: "bg-purple-500/15 text-purple-600 border-purple-500/30",
  fact: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  preference: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  issue: "bg-red-500/15 text-red-600 border-red-500/30",
  dependency: "bg-slate-500/15 text-slate-600 border-slate-500/30",
};

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(1, value)) * 100;
  const color = pct >= 70 ? "bg-emerald-500" : pct >= 40 ? "bg-amber-500" : "bg-red-500";
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] text-muted-foreground w-7 text-right">{pct.toFixed(0)}%</span>
    </div>
  );
}

function timeAgo(dateStr: string | null): string {
  if (!dateStr) return "unknown";
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface AddMemoryFormProps {
  onDone: () => void;
}

function AddMemoryForm({ onDone }: AddMemoryFormProps) {
  const qc = useQueryClient();
  const [scope, setScope] = useState<MemoryScope>("global");
  const [type, setType] = useState<MemoryType>("fact");
  const [key, setKey] = useState("");
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/memories", {
        scope,
        type,
        key: key.trim(),
        content: content.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["/api/memories"] });
      onDone();
    },
    onError: (err: Error) => setError(err.message),
  });

  const handleSubmit = () => {
    if (!key.trim() || !content.trim()) {
      setError("Key and content are required");
      return;
    }
    setError(null);
    create.mutate();
  };

  return (
    <div className="border border-border rounded-lg p-4 space-y-3 bg-card">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Scope</label>
          <Select value={scope} onValueChange={(v) => setScope(v as MemoryScope)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="global">Global</SelectItem>
              <SelectItem value="pipeline">Pipeline</SelectItem>
              <SelectItem value="workspace">Workspace</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1 block">Type</label>
          <Select value={type} onValueChange={(v) => setType(v as MemoryType)}>
            <SelectTrigger className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="decision">Decision</SelectItem>
              <SelectItem value="pattern">Pattern</SelectItem>
              <SelectItem value="fact">Fact</SelectItem>
              <SelectItem value="preference">Preference</SelectItem>
              <SelectItem value="issue">Issue</SelectItem>
              <SelectItem value="dependency">Dependency</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Key</label>
        <Input
          className="h-8 text-xs font-mono"
          placeholder="my-key"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
      </div>
      <div>
        <label className="text-xs font-medium text-muted-foreground mb-1 block">Content</label>
        <textarea
          className="w-full h-20 text-xs rounded-md border border-input bg-background px-3 py-2 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
          placeholder="Memory content..."
          value={content}
          onChange={(e) => setContent(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onDone}>
          Cancel
        </Button>
        <Button size="sm" className="h-7 text-xs" onClick={handleSubmit} disabled={create.isPending}>
          {create.isPending ? "Saving..." : "Save"}
        </Button>
      </div>
    </div>
  );
}

interface MemoryCardProps {
  memory: Memory;
  onDelete: (id: number) => void;
  onUpdate: (id: number, data: { content?: string; confidence?: number }) => void;
  isUpdating: boolean;
}

function MemoryCard({ memory, onDelete, onUpdate, isUpdating }: MemoryCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState(memory.content);
  const [editConfidence, setEditConfidence] = useState(memory.confidence);
  const PREVIEW_LEN = 120;
  const isLong = memory.content.length > PREVIEW_LEN;

  const handleSave = () => {
    const changes: { content?: string; confidence?: number } = {};
    if (editContent.trim() !== memory.content) changes.content = editContent.trim();
    if (editConfidence !== memory.confidence) changes.confidence = editConfidence;
    if (Object.keys(changes).length > 0) {
      onUpdate(memory.id, changes);
    }
    setEditing(false);
  };

  const handleCancel = () => {
    setEditContent(memory.content);
    setEditConfidence(memory.confidence);
    setEditing(false);
  };

  return (
    <div className="border border-border rounded-lg p-3 bg-card space-y-2 hover:border-primary/30 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-mono font-medium text-foreground truncate">{memory.key}</span>
            <Badge className={cn("text-[10px] border", TYPE_COLORS[memory.type])}>
              {memory.type}
            </Badge>
            <Badge variant="outline" className="text-[10px]">{memory.scope}</Badge>
          </div>
          {editing ? (
            <textarea
              className="w-full mt-1 text-xs rounded-md border border-input bg-background px-2 py-1.5 resize-none focus:outline-none focus:ring-1 focus:ring-ring"
              rows={3}
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              autoFocus
            />
          ) : (
            <p className="text-xs text-muted-foreground mt-1">
              {expanded || !isLong
                ? memory.content
                : memory.content.slice(0, PREVIEW_LEN) + "..."}
            </p>
          )}
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          {editing ? (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-primary"
                onClick={handleSave}
                disabled={isUpdating}
              >
                <Check className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground"
                onClick={handleCancel}
              >
                <X className="h-3 w-3" />
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-primary"
                onClick={() => setEditing(true)}
              >
                <Pencil className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={() => onDelete(memory.id)}
              >
                <X className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </div>

      {editing ? (
        <div className="space-y-1">
          <label className="text-[10px] text-muted-foreground">Confidence</label>
          <div className="flex items-center gap-2">
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={editConfidence}
              onChange={(e) => setEditConfidence(parseFloat(e.target.value))}
              className="flex-1 h-1.5 accent-primary"
            />
            <span className="text-[10px] text-muted-foreground w-8 text-right">
              {(editConfidence * 100).toFixed(0)}%
            </span>
          </div>
        </div>
      ) : (
        <ConfidenceBar value={memory.confidence} />
      )}

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {memory.source ?? "unknown"} · {timeAgo(memory.updatedAt)}
        </span>
        {isLong && !editing && (
          <button
            className="text-[10px] text-primary hover:underline flex items-center gap-0.5"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? <><ChevronUp className="h-3 w-3" /> Less</> : <><ChevronDown className="h-3 w-3" /> More</>}
          </button>
        )}
      </div>
    </div>
  );
}

export default function Memory() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [showAddForm, setShowAddForm] = useState(false);

  const queryKey = search
    ? [`/api/memories?q=${encodeURIComponent(search)}`]
    : ["/api/memories"];

  const { data: memories = [], isLoading } = useQuery<Memory[]>({
    queryKey,
    queryFn: async () => {
      const url = search
        ? `/api/memories?q=${encodeURIComponent(search)}`
        : "/api/memories";
      const res = await apiRequest("GET", url);
      return res.json() as Promise<Memory[]>;
    },
  });

  const deleteMemory = useMutation({
    mutationFn: async (id: number) => {
      await apiRequest("DELETE", `/api/memories/${id}`);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/memories"] }),
  });

  const updateMemory = useMutation({
    mutationFn: async ({ id, data }: { id: number; data: { content?: string; confidence?: number } }) => {
      await apiRequest("PUT", `/api/memories/${id}`, data);
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/memories"] }),
  });

  const clearStale = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("DELETE", "/api/memories/stale");
      return res.json() as Promise<{ deleted: number }>;
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["/api/memories"] }),
  });

  const filtered = memories.filter((m) => {
    if (scopeFilter !== "all" && m.scope !== scopeFilter) return false;
    if (typeFilter !== "all" && m.type !== typeFilter) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <div className="h-16 border-b border-border flex items-center px-6 bg-card shrink-0">
        <Brain className="h-5 w-5 mr-3 text-muted-foreground" />
        <h1 className="text-lg font-semibold">Memory</h1>
        <span className="ml-3 text-sm text-muted-foreground">
          {memories.length} entries
        </span>
      </div>

      <ScrollArea className="flex-1">
        <div className="max-w-4xl mx-auto p-6 space-y-4">
          {/* Memory Preferences */}
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base flex items-center gap-2">
                <Brain className="h-4 w-4" />
                Memory Preferences
              </CardTitle>
            </CardHeader>
            <CardContent className="pt-0">
              <MemoryPreferences noCard />
            </CardContent>
          </Card>

          {/* Search + Actions */}
          <div className="flex items-center gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                className="h-9 pl-9 text-sm"
                placeholder="Search memories..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-9 text-xs text-destructive hover:text-destructive"
              onClick={() => clearStale.mutate()}
              disabled={clearStale.isPending}
            >
              <Trash2 className="h-3.5 w-3.5 mr-1.5" />
              {clearStale.isPending ? "Clearing..." : "Clear Stale"}
            </Button>
            <Button
              size="sm"
              className="h-9 text-xs"
              onClick={() => setShowAddForm(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Add Memory
            </Button>
          </div>

          {/* Filters */}
          <div className="flex items-center gap-3">
            <Select value={scopeFilter} onValueChange={setScopeFilter}>
              <SelectTrigger className="h-8 w-36 text-xs">
                <SelectValue placeholder="Scope" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Scopes</SelectItem>
                <SelectItem value="global">Global</SelectItem>
                <SelectItem value="pipeline">Pipeline</SelectItem>
                <SelectItem value="workspace">Workspace</SelectItem>
                <SelectItem value="run">Run</SelectItem>
              </SelectContent>
            </Select>
            <Select value={typeFilter} onValueChange={setTypeFilter}>
              <SelectTrigger className="h-8 w-40 text-xs">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                <SelectItem value="decision">Decision</SelectItem>
                <SelectItem value="pattern">Pattern</SelectItem>
                <SelectItem value="fact">Fact</SelectItem>
                <SelectItem value="preference">Preference</SelectItem>
                <SelectItem value="issue">Issue</SelectItem>
                <SelectItem value="dependency">Dependency</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Add Form */}
          {showAddForm && (
            <AddMemoryForm onDone={() => setShowAddForm(false)} />
          )}

          {/* Memory Grid */}
          {isLoading ? (
            <div className="text-sm text-muted-foreground py-8 text-center">
              Loading memories...
            </div>
          ) : filtered.length === 0 ? (
            <Card>
              <CardContent className="py-12">
                <div className="text-center text-muted-foreground">
                  <Brain className="h-10 w-10 mx-auto mb-3 opacity-30" />
                  <p className="text-sm">No memories found</p>
                  <p className="text-xs mt-1">Run pipelines to accumulate memories, or add one manually.</p>
                </div>
              </CardContent>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filtered.map((m) => (
                <MemoryCard
                  key={m.id}
                  memory={m}
                  onDelete={(id) => deleteMemory.mutate(id)}
                  onUpdate={(id, data) => updateMemory.mutate({ id, data })}
                  isUpdating={updateMemory.isPending}
                />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

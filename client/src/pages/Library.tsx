import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Plus,
  Rss,
  Globe,
  RefreshCw,
  Trash2,
  ExternalLink,
  Search,
  X,
  BookOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ─── API helpers ─────────────────────────────────────────────────────────────

function getAuthToken(): string | null {
  return localStorage.getItem("auth_token");
}

async function fetchJson<T>(url: string): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const token = getAuthToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as { error?: string }).error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

async function deleteApi(url: string): Promise<void> {
  const token = getAuthToken();
  const res = await fetch(url, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface LibraryChannel {
  id: string;
  name: string;
  type: string;
  url: string | null;
  enabled: boolean;
  pollIntervalMinutes: number;
  lastPolledAt: string | null;
  errorMessage: string | null;
  createdAt: string;
}

interface LibraryItem {
  id: string;
  channelId: string | null;
  title: string;
  url: string | null;
  summary: string | null;
  author: string | null;
  tags: string[];
  sourceType: string;
  publishedAt: string | null;
  createdAt: string;
}

// ─── Add Channel Modal ──────────────────────────────────────────────────────

function AddChannelForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState<"rss" | "manual">("rss");
  const [url, setUrl] = useState("");

  const create = useMutation({
    mutationFn: (data: { name: string; type: string; url?: string }) =>
      postJson("/api/library/channels", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library-channels"] });
      onClose();
    },
  });

  return (
    <Card className="border-primary/30">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm">Add Channel</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Name</label>
          <input
            className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Hacker News RSS"
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Type</label>
          <select
            className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
            value={type}
            onChange={(e) => setType(e.target.value as "rss" | "manual")}
          >
            <option value="rss">RSS Feed</option>
            <option value="manual">Manual Collection</option>
          </select>
        </div>
        {type === "rss" && (
          <div>
            <label className="block text-xs font-medium mb-1">Feed URL</label>
            <input
              className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://example.com/feed.xml"
            />
          </div>
        )}
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!name || (type === "rss" && !url) || create.isPending}
            onClick={() => create.mutate({ name, type, url: type === "rss" ? url : undefined })}
          >
            {create.isPending ? "Creating..." : "Add Channel"}
          </Button>
        </div>
        {create.isError && (
          <p className="text-xs text-destructive">{(create.error as Error).message}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Add Item Modal ─────────────────────────────────────────────────────────

function AddItemForm({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [url, setUrl] = useState("");
  const [tagsStr, setTagsStr] = useState("");

  const create = useMutation({
    mutationFn: (data: { title: string; url?: string; tags?: string[] }) =>
      postJson("/api/library/items", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library-items"] });
      onClose();
    },
  });

  return (
    <Card className="border-primary/30">
      <CardHeader className="py-3 px-4">
        <CardTitle className="text-sm">Add Article</CardTitle>
      </CardHeader>
      <CardContent className="px-4 pb-4 space-y-3">
        <div>
          <label className="block text-xs font-medium mb-1">Title</label>
          <input
            className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">URL</label>
          <input
            className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://..."
          />
        </div>
        <div>
          <label className="block text-xs font-medium mb-1">Tags (comma-separated)</label>
          <input
            className="w-full border border-border rounded-md px-3 py-1.5 bg-background text-sm"
            value={tagsStr}
            onChange={(e) => setTagsStr(e.target.value)}
            placeholder="security, devops, react"
          />
        </div>
        <div className="flex gap-2 justify-end">
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={!title || create.isPending}
            onClick={() =>
              create.mutate({
                title,
                url: url || undefined,
                tags: tagsStr
                  .split(",")
                  .map((t) => t.trim())
                  .filter(Boolean),
              })
            }
          >
            {create.isPending ? "Adding..." : "Add"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Channel Card ───────────────────────────────────────────────────────────

function ChannelCard({
  channel,
  isSelected,
  onSelect,
}: {
  channel: LibraryChannel;
  isSelected: boolean;
  onSelect: () => void;
}) {
  const qc = useQueryClient();

  const poll = useMutation({
    mutationFn: () => postJson(`/api/library/channels/${channel.id}/poll`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["library-channels"] });
      qc.invalidateQueries({ queryKey: ["library-items"] });
    },
  });

  const remove = useMutation({
    mutationFn: () => deleteApi(`/api/library/channels/${channel.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library-channels"] }),
  });

  return (
    <div
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors",
        isSelected
          ? "bg-primary/10 text-primary border border-primary/30"
          : "hover:bg-muted/50 border border-transparent",
      )}
    >
      {channel.type === "rss" ? (
        <Rss className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <BookOpen className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="truncate flex-1 font-medium">{channel.name}</span>
      {channel.errorMessage && (
        <span className="text-[9px] text-destructive" title={channel.errorMessage}>
          err
        </span>
      )}
      {channel.type === "rss" && (
        <Button
          variant="ghost"
          size="sm"
          className="h-5 w-5 p-0"
          onClick={(e) => {
            e.stopPropagation();
            poll.mutate();
          }}
          disabled={poll.isPending}
          title="Poll now"
        >
          <RefreshCw className={cn("h-3 w-3", poll.isPending && "animate-spin")} />
        </Button>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0 text-muted-foreground hover:text-destructive"
        onClick={(e) => {
          e.stopPropagation();
          remove.mutate();
        }}
        title="Delete channel"
      >
        <Trash2 className="h-3 w-3" />
      </Button>
    </div>
  );
}

// ─── Item Card ──────────────────────────────────────────────────────────────

function ItemCard({ item }: { item: LibraryItem }) {
  const qc = useQueryClient();

  const remove = useMutation({
    mutationFn: () => deleteApi(`/api/library/items/${item.id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["library-items"] }),
  });

  const date = item.publishedAt
    ? new Date(item.publishedAt).toLocaleDateString()
    : new Date(item.createdAt).toLocaleDateString();

  return (
    <Card className="border-border hover:border-primary/20 transition-colors">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            {item.url ? (
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium hover:text-primary hover:underline flex items-center gap-1"
              >
                {item.title}
                <ExternalLink className="h-3 w-3 shrink-0" />
              </a>
            ) : (
              <p className="text-sm font-medium">{item.title}</p>
            )}
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive shrink-0"
            onClick={() => remove.mutate()}
            title="Delete item"
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>

        {item.summary && (
          <p className="text-xs text-muted-foreground line-clamp-2">{item.summary}</p>
        )}

        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] text-muted-foreground">{date}</span>
          {item.author && (
            <span className="text-[10px] text-muted-foreground">· {item.author}</span>
          )}
          <Badge variant="outline" className="text-[9px] h-4">
            {item.sourceType}
          </Badge>
          {item.tags.map((tag) => (
            <Badge key={tag} variant="secondary" className="text-[9px] h-4">
              {tag}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function Library() {
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);
  const [showAddChannel, setShowAddChannel] = useState(false);
  const [showAddItem, setShowAddItem] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: channels = [] } = useQuery<LibraryChannel[]>({
    queryKey: ["library-channels"],
    queryFn: () => fetchJson("/api/library/channels"),
  });

  const { data: items = [], isLoading: itemsLoading } = useQuery<LibraryItem[]>({
    queryKey: ["library-items", selectedChannel, searchQuery],
    queryFn: () => {
      const params = new URLSearchParams();
      if (selectedChannel) params.set("channelId", selectedChannel);
      if (searchQuery) params.set("q", searchQuery);
      params.set("limit", "100");
      return fetchJson(`/api/library/items?${params}`);
    },
  });

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left sidebar — channels */}
      <aside className="w-64 border-r border-border flex flex-col shrink-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <h2 className="text-sm font-semibold">Channels</h2>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0"
            onClick={() => setShowAddChannel(!showAddChannel)}
          >
            {showAddChannel ? <X className="h-3.5 w-3.5" /> : <Plus className="h-3.5 w-3.5" />}
          </Button>
        </div>

        {showAddChannel && (
          <div className="p-2">
            <AddChannelForm onClose={() => setShowAddChannel(false)} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {/* "All" pseudo-channel */}
          <div
            onClick={() => setSelectedChannel(null)}
            className={cn(
              "flex items-center gap-2 px-3 py-2 rounded-md cursor-pointer text-sm transition-colors",
              selectedChannel === null
                ? "bg-primary/10 text-primary border border-primary/30"
                : "hover:bg-muted/50 border border-transparent",
            )}
          >
            <Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="font-medium">All Items</span>
          </div>

          {channels.map((ch) => (
            <ChannelCard
              key={ch.id}
              channel={ch}
              isSelected={selectedChannel === ch.id}
              onSelect={() => setSelectedChannel(ch.id)}
            />
          ))}
        </div>
      </aside>

      {/* Right content — items feed */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <div className="p-3 border-b border-border flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <input
              className="w-full border border-border rounded-md pl-8 pr-3 py-1.5 bg-background text-sm"
              placeholder="Search library..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
          <Button size="sm" onClick={() => setShowAddItem(!showAddItem)}>
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add Article
          </Button>
        </div>

        {showAddItem && (
          <div className="p-3 border-b border-border">
            <AddItemForm onClose={() => setShowAddItem(false)} />
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {itemsLoading ? (
            <div className="flex items-center justify-center h-32">
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-32 text-center">
              <BookOpen className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">No items yet.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add an RSS channel or create items manually.
              </p>
            </div>
          ) : (
            items.map((item) => <ItemCard key={item.id} item={item} />)
          )}
        </div>
      </main>
    </div>
  );
}

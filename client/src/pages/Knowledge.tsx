import { useState } from "react";
import { useRoute, Link } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Brain, Search, Upload, Trash2, Settings, ChevronRight, FileText, Code2, Clock, Database, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

interface KnowledgeSource {
  sourceType: "code" | "pipeline_run" | "document" | "memory_entry";
  sourceId: string;
  count: number;
}

interface SearchResult {
  id: string;
  sourceType: string;
  sourceId: string;
  chunkText: string;
  score: number;
  metadata: Record<string, unknown>;
  ts: string;
}

interface EmbeddingConfig {
  provider: string;
  model: string;
  dimensions: number;
  config?: Record<string, string>;
}

const SOURCE_TYPE_ICONS: Record<string, React.ReactNode> = {
  code: <Code2 className="h-3.5 w-3.5" />,
  pipeline_run: <Clock className="h-3.5 w-3.5" />,
  document: <FileText className="h-3.5 w-3.5" />,
  memory_entry: <Brain className="h-3.5 w-3.5" />,
};

const SOURCE_TYPE_COLORS: Record<string, string> = {
  code: "bg-blue-500/15 text-blue-600 border-blue-500/30",
  pipeline_run: "bg-amber-500/15 text-amber-600 border-amber-500/30",
  document: "bg-emerald-500/15 text-emerald-600 border-emerald-500/30",
  memory_entry: "bg-purple-500/15 text-purple-600 border-purple-500/30",
};

// ─── Component ────────────────────────────────────────────────────────────────

export default function Knowledge() {
  const [, params] = useRoute("/workspaces/:id/knowledge");
  const workspaceId = params?.id ?? "";
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [isSearching, setIsSearching] = useState(false);

  const [ingestText, setIngestText] = useState("");
  const [ingestSourceId, setIngestSourceId] = useState("");
  const [ingestSourceType, setIngestSourceType] = useState<string>("document");

  // ─── Queries ────────────────────────────────────────────────────────────────

  const { data: sources = [], isLoading: sourcesLoading } = useQuery<KnowledgeSource[]>({
    queryKey: ["/api/workspaces", workspaceId, "knowledge", "sources"],
    queryFn: () => apiRequest("GET", `/api/workspaces/${workspaceId}/knowledge/sources`).then((r) => r.json()),
    enabled: !!workspaceId,
  });

  const { data: embeddingConfig } = useQuery<EmbeddingConfig>({
    queryKey: ["/api/workspaces", workspaceId, "knowledge", "config"],
    queryFn: () => apiRequest("GET", `/api/workspaces/${workspaceId}/knowledge/config`).then((r) => r.json()),
    enabled: !!workspaceId,
  });

  // ─── Mutations ───────────────────────────────────────────────────────────────

  const ingestMutation = useMutation({
    mutationFn: (data: { sourceType: string; sourceId: string; text: string; replace: boolean }) =>
      apiRequest("POST", `/api/workspaces/${workspaceId}/knowledge/ingest`, data).then((r) => r.json()),
    onSuccess: (result: { inserted: number }) => {
      toast({ title: "Ingested", description: `${result.inserted} chunks indexed.` });
      queryClient.invalidateQueries({ queryKey: ["/api/workspaces", workspaceId, "knowledge", "sources"] });
      setIngestText("");
      setIngestSourceId("");
    },
    onError: (err: Error) => {
      toast({ title: "Ingest failed", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: ({ sourceType, sourceId }: { sourceType: string; sourceId: string }) =>
      apiRequest("DELETE", `/api/workspaces/${workspaceId}/knowledge/sources/${sourceType}/${encodeURIComponent(sourceId)}`).then((r) => r.json()),
    onSuccess: () => {
      toast({ title: "Deleted" });
      queryClient.invalidateQueries({ queryKey: ["/api/workspaces", workspaceId, "knowledge", "sources"] });
    },
    onError: () => {
      toast({ title: "Delete failed", variant: "destructive" });
    },
  });

  const reEmbedMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/workspaces/${workspaceId}/knowledge/re-embed`, {}).then((r) => r.json()),
    onSuccess: (result: { totalChunks: number }) => {
      toast({ title: "Re-embed started", description: `Queued ${result.totalChunks} chunks for re-embedding.` });
    },
    onError: () => {
      toast({ title: "Re-embed failed", variant: "destructive" });
    },
  });

  // ─── Handlers ────────────────────────────────────────────────────────────────

  async function handleSearch() {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const res = await apiRequest("GET", `/api/workspaces/${workspaceId}/knowledge/search?q=${encodeURIComponent(searchQuery)}&topK=10`);
      const results = await res.json();
      setSearchResults(results);
    } catch (err) {
      toast({ title: "Search failed", description: (err as Error).message, variant: "destructive" });
    } finally {
      setIsSearching(false);
    }
  }

  function handleIngest() {
    if (!ingestText.trim() || !ingestSourceId.trim()) return;
    ingestMutation.mutate({
      sourceType: ingestSourceType,
      sourceId: ingestSourceId,
      text: ingestText,
      replace: true,
    });
  }

  const totalChunks = sources.reduce((sum, s) => sum + s.count, 0);

  // ─── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="border-b px-6 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="h-5 w-5 text-purple-500" />
          <div>
            <h1 className="font-semibold text-lg">Knowledge Base</h1>
            <p className="text-sm text-muted-foreground">
              {totalChunks.toLocaleString()} chunks indexed
              {embeddingConfig && (
                <span className="ml-2 text-xs">
                  via <span className="font-mono">{embeddingConfig.model}</span> ({embeddingConfig.provider})
                </span>
              )}
            </p>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => reEmbedMutation.mutate()}
          disabled={reEmbedMutation.isPending}
        >
          <RefreshCw className={cn("h-4 w-4 mr-2", reEmbedMutation.isPending && "animate-spin")} />
          Re-embed All
        </Button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="sources">
          <TabsList className="mb-6">
            <TabsTrigger value="sources">
              <Database className="h-4 w-4 mr-2" />
              Sources
            </TabsTrigger>
            <TabsTrigger value="search">
              <Search className="h-4 w-4 mr-2" />
              Search
            </TabsTrigger>
            <TabsTrigger value="import">
              <Upload className="h-4 w-4 mr-2" />
              Import
            </TabsTrigger>
          </TabsList>

          {/* ── Sources tab ── */}
          <TabsContent value="sources">
            {sourcesLoading ? (
              <div className="text-sm text-muted-foreground">Loading sources…</div>
            ) : sources.length === 0 ? (
              <Card>
                <CardContent className="py-12 text-center">
                  <Database className="h-10 w-10 mx-auto mb-3 text-muted-foreground/40" />
                  <p className="text-muted-foreground text-sm">No knowledge sources indexed yet.</p>
                  <p className="text-muted-foreground text-xs mt-1">Use the Import tab to add documents or text.</p>
                </CardContent>
              </Card>
            ) : (
              <div className="space-y-2">
                {sources.map((source) => (
                  <Card key={`${source.sourceType}:${source.sourceId}`}>
                    <CardContent className="py-3 px-4 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Badge
                          variant="outline"
                          className={cn("text-xs gap-1", SOURCE_TYPE_COLORS[source.sourceType])}
                        >
                          {SOURCE_TYPE_ICONS[source.sourceType]}
                          {source.sourceType}
                        </Badge>
                        <span className="text-sm font-mono truncate max-w-xs">{source.sourceId}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{source.count} chunks</span>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => deleteMutation.mutate({ sourceType: source.sourceType, sourceId: source.sourceId })}
                          disabled={deleteMutation.isPending}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}
          </TabsContent>

          {/* ── Search tab ── */}
          <TabsContent value="search">
            <Card className="mb-4">
              <CardContent className="pt-4 pb-4">
                <div className="flex gap-2">
                  <Input
                    placeholder="Search knowledge base semantically…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                    className="flex-1"
                  />
                  <Button onClick={handleSearch} disabled={isSearching || !searchQuery.trim()}>
                    <Search className={cn("h-4 w-4 mr-2", isSearching && "animate-spin")} />
                    Search
                  </Button>
                </div>
              </CardContent>
            </Card>

            {searchResults.length > 0 ? (
              <div className="space-y-3">
                {searchResults.map((result) => (
                  <Card key={result.id}>
                    <CardContent className="py-3 px-4">
                      <div className="flex items-start justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <Badge
                            variant="outline"
                            className={cn("text-xs gap-1", SOURCE_TYPE_COLORS[result.sourceType])}
                          >
                            {SOURCE_TYPE_ICONS[result.sourceType]}
                            {result.sourceType}
                          </Badge>
                          <span className="text-xs font-mono text-muted-foreground truncate max-w-xs">
                            {result.sourceId}
                          </span>
                        </div>
                        <Badge variant="secondary" className="text-xs shrink-0">
                          {(result.score * 100).toFixed(0)}% match
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground leading-relaxed line-clamp-4">
                        {result.chunkText}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : searchQuery && !isSearching ? (
              <p className="text-sm text-muted-foreground text-center py-8">No results found.</p>
            ) : null}
          </TabsContent>

          {/* ── Import tab ── */}
          <TabsContent value="import">
            <Card>
              <CardHeader>
                <CardTitle className="text-base">Import Document</CardTitle>
                <CardDescription>
                  Paste text or code to chunk and embed it into the knowledge base.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Source Type</label>
                    <Select value={ingestSourceType} onValueChange={setIngestSourceType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="document">Document</SelectItem>
                        <SelectItem value="code">Code</SelectItem>
                        <SelectItem value="pipeline_run">Pipeline Run</SelectItem>
                        <SelectItem value="memory_entry">Memory Entry</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-medium">Source ID</label>
                    <Input
                      placeholder="e.g. README.md, run-123"
                      value={ingestSourceId}
                      onChange={(e) => setIngestSourceId(e.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Content</label>
                  <Textarea
                    placeholder="Paste your document or code here…"
                    value={ingestText}
                    onChange={(e) => setIngestText(e.target.value)}
                    rows={10}
                    className="font-mono text-sm"
                  />
                </div>

                <Button
                  onClick={handleIngest}
                  disabled={ingestMutation.isPending || !ingestText.trim() || !ingestSourceId.trim()}
                  className="w-full"
                >
                  {ingestMutation.isPending ? (
                    <>
                      <RefreshCw className="h-4 w-4 mr-2 animate-spin" />
                      Indexing…
                    </>
                  ) : (
                    <>
                      <Upload className="h-4 w-4 mr-2" />
                      Embed & Index
                    </>
                  )}
                </Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

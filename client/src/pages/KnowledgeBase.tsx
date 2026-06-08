/**
 * Active Knowledge Base — Terraform practice-cards surface.
 *
 * Workspace-scoped (route /workspaces/:id/knowledge-base). Four tabs:
 *  - Cards: filterable list + semantic search, with a detail pane.
 *  - Review: the human accept/reject gate (owner/admin only).
 *  - Refresh: run a refresh and read its diff report.
 *  - Compliance: followed/violated/unknown against the infra graph.
 *
 * Workspace scoping: the :id route param is the workspace id; the workspace row
 * is fetched to obtain ownerId for the review/refresh role gate and the name.
 */
import { useMemo, useState } from "react";
import { useRoute } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  BookMarked,
  Library,
  ShieldQuestion,
  RefreshCw,
  ClipboardCheck,
  FileText,
} from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { apiRequest } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import type { WorkspaceRow } from "@shared/schema";
import { CardList } from "@/components/knowledge/CardList";
import { SearchPanel } from "@/components/knowledge/SearchPanel";
import { CardDetail } from "@/components/knowledge/CardDetail";
import { ReviewQueue } from "@/components/knowledge/ReviewQueue";
import { RefreshPanel } from "@/components/knowledge/RefreshPanel";
import { CompliancePanel } from "@/components/knowledge/CompliancePanel";
import { EmptyState } from "@/components/knowledge/QueryStates";
import {
  usePracticeCards,
  type PracticeCard,
} from "@/hooks/use-practice-cards";
import { canMaintain, pendingReviewCards } from "@/lib/practice-cards";

export default function KnowledgeBase() {
  const [, params] = useRoute<{ id: string }>("/workspaces/:id/knowledge-base");
  const workspaceId = params?.id ?? "";
  const { user } = useAuth();

  const [selectedCard, setSelectedCard] = useState<PracticeCard | null>(null);

  const { data: workspace } = useQuery<WorkspaceRow>({
    queryKey: ["workspace", workspaceId],
    queryFn: () =>
      apiRequest("GET", `/api/workspaces/${workspaceId}`).then((r) => r.json()),
    enabled: !!workspaceId,
  });

  // Drive the review-tab badge from the pending_review count.
  const { data: pendingData } = usePracticeCards(workspaceId, {
    reviewState: "pending_review",
    limit: 200,
  });
  const pendingCount = useMemo(
    () => (pendingData ? pendingReviewCards(pendingData.cards).length : 0),
    [pendingData],
  );

  // Resolve a related card's statement for supersession links in the detail pane.
  const resolveCardLabel = useMemo(() => {
    const byId = new Map(
      (pendingData?.cards ?? []).map((c) => [c.id, c.statement]),
    );
    if (selectedCard) byId.set(selectedCard.id, selectedCard.statement);
    return (id: string) => byId.get(id);
  }, [pendingData, selectedCard]);

  const ownerId = workspace?.ownerId ?? null;
  const maintainAllowed = canMaintain(user, ownerId);

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <BookMarked className="h-5 w-5 text-primary" />
        <div>
          <h1 className="text-lg font-semibold">Active Knowledge Base</h1>
          <p className="text-sm text-muted-foreground">
            Terraform best-practice cards
            {workspace && (
              <span className="ml-1">
                · <span className="font-mono">{workspace.name}</span>
              </span>
            )}
          </p>
        </div>
      </header>

      <div className="flex-1 overflow-auto p-6">
        <Tabs defaultValue="cards">
          <TabsList className="mb-6">
            <TabsTrigger value="cards" data-testid="tab-cards">
              <Library className="mr-2 h-4 w-4" />
              Cards
            </TabsTrigger>
            <TabsTrigger value="review" data-testid="tab-review">
              <ClipboardCheck className="mr-2 h-4 w-4" />
              Review
              {pendingCount > 0 && (
                <span
                  className="ml-2 flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] font-bold text-white"
                  data-testid="review-pending-count"
                >
                  {pendingCount}
                </span>
              )}
            </TabsTrigger>
            <TabsTrigger value="refresh" data-testid="tab-refresh">
              <RefreshCw className="mr-2 h-4 w-4" />
              Refresh
            </TabsTrigger>
            <TabsTrigger value="compliance" data-testid="tab-compliance">
              <ShieldQuestion className="mr-2 h-4 w-4" />
              Compliance
            </TabsTrigger>
          </TabsList>

          {/* ── Cards: list + search on the left, detail on the right ── */}
          <TabsContent value="cards">
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
              <div className="space-y-6">
                <SearchPanel
                  workspaceId={workspaceId}
                  onSelectCard={setSelectedCard}
                />
                <CardList
                  workspaceId={workspaceId}
                  selectedCardId={selectedCard?.id ?? null}
                  onSelectCard={setSelectedCard}
                />
              </div>
              <div className="lg:sticky lg:top-0 lg:self-start">
                {selectedCard ? (
                  <div className="rounded-lg border border-border p-5">
                    <CardDetail
                      card={selectedCard}
                      resolveCardLabel={resolveCardLabel}
                    />
                  </div>
                ) : (
                  <EmptyState
                    icon={<FileText className="h-10 w-10" />}
                    title="Select a card"
                    description="Pick a card from the list or a search result to see its statement, sources, freshness, and provenance."
                  />
                )}
              </div>
            </div>
          </TabsContent>

          {/* ── Review queue ── */}
          <TabsContent value="review">
            <ReviewQueue
              workspaceId={workspaceId}
              user={user}
              workspaceOwnerId={ownerId}
            />
          </TabsContent>

          {/* ── Refresh ── */}
          <TabsContent value="refresh">
            <RefreshPanel workspaceId={workspaceId} canRun={maintainAllowed} />
          </TabsContent>

          {/* ── Compliance ── */}
          <TabsContent value="compliance">
            <CompliancePanel workspaceId={workspaceId} />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

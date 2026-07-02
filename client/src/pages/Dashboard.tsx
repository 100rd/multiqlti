import { useQuery } from "@tanstack/react-query";
import { Link } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Cpu, Layers, MessageCircleQuestion, Repeat } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModels, usePendingQuestions, useGatewayStatus } from "@/hooks/use-pipeline";

interface Loops24h {
  passed: number;
  broke: number;
  stopped: number;
  waiting: number;
  running: number;
  total: number;
}

interface StatsSummary {
  modelsConfigured: number;
  taskGroupsTotal: number;
  taskGroupsActive: number;
  consiliumLoopsTotal: number;
  consiliumLoopsActive: number;
  // 24h status breakdown of consilium loops (see /api/stats/summary). Optional
  // on the wire so an older/partial response never crashes the card.
  loops24h?: Loops24h;
}

// Display order + tone for the 24h pills. Greens/reds/ambers loosely track the
// loop-state palette (components/consilium/loop-state.tsx). `mark` is a tiny
// glyph cue; pills with a zero count are hidden to keep the card compact.
const LOOP_24H_PILLS: {
  key: keyof Omit<Loops24h, "total">;
  label: string;
  mark: string;
  className: string;
}[] = [
  { key: "passed", label: "passed", mark: "\u2713", className: "text-green-600 dark:text-green-400" },
  { key: "broke", label: "broke", mark: "\u2717", className: "text-red-600 dark:text-red-400" },
  { key: "waiting", label: "waiting", mark: "\u23f3", className: "text-amber-600 dark:text-amber-400" },
  { key: "stopped", label: "stopped", mark: "\u25cf", className: "text-yellow-600 dark:text-yellow-400" },
  { key: "running", label: "running", mark: "\u25cf", className: "text-blue-600 dark:text-blue-400" },
];

function useStatsSummary() {
  return useQuery<StatsSummary>({
    queryKey: ["/api/stats/summary"],
    refetchInterval: 30_000,
  });
}

export default function Dashboard() {
  const { data: models } = useModels();
  const { data: pendingQuestions } = usePendingQuestions();
  const { data: gwStatus } = useGatewayStatus();
  const { data: stats } = useStatsSummary();

  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : 0;
  const gwMode = gwStatus?.vllm ? 'vLLM' : gwStatus?.ollama ? 'Ollama' : 'Mock';

  const modelsConfigured = stats?.modelsConfigured ?? 0;
  const taskGroupsTotal = stats?.taskGroupsTotal ?? 0;
  const taskGroupsActive = stats?.taskGroupsActive ?? 0;
  const consiliumLoopsTotal = stats?.consiliumLoopsTotal ?? 0;
  const consiliumLoopsActive = stats?.consiliumLoopsActive ?? 0;
  const loops24h = stats?.loops24h;

  return (
    <div className="p-8 h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Task group &amp; consilium orchestration status. Gateway: <span className="font-mono text-xs">{gwMode}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Models</CardTitle>
            <Cpu className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{modelsConfigured}</div>
            <p className="text-xs text-muted-foreground mt-1">via {gwMode} gateway</p>
          </CardContent>
        </Card>

        {/* Task groups are internal machinery of the consilium loop now — surfaced
            as a static metric (their standalone pages have been retired). */}
        <Card className="border-border shadow-sm" data-testid="stat-task-groups">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Task Groups</CardTitle>
            <Layers className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{taskGroupsTotal}</div>
            <p className="text-xs text-muted-foreground mt-1">{taskGroupsActive} running</p>
          </CardContent>
        </Card>

        <Link href="/consilium-loops" data-testid="link-stat-consilium-loops">
          <Card className="border-border shadow-sm cursor-pointer hover:bg-accent/40 transition-colors">
            <CardHeader className="flex flex-row items-center justify-between pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Consilium Loops</CardTitle>
              <Repeat className="h-4 w-4 text-primary" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{consiliumLoopsTotal}</div>
              <p className="text-xs text-muted-foreground mt-1">{consiliumLoopsActive} active</p>
              <div className="mt-2 border-t border-border/60 pt-2">
                {loops24h && loops24h.total > 0 ? (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {LOOP_24H_PILLS.filter((pill) => (loops24h[pill.key] ?? 0) > 0).map(
                      (pill, i, shown) => (
                        <span key={pill.key} className="inline-flex items-center">
                          <span className={cn("text-[11px] font-medium tabular-nums", pill.className)}>
                            {pill.mark} {loops24h[pill.key]} {pill.label}
                          </span>
                          {i < shown.length - 1 && (
                            <span className="ml-2 text-muted-foreground/40 text-[11px]">&middot;</span>
                          )}
                        </span>
                      ),
                    )}
                  </div>
                ) : (
                  <p className="text-[11px] text-muted-foreground/70">no loop activity in 24h</p>
                )}
                <p className="mt-0.5 text-[10px] uppercase tracking-wide text-muted-foreground/50">last 24h</p>
              </div>
            </CardContent>
          </Card>
        </Link>

        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Pending Questions</CardTitle>
            <MessageCircleQuestion className="h-4 w-4 text-amber-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{pendingCount}</div>
            <p className="text-xs text-muted-foreground mt-1">awaiting your input</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6">
        <Card className="border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-medium">Registered Models</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 mt-2">
              {Array.isArray(models) && models.map((model: Record<string, unknown>) => (
                <div key={model.id as string} className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{model.name as string}</p>
                    <p className="text-xs text-muted-foreground">{model.provider as string} &bull; {model.slug as string}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "w-2 h-2 rounded-full",
                      model.isActive ? "bg-emerald-500" : "bg-muted-foreground"
                    )} />
                    <span className="text-xs text-muted-foreground">{model.isActive ? 'Active' : 'Inactive'}</span>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

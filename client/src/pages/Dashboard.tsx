import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Cpu, MessageCircleQuestion } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { cn } from "@/lib/utils";
import { useModels, usePendingQuestions, useGatewayStatus } from "@/hooks/use-pipeline";

interface StatsSummary {
  totalRuns: number;
  activePipelines: number;
  modelsConfigured: number;
  runsLast7Days: number[];
}

function useStatsSummary() {
  return useQuery<StatsSummary>({
    queryKey: ["/api/stats/summary"],
    refetchInterval: 30_000,
  });
}

function buildChartData(runsLast7Days: number[]): Array<{ day: string; runs: number }> {
  const now = new Date();
  return runsLast7Days.map((runs, i) => {
    const d = new Date(now);
    d.setDate(d.getDate() - (6 - i));
    const label = d.toLocaleDateString("en-US", { weekday: "short" });
    return { day: label, runs };
  });
}

export default function Dashboard() {
  const { data: models } = useModels();
  const { data: pendingQuestions } = usePendingQuestions();
  const { data: gwStatus } = useGatewayStatus();
  const { data: stats } = useStatsSummary();

  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : 0;
  const gwMode = gwStatus?.vllm ? 'vLLM' : gwStatus?.ollama ? 'Ollama' : 'Mock';

  const totalRuns = stats?.totalRuns ?? 0;
  const activePipelines = stats?.activePipelines ?? 0;
  const modelsConfigured = stats?.modelsConfigured ?? 0;
  const chartData = buildChartData(stats?.runsLast7Days ?? Array(7).fill(0));

  return (
    <div className="p-8 h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          SDLC pipeline orchestration status. Gateway: <span className="font-mono text-xs">{gwMode}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mb-8">
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

        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Pipeline Runs</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{totalRuns}</div>
            <p className="text-xs text-muted-foreground mt-1">{activePipelines} active pipeline{activePipelines !== 1 ? "s" : ""}</p>
          </CardContent>
        </Card>

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

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="col-span-2 border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-medium">Pipeline Runs — Last 7 Days</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData}>
                  <defs>
                    <linearGradient id="colorRuns" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="day" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} allowDecimals={false} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Area type="monotone" dataKey="runs" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorRuns)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

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

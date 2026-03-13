import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Cpu, ShieldCheck, MessageCircleQuestion } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { cn } from "@/lib/utils";
import { useModels, useRuns, usePendingQuestions, useGatewayStatus } from "@/hooks/use-pipeline";

const mockTrafficData = [
  { time: '00:00', requests: 12 },
  { time: '04:00', requests: 8 },
  { time: '08:00', requests: 45 },
  { time: '12:00', requests: 120 },
  { time: '16:00', requests: 86 },
  { time: '20:00', requests: 54 },
  { time: '24:00', requests: 23 },
];

export default function Dashboard() {
  const { data: models } = useModels();
  const { data: runs } = useRuns();
  const { data: pendingQuestions } = usePendingQuestions();
  const { data: gwStatus } = useGatewayStatus();

  const activeModels = Array.isArray(models) ? models.filter((m: any) => m.isActive).length : 0;
  const activeRuns = Array.isArray(runs) ? runs.filter((r: any) => r.status === 'running' || r.status === 'paused').length : 0;
  const completedRuns = Array.isArray(runs) ? runs.filter((r: any) => r.status === 'completed').length : 0;
  const pendingCount = Array.isArray(pendingQuestions) ? pendingQuestions.length : 0;
  const gwMode = gwStatus?.vllm ? 'vLLM' : gwStatus?.ollama ? 'Ollama' : 'Mock';

  return (
    <div className="p-8 h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">
          SDLC pipeline orchestration status. Gateway: <span className="font-mono text-xs">{gwMode}</span>
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Models</CardTitle>
            <Cpu className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeModels}</div>
            <p className="text-xs text-muted-foreground mt-1">via {gwMode} gateway</p>
          </CardContent>
        </Card>

        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Runs</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">{activeRuns}</div>
            <p className="text-xs text-muted-foreground mt-1">{completedRuns} completed total</p>
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

        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Data Exfiltration</CardTitle>
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">0 B</div>
            <p className="text-xs text-muted-foreground mt-1">100% locally contained</p>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="col-span-2 border-border shadow-sm">
          <CardHeader>
            <CardTitle className="text-base font-medium">Local Inference Traffic</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-[300px] w-full mt-4">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={mockTrafficData}>
                  <defs>
                    <linearGradient id="colorReq" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.1}/>
                      <stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="hsl(var(--border))" />
                  <XAxis dataKey="time" axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 12, fill: 'hsl(var(--muted-foreground))' }} />
                  <Tooltip
                    contentStyle={{ backgroundColor: 'hsl(var(--card))', borderRadius: '8px', border: '1px solid hsl(var(--border))' }}
                    itemStyle={{ color: 'hsl(var(--foreground))' }}
                  />
                  <Area type="monotone" dataKey="requests" stroke="hsl(var(--primary))" strokeWidth={2} fillOpacity={1} fill="url(#colorReq)" />
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
              {Array.isArray(models) && models.map((model: any) => (
                <div key={model.id} className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{model.name}</p>
                    <p className="text-xs text-muted-foreground">{model.provider} • {model.slug}</p>
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

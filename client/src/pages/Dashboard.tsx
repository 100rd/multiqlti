import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Activity, Cpu, ShieldCheck, Zap } from "lucide-react";
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, CartesianGrid } from 'recharts';
import { cn } from "@/lib/utils";

const mockData = [
  { time: '00:00', requests: 12 },
  { time: '04:00', requests: 8 },
  { time: '08:00', requests: 45 },
  { time: '12:00', requests: 120 },
  { time: '16:00', requests: 86 },
  { time: '20:00', requests: 54 },
  { time: '24:00', requests: 23 },
];

export default function Dashboard() {
  return (
    <div className="p-8 h-full overflow-y-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">Overview</h1>
        <p className="text-sm text-muted-foreground mt-1">Local agent execution and sandbox status.</p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Models</CardTitle>
            <Cpu className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">3</div>
            <p className="text-xs text-muted-foreground mt-1">via vLLM gateway</p>
          </CardContent>
        </Card>
        
        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Running Sandboxes</CardTitle>
            <Activity className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">12</div>
            <p className="text-xs text-muted-foreground mt-1">4 idle, 8 active</p>
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

        <Card className="border-border shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tasks Completed</CardTitle>
            <Zap className="h-4 w-4 text-primary" />
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold">1,204</div>
            <p className="text-xs text-muted-foreground mt-1">+14% from yesterday</p>
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
                <AreaChart data={mockData}>
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
            <CardTitle className="text-base font-medium">Active Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-4 mt-2">
              {[
                { name: "Research Agent", model: "Llama-3-70b", status: "Running" },
                { name: "Code Assistant", model: "DeepSeek-Coder", status: "Idle" },
                { name: "System Monitor", model: "Phi-3-Mini", status: "Running" },
                { name: "Data Analyst", model: "Mixtral-8x7b", status: "Sleeping" },
              ].map((agent, i) => (
                <div key={i} className="flex items-center justify-between p-3 rounded-lg border border-border bg-card hover:bg-accent/50 transition-colors">
                  <div>
                    <p className="text-sm font-medium">{agent.name}</p>
                    <p className="text-xs text-muted-foreground">{agent.model}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={cn(
                      "w-2 h-2 rounded-full",
                      agent.status === "Running" ? "bg-emerald-500" : 
                      agent.status === "Idle" ? "bg-amber-500" : "bg-muted-foreground"
                    )} />
                    <span className="text-xs text-muted-foreground">{agent.status}</span>
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
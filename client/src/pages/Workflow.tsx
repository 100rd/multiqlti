import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Settings } from "lucide-react";
import MultiAgentPipeline from "@/components/workflow/MultiAgentPipeline";
import AgentChat from "@/components/workflow/AgentChat";
import CodePreview from "@/components/workflow/CodePreview";

export default function Workflow() {
  const [activeTab, setActiveTab] = useState("design");

  return (
    <div className="flex flex-col h-full bg-background">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Workflow Manager</h2>
          <p className="text-xs text-muted-foreground">Build multi-agent pipelines for complex tasks</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Settings className="h-3 w-3 mr-2" /> Settings
          </Button>
          <Button size="sm" className="h-8 text-xs">
            <Plus className="h-3 w-3 mr-2" /> New Pipeline
          </Button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full h-full flex flex-col">
          <TabsList className="grid w-full grid-cols-4 px-6 pt-4 bg-background">
            <TabsTrigger value="design" className="text-xs">Design & Ideas</TabsTrigger>
            <TabsTrigger value="chat" className="text-xs">Discussion</TabsTrigger>
            <TabsTrigger value="code" className="text-xs">Generated Code</TabsTrigger>
            <TabsTrigger value="history" className="text-xs">History</TabsTrigger>
          </TabsList>

          <div className="flex-1 overflow-hidden p-6">
            <TabsContent value="design" className="h-full overflow-y-auto">
              <MultiAgentPipeline />
            </TabsContent>

            <TabsContent value="chat" className="h-full">
              <AgentChat />
            </TabsContent>

            <TabsContent value="code" className="h-full">
              <CodePreview />
            </TabsContent>

            <TabsContent value="history" className="h-full overflow-y-auto">
              <div className="space-y-4">
                {[
                  { task: "Build React Dashboard UI", status: "Completed", time: "2h 34m", agents: 4 },
                  { task: "Analyze API Performance Report", status: "Running", time: "45m", agents: 3 },
                  { task: "Design Authentication Flow", status: "Completed", time: "1h 12m", agents: 3 },
                ].map((run, idx) => (
                  <Card key={idx} className="border-border p-4 flex items-center justify-between hover:bg-accent/50 transition-colors">
                    <div className="flex-1">
                      <h4 className="font-medium text-sm">{run.task}</h4>
                      <p className="text-xs text-muted-foreground mt-1">{run.agents} agents • {run.time}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                        run.status === 'Completed' ? 'bg-emerald-500/20 text-emerald-700' : 'bg-blue-500/20 text-blue-700'
                      }`}>
                        {run.status}
                      </span>
                      <Button variant="outline" size="sm" className="h-7 text-xs">Review</Button>
                    </div>
                  </Card>
                ))}
              </div>
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

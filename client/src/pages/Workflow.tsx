import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Settings } from "lucide-react";
import MultiAgentPipeline from "@/components/workflow/MultiAgentPipeline";

export default function Workflow() {
  const [activeTab, setActiveTab] = useState("pipeline");

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

      <div className="flex-1 overflow-y-auto p-8">
        <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full max-w-4xl">
          <TabsList className="grid w-full grid-cols-3 mb-8">
            <TabsTrigger value="pipeline" className="text-xs">Pipeline Builder</TabsTrigger>
            <TabsTrigger value="templates" className="text-xs">Templates</TabsTrigger>
            <TabsTrigger value="history" className="text-xs">Execution History</TabsTrigger>
          </TabsList>

          <TabsContent value="pipeline" className="space-y-6">
            <MultiAgentPipeline />
          </TabsContent>

          <TabsContent value="templates" className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {
                  name: "Code Generation Pipeline",
                  desc: "Plan → Design → Implement → Review",
                  agents: ["Planner", "Designer", "Developer", "Reviewer"],
                  icon: "💻"
                },
                {
                  name: "Content Creation",
                  desc: "Plan → Write → Fact Check → Optimize",
                  agents: ["Planner", "Writer", "Fact Checker", "Reviewer"],
                  icon: "📝"
                },
                {
                  name: "Research & Analysis",
                  desc: "Plan → Research → Synthesize → Validate",
                  agents: ["Planner", "Researcher", "Analyst", "Fact Checker"],
                  icon: "🔍"
                },
                {
                  name: "System Architecture",
                  desc: "Design → Architect → Implement → Audit",
                  agents: ["Designer", "Architect", "Developer", "Reviewer"],
                  icon: "🏗️"
                },
              ].map((template, idx) => (
                <Card key={idx} className="border-border p-4 hover:shadow-md transition-shadow cursor-pointer hover:bg-accent/50">
                  <div className="flex items-start justify-between mb-3">
                    <div className="text-2xl">{template.icon}</div>
                    <Button variant="outline" size="sm" className="h-7 text-xs">Use</Button>
                  </div>
                  <h4 className="font-medium text-sm mb-1">{template.name}</h4>
                  <p className="text-xs text-muted-foreground mb-3">{template.desc}</p>
                  <div className="flex flex-wrap gap-1">
                    {template.agents.map((agent, i) => (
                      <span key={i} className="px-2 py-1 rounded-full bg-muted text-xs font-medium">
                        {agent}
                      </span>
                    ))}
                  </div>
                </Card>
              ))}
            </div>
          </TabsContent>

          <TabsContent value="history" className="space-y-4">
            <div className="space-y-3">
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
        </Tabs>
      </div>
    </div>
  );
}

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Plus, Play, Save, Copy } from "lucide-react";
import AgentNode from "./AgentNode";
import { cn } from "@/lib/utils";

interface Agent {
  id: string;
  role: string;
  model: string;
}

export default function MultiAgentPipeline() {
  const [agents, setAgents] = useState<Agent[]>([
    { id: "1", role: "planner", model: "gpt4-turbo" },
    { id: "2", role: "designer", model: "claude-opus" },
    { id: "3", role: "fact_checker", model: "grok-2" },
  ]);

  const addAgent = () => {
    const newId = String(Math.max(...agents.map(a => parseInt(a.id)), 0) + 1);
    setAgents([...agents, { id: newId, role: "reviewer", model: "llama3-70b" }]);
  };

  const removeAgent = (id: string) => {
    if (agents.length > 1) {
      setAgents(agents.filter(a => a.id !== id));
    }
  };

  const updateRole = (id: string, role: string) => {
    setAgents(agents.map(a => a.id === id ? { ...a, role } : a));
  };

  const updateModel = (id: string, model: string) => {
    setAgents(agents.map(a => a.id === id ? { ...a, model } : a));
  };

  return (
    <div className="space-y-6">
      {/* Pipeline Header */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">Multi-Agent Pipeline</h3>
          <p className="text-sm text-muted-foreground mt-1">Chain models to work on complex tasks collaboratively</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="text-xs h-8">
            <Copy className="h-3 w-3 mr-1" /> Template
          </Button>
          <Button variant="outline" size="sm" className="text-xs h-8">
            <Save className="h-3 w-3 mr-1" /> Save
          </Button>
          <Button size="sm" className="text-xs h-8">
            <Play className="h-3 w-3 mr-1" /> Execute
          </Button>
        </div>
      </div>

      {/* Agent Pipeline */}
      <div className="relative">
        <div className="space-y-6">
          {agents.map((agent, idx) => (
            <AgentNode
              key={agent.id}
              id={agent.id}
              role={agent.role}
              model={agent.model}
              description=""
              onRemove={removeAgent}
              onRoleChange={updateRole}
              onModelChange={updateModel}
              isLast={idx === agents.length - 1}
            />
          ))}
        </div>

        {/* Add Agent Button */}
        <div className="mt-6 pt-6 border-t border-border">
          <Button
            variant="outline"
            className="w-full h-9 border-dashed text-muted-foreground hover:text-foreground"
            onClick={addAgent}
          >
            <Plus className="h-4 w-4 mr-2" /> Add Agent Role
          </Button>
        </div>
      </div>

      {/* Pipeline Configuration */}
      <Card className="border-border bg-muted/30 p-4">
        <div className="space-y-3">
          <div className="text-sm font-medium">Pipeline Behavior</div>
          
          <div className="grid grid-cols-2 gap-4 text-xs">
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Sequential Execution</div>
              <div className="text-muted-foreground">Each agent processes the output of the previous one</div>
            </div>
            
            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Sandbox Isolation</div>
              <div className="text-muted-foreground">Each agent runs in an isolated sandbox</div>
            </div>

            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Context Passing</div>
              <div className="text-muted-foreground">Full task context passed to each agent</div>
            </div>

            <div className="p-2 rounded border border-border bg-card">
              <div className="font-medium mb-1">Output Collection</div>
              <div className="text-muted-foreground">All agent outputs logged for review</div>
            </div>
          </div>
        </div>
      </Card>

      {/* Example Task */}
      <Card className="border-border bg-card p-4 space-y-3">
        <div className="text-sm font-medium">Example: Build a Web Dashboard</div>
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex gap-2">
            <span className="font-mono text-blue-500">→</span>
            <span><span className="font-medium text-foreground">Planner (GPT-4)</span> breaks down requirements into subtasks</span>
          </div>
          <div className="flex gap-2">
            <span className="font-mono text-blue-500">→</span>
            <span><span className="font-medium text-foreground">Designer (Claude)</span> creates UI mockups & data structures</span>
          </div>
          <div className="flex gap-2">
            <span className="font-mono text-blue-500">→</span>
            <span><span className="font-medium text-foreground">Developer (DeepSeek)</span> implements the code</span>
          </div>
          <div className="flex gap-2">
            <span className="font-mono text-blue-500">→</span>
            <span><span className="font-medium text-foreground">Fact Checker (Grok)</span> validates outputs & identifies issues</span>
          </div>
          <div className="flex gap-2">
            <span className="font-mono text-blue-500">→</span>
            <span><span className="font-medium text-foreground">Output</span> delivered to you with full audit trail</span>
          </div>
        </div>
      </Card>
    </div>
  );
}

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { X, GripVertical, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";

interface AgentNodeProps {
  id: string;
  role: string;
  model: string;
  description: string;
  onRemove: (id: string) => void;
  onRoleChange: (id: string, role: string) => void;
  onModelChange: (id: string, model: string) => void;
  isLast: boolean;
}

const AGENT_ROLES = [
  { label: "Planner", value: "planner", desc: "Break down tasks and orchestrate workflow" },
  { label: "Designer", value: "designer", desc: "Create architectural & visual designs" },
  { label: "Developer", value: "developer", desc: "Write and refine code" },
  { label: "Fact Checker", value: "fact_checker", desc: "Verify accuracy & completeness" },
  { label: "Reviewer", value: "reviewer", desc: "Quality assurance & optimization" },
  { label: "Researcher", value: "researcher", desc: "Deep research & data collection" },
];

const AVAILABLE_MODELS = [
  { label: "Claude-3-Opus", value: "claude-opus", logo: "🧠" },
  { label: "Grok-2", value: "grok-2", logo: "⚡" },
  { label: "Llama-3-70b", value: "llama3-70b", logo: "🦙" },
  { label: "DeepSeek-Coder", value: "deepseek-coder", logo: "💻" },
  { label: "Mixtral-8x7B", value: "mixtral-8x7b", logo: "🔧" },
  { label: "GPT-4-Turbo", value: "gpt4-turbo", logo: "🤖" },
];

export default function AgentNode({
  id,
  role,
  model,
  description,
  onRemove,
  onRoleChange,
  onModelChange,
  isLast,
}: AgentNodeProps) {
  const selectedRole = AGENT_ROLES.find(r => r.value === role);
  const selectedModel = AVAILABLE_MODELS.find(m => m.value === model);

  return (
    <div className="relative">
      <Card className="border-border shadow-sm bg-card hover:shadow-md transition-shadow">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1">
              <Select value={role} onValueChange={(val) => onRoleChange(id, val)}>
                <SelectTrigger className="w-full h-8 text-sm font-medium bg-muted border-0 focus-visible:ring-1">
                  <SelectValue placeholder="Select role" />
                </SelectTrigger>
                <SelectContent>
                  {AGENT_ROLES.map(r => (
                    <SelectItem key={r.value} value={r.value}>
                      <span className="font-medium">{r.label}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {selectedRole && (
                <p className="text-xs text-muted-foreground mt-1">{selectedRole.desc}</p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={() => onRemove(id)}
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        </CardHeader>

        <CardContent className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground mb-1 block">Model</label>
            <Select value={model} onValueChange={(val) => onModelChange(id, val)}>
              <SelectTrigger className="h-8 text-xs bg-background border-border">
                <SelectValue placeholder="Select model" />
              </SelectTrigger>
              <SelectContent>
                {AVAILABLE_MODELS.map(m => (
                  <SelectItem key={m.value} value={m.value}>
                    <span>{m.logo} {m.label}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="p-2 rounded bg-muted/50 border border-border">
            <div className="text-xs font-mono text-muted-foreground">
              <div className="flex items-center gap-1">
                <span className="text-blue-500">→</span>
                <span className="truncate">{selectedModel?.label || 'Model'}</span>
              </div>
              <div className="text-[10px] mt-1 text-muted-foreground/70">
                Processes task input and passes context to {!isLast ? 'next agent' : 'output'}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Connection line to next agent */}
      {!isLast && (
        <div className="absolute left-1/2 -bottom-6 w-[2px] h-6 bg-border -translate-x-1/2"></div>
      )}
    </div>
  );
}

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Plus, Play, Database, FileCode, Search, Settings } from "lucide-react";

export default function Workflow() {
  return (
    <div className="flex flex-col h-full bg-background">
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div>
          <h2 className="text-sm font-semibold">Workflow Builder</h2>
          <p className="text-xs text-muted-foreground">Configure agent routing and sandbox execution</p>
        </div>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Settings className="h-3 w-3 mr-2" /> Load Config
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <Plus className="h-3 w-3 mr-2" /> Add Node
          </Button>
          <Button size="sm" className="h-8 text-xs">
            <Play className="h-3 w-3 mr-2" /> Run Workflow
          </Button>
        </div>
      </div>

      <div className="flex-1 bg-muted/30 p-8 relative overflow-hidden flex items-center justify-center">
        {/* Abstract Grid Background */}
        <div className="absolute inset-0 bg-[linear-gradient(to_right,hsl(var(--border))_1px,transparent_1px),linear-gradient(to_bottom,hsl(var(--border))_1px,transparent_1px)] bg-[size:24px_24px] opacity-20"></div>
        
        {/* Mock Workflow Nodes */}
        <div className="relative z-10 flex flex-col md:flex-row items-center justify-center gap-12 w-full max-w-5xl">
          
          <Card className="w-64 border-border shadow-sm bg-card relative z-20">
            <div className="p-3 border-b border-border flex items-center gap-2">
              <Search className="h-4 w-4 text-blue-500" />
              <span className="text-sm font-medium">Local Knowledge</span>
            </div>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs text-muted-foreground">Source: Vector DB</div>
              <div className="bg-muted p-2 rounded text-xs font-mono">Query: user_context</div>
            </CardContent>
            {/* Connection dot */}
            <div className="hidden md:block absolute right-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
            <div className="md:hidden absolute bottom-[-6px] left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
          </Card>

          {/* Line Horizontal */}
          <div className="hidden md:block h-[2px] w-12 bg-border absolute left-[calc(50%-10rem)] top-1/2 -translate-y-1/2 z-10"></div>
          {/* Line Vertical */}
          <div className="md:hidden w-[2px] h-12 bg-border absolute top-[calc(50%-10rem)] left-1/2 -translate-x-1/2 z-10"></div>

          <Card className="w-64 border-primary/50 shadow-md bg-card relative z-20 ring-1 ring-primary/20">
            {/* Connection dots */}
            <div className="hidden md:block absolute left-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-primary border-2 border-background"></div>
            <div className="md:hidden absolute top-[-6px] left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-primary border-2 border-background"></div>
            
            <div className="hidden md:block absolute right-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
            <div className="md:hidden absolute bottom-[-6px] left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
            
            <div className="p-3 border-b border-border flex items-center gap-2">
              <Database className="h-4 w-4 text-primary" />
              <span className="text-sm font-medium">Llama-3-70b Planner</span>
            </div>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs text-muted-foreground">Action: Synthesize</div>
              <div className="bg-primary/10 text-primary p-2 rounded text-xs font-mono">Status: Processing...</div>
            </CardContent>
          </Card>

          {/* Line Horizontal */}
          <div className="hidden md:block h-[2px] w-12 bg-border absolute right-[calc(50%-10rem)] top-1/2 -translate-y-1/2 z-10"></div>
          {/* Line Vertical */}
          <div className="md:hidden w-[2px] h-12 bg-border absolute bottom-[calc(50%-10rem)] left-1/2 -translate-x-1/2 z-10"></div>

          <Card className="w-64 border-border shadow-sm bg-card relative z-20 opacity-70">
            {/* Connection dot */}
            <div className="hidden md:block absolute left-[-6px] top-1/2 -translate-y-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
            <div className="md:hidden absolute top-[-6px] left-1/2 -translate-x-1/2 w-3 h-3 rounded-full bg-border border-2 border-background"></div>
            
            <div className="p-3 border-b border-border flex items-center gap-2">
              <FileCode className="h-4 w-4 text-emerald-500" />
              <span className="text-sm font-medium">Python Sandbox</span>
            </div>
            <CardContent className="p-4 space-y-2">
              <div className="text-xs text-muted-foreground">Environment: Isolated</div>
              <div className="bg-muted p-2 rounded text-xs font-mono">Awaiting input</div>
            </CardContent>
          </Card>

        </div>
      </div>
    </div>
  );
}
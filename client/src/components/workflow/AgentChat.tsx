import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";
import { useRuns, useChatMessages, useSendChatMessage } from "@/hooks/use-pipeline";
import { SDLC_TEAMS } from "@shared/constants";

const TEAM_COLORS: Record<string, string> = {
  planning: "bg-blue-500/20 text-blue-700",
  architecture: "bg-purple-500/20 text-purple-700",
  development: "bg-green-500/20 text-green-700",
  testing: "bg-amber-500/20 text-amber-700",
  code_review: "bg-orange-500/20 text-orange-700",
  deployment: "bg-cyan-500/20 text-cyan-700",
  monitoring: "bg-rose-500/20 text-rose-700",
  fact_check: "bg-violet-500/20 text-violet-700",
};

interface AgentChatProps {
  pipelineId?: string;
}

interface ChatMessage {
  id?: string;
  role: string;
  agentTeam?: string;
  modelSlug?: string;
  content: string;
}

interface Run {
  id: string;
  pipelineId?: string;
}

export default function AgentChat({ pipelineId }: AgentChatProps) {
  const { data: runs } = useRuns(pipelineId);

  const scopedRuns = Array.isArray(runs) ? runs : [];
  const latestRun: Run | null = scopedRuns.length > 0 ? scopedRuns[0] : null;
  const runId = latestRun?.id;

  const { data: messages } = useChatMessages(runId);
  const sendMessage = useSendChatMessage();
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim() || !runId || sendMessage.isPending) return;
    sendMessage.mutate({ runId, content: input });
    setInput("");
  };

  const msgList: ChatMessage[] = Array.isArray(messages) ? messages : [];

  return (
    <div className="flex flex-col h-full bg-background rounded-lg border border-border">
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center px-4 bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Agent Discussion</span>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">
          {runId ? `Run ${runId.slice(0, 8)}` : "No active run"}
        </span>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4 pr-4">
          {msgList.length === 0 && (
            <div className="text-sm text-muted-foreground text-center py-12">
              {runId ? "No messages yet in this run." : "Execute a pipeline to see agent discussion here."}
            </div>
          )}
          {msgList.map((msg, i) => {
            const isUser = msg.role === "user";
            const teamKey = msg.agentTeam;
            const team = teamKey ? SDLC_TEAMS[teamKey as keyof typeof SDLC_TEAMS] : null;
            const agentName = team?.name ?? (isUser ? "You" : "Agent");
            const colorClass = isUser
              ? "bg-primary text-primary-foreground"
              : TEAM_COLORS[teamKey ?? ""] ?? "bg-muted text-muted-foreground";

            return (
              <div key={msg.id || i} className={cn(
                "flex gap-3",
                isUser ? "flex-row-reverse" : "flex-row",
              )}>
                <div className={cn(
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-medium",
                  colorClass,
                )}>
                  {isUser ? "U" : agentName[0]}
                </div>

                <div className="flex-1 max-w-[70%]">
                  <div className={cn(
                    "px-4 py-2 rounded-lg text-sm shadow-sm",
                    isUser
                      ? "bg-primary text-primary-foreground rounded-tr-none"
                      : "bg-card border border-border text-card-foreground rounded-tl-none",
                  )}>
                    <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
                  </div>
                  <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 px-2">
                    <span className="font-medium">{agentName}</span>
                    {msg.modelSlug && (
                      <>
                        <span>·</span>
                        <span className="font-mono">{msg.modelSlug}</span>
                      </>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="h-16 border-t border-border flex items-center gap-2 px-4 bg-card shrink-0">
        <Input
          className="flex-1 h-9 text-sm bg-background border-border rounded-full"
          placeholder={runId ? "Ask agents to refine or address concerns..." : "Start a pipeline run first"}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSend()}
          disabled={!runId || sendMessage.isPending}
        />
        <Button
          size="icon"
          className="h-9 w-9 rounded-full"
          onClick={handleSend}
          disabled={!input.trim() || !runId || sendMessage.isPending}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

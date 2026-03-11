import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send, Bot, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  agent: string;
  role: string;
  content: string;
  timestamp: string;
}

export default function AgentChat() {
  const [messages, setMessages] = useState<Message[]>([
    {
      agent: "Planner",
      role: "planner",
      content: "I've analyzed the requirements. We need a responsive dashboard with real-time data visualization and user authentication.",
      timestamp: "14:32",
    },
    {
      agent: "Designer",
      role: "designer",
      content: "Based on the plan, I propose a minimalist layout with card-based components. Color scheme: neutral grays with accent blues for CTAs.",
      timestamp: "14:33",
    },
    {
      agent: "Designer",
      role: "designer",
      content: "I'm suggesting a left sidebar for navigation, main content area with grid layout for dashboard widgets, and a top bar for controls.",
      timestamp: "14:34",
    },
  ]);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([...messages, {
      agent: "You",
      role: "user",
      content: input,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    }]);
    setInput("");
  };

  return (
    <div className="flex flex-col h-full bg-background rounded-lg border border-border">
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center px-4 bg-card shrink-0">
        <div className="flex items-center gap-2">
          <Lightbulb className="h-4 w-4 text-amber-500" />
          <span className="text-sm font-medium">Agent Discussion</span>
        </div>
        <span className="ml-auto text-xs text-muted-foreground">3 agents active</span>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4">
        <div className="space-y-4 pr-4">
          {messages.map((msg, i) => (
            <div key={i} className={cn(
              "flex gap-3",
              msg.role === "user" ? "flex-row-reverse" : "flex-row"
            )}>
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-medium flex-col justify-center",
                msg.role === "planner" ? "bg-blue-500/20 text-blue-700" :
                msg.role === "designer" ? "bg-purple-500/20 text-purple-700" :
                msg.role === "developer" ? "bg-green-500/20 text-green-700" :
                msg.role === "user" ? "bg-primary text-primary-foreground" :
                "bg-muted text-muted-foreground"
              )}>
                {msg.agent === "You" ? "👤" : msg.agent[0]}
              </div>
              
              <div className={cn(
                "flex-1 max-w-[70%]",
                msg.role === "user" ? "flex-row-reverse" : ""
              )}>
                <div className={cn(
                  "px-4 py-2 rounded-lg text-sm shadow-sm",
                  msg.role === "user"
                    ? "bg-primary text-primary-foreground rounded-tr-none"
                    : "bg-card border border-border text-card-foreground rounded-tl-none"
                )}>
                  {msg.content}
                </div>
                <div className="text-xs text-muted-foreground mt-1 flex items-center gap-2 px-2">
                  <span className="font-medium">{msg.agent}</span>
                  <span>•</span>
                  <span>{msg.timestamp}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="h-16 border-t border-border flex items-center gap-2 px-4 bg-card shrink-0">
        <Input
          className="flex-1 h-9 text-sm bg-background border-border rounded-full"
          placeholder="Ask agents to refine design or address concerns..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleSend()}
        />
        <Button
          size="icon"
          className="h-9 w-9 rounded-full"
          onClick={handleSend}
          disabled={!input.trim()}
        >
          <Send className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

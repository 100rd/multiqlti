import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Bot, User, Settings2, Paperclip } from "lucide-react";
import { cn } from "@/lib/utils";

export default function Chat() {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Local environment initialized. Sandboxes are active. I am restricted from external network access. How can I help you today?" }
  ]);
  const [input, setInput] = useState("");

  const handleSend = () => {
    if (!input.trim()) return;
    setMessages([...messages, { role: "user", content: input }]);
    setInput("");
    
    // Mock response
    setTimeout(() => {
      setMessages(prev => [...prev, { 
        role: "assistant", 
        content: "I have spawned a local Python sandbox to process your request. No data will leave this machine." 
      }]);
    }, 1000);
  };

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold">Local Execution Chat</h2>
            <p className="text-xs text-muted-foreground">Connected via vLLM Gateway</p>
          </div>
        </div>
        
        <div className="flex items-center gap-3">
          <Select defaultValue="llama3">
            <SelectTrigger className="w-[180px] h-8 text-xs bg-background">
              <SelectValue placeholder="Select Model" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="llama3">Llama-3-70b-Instruct</SelectItem>
              <SelectItem value="mixtral">Mixtral-8x7B-v0.1</SelectItem>
              <SelectItem value="deepseek">DeepSeek-Coder-33B</SelectItem>
              <SelectItem value="phi3">Phi-3-Mini-128K</SelectItem>
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" className="h-8 w-8">
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Chat Area */}
      <ScrollArea className="flex-1 p-6">
        <div className="max-w-3xl mx-auto space-y-6 pb-4">
          {messages.map((msg, i) => (
            <div key={i} className={cn(
              "flex gap-4",
              msg.role === "user" ? "flex-row-reverse" : "flex-row"
            )}>
              <div className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                msg.role === "user" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )}>
                {msg.role === "user" ? <User className="h-4 w-4" /> : <Bot className="h-4 w-4" />}
              </div>
              
              <div className={cn(
                "px-4 py-3 rounded-2xl max-w-[80%] text-sm shadow-sm",
                msg.role === "user" 
                  ? "bg-primary text-primary-foreground rounded-tr-none" 
                  : "bg-card border border-border text-card-foreground rounded-tl-none"
              )}>
                {msg.content}
              </div>
            </div>
          ))}
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="p-6 bg-background shrink-0 border-t border-border">
        <div className="max-w-3xl mx-auto relative flex items-center">
          <Button variant="ghost" size="icon" className="absolute left-2 h-8 w-8 text-muted-foreground hover:text-foreground rounded-full z-10">
            <Paperclip className="h-4 w-4" />
          </Button>
          <Input 
            className="w-full pl-12 pr-12 py-6 rounded-full border-border bg-card shadow-sm focus-visible:ring-1"
            placeholder="Instruct the local agent..."
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSend()}
          />
          <Button 
            size="icon" 
            className="absolute right-2 h-8 w-8 rounded-full z-10"
            onClick={handleSend}
            disabled={!input.trim()}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground mt-3 font-mono">All processing is performed strictly on-device. No telemetry.</p>
      </div>
    </div>
  );
}
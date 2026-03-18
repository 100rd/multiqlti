import { useState, useEffect, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send, Bot, User, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useModels, useStandaloneChat, useGatewayStatus } from "@/hooks/use-pipeline";

interface ChatMsg {
  role: string;
  content: string;
}

const HISTORY_STORAGE_KEY = "chat-history-standalone";

function loadHistory(): ChatMsg[] {
  try {
    const raw = localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as ChatMsg[];
  } catch {
    return [];
  }
}

function saveHistory(msgs: ChatMsg[]): void {
  try {
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(msgs));
  } catch {
    // localStorage may be unavailable
  }
}

const DEFAULT_GREETING: ChatMsg = {
  role: "assistant",
  content: "Local environment initialized. Sandboxes are active. I am restricted from external network access. How can I help you today?",
};

type GatewayStatus = Record<string, boolean | string | null>;
type ModelRecord = Record<string, unknown>;

function isProviderAvailable(provider: string, gatewayStatus: GatewayStatus | undefined): boolean {
  if (!gatewayStatus) return true; // not yet loaded — don't hide anything
  if (provider === "mock") return true;
  return !!gatewayStatus[provider];
}

export default function Chat() {
  const { data: models } = useModels();
  const { data: gatewayStatus } = useGatewayStatus();
  const chatMutation = useStandaloneChat();
  const scrollRef = useRef<HTMLDivElement>(null);

  // Only show active models whose provider is actually configured (has API key / endpoint)
  const modelList: ModelRecord[] = Array.isArray(models)
    ? models.filter((m: ModelRecord) =>
        m.isActive && isProviderAvailable(m.provider as string, gatewayStatus as GatewayStatus)
      )
    : [];

  const [selectedModel, setSelectedModel] = useState<string>("");
  const [messages, setMessages] = useState<ChatMsg[]>(() => {
    const saved = loadHistory();
    return saved.length > 0 ? saved : [DEFAULT_GREETING];
  });
  const [input, setInput] = useState("");
  const [tokensUsed, setTokensUsed] = useState(0);

  // Set default model once models are loaded
  useEffect(() => {
    if (!selectedModel && modelList.length > 0) {
      setSelectedModel(modelList[0].slug as string);
    }
  }, [modelList, selectedModel]);

  // If the selected model's provider loses its key, switch to first available
  useEffect(() => {
    if (selectedModel && gatewayStatus && modelList.length > 0) {
      const still = modelList.find((m) => (m.slug as string) === selectedModel);
      if (!still) setSelectedModel(modelList[0].slug as string);
    }
  }, [modelList, selectedModel, gatewayStatus]);

  // Reset token counter when switching models
  useEffect(() => {
    setTokensUsed(0);
  }, [selectedModel]);

  // Persist chat history on every message change
  useEffect(() => {
    saveHistory(messages);
  }, [messages]);

  // Scroll to bottom on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const selectedModelData = modelList.find((m) => (m.slug as string) === selectedModel);
  const contextLimit = (selectedModelData?.contextLimit as number) ?? 0;
  const noModelsAvailable = !!gatewayStatus && modelList.length === 0;
  const canSend = !!selectedModel && !chatMutation.isPending && !!input.trim() && !noModelsAvailable;

  const handleSend = () => {
    if (!canSend) return;
    const userMsg: ChatMsg = { role: "user", content: input };
    const updatedMessages = [...messages, userMsg];
    setMessages(updatedMessages);
    setInput("");

    chatMutation.mutate(
      {
        content: input,
        modelSlug: selectedModel,
        history: updatedMessages.slice(-10),
      },
      {
        onSuccess: (data: { content: string; tokensUsed?: number }) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: data.content },
          ]);
          if (data.tokensUsed) {
            setTokensUsed((prev) => prev + (data.tokensUsed ?? 0));
          }
        },
        onError: (error: Error) => {
          setMessages((prev) => [
            ...prev,
            { role: "assistant", content: `Error: ${error.message}` },
          ]);
        },
      },
    );
  };

  const handleClearHistory = () => {
    const fresh = [DEFAULT_GREETING];
    setMessages(fresh);
    saveHistory(fresh);
    setTokensUsed(0);
  };

  const tokenPct = contextLimit > 0 ? tokensUsed / contextLimit : 0;

  return (
    <div className="flex flex-col h-full bg-background">
      {/* Top bar */}
      <div className="h-16 border-b border-border flex items-center justify-between px-6 bg-card shrink-0">
        <div className="flex items-center gap-4">
          <div className="flex flex-col">
            <h2 className="text-sm font-semibold">Local Execution Chat</h2>
            <p className="text-xs text-muted-foreground">Connected via Gateway</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Token usage counter */}
          {contextLimit > 0 && (
            <div className={cn(
              "text-xs font-mono tabular-nums",
              tokenPct >= 0.9 ? "text-destructive" : tokenPct >= 0.7 ? "text-yellow-500" : "text-muted-foreground"
            )}>
              {tokensUsed.toLocaleString()} / {(contextLimit / 1024).toFixed(0)}k ctx
            </div>
          )}

          <Select value={selectedModel} onValueChange={setSelectedModel}>
            <SelectTrigger className="w-[200px] h-8 text-xs bg-background">
              <SelectValue placeholder={noModelsAvailable ? "No models — add API key" : "Select Model"} />
            </SelectTrigger>
            <SelectContent>
              {modelList.map((m) => (
                <SelectItem key={m.slug as string} value={m.slug as string}>
                  {m.name as string}
                  <span className="text-muted-foreground ml-1">({m.provider as string})</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="icon" className="h-8 w-8" onClick={handleClearHistory} title="Clear history">
            <Settings2 className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* No-models banner */}
      {noModelsAvailable && (
        <div className="px-6 py-2 text-center text-xs bg-muted/60 border-b border-border text-muted-foreground">
          No models available. Add an API key or endpoint in{" "}
          <strong>Settings → Providers</strong>.
        </div>
      )}

      {/* Chat Area */}
      <ScrollArea className="flex-1 p-6">
        <div ref={scrollRef} className="max-w-3xl mx-auto space-y-6 pb-4">
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
                <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
              </div>
            </div>
          ))}
          {chatMutation.isPending && (
            <div className="flex gap-4">
              <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 bg-muted text-muted-foreground">
                <Bot className="h-4 w-4" />
              </div>
              <div className="px-4 py-3 rounded-2xl bg-card border border-border text-card-foreground rounded-tl-none">
                <div className="flex gap-1">
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce" />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0.15s" }} />
                  <div className="w-2 h-2 rounded-full bg-muted-foreground/50 animate-bounce" style={{ animationDelay: "0.3s" }} />
                </div>
              </div>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Input Area */}
      <div className="p-6 bg-background shrink-0 border-t border-border">
        <div className="max-w-3xl mx-auto relative flex items-center">
          <Input
            className="w-full pr-12 py-6 rounded-full border-border bg-card shadow-sm focus-visible:ring-1"
            placeholder={
              noModelsAvailable
                ? "Configure an API key in Settings to chat…"
                : !selectedModel
                  ? "Select a model above to start…"
                  : "Instruct the local agent…"
            }
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSend()}
            disabled={chatMutation.isPending || noModelsAvailable || !selectedModel}
          />
          <Button
            size="icon"
            className="absolute right-2 h-8 w-8 rounded-full z-10"
            onClick={handleSend}
            disabled={!canSend}
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        <p className="text-center text-[10px] text-muted-foreground mt-3 font-mono">
          {noModelsAvailable
            ? "No models available — add an API key or local endpoint in Settings"
            : selectedModel
              ? `Model: ${selectedModel} \u2022 All processing is performed strictly on-device.`
              : "Select a model to begin"}
        </p>
      </div>
    </div>
  );
}

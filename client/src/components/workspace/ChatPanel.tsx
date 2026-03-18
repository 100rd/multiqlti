import { useState, useRef, useEffect } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { apiRequest } from "@/hooks/use-pipeline";

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model?: string;
}

interface ChatPanelProps {
  workspaceId: string;
  modelSlug: string;
  contextFilePaths?: string[];
}

async function sendChat(
  workspaceId: string,
  message: string,
  modelSlug: string,
  filePaths: string[],
): Promise<string> {
  const data = await apiRequest("POST", `/api/workspaces/${workspaceId}/chat`, {
    message,
    modelSlug,
    context: filePaths.length > 0 ? { filePaths } : undefined,
  }) as { reply: string };
  return data.reply;
}

export function ChatPanel({ workspaceId, modelSlug, contextFilePaths = [] }: ChatPanelProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isSending, setIsSending] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || isSending) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setIsSending(true);

    try {
      const reply = await sendChat(workspaceId, text, modelSlug, contextFilePaths);
      const assistantMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: reply,
        model: modelSlug,
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      const errMsg: Message = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: `Error: ${(err as Error).message}`,
        model: modelSlug,
      };
      setMessages((prev) => [...prev, errMsg]);
    } finally {
      setIsSending(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-24">
            <p className="text-xs text-muted-foreground text-center">
              Ask about the code in this workspace.
              {contextFilePaths.length > 0 && (
                <> {contextFilePaths.length} file(s) in context.</>
              )}
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            className={cn(
              "flex",
              msg.role === "user" ? "justify-end" : "justify-start",
            )}
          >
            <div
              className={cn(
                "max-w-[85%] rounded-lg px-3 py-2 text-xs",
                msg.role === "user"
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-foreground",
              )}
            >
              {msg.role === "assistant" && msg.model && (
                <span className="block text-[10px] font-mono font-semibold mb-1 opacity-60">
                  {msg.model}
                </span>
              )}
              <pre className="whitespace-pre-wrap font-sans">{msg.content}</pre>
            </div>
          </div>
        ))}

        {isSending && (
          <div className="flex justify-start">
            <div className="bg-muted rounded-lg px-3 py-2 text-xs text-muted-foreground">
              Thinking...
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3 shrink-0">
        <div className="flex gap-2 items-end">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the code... (Enter to send)"
            rows={2}
            className="flex-1 resize-none text-xs px-3 py-2 rounded-md border border-border bg-background text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            onClick={handleSend}
            disabled={!input.trim() || isSending}
            className="shrink-0 p-2 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            <Send className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

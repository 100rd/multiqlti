import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import type { ProviderMessage } from "@shared/types";
import { validateBody, validateQuery } from "../middleware/validate";
import { toolRegistry } from "../tools/index";

// ─── Zod schemas ─────────────────────────────────────────────────────────────

const HistoryMessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(100000),
});

const GetChatMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(500).optional(),
});

const SendChatSchema = z.object({
  content: z.string().min(1, "content is required").max(50000),
  modelSlug: z.string().max(200).optional(),
});

const StandaloneChatSchema = z.object({
  content: z.string().min(1, "content is required").max(50000),
  modelSlug: z.string().max(200).optional(),
  history: z.array(HistoryMessageSchema).max(100).optional(),
});

const StreamChatSchema = z.object({
  content: z.string().min(1, "content is required").max(50000),
  modelSlug: z.string().max(200).optional(),
  history: z.array(HistoryMessageSchema).max(100).optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PLATFORM_SYSTEM_PROMPT =
  "You are a helpful platform assistant. You can manage pipelines, workspaces, triggers, models, " +
  "skills, and memories using the available tools. When a user asks to perform a platform action, " +
  "use the appropriate tool. For destructive actions (delete, cancel), present the confirmation " +
  "details to the user and only proceed when they confirm.";

function getPlatformToolDefinitions(userRole?: string) {
  const allTools = toolRegistry.getAvailableTools({ tags: ["platform"] });
  if (userRole === "admin" || userRole === "maintainer") return allTools;
  // Non-privileged users only get non-destructive tools
  return allTools.filter((t) => !t.tags?.includes("destructive"));
}

/** Map a chat message role to a valid ProviderMessage role. */
function toProviderRole(role: string): "system" | "user" | "assistant" {
  if (role === "agent") return "assistant";
  if (role === "system" || role === "assistant") return role;
  return "user";
}

// ─────────────────────────────────────────────────────────────────────────────

export function registerChatRoutes(
  router: Router,
  storage: IStorage,
  gateway: Gateway,
  wsManager: WsManager,
) {
  router.get("/api/chat/:runId/messages", validateQuery(GetChatMessagesQuerySchema), async (req, res) => {
    const { limit } = req.query as z.infer<typeof GetChatMessagesQuerySchema>;
    const messages = await storage.getChatMessages(req.params["runId"] as string, limit);
    res.json(messages);
  });

  const sendChatHandler: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof SendChatSchema>;
    const content: string = body.content;
    const modelSlug: string | undefined = body.modelSlug;
    const runId = String(req.params["runId"]);

    // Save user message
    const userMsg = await storage.createChatMessage({
      runId,
      role: "user",
      content,
    });

    // Get conversation history and build typed provider messages
    const history = await storage.getChatMessages(runId, 20);
    const historyMessages: ProviderMessage[] = history.map((m) => ({
      role: toProviderRole(m.role),
      content: m.content,
    }));

    // Get tool-enabled response from gateway
    const slug: string = modelSlug ?? "llama3-70b";
    const userRole = (req as unknown as { user?: { role?: string } }).user?.role;
    const tools = getPlatformToolDefinitions(userRole);
    const response = await gateway.completeWithTools({
      modelSlug: slug,
      messages: [
        { role: "system" as const, content: PLATFORM_SYSTEM_PROMPT },
        ...historyMessages,
      ],
      tools,
    });

    const assistantMsg = await storage.createChatMessage({
      runId,
      role: "assistant",
      modelSlug: slug,
      content: response.content,
    });

    // Broadcast via WebSocket
    wsManager.broadcastToRun(runId, {
      type: "chat:message",
      runId,
      payload: {
        messageId: assistantMsg.id,
        role: "assistant",
        content: response.content,
        modelSlug: slug,
        toolCallLog: response.toolCallLog,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({
      userMessage: userMsg,
      assistantMessage: assistantMsg,
      toolCallLog: response.toolCallLog,
    });
  };
  router.post("/api/chat/:runId/messages", validateBody(SendChatSchema), sendChatHandler);

  // Standalone chat (no pipeline) — now with platform tools
  const standaloneChatHandler: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof StandaloneChatSchema>;
    const content: string = body.content;
    const modelSlug: string | undefined = body.modelSlug;
    const history = body.history;

    const slug: string = modelSlug ?? "llama3-70b";
    const messages: ProviderMessage[] = [
      { role: "system" as const, content: PLATFORM_SYSTEM_PROMPT },
      ...(Array.isArray(history)
        ? history.map((h): ProviderMessage => ({ role: toProviderRole(h.role), content: h.content }))
        : []),
      { role: "user" as const, content },
    ];

    const userRole = (req as unknown as { user?: { role?: string } }).user?.role;
    const tools = getPlatformToolDefinitions(userRole);
    const response = await gateway.completeWithTools({
      modelSlug: slug,
      messages,
      tools,
    });

    res.json({
      content: response.content,
      modelSlug: slug,
      tokensUsed: response.tokensUsed,
      toolCallLog: response.toolCallLog,
    });
  };
  router.post("/api/chat/standalone", validateBody(StandaloneChatSchema), standaloneChatHandler);

  // SSE streaming endpoint for standalone chat
  const streamChatHandler: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof StreamChatSchema>;
    const content: string = body.content;
    const modelSlug: string | undefined = body.modelSlug;
    const history = body.history;

    const slug: string = modelSlug ?? "llama3-70b";
    const messages: ProviderMessage[] = [
      ...(Array.isArray(history)
        ? history.map((h): ProviderMessage => ({ role: toProviderRole(h.role), content: h.content }))
        : []),
      { role: "user" as const, content },
    ];

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      for await (const chunk of gateway.stream({ modelSlug: slug, messages })) {
        res.write(`data: ${JSON.stringify({ chunk })}\n\n`);
      }
      res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    } catch (error) {
      res.write(
        `data: ${JSON.stringify({ error: (error as Error).message })}\n\n`,
      );
    }
    res.end();
  };
  router.post("/api/chat/stream", validateBody(StreamChatSchema), streamChatHandler);
}

import { Router } from "express";
import type { RequestHandler } from "express";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";
import { validateBody, validateQuery } from "../middleware/validate";

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

// ─────────────────────────────────────────────────────────────────────────────

export function registerChatRoutes(
  router: Router,
  storage: IStorage,
  gateway: Gateway,
  wsManager: WsManager,
) {
  router.get("/api/chat/:runId/messages", validateQuery(GetChatMessagesQuerySchema), async (req, res) => {
    const { limit } = req.query as z.infer<typeof GetChatMessagesQuerySchema>;
    const messages = await storage.getChatMessages(req.params["runId"], limit);
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

    // Get conversation history
    const history = await storage.getChatMessages(runId, 20);
    const messages = history.map((m) => ({
      role: m.role === "agent" ? "assistant" : m.role,
      content: m.content,
    }));

    // Get response from gateway
    const slug: string = modelSlug ?? "llama3-70b";
    const response = await gateway.complete({
      modelSlug: slug,
      messages,
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
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ userMessage: userMsg, assistantMessage: assistantMsg });
  };
  router.post("/api/chat/:runId/messages", validateBody(SendChatSchema), sendChatHandler);

  // Standalone chat (no pipeline)
  const standaloneChatHandler: RequestHandler = async (req, res) => {
    const body = req.body as z.infer<typeof StandaloneChatSchema>;
    const content: string = body.content;
    const modelSlug: string | undefined = body.modelSlug;
    const history = body.history;

    const slug: string = modelSlug ?? "llama3-70b";
    const messages = [
      ...(Array.isArray(history)
        ? history.map((h) => ({ role: h.role, content: h.content }))
        : []),
      { role: "user", content },
    ];

    const response = await gateway.complete({ modelSlug: slug, messages });
    res.json({
      content: response.content,
      modelSlug: slug,
      tokensUsed: response.tokensUsed,
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
    const messages = [
      ...(Array.isArray(history)
        ? history.map((h) => ({ role: h.role, content: h.content }))
        : []),
      { role: "user", content },
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

import { Router } from "express";
import type { IStorage } from "../storage";
import type { Gateway } from "../gateway/index";
import type { WsManager } from "../ws/manager";

export function registerChatRoutes(
  router: Router,
  storage: IStorage,
  gateway: Gateway,
  wsManager: WsManager,
) {
  router.get("/api/chat/:runId/messages", async (req, res) => {
    const limit = req.query.limit ? parseInt(req.query.limit as string) : undefined;
    const messages = await storage.getChatMessages(req.params.runId, limit);
    res.json(messages);
  });

  router.post("/api/chat/:runId/messages", async (req, res) => {
    const { content, modelSlug } = req.body;
    if (!content) {
      return res.status(400).json({ message: "content is required" });
    }

    // Save user message
    const userMsg = await storage.createChatMessage({
      runId: req.params.runId,
      role: "user",
      content,
    });

    // Get conversation history
    const history = await storage.getChatMessages(req.params.runId, 20);
    const messages = history.map((m) => ({
      role: m.role === "agent" ? "assistant" : m.role,
      content: m.content,
    }));

    // Get response from gateway
    const slug = modelSlug ?? "llama3-70b";
    const response = await gateway.complete({
      modelSlug: slug,
      messages,
    });

    const assistantMsg = await storage.createChatMessage({
      runId: req.params.runId,
      role: "assistant",
      modelSlug: slug,
      content: response.content,
    });

    // Broadcast via WebSocket
    wsManager.broadcastToRun(req.params.runId, {
      type: "chat:message",
      runId: req.params.runId,
      payload: {
        messageId: assistantMsg.id,
        role: "assistant",
        content: response.content,
        modelSlug: slug,
      },
      timestamp: new Date().toISOString(),
    });

    res.json({ userMessage: userMsg, assistantMessage: assistantMsg });
  });

  // Standalone chat (no pipeline)
  router.post("/api/chat/standalone", async (req, res) => {
    const { content, modelSlug, history } = req.body;
    if (!content) {
      return res.status(400).json({ message: "content is required" });
    }

    const slug = modelSlug ?? "llama3-70b";
    const messages = [
      ...(Array.isArray(history)
        ? history.map((h: { role: string; content: string }) => ({
            role: h.role,
            content: h.content,
          }))
        : []),
      { role: "user", content },
    ];

    const response = await gateway.complete({ modelSlug: slug, messages });
    res.json({
      content: response.content,
      modelSlug: slug,
      tokensUsed: response.tokensUsed,
    });
  });

  // SSE streaming endpoint for standalone chat
  router.post("/api/chat/stream", async (req, res) => {
    const { content, modelSlug, history } = req.body;
    if (!content) {
      return res.status(400).json({ message: "content is required" });
    }

    const slug = modelSlug ?? "llama3-70b";
    const messages = [
      ...(Array.isArray(history)
        ? history.map((h: { role: string; content: string }) => ({
            role: h.role,
            content: h.content,
          }))
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
  });
}

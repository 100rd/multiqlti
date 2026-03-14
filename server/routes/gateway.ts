import { Router } from "express";
import type { Gateway } from "../gateway/index";
import { SDLC_TEAMS, TEAM_ORDER } from "@shared/constants";

export function registerGatewayRoutes(router: Router, gateway: Gateway) {
  router.post("/api/gateway/complete", async (req, res) => {
    const { modelSlug, messages, temperature, maxTokens } = req.body;
    if (!modelSlug || !messages) {
      return res
        .status(400)
        .json({ message: "modelSlug and messages are required" });
    }

    try {
      const response = await gateway.complete({
        modelSlug,
        messages,
        temperature,
        maxTokens,
      });
      res.json(response);
    } catch (e) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  router.post("/api/gateway/stream", async (req, res) => {
    const { modelSlug, messages, temperature, maxTokens } = req.body;
    if (!modelSlug || !messages) {
      return res
        .status(400)
        .json({ message: "modelSlug and messages are required" });
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    try {
      for await (const chunk of gateway.stream({
        modelSlug,
        messages,
        temperature,
        maxTokens,
      })) {
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

  router.get("/api/gateway/status", async (_req, res) => {
    res.json(gateway.getStatus());
  });

  /** Test connectivity for a specific provider */
  router.post("/api/gateway/test/:provider", async (req, res) => {
    const { provider } = req.params;
    const status = gateway.getStatus();
    const providerKey = provider as keyof typeof status;

    // Check if provider is registered (env var is set)
    if (!(providerKey in status) || !status[providerKey as keyof typeof status]) {
      return res.json({ ok: false, error: "Provider not configured" });
    }

    const start = Date.now();
    try {
      await gateway.complete({
        modelSlug: `__test__${provider}`,
        messages: [{ role: "user", content: "ping" }],
        maxTokens: 5,
      });
      res.json({ ok: true, latencyMs: Date.now() - start });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });

  /** Discover models from all connected provider endpoints */
  router.get("/api/providers/discover", async (_req, res) => {
    try {
      const discovered = await gateway.discoverModels();
      res.json(discovered);
    } catch (e) {
      res.status(500).json({ message: (e as Error).message });
    }
  });

  /** Probe a custom endpoint to discover its models */
  router.post("/api/providers/probe", async (req, res) => {
    const { endpoint, providerType } = req.body;
    if (!endpoint || !providerType) {
      return res
        .status(400)
        .json({ message: "endpoint and providerType are required" });
    }
    if (providerType !== "vllm" && providerType !== "ollama") {
      return res
        .status(400)
        .json({ message: "providerType must be 'vllm' or 'ollama'" });
    }
    try {
      const models = await gateway.discoverFromEndpoint(endpoint, providerType);
      res.json({ models });
    } catch (e) {
      res.status(502).json({ message: (e as Error).message });
    }
  });

  router.get("/api/teams", async (_req, res) => {
    const teams = TEAM_ORDER.map((teamId) => {
      const { systemPromptTemplate, ...rest } = SDLC_TEAMS[teamId];
      return rest;
    });
    res.json(teams);
  });
}

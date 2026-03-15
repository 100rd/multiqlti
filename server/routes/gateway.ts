import { Router } from "express";
import { z } from "zod";
import type { Gateway } from "../gateway/index";
import { SDLC_TEAMS, TEAM_ORDER } from "@shared/constants";
import { validateBody } from "../middleware/validate.js";

// ─── SSRF denylist ────────────────────────────────────────────────────────────

const SSRF_DENYLIST_PATTERNS = [
  /^https?:\/\/169\.254\./,           // AWS IMDSv1
  /^https?:\/\/\[?fd00:ec2/i,         // AWS IMDSv2 IPv6
  /^https?:\/\/metadata\.google/,     // GCP metadata
  /^https?:\/\/metadata\.internal/,   // GCP alt
  /^https?:\/\/169\.254\.169\.254/,   // Common cloud metadata
];

function isSsrfBlocked(url: string): boolean {
  return SSRF_DENYLIST_PATTERNS.some((re) => re.test(url));
}

// ─── Zod schemas ──────────────────────────────────────────────────────────────

const MessageSchema = z.object({
  role: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(100000),
});

const GatewayCompleteSchema = z.object({
  modelSlug: z.string().min(1).max(200),
  messages: z.array(MessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().max(100000).optional(),
});

const GatewayStreamSchema = GatewayCompleteSchema;

const ProbeEndpointSchema = z.object({
  endpoint: z.string().url().max(500),
  providerType: z.enum(["vllm", "ollama"]),
});

// ─────────────────────────────────────────────────────────────────────────────

export function registerGatewayRoutes(router: Router, gateway: Gateway) {
  router.post("/api/gateway/complete", validateBody(GatewayCompleteSchema), async (req, res) => {
    const { modelSlug, messages, temperature, maxTokens } = req.body as z.infer<typeof GatewayCompleteSchema>;

    try {
      const response = await gateway.complete({
        modelSlug,
        messages,
        temperature,
        maxTokens,
      });
      res.json(response);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  router.post("/api/gateway/stream", validateBody(GatewayStreamSchema), async (req, res) => {
    const { modelSlug, messages, temperature, maxTokens } = req.body as z.infer<typeof GatewayStreamSchema>;

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
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** Probe a custom endpoint to discover its models */
  router.post("/api/providers/probe", validateBody(ProbeEndpointSchema), async (req, res) => {
    const { endpoint, providerType } = req.body as z.infer<typeof ProbeEndpointSchema>;
    if (isSsrfBlocked(endpoint)) {
      return res.status(400).json({ error: "Endpoint not allowed" });
    }
    try {
      const models = await gateway.discoverFromEndpoint(endpoint, providerType);
      res.json({ models });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
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

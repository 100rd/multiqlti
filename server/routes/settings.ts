import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerKeys } from "@shared/schema";
import { encrypt, decrypt } from "../crypto";
import type { Gateway } from "../gateway/index";

const CLOUD_PROVIDERS = ["anthropic", "google", "xai"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

const SaveKeySchema = z.object({
  apiKey: z.string().min(1, "apiKey must be non-empty"),
});

/** Source of an active key: env var takes precedence over DB. */
function getKeySource(provider: CloudProvider): "env" | "db" | "none" {
  const envVars: Record<CloudProvider, string> = {
    anthropic: "ANTHROPIC_API_KEY",
    google: "GOOGLE_API_KEY",
    xai: "XAI_API_KEY",
  };
  if (process.env[envVars[provider]]) return "env";
  return "none"; // updated to "db" by caller if DB row exists
}

export function registerSettingsRoutes(router: Router, gateway: Gateway) {
  /** GET /api/settings/providers — list providers with config status */
  router.get("/api/settings/providers", async (_req, res) => {
    try {
      const rows = await db.select().from(providerKeys);
      const dbMap = new Map(rows.map((r) => [r.provider, r]));

      const result = CLOUD_PROVIDERS.map((provider) => {
        const envSource = getKeySource(provider);
        const dbRow = dbMap.get(provider);
        const source: "env" | "db" | "none" =
          envSource === "env" ? "env" : dbRow ? "db" : "none";

        return {
          provider,
          configured: source !== "none",
          source,
          updatedAt: dbRow?.updatedAt ?? null,
        };
      });

      res.json(result);
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** POST /api/settings/providers/:provider/key — save encrypted API key */
  router.post("/api/settings/providers/:provider/key", async (req, res) => {
    const { provider } = req.params;
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    const result = SaveKeySchema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.message });
    }

    try {
      const encrypted = encrypt(result.data.apiKey);
      const now = new Date();

      await db
        .insert(providerKeys)
        .values({ provider, apiKeyEncrypted: encrypted, updatedAt: now })
        .onConflictDoUpdate({
          target: providerKeys.provider,
          set: { apiKeyEncrypted: encrypted, updatedAt: now },
        });

      // Hot-reload the gateway with the new key
      await gateway.reloadProvider(provider as CloudProvider, result.data.apiKey);

      res.json({ ok: true, provider, source: "db" });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** DELETE /api/settings/providers/:provider/key — remove saved key */
  router.delete("/api/settings/providers/:provider/key", async (req, res) => {
    const { provider } = req.params;
    if (!(CLOUD_PROVIDERS as readonly string[]).includes(provider)) {
      return res.status(400).json({ error: `Unknown provider: ${provider}` });
    }

    try {
      await db.delete(providerKeys).where(eq(providerKeys.provider, provider));
      // Reload gateway — if env var is set it will still work, otherwise provider is gone
      await gateway.reloadProvider(provider as CloudProvider, null);
      res.json({ ok: true, provider });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

/** Load DB-stored keys and return a map of provider → decrypted key. */
export async function loadProviderKeysFromDb(): Promise<Map<string, string>> {
  try {
    const rows = await db.select().from(providerKeys);
    const map = new Map<string, string>();
    for (const row of rows) {
      try {
        map.set(row.provider, decrypt(row.apiKeyEncrypted));
      } catch {
        console.warn(`[settings] Failed to decrypt key for provider: ${row.provider}`);
      }
    }
    return map;
  } catch {
    // DB may not be available (MemStorage mode)
    return new Map();
  }
}

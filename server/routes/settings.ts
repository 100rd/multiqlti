import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { providerKeys } from "@shared/schema";
import { encrypt, decrypt } from "../crypto";
import type { Gateway } from "../gateway/index";
import { configLoader } from "../config/loader";

const CLOUD_PROVIDERS = ["anthropic", "google", "xai"] as const;
type CloudProvider = (typeof CLOUD_PROVIDERS)[number];

const SaveKeySchema = z.object({
  key: z.string().min(1, "key must be non-empty").max(500),
});

/** Source of an active key: config value (env var / config.yaml) takes precedence over DB. */
function getKeySource(provider: CloudProvider): "env" | "db" | "none" {
  const providers = configLoader.get().providers;
  const configKeys: Record<CloudProvider, string | undefined> = {
    anthropic: providers.anthropic.apiKey,
    google: providers.google.apiKey,
    xai: providers.xai.apiKey,
  };
  if (configKeys[provider]) return "env";
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
      return res.status(400).json({
        error: "Validation failed",
        issues: result.error.issues.map((i) => ({ path: i.path, message: i.message })),
      });
    }

    try {
      const encrypted = encrypt(result.data.key);
      const now = new Date();

      await db
        .insert(providerKeys)
        .values({ provider, apiKeyEncrypted: encrypted, updatedAt: now })
        .onConflictDoUpdate({
          target: providerKeys.provider,
          set: { apiKeyEncrypted: encrypted, updatedAt: now },
        });

      // Hot-reload the gateway with the new key
      await gateway.reloadProvider(provider as CloudProvider, result.data.key);

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
      // Reload gateway — if config key is set it will still work, otherwise provider is gone
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

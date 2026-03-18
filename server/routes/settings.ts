import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";
import { db } from "../db";
import { providerKeys } from "@shared/schema";
import { encrypt, decrypt } from "../crypto";
import type { Gateway } from "../gateway/index";
import { configLoader } from "../config/loader";
import type { VersionsResponse } from "@shared/types";

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

// ─── Version probe helpers ────────────────────────────────────────────────────

/** Read the version field from the root package.json. Cached at module load. */
let _pkgVersion: string | undefined;
function getPackageVersion(): string {
  if (_pkgVersion !== undefined) return _pkgVersion;
  try {
    const pkgPath = resolve(process.cwd(), "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: string };
    _pkgVersion = pkg.version ?? "unknown";
  } catch {
    _pkgVersion = "unknown";
  }
  return _pkgVersion;
}

/** Probe docker version via spawnSync. Returns null when binary is not found or times out. */
export function probeDockerVersion(): string | null {
  try {
    const result = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
      timeout: 3000,
      encoding: "utf-8",
    });
    if (result.status !== 0 || result.error || !result.stdout) return null;
    const version = result.stdout.trim();
    return version.length > 0 ? version : null;
  } catch {
    return null;
  }
}

/** Probe vLLM version via HTTP. Returns null on any error. */
export async function probeVllmVersion(): Promise<string | null> {
  const baseUrl = process.env.VLLM_BASE_URL;
  if (!baseUrl) return null;
  try {
    const res = await fetch(`${baseUrl}/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/** Probe Ollama version via HTTP. Returns null on any error. */
export async function probeOllamaVersion(): Promise<string | null> {
  const baseUrl = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";
  try {
    const res = await fetch(`${baseUrl}/api/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return data.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract a clean semver string from a full PostgreSQL version string.
 * e.g. "PostgreSQL 16.1 on x86_64-pc-linux-gnu, ..." → "16.1"
 * Returns null when the input is not a recognisable version string.
 */
export function extractPostgresVersion(raw: string): string | null {
  // Match patterns like "16.1", "15.4", "14.10" — major.minor only
  const match = raw.match(/\bPostgreSQL\s+(\d+\.\d+)/i);
  if (match) return match[1];
  // Fallback: bare semver-like token
  const bare = raw.match(/(\d+\.\d+(?:\.\d+)?)/);
  return bare ? bare[1] : null;
}

/** Probe PostgreSQL version via the DB connection. Returns null on any error. */
async function probePostgresVersion(): Promise<string | null> {
  try {
    const { sql } = await import("drizzle-orm");
    const rows = (await db.execute(sql`SELECT version()`)) as unknown as Array<{ version?: string }>;
    const raw = rows[0]?.version ?? "";
    return extractPostgresVersion(raw);
  } catch {
    return null;
  }
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

  /**
   * GET /api/settings/versions — live component version report.
   *
   * Uses Promise.allSettled so every probe failure is isolated — this endpoint
   * will NEVER return 500 due to an unavailable downstream service.
   */
  router.get("/api/settings/versions", async (_req, res) => {
    const pkgVersion = getPackageVersion();

    const [dockerResult, vllmResult, ollamaResult, pgResult] = await Promise.allSettled([
      Promise.resolve(probeDockerVersion()),
      probeVllmVersion(),
      probeOllamaVersion(),
      probePostgresVersion(),
    ]);

    const response: VersionsResponse = {
      platform: {
        frontend: pkgVersion,
        backend: pkgVersion,
        node: process.version,
        buildDate: process.env.BUILD_DATE ?? "dev",
        gitCommit: process.env.GIT_COMMIT ?? "dev",
      },
      runtimes: {
        docker: dockerResult.status === "fulfilled" ? dockerResult.value : null,
        vllm: vllmResult.status === "fulfilled" ? vllmResult.value : null,
        ollama: ollamaResult.status === "fulfilled" ? ollamaResult.value : null,
      },
      database: {
        postgres: pgResult.status === "fulfilled" ? pgResult.value : null,
      },
    };

    res.json(response);
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

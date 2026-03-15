import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { load as loadYaml } from "js-yaml";
import { ConfigSchema, type AppConfig } from "./schema";
import { ProjectConfigSchema, type ProjectConfig } from "./project-schema";
import type { ConfigDiffEntry } from "@shared/types";

/**
 * Deep-merge source into target. Only plain objects are recursed into;
 * all other values from source overwrite target.
 */
function deepMerge(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const srcVal = source[key];
    const tgtVal = target[key];
    if (
      srcVal !== null &&
      typeof srcVal === "object" &&
      !Array.isArray(srcVal) &&
      tgtVal !== null &&
      typeof tgtVal === "object" &&
      !Array.isArray(tgtVal)
    ) {
      result[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else if (srcVal !== undefined) {
      result[key] = srcVal;
    }
  }
  return result;
}

/**
 * Parse a string value from an environment variable into the appropriate type.
 * Booleans: "true"/"1" → true, anything else → false.
 * Numbers: parsed via Number(); NaN is rejected.
 */
function parseEnvValue(value: string, kind: "string" | "number" | "boolean"): unknown {
  if (kind === "boolean") return value === "true" || value === "1";
  if (kind === "number") {
    const n = Number(value);
    if (Number.isNaN(n)) return undefined;
    return n;
  }
  return value;
}

type EnvMapping = {
  envKey: string;
  configPath: string[];
  kind: "string" | "number" | "boolean";
};

/**
 * Full environment variable → config key mapping.
 * MULTI_* prefix takes highest priority; legacy names are aliases.
 * Later entries in this list overwrite earlier ones, so MULTI_* keys
 * must come after their legacy aliases.
 */
const ENV_MAPPINGS: EnvMapping[] = [
  // Legacy aliases (lower priority — applied first)
  { envKey: "NODE_ENV",         configPath: ["server", "nodeEnv"],                     kind: "string"  },
  { envKey: "PORT",             configPath: ["server", "port"],                         kind: "number"  },
  { envKey: "DATABASE_URL",     configPath: ["database", "url"],                        kind: "string"  },
  { envKey: "JWT_SECRET",       configPath: ["auth", "jwtSecret"],                      kind: "string"  },
  { envKey: "ANTHROPIC_API_KEY",configPath: ["providers", "anthropic", "apiKey"],       kind: "string"  },
  { envKey: "GOOGLE_API_KEY",   configPath: ["providers", "google", "apiKey"],          kind: "string"  },
  { envKey: "XAI_API_KEY",      configPath: ["providers", "xai", "apiKey"],             kind: "string"  },
  { envKey: "VLLM_ENDPOINT",    configPath: ["providers", "vllm", "endpoint"],          kind: "string"  },
  { envKey: "OLLAMA_ENDPOINT",  configPath: ["providers", "ollama", "endpoint"],        kind: "string"  },
  { envKey: "SANDBOX_ENABLED",  configPath: ["features", "sandbox", "enabled"],         kind: "boolean" },
  { envKey: "ENCRYPTION_KEY",   configPath: ["encryption", "key"],                      kind: "string"  },

  // MULTI_* prefixed keys (highest priority — applied after legacy)
  { envKey: "MULTI_SERVER_PORT",                     configPath: ["server", "port"],                              kind: "number"  },
  { envKey: "MULTI_DATABASE_URL",                    configPath: ["database", "url"],                             kind: "string"  },
  { envKey: "MULTI_AUTH_JWT_SECRET",                 configPath: ["auth", "jwtSecret"],                           kind: "string"  },
  { envKey: "MULTI_PROVIDERS_ANTHROPIC_API_KEY",     configPath: ["providers", "anthropic", "apiKey"],            kind: "string"  },
  { envKey: "MULTI_PROVIDERS_GOOGLE_API_KEY",        configPath: ["providers", "google", "apiKey"],               kind: "string"  },
  { envKey: "MULTI_PROVIDERS_XAI_API_KEY",           configPath: ["providers", "xai", "apiKey"],                  kind: "string"  },
  { envKey: "MULTI_PROVIDERS_VLLM_ENDPOINT",         configPath: ["providers", "vllm", "endpoint"],               kind: "string"  },
  { envKey: "MULTI_PROVIDERS_OLLAMA_ENDPOINT",       configPath: ["providers", "ollama", "endpoint"],             kind: "string"  },
  { envKey: "MULTI_FEATURES_SANDBOX_ENABLED",        configPath: ["features", "sandbox", "enabled"],              kind: "boolean" },
  { envKey: "MULTI_ENCRYPTION_KEY",                  configPath: ["encryption", "key"],                           kind: "string"  },
];

/**
 * Set a value at a nested path inside an object, creating intermediate
 * objects as needed.
 */
function setNested(
  obj: Record<string, unknown>,
  path: string[],
  value: unknown,
): void {
  let cursor = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const segment = path[i];
    if (typeof cursor[segment] !== "object" || cursor[segment] === null) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[path[path.length - 1]] = value;
}

/**
 * Build a partial config object from environment variables.
 * Only keys that are actually set in the environment are included.
 */
function buildEnvOverrides(): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const mapping of ENV_MAPPINGS) {
    const raw = process.env[mapping.envKey];
    if (raw === undefined) continue;
    const parsed = parseEnvValue(raw, mapping.kind);
    if (parsed === undefined) continue;
    setNested(overrides, mapping.configPath, parsed);
  }
  return overrides;
}

/**
 * Load and parse config.yaml from the project root, if it exists.
 * Returns an empty object when the file is absent.
 */
function loadYamlFile(projectRoot: string): Record<string, unknown> {
  const yamlPath = join(projectRoot, "config.yaml");
  if (!existsSync(yamlPath)) return {};
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = loadYaml(raw);
  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config.yaml must be a YAML mapping (object), not a scalar or list");
  }
  return parsed as Record<string, unknown>;
}

class ConfigLoader {
  private cachedConfig: AppConfig | null = null;

  /**
   * Load and validate configuration from all sources.
   * Call exactly once at startup before anything else reads config.
   * If validation fails, logs the error and exits the process.
   */
  load(projectRoot?: string): AppConfig {
    if (this.cachedConfig !== null) return this.cachedConfig;

    const root = projectRoot ?? process.cwd();

    // 1. Start with schema defaults (produced by parsing an empty object)
    const defaults = ConfigSchema.partial().parse({});

    // 2. Merge in config.yaml values
    const yamlValues = loadYamlFile(root);
    const afterYaml = deepMerge(
      defaults as unknown as Record<string, unknown>,
      yamlValues,
    );

    // 3. Merge in environment variable overrides
    const envOverrides = buildEnvOverrides();
    const merged = deepMerge(afterYaml, envOverrides);

    // 4. Validate the fully-merged config through the Zod schema
    const result = ConfigSchema.safeParse(merged);
    if (!result.success) {
      console.error("[config] Configuration validation failed:");
      for (const issue of result.error.issues) {
        const path = issue.path.join(".");
        console.error(`  ${path}: ${issue.message}`);
      }
      process.exit(1);
    }

    this.cachedConfig = result.data;
    return this.cachedConfig;
  }

  /**
   * Return the cached config. Lazily calls load() if not yet initialized.
   * This allows test environments to use configLoader without explicit setup.
   */
  get(): AppConfig {
    if (this.cachedConfig === null) {
      this.load();
    }
    return this.cachedConfig!;
  }

  /**
   * Load and validate `multiqlti.yaml` from a workspace's local path (Layer 4).
   * Returns null if the file is absent or the path is not a local directory.
   * Throws a descriptive error if the file is present but fails validation.
   */
  loadProjectConfig(workspacePath: string): ProjectConfig | null {
    const yamlPath = join(workspacePath, "multiqlti.yaml");
    if (!existsSync(yamlPath)) return null;

    const raw = readFileSync(yamlPath, "utf-8");
    const parsed = loadYaml(raw);
    if (parsed === null || parsed === undefined) return null;
    if (typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("multiqlti.yaml must be a YAML mapping (object), not a scalar or list");
    }

    const result = ProjectConfigSchema.safeParse(parsed);
    if (!result.success) {
      const messages = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      throw new Error(`multiqlti.yaml validation failed:\n${messages.join("\n")}`);
    }

    return result.data;
  }

  /**
   * Compute a diff between a project config and the current platform config.
   * Only reports fields that are explicitly set in the project config.
   */
  diff(projectConfig: ProjectConfig): ConfigDiffEntry[] {
    const platform = this.get();
    const entries: ConfigDiffEntry[] = [];

    function compare(
      path: string,
      platformVal: unknown,
      projectVal: unknown,
    ): void {
      if (projectVal === undefined) return;

      if (
        projectVal !== null &&
        typeof projectVal === "object" &&
        !Array.isArray(projectVal) &&
        platformVal !== null &&
        typeof platformVal === "object" &&
        !Array.isArray(platformVal)
      ) {
        for (const key of Object.keys(projectVal as Record<string, unknown>)) {
          compare(
            path ? `${path}.${key}` : key,
            (platformVal as Record<string, unknown>)[key],
            (projectVal as Record<string, unknown>)[key],
          );
        }
        return;
      }

      if (platformVal === undefined) {
        entries.push({ path, platformValue: undefined, projectValue: projectVal, changeType: "new" });
      } else if (platformVal === projectVal) {
        // unchanged — omit from diff
      } else {
        entries.push({ path, platformValue: platformVal, projectValue: projectVal, changeType: "override" });
      }
    }

    // Compare known diff-able sections
    const platformDefaults = {
      tokenBudget: 0.5,
      stageTimeout: 300_000,
    };

    if (projectConfig.defaults) {
      compare("defaults.tokenBudget", platformDefaults.tokenBudget, projectConfig.defaults.tokenBudget);
      compare("defaults.stageTimeout", platformDefaults.stageTimeout, projectConfig.defaults.stageTimeout);
      if (projectConfig.defaults.retryPolicy) {
        compare("defaults.retryPolicy.maxRetries", 2, projectConfig.defaults.retryPolicy.maxRetries);
        compare("defaults.retryPolicy.backoffMs", 1000, projectConfig.defaults.retryPolicy.backoffMs);
      }
    }
    if (projectConfig.privacy) {
      compare("privacy.enabled", platform.features.privacy.enabled, projectConfig.privacy.enabled);
      if (projectConfig.privacy.customPatterns !== undefined) {
        entries.push({
          path: "privacy.customPatterns",
          platformValue: [],
          projectValue: projectConfig.privacy.customPatterns,
          changeType: projectConfig.privacy.customPatterns.length > 0 ? "new" : "override",
        });
      }
    }
    if (projectConfig.maintenance) {
      compare("maintenance.enabled", platform.features.maintenance.enabled, projectConfig.maintenance.enabled);
      compare("maintenance.schedule", platform.features.maintenance.cronSchedule, projectConfig.maintenance.schedule);
    }

    return entries;
  }
}

export const configLoader = new ConfigLoader();

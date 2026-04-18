/**
 * preferences-exporter.ts — Export workspace preferences to YAML config files.
 *
 * Output path: <repoPath>/preferences/global.yaml
 *              <repoPath>/preferences/<workspace-name>.yaml  (per workspace)
 *
 * Schema: PreferencesConfigEntitySchema (shared/config-sync/schemas.ts)
 *
 * The workspace settings stored in the DB are an open `Record<string, unknown>`.
 * This exporter maps the known UI preference keys to the typed schema fields
 * and puts everything else in the `extra` bag.
 */

import path from "path";
import type { IStorage } from "../../storage.js";
import type { PreferencesConfigEntity } from "@shared/config-sync/schemas.js";
import { PreferencesConfigEntitySchema } from "@shared/config-sync/schemas.js";
import { writeYaml } from "./yaml-writer.js";
import { sanitizeSlug } from "./pipeline-exporter.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const API_VERSION = "1.0.0";
const PREFERENCES_DIR = "preferences";
const GLOBAL_FILENAME = "global.yaml";

const VALID_THEMES = ["light", "dark", "system"] as const;
const VALID_LAYOUTS = ["default", "compact", "wide"] as const;

// ─── Public API ───────────────────────────────────────────────────────────────

export interface PreferencesExportResult {
  exported: string[];
  errors: Array<{ scope: string; error: string }>;
}

/**
 * Export preferences for all workspaces.
 *
 * Each workspace with non-null settings gets its own YAML.  A global
 * `global.yaml` is always written (even if empty) to provide a known
 * anchor for applying default preferences.
 */
export async function exportPreferences(
  storage: IStorage,
  repoPath: string,
): Promise<PreferencesExportResult> {
  const workspaces = await storage.getWorkspaces();
  const outDir = path.join(repoPath, PREFERENCES_DIR);

  const exported: string[] = [];
  const errors: PreferencesExportResult["errors"] = [];

  // Always write global.yaml
  try {
    const globalEntity = buildGlobalPreferences();
    const validated = PreferencesConfigEntitySchema.parse(globalEntity);
    const filePath = path.join(outDir, GLOBAL_FILENAME);
    const comment = [
      "kind: preferences",
      "scope: global",
      "managed-by: mqlti config export",
    ].join("\n");
    await writeYaml(filePath, validated, { comment });
    exported.push(filePath);
  } catch (err: unknown) {
    errors.push({
      scope: "global",
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Per-workspace settings
  for (const workspace of workspaces) {
    try {
      const settings = await storage.getWorkspaceSettings(workspace.id);
      if (!settings) continue;

      const entity = workspaceSettingsToEntity(workspace.name, workspace.id, settings);
      const validated = PreferencesConfigEntitySchema.parse(entity);

      const slug = sanitizeSlug(workspace.name, workspace.id);
      const filePath = path.join(outDir, `${slug}.yaml`);

      const comment = [
        "kind: preferences",
        `scope: workspace`,
        `workspace_id: ${workspace.id}`,
        "managed-by: mqlti config export",
      ].join("\n");

      await writeYaml(filePath, validated, { comment });
      exported.push(filePath);
    } catch (err: unknown) {
      errors.push({
        scope: `workspace:${workspace.id}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { exported, errors };
}

// ─── Mapping helpers ──────────────────────────────────────────────────────────

function buildGlobalPreferences(): PreferencesConfigEntity {
  return {
    kind: "preferences",
    apiVersion: API_VERSION,
    scope: "global",
    ui: {
      theme: "system",
      layout: "default",
      featureFlags: {},
    },
    extra: {},
  };
}

function workspaceSettingsToEntity(
  workspaceName: string,
  workspaceId: string,
  settings: Record<string, unknown>,
): PreferencesConfigEntity {
  const ui = (settings["ui"] ?? {}) as Record<string, unknown>;
  const featureFlags = isPlainObject(ui["featureFlags"])
    ? (ui["featureFlags"] as Record<string, unknown>)
    : {};

  // Filter featureFlags to only boolean values
  const filteredFlags: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(featureFlags)) {
    if (typeof v === "boolean") filteredFlags[k] = v;
  }

  // Strip known UI keys from settings to build `extra`
  const { ui: _ui, ...rest } = settings;
  void _ui; // suppress unused variable

  return {
    kind: "preferences",
    apiVersion: API_VERSION,
    scope: "user",
    userId: workspaceId,
    ui: {
      theme: coerceTheme(ui["theme"]),
      layout: coerceLayout(ui["layout"]),
      featureFlags: filteredFlags,
    },
    extra: rest as Record<string, unknown>,
  };
}

function coerceTheme(v: unknown): "light" | "dark" | "system" {
  if (typeof v === "string" && (VALID_THEMES as readonly string[]).includes(v)) {
    return v as "light" | "dark" | "system";
  }
  return "system";
}

function coerceLayout(v: unknown): "default" | "compact" | "wide" {
  if (typeof v === "string" && (VALID_LAYOUTS as readonly string[]).includes(v)) {
    return v as "default" | "compact" | "wide";
  }
  return "default";
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

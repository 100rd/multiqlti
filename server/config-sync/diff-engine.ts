/**
 * diff-engine.ts — Compute create/update/delete diffs between YAML repo
 * state and live DB state.
 *
 * Issue #317: Config sync apply path
 *
 * A diff is a list of operations to perform to bring the DB into alignment
 * with the repo YAML files.  The engine itself performs NO writes — callers
 * decide whether to apply, print, or discard the diff.
 *
 * Tombstone semantics:
 *   An entity present in the DB but absent from the repo YAML will generate a
 *   "delete" operation (tombstone) unless the entity type is configured to
 *   skip tombstone (e.g. skills by default are not deleted).
 *
 * Conflict detection:
 *   If the DB record was updated_at is AFTER the last-export timestamp, it
 *   means someone modified it outside of config-sync.  The diff records the
 *   conflict; the caller must pass `--force` to apply anyway.
 */

import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import type {
  PipelineConfigEntity,
  TriggerConfigEntity,
  PromptConfigEntity,
  SkillStateConfigEntity,
  ConnectionConfigEntity,
  ProviderKeyConfigEntity,
  PreferencesConfigEntity,
} from "@shared/config-sync/schemas.js";
import {
  PipelineConfigEntitySchema,
  TriggerConfigEntitySchema,
  PromptConfigEntitySchema,
  SkillStateConfigEntitySchema,
  ConnectionConfigEntitySchema,
  ProviderKeyConfigEntitySchema,
  PreferencesConfigEntitySchema,
} from "@shared/config-sync/schemas.js";

// ─── Public types ─────────────────────────────────────────────────────────────

export type ChangeKind = "create" | "update" | "delete";

export interface DiffEntry<T = unknown> {
  /** What operation this entry represents. */
  kind: ChangeKind;
  /** Entity type (pipeline, trigger, etc.) */
  entityType: string;
  /**
   * A human-readable identifier — name or a compound key.
   * Used in logs and audit records; NOT the DB primary key.
   */
  label: string;
  /**
   * For create/update: the full entity from the YAML file.
   * For delete: the current DB record's identifying fields.
   */
  entity: T | null;
  /**
   * For update: a best-effort JSON diff summary (field→[old,new]).
   * Omitted for create/delete.
   */
  diff?: Record<string, [unknown, unknown]>;
  /**
   * The source YAML file path (absolute) — for traceability.
   * Undefined for delete entries derived purely from DB state.
   */
  filePath?: string;
  /**
   * Set when a DB record was updated more recently than the last export,
   * indicating an out-of-band modification.
   */
  conflict?: {
    dbUpdatedAt: string;
    lastExportAt: string;
    message: string;
  };
}

export interface EntityDiff<T = unknown> {
  entityType: string;
  entries: DiffEntry<T>[];
  /** Files that failed to parse/validate. */
  parseErrors: Array<{ filePath: string; error: string }>;
}

export interface DiffOptions {
  /**
   * ISO-8601 timestamp of the last export.  Used to detect conflicts.
   * If not provided, conflict detection is disabled.
   */
  lastExportAt?: string | null;
  /**
   * Whether entities missing from the repo should generate a delete entry.
   * Defaults to true for most entity types.
   */
  tombstone?: boolean;
}

// ─── YAML readers ─────────────────────────────────────────────────────────────

/**
 * Read all YAML files from a directory.
 * Returns a map of filePath → parsed object.
 * Files that fail to read/parse are returned in the errors array.
 */
export async function readYamlDir(
  dirPath: string,
): Promise<{ files: Map<string, unknown>; errors: Array<{ filePath: string; error: string }> }> {
  const files = new Map<string, unknown>();
  const errors: Array<{ filePath: string; error: string }> = [];

  let entries: import("fs").Dirent[];
  try {
    entries = await fs.readdir(dirPath, { withFileTypes: true });
  } catch {
    // Directory might not exist yet — treat as empty
    return { files, errors };
  }

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const filePath = path.join(dirPath, entry.name);
    try {
      const raw = await fs.readFile(filePath, "utf-8");
      const parsed = yaml.load(raw);
      files.set(filePath, parsed);
    } catch (err: unknown) {
      errors.push({
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { files, errors };
}

// ─── Field-level diff helper ──────────────────────────────────────────────────

/**
 * Produce a flat diff between two plain objects.
 * Only top-level scalar fields are compared; nested objects are deep-serialised
 * for comparison and their full value is reported in [old, new] if changed.
 */
export function fieldDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, [unknown, unknown]> {
  const result: Record<string, [unknown, unknown]> = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    const bVal = JSON.stringify(before[key]);
    const aVal = JSON.stringify(after[key]);
    if (bVal !== aVal) {
      result[key] = [before[key], after[key]];
    }
  }
  return result;
}

// ─── Conflict checker ─────────────────────────────────────────────────────────

/**
 * Returns a conflict descriptor if the DB record was updated after lastExportAt.
 */
export function checkConflict(
  updatedAt: Date | null | undefined,
  lastExportAt: string | null | undefined,
): DiffEntry["conflict"] | undefined {
  if (!lastExportAt || !updatedAt) return undefined;
  const exportTs = new Date(lastExportAt).getTime();
  const dbTs = updatedAt.getTime();
  if (dbTs > exportTs) {
    return {
      dbUpdatedAt: updatedAt.toISOString(),
      lastExportAt,
      message: `DB record modified after last export (${updatedAt.toISOString()} > ${lastExportAt})`,
    };
  }
  return undefined;
}

// ─── Pipeline diff ────────────────────────────────────────────────────────────

export interface PipelineDiffInput {
  repoPath: string;
  /** Current pipelines from DB, keyed by name. */
  dbPipelines: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffPipelines(
  input: PipelineDiffInput,
): Promise<EntityDiff<PipelineConfigEntity>> {
  const dirPath = path.join(input.repoPath, "pipelines");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<PipelineConfigEntity>[] = [];

  const seenNames = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = PipelineConfigEntitySchema.parse(raw);
      seenNames.add(entity.name);
      const existing = input.dbPipelines.get(entity.name);

      if (!existing) {
        entries.push({ kind: "create", entityType: "pipeline", label: entity.name, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "pipeline", label: entity.name, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (input.options?.tombstone !== false) {
    for (const [name, db] of input.dbPipelines) {
      if (!seenNames.has(name)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "pipeline", label: name, entity: null, conflict });
      }
    }
  }

  return { entityType: "pipeline", entries, parseErrors };
}

// ─── Trigger diff ─────────────────────────────────────────────────────────────

export interface TriggerDiffInput {
  repoPath: string;
  /** Current triggers from DB, keyed by slug (pipelineName__type__id8). */
  dbTriggers: Map<string, { id: string; pipelineId: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  /** Map of pipeline id → name, for building slug keys. */
  pipelineIdToName: Map<string, string>;
  options?: DiffOptions;
}

export async function diffTriggers(
  input: TriggerDiffInput,
): Promise<EntityDiff<TriggerConfigEntity>> {
  const dirPath = path.join(input.repoPath, "triggers");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<TriggerConfigEntity>[] = [];

  const seenSlugs = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = TriggerConfigEntitySchema.parse(raw);
      // Slug is derived from the filename (without .yaml extension)
      const slug = path.basename(filePath, ".yaml");
      seenSlugs.add(slug);
      const existing = input.dbTriggers.get(slug);

      if (!existing) {
        entries.push({ kind: "create", entityType: "trigger", label: slug, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "trigger", label: slug, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (input.options?.tombstone !== false) {
    for (const [slug, db] of input.dbTriggers) {
      if (!seenSlugs.has(slug)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "trigger", label: slug, entity: null, conflict });
      }
    }
  }

  return { entityType: "trigger", entries, parseErrors };
}

// ─── Prompt diff ──────────────────────────────────────────────────────────────

export interface PromptDiffInput {
  repoPath: string;
  /** Current prompt skills from DB, keyed by name. */
  dbPrompts: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffPrompts(
  input: PromptDiffInput,
): Promise<EntityDiff<PromptConfigEntity>> {
  const dirPath = path.join(input.repoPath, "prompts");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<PromptConfigEntity>[] = [];

  const seenNames = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = PromptConfigEntitySchema.parse(raw);
      seenNames.add(entity.name);
      const existing = input.dbPrompts.get(entity.name);

      if (!existing) {
        entries.push({ kind: "create", entityType: "prompt", label: entity.name, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "prompt", label: entity.name, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (input.options?.tombstone !== false) {
    for (const [name, db] of input.dbPrompts) {
      if (!seenNames.has(name)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "prompt", label: name, entity: null, conflict });
      }
    }
  }

  return { entityType: "prompt", entries, parseErrors };
}

// ─── Skill-state diff ─────────────────────────────────────────────────────────

export interface SkillStateDiffInput {
  repoPath: string;
  /** Current skills from DB, keyed by id. */
  dbSkills: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffSkills(
  input: SkillStateDiffInput,
): Promise<EntityDiff<SkillStateConfigEntity>> {
  const filePath = path.join(input.repoPath, "skill-states", "skill-state.yaml");
  const parseErrors: EntityDiff["parseErrors"] = [];
  const entries: DiffEntry<SkillStateConfigEntity>[] = [];

  let entity: SkillStateConfigEntity;
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = yaml.load(raw);
    entity = SkillStateConfigEntitySchema.parse(parsed);
  } catch (err: unknown) {
    // Skill-state file might not exist
    return { entityType: "skill-state", entries, parseErrors: [{ filePath, error: err instanceof Error ? err.message : String(err) }] };
  }

  // Skills are applied as a whole snapshot — emit updates for changed skills,
  // creates for new ones.  Deletions are opt-in (tombstone off by default).
  const seenIds = new Set<string>();

  for (const skill of entity.skills) {
    seenIds.add(skill.id);
    const existing = input.dbSkills.get(skill.id);

    if (!existing) {
      // Represent as a partial update to skill-state (create the individual skill)
      entries.push({
        kind: "create",
        entityType: "skill-state",
        label: skill.name,
        entity,
        filePath,
      });
    } else {
      const diff = fieldDiff(
        existing.raw,
        skill as unknown as Record<string, unknown>,
      );
      if (Object.keys(diff).length > 0) {
        const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
        entries.push({
          kind: "update",
          entityType: "skill-state",
          label: skill.name,
          entity,
          diff,
          filePath,
          conflict,
        });
      }
    }
  }

  // Skills tombstone is OFF by default (skills are additive)
  if (input.options?.tombstone === true) {
    for (const [id, db] of input.dbSkills) {
      if (!seenIds.has(id)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "skill-state", label: db.name, entity: null, conflict });
      }
    }
  }

  return { entityType: "skill-state", entries, parseErrors };
}

// ─── Connection diff ──────────────────────────────────────────────────────────

export interface ConnectionDiffInput {
  repoPath: string;
  /** Current connections from DB, keyed by name. */
  dbConnections: Map<string, { id: string; name: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffConnections(
  input: ConnectionDiffInput,
): Promise<EntityDiff<ConnectionConfigEntity>> {
  const dirPath = path.join(input.repoPath, "connections");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<ConnectionConfigEntity>[] = [];

  const seenNames = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = ConnectionConfigEntitySchema.parse(raw);
      seenNames.add(entity.name);
      const existing = input.dbConnections.get(entity.name);

      if (!existing) {
        entries.push({ kind: "create", entityType: "connection", label: entity.name, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "connection", label: entity.name, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (input.options?.tombstone !== false) {
    for (const [name, db] of input.dbConnections) {
      if (!seenNames.has(name)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "connection", label: name, entity: null, conflict });
      }
    }
  }

  return { entityType: "connection", entries, parseErrors };
}

// ─── Provider-key diff ────────────────────────────────────────────────────────

export interface ProviderKeyDiffInput {
  repoPath: string;
  /** Current provider keys from DB, keyed by provider name. */
  dbProviderKeys: Map<string, { id: string; provider: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffProviderKeys(
  input: ProviderKeyDiffInput,
): Promise<EntityDiff<ProviderKeyConfigEntity>> {
  const dirPath = path.join(input.repoPath, "provider-keys");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<ProviderKeyConfigEntity>[] = [];

  const seenProviders = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = ProviderKeyConfigEntitySchema.parse(raw);
      seenProviders.add(entity.provider);
      const existing = input.dbProviderKeys.get(entity.provider);

      if (!existing) {
        entries.push({ kind: "create", entityType: "provider-key", label: entity.provider, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "provider-key", label: entity.provider, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  if (input.options?.tombstone !== false) {
    for (const [provider, db] of input.dbProviderKeys) {
      if (!seenProviders.has(provider)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "provider-key", label: provider, entity: null, conflict });
      }
    }
  }

  return { entityType: "provider-key", entries, parseErrors };
}

// ─── Preferences diff ─────────────────────────────────────────────────────────

export interface PreferencesDiffInput {
  repoPath: string;
  /** Current preferences from DB, keyed by scope key ("global" or "user:<id>"). */
  dbPreferences: Map<string, { scopeKey: string; updatedAt: Date | null; raw: Record<string, unknown> }>;
  options?: DiffOptions;
}

export async function diffPreferences(
  input: PreferencesDiffInput,
): Promise<EntityDiff<PreferencesConfigEntity>> {
  const dirPath = path.join(input.repoPath, "preferences");
  const { files, errors } = await readYamlDir(dirPath);
  const parseErrors: EntityDiff["parseErrors"] = [...errors];
  const entries: DiffEntry<PreferencesConfigEntity>[] = [];

  const seenKeys = new Set<string>();

  for (const [filePath, raw] of files) {
    try {
      const entity = PreferencesConfigEntitySchema.parse(raw);
      const scopeKey = entity.scope === "user" && entity.userId
        ? `user:${entity.userId}`
        : "global";
      seenKeys.add(scopeKey);
      const existing = input.dbPreferences.get(scopeKey);

      if (!existing) {
        entries.push({ kind: "create", entityType: "preferences", label: scopeKey, entity, filePath });
      } else {
        const diff = fieldDiff(existing.raw, entity as unknown as Record<string, unknown>);
        if (Object.keys(diff).length > 0) {
          const conflict = checkConflict(existing.updatedAt, input.options?.lastExportAt);
          entries.push({ kind: "update", entityType: "preferences", label: scopeKey, entity, diff, filePath, conflict });
        }
      }
    } catch (err: unknown) {
      parseErrors.push({ filePath, error: err instanceof Error ? err.message : String(err) });
    }
  }

  // Preferences tombstone is OFF by default
  if (input.options?.tombstone === true) {
    for (const [scopeKey, db] of input.dbPreferences) {
      if (!seenKeys.has(scopeKey)) {
        const conflict = checkConflict(db.updatedAt, input.options?.lastExportAt);
        entries.push({ kind: "delete", entityType: "preferences", label: scopeKey, entity: null, conflict });
      }
    }
  }

  return { entityType: "preferences", entries, parseErrors };
}

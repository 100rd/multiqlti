/**
 * registry-sync.ts — Git-backed skills registry sync (issue #446, task 52.1).
 *
 * Design (Option 3, binding — see reports/BkArch-52a-decision.md):
 *   1. Read `skills-lock.json` from a configured local registry root.
 *   2. Per lock entry, read the referenced SKILL.md and compute its sha256.
 *   3. Compare against the lock's pinned `computedHash` — mismatch means the
 *      file drifted from what was reviewed/pinned; the row is NOT
 *      created/updated and the drift is surfaced in the result instead.
 *   4. Skip entries whose `compatible_tools` frontmatter does not include
 *      "multiqlti".
 *   5. Upsert (by skill name) a read-only `sourceType: 'git'` skill row,
 *      carrying provenance (externalSource/externalId/externalVersion/
 *      installedAt/autoUpdate).
 *
 * Path confinement reuses the exact primitives from
 * `server/services/consilium/repo-allowlist.ts` (fail-closed: an empty
 * allowlist throws) so this feature cannot widen filesystem access beyond
 * what's already configured for consilium-loop repo access.
 */
import { readFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { z } from "zod";
import type { IStorage } from "../storage";
import type { InsertSkill } from "@shared/schema";
import { assertAllowedRepoPath } from "../services/consilium/repo-allowlist";
import { parseSkillMd, SkillMdParseError } from "./skill-md-service";

const MULTIQLTI_TOOL = "multiqlti";
const DEFAULT_LOCK_FILE_NAME = "skills-lock.json";

// ─── Lock file schema ───────────────────────────────────────────────────────

const LockEntrySchema = z.object({
  source: z.string().min(1).max(300),
  sourceType: z.string().max(50).optional(),
  skillPath: z.string().min(1).max(500),
  computedHash: z.string().regex(/^[a-f0-9]{64}$/i, "computedHash must be a sha256 hex digest"),
});

const SkillsLockSchema = z.object({
  version: z.number().optional(),
  skills: z.record(LockEntrySchema),
});

// ─── Result types ───────────────────────────────────────────────────────────

export type RegistrySkillStatus = "synced" | "skipped" | "drift" | "conflict" | "error";

export interface RegistrySkillResult {
  skillKey: string;
  skillPath: string;
  status: RegistrySkillStatus;
  reason?: string;
  skillId?: string;
  /** Set only for status:'conflict' — the sourceType of the row that already owns this name. */
  existingSourceType?: string;
}

export interface RegistrySyncResult {
  registryRoot: string;
  results: RegistrySkillResult[];
}

export interface RegistrySyncOptions {
  storage: IStorage;
  /** Local filesystem path to the registry root (must resolve inside allowedRoots). */
  registryRoot: string;
  /** teamId assigned to synced skill rows. */
  teamId: string;
  /** Fail-closed allowlist of repo roots this sync is permitted to read from. */
  allowedRoots: readonly string[];
  createdBy?: string;
  /** Tracking flag stored on synced rows; does not change sync behavior. */
  autoUpdate?: boolean;
  /** Override for tests; defaults to "skills-lock.json". */
  lockFileName?: string;
}

/**
 * Syncs skills from a local git-registry root into storage. Throws only for
 * whole-sync failures (path confinement violation, unreadable/invalid lock
 * file). Per-skill failures (missing file, hash drift, parse error, skip) are
 * captured in the returned per-skill results instead of throwing.
 */
export async function syncSkillsRegistry(opts: RegistrySyncOptions): Promise<RegistrySyncResult> {
  const { storage, teamId, allowedRoots, createdBy = "system", autoUpdate = false } = opts;
  const lockFileName = opts.lockFileName ?? DEFAULT_LOCK_FILE_NAME;

  // Fail-closed path confinement — reuses the exact consilium-loop primitives.
  const resolvedRoot = assertAllowedRepoPath(opts.registryRoot, allowedRoots);

  const lockPath = join(resolvedRoot, lockFileName);
  const lockParsed = await readLockFile(lockPath);

  const results: RegistrySkillResult[] = [];
  for (const [skillKey, entry] of Object.entries(lockParsed.skills)) {
    results.push(await syncOneSkill({ skillKey, entry, resolvedRoot, teamId, createdBy, autoUpdate, storage }));
  }

  return { registryRoot: resolvedRoot, results };
}

async function readLockFile(lockPath: string): Promise<z.infer<typeof SkillsLockSchema>> {
  let raw: string;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (err) {
    throw new Error(
      `[registry-sync] Unable to read lock file at ${lockPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error(`[registry-sync] Lock file is not valid JSON: ${lockPath}`);
  }

  const parsed = SkillsLockSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    throw new Error(
      `[registry-sync] Lock file failed schema validation: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`,
    );
  }
  return parsed.data;
}

interface SyncOneSkillParams {
  skillKey: string;
  entry: z.infer<typeof LockEntrySchema>;
  resolvedRoot: string;
  teamId: string;
  createdBy: string;
  autoUpdate: boolean;
  storage: IStorage;
}

async function syncOneSkill(params: SyncOneSkillParams): Promise<RegistrySkillResult> {
  const { skillKey, entry, resolvedRoot, teamId, createdBy, autoUpdate, storage } = params;

  try {
    // Defense in depth: confine the resolved skill file to the registry root
    // too, so a malicious skillPath ("../../etc/passwd") cannot escape it.
    const skillFullPath = assertAllowedRepoPath(join(resolvedRoot, entry.skillPath), [resolvedRoot]);

    let raw: string;
    try {
      raw = await readFile(skillFullPath, "utf8");
    } catch (err) {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "error",
        reason: `Unable to read SKILL.md: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const actualHash = createHash("sha256").update(raw, "utf8").digest("hex");
    if (actualHash !== entry.computedHash.toLowerCase()) {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "drift",
        reason: `sha256 mismatch: lock expects ${entry.computedHash}, file is ${actualHash}`,
      };
    }

    let parsed;
    try {
      parsed = parseSkillMd(raw);
    } catch (err) {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "error",
        reason: err instanceof SkillMdParseError ? err.message : "Failed to parse SKILL.md",
      };
    }

    if (!parsed.frontmatter.compatible_tools.includes(MULTIQLTI_TOOL)) {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "skipped",
        reason: `compatible_tools does not include "${MULTIQLTI_TOOL}"`,
      };
    }

    const insertData: InsertSkill = {
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description,
      teamId,
      systemPromptOverride: parsed.body,
      tags: parsed.frontmatter.tags,
      isBuiltin: false,
      isPublic: true,
      createdBy,
      version: parsed.frontmatter.version,
      sharing: "public",
      sourceType: "git",
      gitSourceId: entry.source,
      externalSource: entry.source,
      externalId: entry.skillPath,
      externalVersion: actualHash,
      installedAt: new Date(),
      autoUpdate,
    };

    // getSkillIdByName is a GLOBAL, unscoped lookup (no teamId/sourceType
    // filter) -- guard against silently clobbering a manually-created skill
    // (including built-ins, which are sourceType:'manual' + isBuiltin:true),
    // or another team's git-sourced skill that happens to share this name.
    // Update ONLY a row we already own (sourceType 'git' AND same teamId) --
    // this preserves git->git idempotency and drift semantics. Anything else
    // is reported as a conflict and left completely unwritten.
    const existingId = await storage.getSkillIdByName(parsed.frontmatter.name);
    const existing = existingId ? await storage.getSkill(existingId) : undefined;

    if (existing && existing.sourceType !== "git") {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "conflict",
        existingSourceType: existing.sourceType,
        reason: `Name collision: a ${existing.isBuiltin ? "built-in" : "manually-created"} skill named "${parsed.frontmatter.name}" already exists; registry sync will not overwrite non-git skills.`,
      };
    }
    if (existing && existing.teamId !== teamId) {
      return {
        skillKey,
        skillPath: entry.skillPath,
        status: "conflict",
        existingSourceType: existing.sourceType,
        reason: `Name collision: a git-sourced skill named "${parsed.frontmatter.name}" already exists for a different team; registry sync will not overwrite it.`,
      };
    }

    const skillId = existing
      ? (await storage.updateSkill(existing.id, insertData)).id
      : (await storage.createSkill(insertData)).id;

    return { skillKey, skillPath: entry.skillPath, status: "synced", skillId };
  } catch (err) {
    return {
      skillKey,
      skillPath: entry.skillPath,
      status: "error",
      reason: err instanceof Error ? err.message : "Unknown error",
    };
  }
}

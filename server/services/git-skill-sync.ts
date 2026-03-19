/**
 * git-skill-sync.ts — Sync skills from a remote Git repository.
 *
 * Security requirements:
 * - Only https:// and git@ URLs are allowed (no file://, git://, ssh://)
 * - Path is validated to prevent traversal outside the clone root
 * - PAT is injected into the clone URL and never persisted in plain text
 * - Clone runs in an isolated temp dir cleaned up in finally
 * - 30s clone timeout, 10s parse timeout per file
 * - Errors are caught per-file; one bad file does not abort the whole sync
 */

import { execFile } from "child_process";
import { promisify } from "util";
import { mkdtemp, rm, readdir, readFile, stat } from "fs/promises";
import { join, resolve, extname, relative } from "path";
import { tmpdir } from "os";
import { eq, and } from "drizzle-orm";
import { db } from "../db";
import { gitSkillSources, skills } from "@shared/schema";
import type { GitSkillSourceRow } from "@shared/schema";
import { decrypt } from "../crypto";
import { SkillYamlSchema } from "../skills/yaml-service";
import yaml from "js-yaml";

const execFileAsync = promisify(execFile);

// ─── URL Validation ───────────────────────────────────────────────────────────

/**
 * Returns true for allowed remote URLs: https:// or git@ SSH shorthand.
 * Rejects file://, git://, ssh://, and anything else.
 */
export function isAllowedRepoUrl(url: string): boolean {
  const trimmed = url.trim();
  // Allow HTTPS
  if (/^https:\/\//i.test(trimmed)) return true;
  // Allow SSH shorthand: git@host:owner/repo.git
  if (/^git@[\w.-]+:[\w./\-]+$/i.test(trimmed)) return true;
  return false;
}

/**
 * Injects a PAT into an https:// URL: https://PAT@host/path
 * Returns the original URL for SSH (git@) — SSH uses key auth, not PAT.
 */
function injectPat(repoUrl: string, pat: string): string {
  if (/^https:\/\//i.test(repoUrl)) {
    return repoUrl.replace(/^https:\/\//i, `https://${encodeURIComponent(pat)}@`);
  }
  return repoUrl; // SSH — PAT not applicable
}

// ─── Path Validation ─────────────────────────────────────────────────────────

/**
 * Resolves and validates that `userPath` stays within `cloneRoot`.
 * Throws if path traversal is detected.
 */
function safePath(cloneRoot: string, userPath: string): string {
  // Normalise: strip leading slash, collapse .. sequences via resolve
  const normalised = userPath.replace(/^\/+/, "") || ".";
  const resolved = resolve(cloneRoot, normalised);
  if (!resolved.startsWith(cloneRoot + "/") && resolved !== cloneRoot) {
    throw new Error(`Path traversal detected: ${userPath} escapes clone root`);
  }
  return resolved;
}

// ─── File Discovery ───────────────────────────────────────────────────────────

async function walkDir(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden directories (.git, .github, etc.)
      if (!entry.name.startsWith(".")) {
        files.push(...(await walkDir(full)));
      }
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if (ext === ".yaml" || ext === ".yml" || ext === ".json") {
        files.push(full);
      }
    }
  }
  return files;
}

// ─── Skill File Parsing ───────────────────────────────────────────────────────

interface ParsedSkillFile {
  relativePath: string;
  name: string;
  teamId: string;
  systemPrompt: string;
  tools: string[];
  modelPreference: string | null;
  outputSchema: Record<string, unknown> | null;
  sharing: "private" | "team" | "public";
  version: string;
  description: string;
  tags: string[];
}

/**
 * Parses a YAML or JSON file against SkillYamlSchema.
 * Returns null and logs a warning for invalid files — does not throw.
 */
async function parseSkillFile(
  filePath: string,
  cloneRoot: string,
): Promise<ParsedSkillFile | null> {
  const relPath = relative(cloneRoot, filePath);
  try {
    const content = await Promise.race<string>([
      readFile(filePath, "utf-8"),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error("Parse timeout")), 10_000),
      ),
    ]);

    const ext = extname(filePath).toLowerCase();
    let raw: unknown;

    if (ext === ".json") {
      raw = JSON.parse(content);
    } else {
      // js-yaml DEFAULT_SCHEMA — safe, no !!js/function
      raw = yaml.load(content);
    }

    const parsed = SkillYamlSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[git-skill-sync] Skipping ${relPath}: ${parsed.error.errors[0]?.message}`);
      return null;
    }

    const { metadata, spec } = parsed.data;
    return {
      relativePath: relPath,
      name: metadata.name,
      teamId: spec.teamId,
      systemPrompt: spec.systemPrompt,
      tools: spec.tools,
      modelPreference: spec.modelPreference,
      outputSchema: spec.outputSchema,
      sharing: spec.sharing,
      version: metadata.version,
      description: metadata.description,
      tags: metadata.tags,
    };
  } catch (err) {
    console.warn(`[git-skill-sync] Skipping ${relPath}: ${(err as Error).message}`);
    return null;
  }
}

// ─── Main Sync Function ───────────────────────────────────────────────────────

/**
 * Sync skills from a git source into the DB.
 * - Upserts skills keyed on (gitSourceId, relativePath)
 * - Updates lastSyncedAt on success, lastError on failure
 * - Always cleans up the temp clone dir
 */
export async function syncGitSkillSource(sourceId: string): Promise<void> {
  // 1. Load source from DB
  const [source] = await db
    .select()
    .from(gitSkillSources)
    .where(eq(gitSkillSources.id, sourceId));

  if (!source) {
    throw new Error(`Git skill source not found: ${sourceId}`);
  }

  // 2. Validate URL
  if (!isAllowedRepoUrl(source.repoUrl)) {
    const err = `Rejected URL scheme: ${source.repoUrl}. Only https:// and git@ are allowed.`;
    await db
      .update(gitSkillSources)
      .set({ lastError: err })
      .where(eq(gitSkillSources.id, sourceId));
    throw new Error(err);
  }

  let tmpDir: string | null = null;

  try {
    // 3. Create isolated temp dir
    tmpDir = await mkdtemp(join(tmpdir(), "multiqlti-git-sync-"));

    // 4. Build clone URL (inject PAT for private repos)
    let cloneUrl = source.repoUrl;
    if (source.encryptedPat) {
      try {
        const pat = decrypt(source.encryptedPat);
        cloneUrl = injectPat(source.repoUrl, pat);
      } catch (cryptoErr) {
        throw new Error(`Failed to decrypt PAT: ${(cryptoErr as Error).message}`);
      }
    }

    // 5. Clone with 30s timeout, depth=1
    await Promise.race([
      execFileAsync("git", [
        "clone",
        "--depth", "1",
        "--branch", source.branch,
        "--single-branch",
        cloneUrl,
        tmpDir,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("git clone timed out after 30s")), 30_000),
      ),
    ]);

    // 6. Validate path and discover skill files
    const skillsDir = safePath(tmpDir, source.path);

    // Confirm path exists
    const pathStat = await stat(skillsDir).catch(() => null);
    if (!pathStat?.isDirectory()) {
      throw new Error(`Path '${source.path}' is not a directory in the repository`);
    }

    const filePaths = await walkDir(skillsDir);

    // 7. Parse all files in parallel, tolerating failures
    const parseResults = await Promise.allSettled(
      filePaths.map((fp) => parseSkillFile(fp, tmpDir!)),
    );

    const validSkills = parseResults
      .filter(
        (r): r is PromiseFulfilledResult<ParsedSkillFile> =>
          r.status === "fulfilled" && r.value !== null,
      )
      .map((r) => r.value as ParsedSkillFile);

    // 8. Upsert skills into DB keyed on (gitSourceId, relativePath)
    // Load existing skills for this source to detect updates vs inserts
    const existingSkills = await db
      .select({ id: skills.id, gitSourceId: skills.gitSourceId, name: skills.name })
      .from(skills)
      .where(eq(skills.gitSourceId, sourceId));

    // Build map: relativePath → existing skill id (we store path in description for git skills)
    // We key by name+sourceId as a stable identity (relativePath stored in description field)
    const existingByPath = new Map<string, string>();
    for (const existing of existingSkills) {
      // We store the relative path in the name field for git skills: "source::relPath"
      existingByPath.set(existing.name, existing.id);
    }

    const seenPaths = new Set<string>();

    for (const parsed of validSkills) {
      // Composite key: use relativePath as stable skill identity within a source
      const stableKey = `${sourceId}::${parsed.relativePath}`;
      seenPaths.add(stableKey);

      const existingId = existingByPath.get(stableKey);

      const skillData = {
        name: stableKey, // stable identity key stored in name
        description: parsed.description,
        teamId: parsed.teamId,
        systemPromptOverride: parsed.systemPrompt,
        tools: parsed.tools as unknown as string[],
        modelPreference: parsed.modelPreference,
        outputSchema: parsed.outputSchema as Record<string, unknown> | undefined,
        tags: parsed.tags as unknown as string[],
        version: parsed.version,
        sharing: parsed.sharing,
        isBuiltin: false,
        isPublic: parsed.sharing === "public",
        createdBy: source.createdBy ?? "git-sync",
        sourceType: "git" as const,
        gitSourceId: sourceId,
      };

      if (existingId) {
        await db
          .update(skills)
          .set({ ...skillData, updatedAt: new Date() })
          .where(eq(skills.id, existingId));
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await db.insert(skills).values(skillData as any);
      }
    }

    // 9. Remove skills from this source that were not found in the latest sync
    for (const [path, id] of existingByPath.entries()) {
      if (!seenPaths.has(path)) {
        await db.delete(skills).where(eq(skills.id, id));
      }
    }

    // 10. Mark success
    await db
      .update(gitSkillSources)
      .set({ lastSyncedAt: new Date(), lastError: null })
      .where(eq(gitSkillSources.id, sourceId));

    console.log(`[git-skill-sync] Synced ${validSkills.length} skills from source ${sourceId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[git-skill-sync] Sync failed for source ${sourceId}: ${message}`);

    await db
      .update(gitSkillSources)
      .set({ lastError: message })
      .where(eq(gitSkillSources.id, sourceId));

    throw err;
  } finally {
    // Always clean up temp dir
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true }).catch((e) => {
        console.warn(`[git-skill-sync] Failed to clean up ${tmpDir}: ${(e as Error).message}`);
      });
    }
  }
}

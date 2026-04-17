/**
 * server/tools/loader.ts
 *
 * Dynamic tool/skill/role loader for workspace-scoped custom extensions.
 *
 * Responsibilities:
 *   1. Accept a WorkspaceToolSourceConfig describing where to load modules from.
 *   2. Load & sandbox-execute each source (npm, local, git).
 *   3. Validate the resulting exports against the SDK contract.
 *   4. Register valid tools into the workspace-scoped overlay in WorkspaceToolRegistry.
 *   5. Support hot-reload: watch local paths and re-load on change.
 *   6. Rollback: a failed load preserves the previously-loaded version intact.
 *
 * Security:
 *   - All user code runs inside a `vm.Context` (see sandbox-vm.ts).
 *   - Outbound HTTP is blocked unless the tool declared "http:outbound" scope.
 *   - Execution per tool invocation is capped by `SandboxLimits.executionTimeoutMs`.
 *   - npm/git sources are written to a tmp directory; local sources are read-only
 *     (no writes from within the sandbox).
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execFile } from "child_process";
import { promisify } from "util";
import type { FSWatcher } from "fs";

import type {
  WorkspaceToolSourceConfig,
  ToolSource,
  NormalisedToolDefinition,
  NormalisedSkillDefinition,
  NormalisedRoleDefinition,
  SdkModule,
  ToolScope,
} from "../../packages/sdk/src/types.js";

import {
  createSandboxContext,
  compileScript,
  runScript,
  wrapModuleSource,
  DEFAULT_SANDBOX_LIMITS,
} from "./sandbox-vm.js";

import type { SandboxLimits } from "./sandbox-vm.js";
import type { WorkspaceToolRegistry } from "./workspace-registry.js";

const execFileAsync = promisify(execFile);

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long to wait for npm install / git clone before aborting. */
const INSTALL_TIMEOUT_MS = 60_000;

/** Maximum source file size we will read and compile (1 MB). */
const MAX_SOURCE_SIZE_BYTES = 1_024 * 1_024;

// ─── Validation ───────────────────────────────────────────────────────────────

const NAME_RE = /^[a-z][a-z0-9_-]{0,79}$/;
const VALID_SCOPES = new Set<ToolScope>([
  "read:workspace",
  "write:workspace",
  "read:memory",
  "write:memory",
  "read:runs",
  "write:runs",
  "http:outbound",
]);

function isValidToolDef(v: unknown): v is NormalisedToolDefinition {
  if (!v || typeof v !== "object") return false;
  const t = v as Record<string, unknown>;
  return (
    t._kind === "tool" &&
    typeof t.name === "string" &&
    NAME_RE.test(t.name) &&
    typeof t.description === "string" &&
    t.description.trim().length > 0 &&
    typeof t.inputSchema === "object" &&
    t.inputSchema !== null &&
    (t.inputSchema as Record<string, unknown>).type === "object" &&
    Array.isArray(t.scopes) &&
    (t.scopes as unknown[]).every((s) => typeof s === "string" && VALID_SCOPES.has(s as ToolScope)) &&
    typeof t.handler === "function" &&
    typeof t.sdkVersion === "string"
  );
}

function isValidSkillDef(v: unknown): v is NormalisedSkillDefinition {
  if (!v || typeof v !== "object") return false;
  const s = v as Record<string, unknown>;
  return (
    s._kind === "skill" &&
    typeof s.name === "string" &&
    NAME_RE.test(s.name) &&
    typeof s.description === "string" &&
    Array.isArray(s.prompts) &&
    (s.prompts as unknown[]).length > 0
  );
}

function isValidRoleDef(v: unknown): v is NormalisedRoleDefinition {
  if (!v || typeof v !== "object") return false;
  const r = v as Record<string, unknown>;
  return (
    r._kind === "role" &&
    typeof r.name === "string" &&
    NAME_RE.test(r.name) &&
    typeof r.systemPrompt === "string" &&
    r.systemPrompt.trim().length > 0
  );
}

function validateSdkModule(raw: unknown): SdkModule {
  if (!raw || typeof raw !== "object") {
    throw new Error("Module did not export an object.");
  }

  const mod = raw as Record<string, unknown>;
  const result: SdkModule = {};

  if (mod.tools !== undefined) {
    if (!Array.isArray(mod.tools)) {
      throw new Error("Module exports.tools must be an array.");
    }
    result.tools = [];
    for (let i = 0; i < (mod.tools as unknown[]).length; i++) {
      const t = (mod.tools as unknown[])[i];
      if (!isValidToolDef(t)) {
        throw new Error(
          `Module exports.tools[${i}] failed SDK schema validation. ` +
            "Ensure you used defineTool() from @multiqlti/sdk.",
        );
      }
      result.tools.push(t);
    }
  }

  if (mod.skills !== undefined) {
    if (!Array.isArray(mod.skills)) {
      throw new Error("Module exports.skills must be an array.");
    }
    result.skills = [];
    for (let i = 0; i < (mod.skills as unknown[]).length; i++) {
      const s = (mod.skills as unknown[])[i];
      if (!isValidSkillDef(s)) {
        throw new Error(`Module exports.skills[${i}] failed SDK schema validation.`);
      }
      result.skills.push(s);
    }
  }

  if (mod.roles !== undefined) {
    if (!Array.isArray(mod.roles)) {
      throw new Error("Module exports.roles must be an array.");
    }
    result.roles = [];
    for (let i = 0; i < (mod.roles as unknown[]).length; i++) {
      const r = (mod.roles as unknown[])[i];
      if (!isValidRoleDef(r)) {
        throw new Error(`Module exports.roles[${i}] failed SDK schema validation.`);
      }
      result.roles.push(r);
    }
  }

  const hasContent =
    (result.tools?.length ?? 0) > 0 ||
    (result.skills?.length ?? 0) > 0 ||
    (result.roles?.length ?? 0) > 0;

  if (!hasContent) {
    throw new Error(
      "Module exported no tools, skills, or roles. At least one must be non-empty.",
    );
  }

  return result;
}

// ─── Source resolution ────────────────────────────────────────────────────────

/**
 * Resolves a ToolSource to a local filesystem path containing the entry-point
 * JS file (index.js or the main field).
 *
 * For `local`: validates the path and returns it directly.
 * For `npm`:   creates a temp dir and runs `npm install`.
 * For `git`:   creates a temp dir and runs `git clone`.
 */
async function resolveSourceToPath(source: ToolSource): Promise<string> {
  switch (source.type) {
    case "local": {
      const resolved = path.resolve(source.path);
      if (!fs.existsSync(resolved)) {
        throw new Error(`[sdk-loader] Local source path does not exist: ${resolved}`);
      }
      const stat = fs.statSync(resolved);
      if (stat.isDirectory()) {
        // Look for index.js, index.ts, or package.json main
        return resolvePackageEntry(resolved);
      }
      return resolved;
    }

    case "npm": {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiqlti-sdk-npm-"));
      try {
        const registry = source.registry ?? "https://registry.npmjs.org";
        await execFileAsync(
          "npm",
          ["install", "--prefix", tmpDir, "--registry", registry, source.package],
          { timeout: INSTALL_TIMEOUT_MS },
        );
        // The package is installed under node_modules/<name>
        const pkgName = source.package.replace(/@[^@/]+$/, ""); // strip version
        const pkgDir = path.join(tmpDir, "node_modules", pkgName);
        return resolvePackageEntry(pkgDir);
      } catch (err) {
        // Clean up temp dir on failure
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`[sdk-loader] npm install failed for "${source.package}": ${(err as Error).message}`);
      }
    }

    case "git": {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "multiqlti-sdk-git-"));
      try {
        const ref = source.ref ?? "main";
        await execFileAsync(
          "git",
          ["clone", "--depth", "1", "--branch", ref, source.url, tmpDir],
          { timeout: INSTALL_TIMEOUT_MS },
        );
        const subpath = source.subpath ?? ".";
        const pkgDir = path.resolve(tmpDir, subpath);
        return resolvePackageEntry(pkgDir);
      } catch (err) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        throw new Error(`[sdk-loader] git clone failed for "${source.url}": ${(err as Error).message}`);
      }
    }
  }
}

function resolvePackageEntry(dir: string): string {
  // Try package.json "main" field
  const pkgJsonPath = path.join(dir, "package.json");
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8")) as Record<string, unknown>;
      if (typeof pkg.main === "string") {
        return path.resolve(dir, pkg.main);
      }
    } catch {
      // Ignore malformed package.json
    }
  }
  // Fallback candidates
  for (const candidate of ["index.js", "index.ts", "src/index.js", "src/index.ts"]) {
    const p = path.join(dir, candidate);
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`[sdk-loader] Could not find entry point in directory: ${dir}`);
}

// ─── Loading ──────────────────────────────────────────────────────────────────

/**
 * Reads the entry-point file, sandboxes it, and returns the validated SdkModule.
 */
function loadModuleFromPath(entryPath: string, limits: SandboxLimits): SdkModule {
  const stat = fs.statSync(entryPath);
  if (stat.size > MAX_SOURCE_SIZE_BYTES) {
    throw new Error(
      `[sdk-loader] Source file too large: ${stat.size} bytes (max ${MAX_SOURCE_SIZE_BYTES})`,
    );
  }

  const source = fs.readFileSync(entryPath, "utf8");
  const wrapped = wrapModuleSource(source);

  // Derive scopes from the module source by doing a pre-pass scan (the real
  // scopes come from each tool definition after execution).  We need a context
  // to run the module at all, so we start with all scopes allowed and then
  // restrict per-tool at invocation time in the WorkspaceToolRegistry.
  const allScopes: ToolScope[] = [
    "read:workspace",
    "write:workspace",
    "read:memory",
    "write:memory",
    "read:runs",
    "write:runs",
    "http:outbound",
  ];

  const ctx = createSandboxContext(allScopes, globalThis.fetch ?? null);
  const script = compileScript(wrapped, entryPath, ctx);
  const raw = runScript(script, ctx, limits.executionTimeoutMs);

  return validateSdkModule(raw);
}

// ─── DynamicToolLoader ────────────────────────────────────────────────────────

export interface LoadResult {
  workspaceId: string;
  toolsRegistered: number;
  skillsRegistered: number;
  rolesRegistered: number;
  errors: string[];
}

/**
 * Manages loading, validating, and registering custom tool modules for a
 * specific workspace.  Maintains the previously-loaded snapshot for rollback.
 */
export class DynamicToolLoader {
  private readonly workspaceId: string;
  private readonly registry: WorkspaceToolRegistry;
  private readonly limits: SandboxLimits;

  /** Watchers indexed by local path. */
  private watchers: Map<string, FSWatcher> = new Map();

  /** Snapshot of the last successfully loaded module per source key. */
  private lastGoodModules: Map<string, SdkModule> = new Map();

  constructor(
    workspaceId: string,
    registry: WorkspaceToolRegistry,
    limits: SandboxLimits = DEFAULT_SANDBOX_LIMITS,
  ) {
    this.workspaceId = workspaceId;
    this.registry = registry;
    this.limits = limits;
  }

  /**
   * Loads (or reloads) all sources defined in the workspace config.
   * Errors in individual sources are collected and returned; they do NOT
   * prevent other sources from loading.  A failed source rolls back to its
   * previously-loaded version (if any).
   */
  async load(config: WorkspaceToolSourceConfig): Promise<LoadResult> {
    const result: LoadResult = {
      workspaceId: this.workspaceId,
      toolsRegistered: 0,
      skillsRegistered: 0,
      rolesRegistered: 0,
      errors: [],
    };

    for (const source of config.sources) {
      const sourceKey = buildSourceKey(source);
      try {
        const entryPath = await resolveSourceToPath(source);
        const sdkModule = loadModuleFromPath(entryPath, this.limits);

        // Register into workspace overlay
        this.registry.setWorkspaceOverlay(this.workspaceId, sourceKey, sdkModule);

        // Update rollback snapshot
        this.lastGoodModules.set(sourceKey, sdkModule);

        result.toolsRegistered += sdkModule.tools?.length ?? 0;
        result.skillsRegistered += sdkModule.skills?.length ?? 0;
        result.rolesRegistered += sdkModule.roles?.length ?? 0;

        // Set up hot-reload watcher for local sources
        if (source.type === "local" && config.hotReload) {
          this.watchLocalSource(source.path, config);
        }
      } catch (err) {
        const message = (err as Error).message;
        result.errors.push(`[${sourceKey}] ${message}`);

        // Rollback: re-register the last good version if available
        const lastGood = this.lastGoodModules.get(sourceKey);
        if (lastGood) {
          this.registry.setWorkspaceOverlay(this.workspaceId, sourceKey, lastGood);
        } else {
          // Nothing to rollback — remove the source from registry (no broken state)
          this.registry.removeWorkspaceOverlay(this.workspaceId, sourceKey);
        }
      }
    }

    return result;
  }

  /**
   * Watches a local source directory/file for changes and triggers a reload.
   * Debounces rapid successive changes to avoid thrashing.
   */
  private watchLocalSource(localPath: string, config: WorkspaceToolSourceConfig): void {
    if (this.watchers.has(localPath)) return; // already watching

    let debounceTimer: ReturnType<typeof setTimeout> | null = null;

    const watcher = fs.watch(localPath, { recursive: true }, (_event, _filename) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        // Fire-and-forget reload; errors are logged to console (no throw)
        this.load(config).catch((err: unknown) => {
          console.warn(
            `[sdk-loader] Hot-reload failed for workspace "${this.workspaceId}" source "${localPath}":`,
            (err as Error).message,
          );
        });
      }, 300);
    });

    watcher.on("error", (err) => {
      console.warn(`[sdk-loader] File watcher error for "${localPath}":`, err.message);
    });

    this.watchers.set(localPath, watcher);
  }

  /** Stop all file-system watchers associated with this loader. */
  dispose(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildSourceKey(source: ToolSource): string {
  switch (source.type) {
    case "npm":
      return `npm:${source.package}`;
    case "local":
      return `local:${path.resolve(source.path)}`;
    case "git":
      return `git:${source.url}@${source.ref ?? "main"}`;
  }
}

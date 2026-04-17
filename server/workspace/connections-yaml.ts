/**
 * Declarative YAML config for workspace connections (issue #276)
 *
 * Reads `.multiqlti/connections.yaml` from the workspace root, resolves
 * secret references (env/file), diffs against the current DB state, and
 * produces a reconciliation plan.
 *
 * Security invariants:
 *   - Inline plaintext secrets in YAML are rejected with a hard error.
 *   - Resolved secret values are NEVER logged.
 *   - The ${vault:…} reference is a typed stub for future implementation.
 */

import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { z } from "zod";
import { CONNECTION_TYPES } from "@shared/schema";
import type { WorkspaceConnection, CreateWorkspaceConnectionInput, UpdateWorkspaceConnectionInput, ConnectionType } from "@shared/types";
import type { IStorage } from "../storage";

// ─── Constants ───────────────────────────────────────────────────────────────

export const CONNECTIONS_YAML_PATH = ".multiqlti/connections.yaml";

/** Supported secret reference prefixes. */
const SECRET_REF_PATTERN = /^\$\{(env|file|vault):([^}]+)\}$/;

/** Characters that suggest a value is a plaintext secret (not a reference). */
const PLAINTEXT_SECRET_INDICATORS = /^[A-Za-z0-9+/]{20,}={0,2}$|glpat-|ghp_|xoxb-|sk-/;

// ─── Zod schemas ─────────────────────────────────────────────────────────────

/**
 * A secret value in YAML must be a ${env:…}, ${file:…} or ${vault:…} reference.
 * Any other string is rejected as a potential plaintext secret.
 */
const SecretRefSchema = z
  .string()
  .refine(
    (v) => SECRET_REF_PATTERN.test(v),
    (v) => ({
      message: `Plaintext secrets are not allowed. Use \${env:VAR}, \${file:path}, or \${vault:path} references. Got: ${v.slice(0, 20)}…`,
    }),
  );

const YamlConnectionSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(CONNECTION_TYPES),
  config: z.record(z.unknown()).default({}),
  /**
   * secrets is a record of secret name → reference string.
   * All values must be reference expressions — never plaintext.
   */
  secrets: z.record(SecretRefSchema).optional(),
});

export const ConnectionsFileSchema = z.object({
  version: z.literal(1),
  connections: z.array(YamlConnectionSchema).default([]),
});

export type YamlConnection = z.infer<typeof YamlConnectionSchema>;
export type ConnectionsFile = z.infer<typeof ConnectionsFileSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SecretResolutionError {
  connectionName: string;
  secretKey: string;
  ref: string;
  message: string;
}

export interface ResolvedSecrets {
  secrets: Record<string, string>;
  errors: SecretResolutionError[];
}

/** A single action in the reconciliation plan. */
export type ReconcileActionType = "create" | "update" | "delete" | "unchanged";

export interface ReconcileAction {
  type: ReconcileActionType;
  connectionName: string;
  /** Only set for update/create actions. */
  yamlEntry?: YamlConnection;
  /** Only set for update/delete actions — existing DB record. */
  existing?: WorkspaceConnection;
  /** Human-readable reason for the action. */
  reason: string;
}

export interface ReconcilePlan {
  actions: ReconcileAction[];
  hasChanges: boolean;
}

export interface ApplyResult {
  created: string[];
  updated: string[];
  deleted: string[];
  errors: Array<{ connectionName: string; message: string }>;
}

/** Drift item: a connection modified in UI after YAML was applied. */
export interface DriftItem {
  connectionId: string;
  connectionName: string;
  connectionType: ConnectionType;
  /** Keys whose values differ between YAML config and DB config. */
  driftedConfigKeys: string[];
}

// ─── YAML Parsing ────────────────────────────────────────────────────────────

/**
 * Load and parse the connections YAML from a workspace root directory.
 * Returns null when the file does not exist (graceful absence).
 * Throws on parse error or schema violation.
 */
export async function loadConnectionsYaml(workspaceRoot: string): Promise<ConnectionsFile | null> {
  const fullPath = path.join(workspaceRoot, CONNECTIONS_YAML_PATH);

  let raw: string;
  try {
    raw = await fs.readFile(fullPath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    throw err;
  }

  const parsed = yaml.load(raw);

  const result = ConnectionsFileSchema.safeParse(parsed);
  if (!result.success) {
    const firstIssue = result.error.issues[0];
    const path_ = firstIssue.path.join(".");
    throw new Error(
      `connections.yaml validation failed at "${path_}": ${firstIssue.message}`,
    );
  }

  return result.data;
}

// ─── Secret Reference Resolution ─────────────────────────────────────────────

/**
 * Resolve a single secret reference string into its plaintext value.
 *
 * Supports:
 *   ${env:VAR_NAME}    → process.env[VAR_NAME]
 *   ${file:./path}     → fs.readFile(path, "utf-8").trim()
 *   ${vault:path}      → throws NotImplemented (future extension stub)
 *
 * NEVER logs the resolved value.
 */
export async function resolveSecretRef(
  ref: string,
  workspaceRoot: string,
): Promise<string> {
  const match = SECRET_REF_PATTERN.exec(ref);
  if (!match) {
    throw new Error(`Invalid secret reference format: "${ref}"`);
  }

  const refType = match[1] as "env" | "file" | "vault";
  const refValue = match[2];

  switch (refType) {
    case "env": {
      const value = process.env[refValue];
      if (value === undefined) {
        throw new Error(`Environment variable "${refValue}" is not set`);
      }
      return value;
    }

    case "file": {
      const resolvedPath = path.resolve(workspaceRoot, refValue);
      // Guard against path traversal outside workspace root
      if (!resolvedPath.startsWith(path.resolve(workspaceRoot))) {
        throw new Error(`File reference "${refValue}" would escape the workspace root`);
      }
      try {
        const content = await fs.readFile(resolvedPath, "utf-8");
        return content.trim();
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          throw new Error(`Secret file not found: "${refValue}"`);
        }
        throw err;
      }
    }

    case "vault": {
      // Stub: vault integration is a future extension
      throw new Error(
        `Vault secret references are not yet implemented. Ref: "${ref}". ` +
        `Please use \${env:VAR} or \${file:path} instead.`,
      );
    }

    default: {
      const _exhaustive: never = refType;
      throw new Error(`Unknown secret reference type: ${_exhaustive}`);
    }
  }
}

/**
 * Resolve all secret references for a single connection.
 * Returns resolved secrets map + any resolution errors.
 * Errors are collected (not thrown) so callers can decide to fail-open or fail-closed.
 */
export async function resolveConnectionSecrets(
  connectionName: string,
  secretRefs: Record<string, string>,
  workspaceRoot: string,
): Promise<ResolvedSecrets> {
  const secrets: Record<string, string> = {};
  const errors: SecretResolutionError[] = [];

  for (const [key, ref] of Object.entries(secretRefs)) {
    try {
      secrets[key] = await resolveSecretRef(ref, workspaceRoot);
    } catch (err: unknown) {
      errors.push({
        connectionName,
        secretKey: key,
        ref,
        message: (err as Error).message,
      });
    }
  }

  return { secrets, errors };
}

// ─── Plaintext Secret Detection ───────────────────────────────────────────────

/**
 * Scans a raw YAML string for patterns that look like plaintext secrets in the
 * secrets block. This is a defence-in-depth check on top of SecretRefSchema.
 *
 * Returns the first suspicious value found, or null if clean.
 *
 * NOTE: This operates on the raw YAML text before parsing to catch values that
 * bypass Zod parsing (e.g. anchors, multi-line strings).
 */
export function detectPlaintextSecret(rawYaml: string): string | null {
  // Find all values under `secrets:` blocks via a simple pattern scan
  const secretsBlockPattern = /^\s+secrets:\s*\n((?:\s{4,}[^:]+:.*\n)*)/gm;
  let match: RegExpExecArray | null;

  while ((match = secretsBlockPattern.exec(rawYaml)) !== null) {
    const block = match[1];
    const valuePattern = /:\s*["']?([^"'\n#]+?)["']?\s*(?:#.*)?$/gm;
    let valueMatch: RegExpExecArray | null;

    while ((valueMatch = valuePattern.exec(block)) !== null) {
      const value = valueMatch[1].trim();
      // Skip reference expressions
      if (SECRET_REF_PATTERN.test(value)) continue;
      // Skip empty values
      if (!value) continue;
      // Flag if it looks like a token/key
      if (PLAINTEXT_SECRET_INDICATORS.test(value)) {
        return value.slice(0, 10) + "…";
      }
    }
  }

  return null;
}

// ─── Reconciliation ───────────────────────────────────────────────────────────

/**
 * Diff YAML entries against DB state and produce a plan.
 *
 * Rules:
 *   - YAML has connection, DB does not → create
 *   - YAML has connection, DB has it (by name+workspaceId) → compare config → update or unchanged
 *   - DB has connection, YAML does not → delete (only for YAML-managed connections)
 *
 * "YAML-managed" is tracked by checking whether a connection's name matches
 * any YAML entry. In a future extension a `yamlManaged: true` flag can be
 * persisted, but for now we treat connections whose names match as managed.
 */
export function buildReconcilePlan(
  yamlConnections: YamlConnection[],
  dbConnections: WorkspaceConnection[],
): ReconcilePlan {
  const actions: ReconcileAction[] = [];

  const dbByName = new Map<string, WorkspaceConnection>(
    dbConnections.map((c) => [c.name, c]),
  );

  const yamlNames = new Set(yamlConnections.map((c) => c.name));

  // Compute creates and updates
  for (const yamlConn of yamlConnections) {
    const existing = dbByName.get(yamlConn.name);

    if (!existing) {
      actions.push({
        type: "create",
        connectionName: yamlConn.name,
        yamlEntry: yamlConn,
        reason: "Connection defined in YAML but not in DB",
      });
      continue;
    }

    // Check for config drift
    if (configDiffers(yamlConn.config, existing.config) || existing.type !== yamlConn.type) {
      actions.push({
        type: "update",
        connectionName: yamlConn.name,
        yamlEntry: yamlConn,
        existing,
        reason: configDiffReason(yamlConn, existing),
      });
    } else {
      actions.push({
        type: "unchanged",
        connectionName: yamlConn.name,
        yamlEntry: yamlConn,
        existing,
        reason: "No changes detected",
      });
    }
  }

  // Compute deletes: DB connections whose names were previously managed by YAML
  // (i.e., names NOT in current YAML set)
  for (const dbConn of dbConnections) {
    if (!yamlNames.has(dbConn.name)) {
      // Only delete connections that were known to be YAML-managed via a marker.
      // Without a persistent marker we skip deletes to be safe (non-destructive default).
      // Callers can pass includeDeletes=true to enable this.
    }
  }

  return {
    actions,
    hasChanges: actions.some((a) => a.type !== "unchanged"),
  };
}

/**
 * Extended plan that includes deletions of DB connections not present in YAML.
 * Useful when auto-apply mode with full reconciliation is desired.
 */
export function buildReconcilePlanWithDeletes(
  yamlConnections: YamlConnection[],
  dbConnections: WorkspaceConnection[],
): ReconcilePlan {
  const plan = buildReconcilePlan(yamlConnections, dbConnections);
  const yamlNames = new Set(yamlConnections.map((c) => c.name));

  for (const dbConn of dbConnections) {
    if (!yamlNames.has(dbConn.name)) {
      plan.actions.push({
        type: "delete",
        connectionName: dbConn.name,
        existing: dbConn,
        reason: "Connection exists in DB but is absent from YAML",
      });
    }
  }

  plan.hasChanges = plan.actions.some((a) => a.type !== "unchanged");
  return plan;
}

/** Deep-compare config objects for reconciliation purposes. */
function configDiffers(
  yamlConfig: Record<string, unknown>,
  dbConfig: Record<string, unknown>,
): boolean {
  return JSON.stringify(sortKeys(yamlConfig)) !== JSON.stringify(sortKeys(dbConfig));
}

function configDiffReason(yamlConn: YamlConnection, existing: WorkspaceConnection): string {
  if (existing.type !== yamlConn.type) {
    return `Type changed from "${existing.type}" to "${yamlConn.type}"`;
  }
  const yamlKeys = Object.keys(yamlConn.config);
  const dbKeys = Object.keys(existing.config);
  const changed = [
    ...yamlKeys.filter((k) => JSON.stringify(yamlConn.config[k]) !== JSON.stringify(existing.config[k])),
    ...dbKeys.filter((k) => !(k in yamlConn.config)),
  ];
  return `Config keys changed: ${changed.slice(0, 5).join(", ")}`;
}

function sortKeys(obj: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)),
  );
}

// ─── Plan Application ─────────────────────────────────────────────────────────

/**
 * Apply a reconciliation plan against the database.
 *
 * @param plan        The plan produced by buildReconcilePlan.
 * @param workspaceId The workspace to apply changes in.
 * @param workspaceRoot  Filesystem root for resolving file-based secret refs.
 * @param storage     Storage implementation.
 * @param createdBy   User ID initiating the sync (optional).
 */
export async function applyReconcilePlan(
  plan: ReconcilePlan,
  workspaceId: string,
  workspaceRoot: string,
  storage: IStorage,
  createdBy?: string | null,
): Promise<ApplyResult> {
  const result: ApplyResult = {
    created: [],
    updated: [],
    deleted: [],
    errors: [],
  };

  for (const action of plan.actions) {
    if (action.type === "unchanged") continue;

    try {
      switch (action.type) {
        case "create": {
          const yamlEntry = action.yamlEntry!;
          let resolvedSecrets: Record<string, string> | undefined;

          if (yamlEntry.secrets && Object.keys(yamlEntry.secrets).length > 0) {
            const resolution = await resolveConnectionSecrets(
              yamlEntry.name,
              yamlEntry.secrets,
              workspaceRoot,
            );
            if (resolution.errors.length > 0) {
              result.errors.push({
                connectionName: yamlEntry.name,
                message: resolution.errors.map((e) => `${e.secretKey}: ${e.message}`).join("; "),
              });
              continue;
            }
            resolvedSecrets = resolution.secrets;
          }

          const input: CreateWorkspaceConnectionInput = {
            workspaceId,
            type: yamlEntry.type,
            name: yamlEntry.name,
            config: yamlEntry.config,
            ...(resolvedSecrets ? { secrets: resolvedSecrets } : {}),
            createdBy: createdBy ?? null,
          };

          await storage.createWorkspaceConnection(input);
          result.created.push(yamlEntry.name);
          break;
        }

        case "update": {
          const yamlEntry = action.yamlEntry!;
          const existing = action.existing!;

          let resolvedSecrets: Record<string, string> | null | undefined;

          if (yamlEntry.secrets !== undefined) {
            if (Object.keys(yamlEntry.secrets).length === 0) {
              resolvedSecrets = null; // explicitly remove secrets
            } else {
              const resolution = await resolveConnectionSecrets(
                yamlEntry.name,
                yamlEntry.secrets,
                workspaceRoot,
              );
              if (resolution.errors.length > 0) {
                result.errors.push({
                  connectionName: yamlEntry.name,
                  message: resolution.errors.map((e) => `${e.secretKey}: ${e.message}`).join("; "),
                });
                continue;
              }
              resolvedSecrets = resolution.secrets;
            }
          }

          const updates: UpdateWorkspaceConnectionInput = {
            config: yamlEntry.config,
            ...(resolvedSecrets !== undefined ? { secrets: resolvedSecrets } : {}),
          };

          await storage.updateWorkspaceConnection(existing.id, updates);
          result.updated.push(yamlEntry.name);
          break;
        }

        case "delete": {
          const existing = action.existing!;
          await storage.deleteWorkspaceConnection(existing.id);
          result.deleted.push(action.connectionName);
          break;
        }
      }
    } catch (err: unknown) {
      result.errors.push({
        connectionName: action.connectionName,
        message: (err as Error).message,
      });
    }
  }

  return result;
}

// ─── Drift Detection ─────────────────────────────────────────────────────────

/**
 * Detect connections whose DB config has drifted from the YAML definition.
 *
 * A drift occurs when a connection defined in YAML has been modified through
 * the UI after the last YAML sync, causing the DB state to diverge.
 *
 * Only config (non-secret) fields are compared — secrets are never compared
 * directly as they are stored encrypted.
 */
export function detectDrift(
  yamlConnections: YamlConnection[],
  dbConnections: WorkspaceConnection[],
): DriftItem[] {
  const dbByName = new Map<string, WorkspaceConnection>(
    dbConnections.map((c) => [c.name, c]),
  );

  const driftItems: DriftItem[] = [];

  for (const yamlConn of yamlConnections) {
    const dbConn = dbByName.get(yamlConn.name);
    if (!dbConn) continue; // not yet created — not drift

    if (dbConn.type !== yamlConn.type) {
      driftItems.push({
        connectionId: dbConn.id,
        connectionName: dbConn.name,
        connectionType: dbConn.type,
        driftedConfigKeys: ["type"],
      });
      continue;
    }

    const driftedKeys = findDriftedKeys(yamlConn.config, dbConn.config);
    if (driftedKeys.length > 0) {
      driftItems.push({
        connectionId: dbConn.id,
        connectionName: dbConn.name,
        connectionType: dbConn.type,
        driftedConfigKeys: driftedKeys,
      });
    }
  }

  return driftItems;
}

/** Return config keys that differ between YAML and DB config. */
function findDriftedKeys(
  yamlConfig: Record<string, unknown>,
  dbConfig: Record<string, unknown>,
): string[] {
  const allKeys = new Set([...Object.keys(yamlConfig), ...Object.keys(dbConfig)]);
  return [...allKeys].filter(
    (k) => JSON.stringify(yamlConfig[k]) !== JSON.stringify(dbConfig[k]),
  );
}

// ─── High-level workspace sync entrypoint ─────────────────────────────────────

export interface ConnectionsSyncOptions {
  /** When true, connections absent from YAML are deleted from DB. Default: false. */
  includeDeletes?: boolean;
  /** When true, apply the plan without user confirmation. Default: false. */
  autoApply?: boolean;
  /** User initiating the sync. */
  createdBy?: string | null;
}

export interface ConnectionsSyncResult {
  plan: ReconcilePlan;
  applied: boolean;
  applyResult?: ApplyResult;
  drift: DriftItem[];
  yamlMissing: boolean;
}

/**
 * Full connections sync flow:
 *  1. Load YAML
 *  2. Load DB connections for workspace
 *  3. Build plan
 *  4. Detect drift
 *  5. Apply if autoApply=true
 *
 * Returns a full result descriptor. The caller decides whether to apply
 * (e.g. after showing the plan to the user in the API response).
 */
export async function syncConnectionsFromYaml(
  workspaceId: string,
  workspaceRoot: string,
  storage: IStorage,
  options: ConnectionsSyncOptions = {},
): Promise<ConnectionsSyncResult> {
  const { includeDeletes = false, autoApply = false, createdBy } = options;

  const connectionsFile = await loadConnectionsYaml(workspaceRoot);

  if (!connectionsFile) {
    return {
      plan: { actions: [], hasChanges: false },
      applied: false,
      drift: [],
      yamlMissing: true,
    };
  }

  const dbConnections = await storage.getWorkspaceConnections(workspaceId);

  const plan = includeDeletes
    ? buildReconcilePlanWithDeletes(connectionsFile.connections, dbConnections)
    : buildReconcilePlan(connectionsFile.connections, dbConnections);

  const drift = detectDrift(connectionsFile.connections, dbConnections);

  if (!autoApply || !plan.hasChanges) {
    return { plan, applied: false, drift, yamlMissing: false };
  }

  const applyResult = await applyReconcilePlan(
    plan,
    workspaceId,
    workspaceRoot,
    storage,
    createdBy,
  );

  return { plan, applied: true, applyResult, drift, yamlMissing: false };
}

// ─── YAML Schema Validation (for CLI linter) ─────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  connectionCount: number;
}

/**
 * Validate a YAML string against the connections schema.
 * Returns a structured result suitable for CLI output — never throws.
 */
export function validateConnectionsYaml(rawYaml: string): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Pre-parse plaintext secret check
  const plaintextSecret = detectPlaintextSecret(rawYaml);
  if (plaintextSecret) {
    errors.push(
      `Potential plaintext secret detected in secrets block: "${plaintextSecret}". ` +
      `Use \${env:VAR_NAME}, \${file:./path}, or \${vault:path} instead.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(rawYaml);
  } catch (err: unknown) {
    errors.push(`YAML parse error: ${(err as Error).message}`);
    return { valid: false, errors, warnings, connectionCount: 0 };
  }

  const result = ConnectionsFileSchema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const path_ = issue.path.join(".");
      errors.push(`${path_ ? path_ + ": " : ""}${issue.message}`);
    }
    return { valid: errors.length === 0, errors, warnings, connectionCount: 0 };
  }

  // Warn on vault refs (not yet implemented)
  for (const conn of result.data.connections) {
    for (const [key, ref] of Object.entries(conn.secrets ?? {})) {
      if (ref.startsWith("${vault:")) {
        warnings.push(
          `Connection "${conn.name}" secret "${key}": vault references are not yet implemented.`,
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    connectionCount: result.data.connections.length,
  };
}

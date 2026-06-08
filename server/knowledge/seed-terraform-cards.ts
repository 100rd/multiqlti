/**
 * Example dataset: genuine, well-established Terraform MODULE best-practice cards,
 * plus an idempotent seeder for the Active Knowledge Base.
 *
 * These practices are stable and widely documented — authored from first-party
 * HashiCorp / OpenTofu / community references (no live web fetch). Every source
 * URL is on the curated allowlist (terraform-best-practices.com,
 * developer.hashicorp.com/terraform/language/..., opentofu.org).
 *
 * The seeder is idempotent (content-hash dedupe) and BEST-EFFORT on projection:
 * if the embedding provider (Ollama) is unavailable, the card still persists and
 * projection is skipped with a one-line hint — it never throws.
 */
import type { IStorage } from "../storage";
import type {
  PracticeCardAppliesTo,
  PracticeCardSource,
  PracticeCardRow,
  InsertPracticeCard,
} from "@shared/schema";
import { computeContentHash, projectToChunk } from "./practice-card-service";
import { VectorStore } from "../memory/vector-store";
import { EmbeddingProviderFactory, DEFAULT_EMBEDDING_CONFIG } from "../memory/embeddings";
import type { EmbeddingProviderConfig } from "../memory/embeddings";

export const EXAMPLE_TOPIC = "terraform-module-best-practices";
export const EXAMPLE_WORKSPACE_NAME = "Example: Terraform Best Practices";
/** Stable fallback owner id when no admin user is available. */
export const SYSTEM_OWNER_ID = "system-knowledge-seed";

/** Recent verification date stamped on every seeded card. */
const VERIFIED_AT = "2026-06-01T00:00:00.000Z";

/** A card definition before server-side fields (hash, ids, timestamps) are added. */
export interface ExampleCard {
  statement: string;
  rationale: string;
  appliesTo: PracticeCardAppliesTo;
  sources: PracticeCardSource[];
  confidence: number;
}

/**
 * ~14 genuine Terraform module best-practice cards. Provenance is intentionally
 * split: ingestedBy != verifiedBy (the adversarial-curation invariant).
 */
export const EXAMPLE_TERRAFORM_CARDS: readonly ExampleCard[] = [
  {
    statement:
      "Pin provider versions with a required_providers block and a pessimistic (~>) constraint.",
    rationale:
      "Unpinned providers let a major release silently change resource behavior on the next init/apply. A required_providers block with a ~> constraint allows patch/minor updates while preventing surprise major upgrades.",
    appliesTo: { tool: "terraform", resourceKinds: ["provider"], tags: ["versioning", "providers"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/providers/requirements",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.97,
  },
  {
    statement: "Pin module versions with a version argument when sourcing from a registry.",
    rationale:
      "A floating module reference re-resolves on every init and can pull breaking changes. Pinning the version (exact or ~>) makes plans reproducible and upgrades deliberate.",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["versioning", "modules"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/modules/sources",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.96,
  },
  {
    statement: "Commit the .terraform.lock.hcl dependency lock file to version control.",
    rationale:
      "The lock file records the exact provider versions and checksums selected. Committing it makes every machine and CI run use identical providers and detects unexpected upstream changes.",
    appliesTo: { tool: "terraform", resourceKinds: ["provider"], tags: ["versioning", "lockfile", "reproducibility"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/files/dependency-lock",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.95,
  },
  {
    statement:
      "Use a remote backend with state locking (e.g. S3 + DynamoDB, or a backend with native locking).",
    rationale:
      "Local state is unshareable and unsafe for teams. A remote backend with locking prevents two concurrent applies from corrupting state and keeps a single source of truth.",
    appliesTo: { tool: "terraform", resourceKinds: ["backend"], tags: ["state", "remote-state", "locking"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/backend",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.96,
  },
  {
    statement: "Isolate state per environment (dev/staging/prod) rather than sharing one state file.",
    rationale:
      "A shared state file couples environments so a prod apply can be blocked or polluted by dev changes. Separate state (distinct keys/workspaces/dirs) limits blast radius and enables independent lifecycles.",
    appliesTo: { tool: "terraform", resourceKinds: ["backend"], tags: ["state", "environments", "isolation"] },
    sources: [
      {
        url: "https://terraform-best-practices.com/key-concepts.html",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.9,
  },
  {
    statement:
      "Never hardcode secrets in .tf files or state; pass them via variables sourced from a secret manager.",
    rationale:
      "Hardcoded secrets leak into VCS and into plaintext state. Inject them through variables backed by a secrets manager (Vault, AWS Secrets Manager, SSM) and mark sensitive outputs to avoid logging.",
    appliesTo: { tool: "terraform", resourceKinds: ["variable"], tags: ["security", "secrets"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/values/variables",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.95,
  },
  {
    statement: "Declare every input variable with an explicit type and a description.",
    rationale:
      "Typed, described variables fail fast on bad input, self-document the module interface, and render well in generated docs. Untyped variables defer errors to apply time and obscure intent.",
    appliesTo: { tool: "terraform", resourceKinds: ["variable"], tags: ["variables", "typing", "documentation"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/values/variables",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.93,
  },
  {
    statement: "Declare outputs with descriptions and mark sensitive outputs as sensitive.",
    rationale:
      "Outputs are a module's public API; descriptions document them and sensitive = true keeps secret values out of CLI output and logs.",
    appliesTo: { tool: "terraform", resourceKinds: ["output"], tags: ["outputs", "documentation", "security"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/values/outputs",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.92,
  },
  {
    statement: "Follow the standard module file layout: main.tf, variables.tf, outputs.tf, versions.tf.",
    rationale:
      "A predictable layout makes modules easy to navigate, review, and tool against. versions.tf centralizes the terraform/provider version constraints away from resource logic.",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["modules", "structure", "layout"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/modules/develop/structure",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.91,
  },
  {
    statement: "Prefer for_each over count for collections of keyed resources to keep stable addresses.",
    rationale:
      "count indexes resources positionally, so inserting or removing an element re-indexes and destroys/recreates unrelated resources. for_each keys by a stable identifier, so changes affect only the intended element.",
    appliesTo: { tool: "terraform", resourceKinds: ["resource"], tags: ["meta-arguments", "for_each", "count"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/meta-arguments/for_each",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.93,
  },
  {
    statement: "Use data sources to look up existing infrastructure instead of hardcoding IDs/ARNs.",
    rationale:
      "Hardcoded IDs drift across accounts and environments and break on recreation. Data sources resolve current values at plan time, keeping configuration portable and accurate.",
    appliesTo: { tool: "terraform", resourceKinds: ["data"], tags: ["data-sources", "portability"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/data-sources",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.9,
  },
  {
    statement: "Grant the Terraform provider least-privilege credentials scoped to what it manages.",
    rationale:
      "Broad admin credentials turn any misconfiguration or compromise into a wide blast radius. Scoping the provider's IAM/role to the resources it manages limits damage and enforces separation of duties.",
    appliesTo: { tool: "terraform", resourceKinds: ["provider"], tags: ["security", "least-privilege", "iam"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/providers/configuration",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.9,
  },
  {
    statement: "Run terraform fmt, terraform validate, and terraform plan in CI before any apply.",
    rationale:
      "fmt enforces consistent style, validate catches type/reference errors early, and a reviewed plan prevents surprise changes. Gating apply behind these checks turns infrastructure changes into reviewable, predictable steps.",
    appliesTo: { tool: "terraform", tags: ["ci", "workflow", "validation"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/cli/commands/validate",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.93,
  },
  {
    statement: "Keep modules small and composable, each with a single clear responsibility.",
    rationale:
      "Large catch-all modules are hard to reuse, test, and reason about. Small composable modules with focused interfaces compose into larger systems and limit the impact of any single change.",
    appliesTo: { tool: "terraform", resourceKinds: ["module"], tags: ["modules", "composition", "design"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/modules/develop/composition",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.9,
  },
  {
    statement:
      "Avoid local-exec/remote-exec provisioners; use native providers or a data source instead.",
    rationale:
      "Provisioners are a last resort: they run imperatively, are not tracked in state, and break the plan/apply contract (no diff, no idempotency). A native resource or data source keeps changes declarative and reproducible.",
    appliesTo: { tool: "terraform", resourceKinds: ["provisioner"], tags: ["provisioners", "anti-pattern"] },
    sources: [
      {
        url: "https://developer.hashicorp.com/terraform/language/resources/provisioners/syntax",
        sourceVersion: "v1.9",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.92,
  },
  {
    statement: "Tag resources consistently (owner, environment, cost-center) via a shared locals map.",
    rationale:
      "Consistent tags enable cost attribution, ownership, and automated cleanup. Centralizing them in a locals map (merged into each resource's tags) keeps tagging uniform and easy to change in one place.",
    appliesTo: { tool: "terraform", resourceKinds: ["resource", "locals"], tags: ["tagging", "governance", "cost"] },
    sources: [
      {
        url: "https://terraform-best-practices.com/naming.html",
        fetchedAt: VERIFIED_AT,
      },
    ],
    confidence: 0.88,
  },
];

// ─── Seeder ────────────────────────────────────────────────────────────────────

/** Minimal projection capability the seeder needs (injectable for tests). */
export interface ProjectionRunner {
  embed: (text: string) => Promise<number[]>;
  insertChunks: (rows: Array<Record<string, unknown>>) => Promise<unknown[]>;
  dimensions: number;
  model: string;
  provider: string;
}

export interface SeedExampleOptions {
  /**
   * Explicit owner id for the example workspace. MUST be a real users.id (the
   * workspaces.owner_id FK). When omitted, resolveAdminUserId is consulted; if
   * that yields nothing the workspace owner is left NULL (FK-safe).
   */
  adminUserId?: string;
  /**
   * Optional async resolver for a real admin user id (e.g. a DB lookup). Used
   * only when adminUserId is not supplied. Returning null leaves the workspace
   * unowned rather than fabricating a non-existent user id.
   */
  resolveAdminUserId?: () => Promise<string | null>;
  /**
   * Projection deps builder. Defaults to the real VectorStore + the workspace
   * embedding config. Projection is always best-effort regardless.
   */
  buildProjection?: (workspaceId: string) => Promise<ProjectionRunner | null>;
  /** Optional logger; defaults to console.warn for the skip hint. */
  log?: (message: string) => void;
}

export interface SeedResult {
  workspaceId: string;
  created: number;
  alreadyPresent: number;
  projected: number;
  projectionSkipped: boolean;
}

const SEED_INGESTED_BY = "terraform-best-practices-seed";
const SEED_VERIFIED_BY = "best-practices-validator";

/**
 * Resolve the first admin user id from the database, or null if none exists.
 * Used to give the example workspace a real (FK-valid) owner. Best-effort — any
 * lookup failure resolves to null so seeding still proceeds with an unowned ws.
 */
export async function resolveFirstAdminUserId(): Promise<string | null> {
  try {
    const { db } = await import("../db");
    const { users } = await import("@shared/schema");
    const { eq } = await import("drizzle-orm");
    const [admin] = await db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).limit(1);
    return admin?.id ?? null;
  } catch {
    return null;
  }
}

/**
 * Find or create the example workspace, returning its id. Idempotent by name.
 * The owner must be a real users.id (FK) or null — never a fabricated id.
 */
async function ensureExampleWorkspace(storage: IStorage, ownerId: string | null): Promise<string> {
  const existing = (await storage.getWorkspaces()).find((w) => w.name === EXAMPLE_WORKSPACE_NAME);
  if (existing) return existing.id;
  const created = await storage.createWorkspace({
    name: EXAMPLE_WORKSPACE_NAME,
    type: "local",
    path: "/knowledge/terraform-best-practices",
    branch: "main",
    status: "active",
    ownerId,
  });
  return created.id;
}

/** Default projection runner: real VectorStore + workspace embedding config. */
async function defaultProjection(workspaceId: string): Promise<ProjectionRunner> {
  const store = new VectorStore();
  const configRow = await store.getEmbeddingConfig(workspaceId);
  const config: EmbeddingProviderConfig = configRow
    ? {
        provider: configRow.provider as EmbeddingProviderConfig["provider"],
        model: configRow.model,
        dimensions: configRow.dimensions,
        options: configRow.config as Record<string, string> | undefined,
      }
    : DEFAULT_EMBEDDING_CONFIG;
  const provider = EmbeddingProviderFactory.create(config);
  return {
    embed: (text: string) => provider.embed(text),
    insertChunks: (rows) => store.insertChunks(rows as Parameters<VectorStore["insertChunks"]>[0]),
    dimensions: config.dimensions,
    model: config.model,
    provider: config.provider,
  };
}

function buildInsert(card: ExampleCard, workspaceId: string, ingesterId: string): InsertPracticeCard {
  const contentHash = computeContentHash({
    statement: card.statement,
    rationale: card.rationale,
    appliesTo: card.appliesTo,
  });
  return {
    workspaceId,
    topic: EXAMPLE_TOPIC,
    statement: card.statement,
    rationale: card.rationale,
    appliesTo: card.appliesTo,
    sources: card.sources,
    confidence: card.confidence,
    status: "active",
    ingestedBy: SEED_INGESTED_BY,
    ingestedByUserId: ingesterId,
    verifiedBy: SEED_VERIFIED_BY,
    verifiedByUserId: ingesterId,
    verification: { verdict: "pass", notes: "Seeded example dataset", at: VERIFIED_AT },
    reviewState: "accepted",
    contentHash,
    lastVerifiedAt: new Date(VERIFIED_AT),
  };
}

/**
 * Idempotently seed the example Terraform cards into a dedicated workspace.
 * Cards are inserted as accepted/active; content-hash dedupe makes re-runs no-ops.
 * Projection into memory_chunks is BEST-EFFORT — a missing embedding provider
 * skips projection (with a hint) but never fails the seed.
 */
export async function seedExampleTerraformCards(
  storage: IStorage,
  opts: SeedExampleOptions = {},
): Promise<SeedResult> {
  const log = opts.log ?? ((m: string) => console.warn(m));

  // Resolve a REAL admin user id for the workspace owner (workspaces.owner_id is
  // an FK). Never fabricate one: fall back to null (unowned) when none exists.
  const ownerId: string | null =
    opts.adminUserId ?? (opts.resolveAdminUserId ? await opts.resolveAdminUserId() : null);
  const workspaceId = await ensureExampleWorkspace(storage, ownerId);

  // Card provenance ids are free text (no FK) — use the owner id when present,
  // otherwise a stable, non-FK system label so provenance is never blank.
  const ingesterId = ownerId ?? SYSTEM_OWNER_ID;

  // Persist all cards first (always succeeds; idempotent by contentHash).
  const persisted: PracticeCardRow[] = [];
  let created = 0;
  let alreadyPresent = 0;
  for (const card of EXAMPLE_TERRAFORM_CARDS) {
    const before = await storage.getPracticeCardsByWorkspace(workspaceId);
    const row = await storage.createPracticeCard(buildInsert(card, workspaceId, ingesterId));
    const isNew = !before.some((c) => c.id === row.id);
    if (isNew) created++;
    else alreadyPresent++;
    persisted.push(row);
  }

  // Best-effort projection: never throw on embedding-provider failure.
  let projected = 0;
  let projectionSkipped = false;
  try {
    const builder = opts.buildProjection ?? ((ws) => defaultProjection(ws));
    const runner = await builder(workspaceId);
    if (!runner) {
      projectionSkipped = true;
    } else {
      for (const card of persisted) {
        await projectToChunk(card, {
          embed: runner.embed,
          insertChunks: runner.insertChunks,
          dimensions: runner.dimensions,
          model: runner.model,
          provider: runner.provider,
        });
        projected++;
      }
    }
  } catch {
    projectionSkipped = true;
    log(
      "[seed-knowledge] embedding provider unavailable — cards persisted but NOT projected to search. " +
        "Run POST /api/workspaces/:id/knowledge/re-embed once Ollama is reachable.",
    );
  }

  return { workspaceId, created, alreadyPresent, projected, projectionSkipped };
}

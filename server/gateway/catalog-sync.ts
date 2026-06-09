/**
 * Model catalog reconciliation.
 *
 * The DB model catalog (storage.getModels / getActiveModels) is the source of
 * truth for every UI surface that does NOT talk to /api/providers/discover
 * directly: the Workspace chat + review selectors, the MultiAgentPipeline,
 * the ManagerConfigPanel, the Dashboard, and the Settings "Registered Models"
 * list. Historically it was seeded with stale DEFAULT_MODELS (local vllm/ollama
 * stand-ins + an xai model) that no longer correspond to anything runnable.
 *
 * `reconcileModelCatalog` aligns that catalog with the LIVE provider-discovered
 * models (already gated by VISIBLE_PROVIDER_KEYS via Gateway.discoverModels):
 *   - discovered models are upserted by slug and marked active;
 *   - every existing catalog model whose provider is NOT on the visibility
 *     allowlist, OR whose slug is no longer discovered, is DEACTIVATED.
 *
 * Models are deactivated (isActive=false), never deleted, so pipeline stage
 * slugs still resolve via storage.getModelBySlug.
 *
 * It is best-effort and never throws: if discovery fails or yields no visible
 * models we do NOT wipe the catalog, but we STILL deactivate non-allowlisted
 * models so the fake local/xai entries disappear regardless.
 */
import type { IStorage } from "../storage";
import type { InsertModel } from "@shared/schema";
import { VISIBLE_PROVIDER_KEYS } from "./index";

const DEFAULT_CONTEXT_LIMIT = 4096;

/** Per-provider discover payload shape returned by Gateway.discoverModels(). */
interface DiscoverGroup {
  available: boolean;
  models: unknown[];
  error?: string;
}
type DiscoverResult = Record<string, DiscoverGroup>;

/** The minimal gateway surface this module needs (eases testing). */
export interface CatalogSyncGateway {
  discoverModels(): Promise<DiscoverResult>;
}

export interface ReconcileResult {
  upserted: number;
  deactivated: number;
}

/** A discovered model, normalized to the fields we persist. */
interface NormalizedModel {
  slug: string;
  name: string;
  provider: string;
  modelId?: string;
  contextLimit: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Narrow one raw discovered entry into a NormalizedModel, or null if unusable. */
function normalizeEntry(raw: unknown): NormalizedModel | null {
  if (!isRecord(raw)) return null;
  const slug = typeof raw.slug === "string" && raw.slug
    ? raw.slug
    : typeof raw.id === "string" && raw.id
      ? raw.id
      : null;
  if (!slug) return null;

  const name = typeof raw.name === "string" && raw.name ? raw.name : slug;
  const provider = typeof raw.provider === "string" && raw.provider ? raw.provider : "";
  const modelId = typeof raw.modelId === "string" && raw.modelId ? raw.modelId : undefined;
  const contextLimit =
    typeof raw.contextLimit === "number" && raw.contextLimit > 0
      ? raw.contextLimit
      : DEFAULT_CONTEXT_LIMIT;

  return { slug, name, provider, modelId, contextLimit };
}

/** Flatten the per-provider discover payload into a deduped list (by slug). */
function flattenDiscovered(payload: DiscoverResult): NormalizedModel[] {
  const seen = new Set<string>();
  const out: NormalizedModel[] = [];
  for (const group of Object.values(payload)) {
    if (!group?.available || !Array.isArray(group.models)) continue;
    for (const raw of group.models) {
      const model = normalizeEntry(raw);
      if (!model || seen.has(model.slug)) continue;
      seen.add(model.slug);
      out.push(model);
    }
  }
  return out;
}

/** Best-effort discovery: returns [] (never throws) when the gateway fails. */
async function safeDiscover(gateway: CatalogSyncGateway): Promise<NormalizedModel[]> {
  try {
    const payload = await gateway.discoverModels();
    return flattenDiscovered(payload);
  } catch {
    return [];
  }
}

function toInsert(model: NormalizedModel): InsertModel {
  return {
    name: model.name,
    slug: model.slug,
    provider: model.provider,
    modelId: model.modelId,
    contextLimit: model.contextLimit,
    capabilities: [],
    isActive: true,
  };
}

/**
 * Reconcile the DB model catalog with the live discovered models.
 * Never throws — discovery failures degrade gracefully.
 */
export async function reconcileModelCatalog(
  storage: IStorage,
  gateway: CatalogSyncGateway,
): Promise<ReconcileResult> {
  const discovered = await safeDiscover(gateway);
  const discoveredSlugs = new Set(discovered.map((m) => m.slug));
  const discoveryAvailable = discovered.length > 0;

  let upserted = 0;
  for (const model of discovered) {
    await storage.upsertModelBySlug(toInsert(model));
    upserted += 1;
  }

  // Deactivate stale catalog rows. A model is stale when its provider is not on
  // the visibility allowlist, OR (only when discovery succeeded) its slug is no
  // longer discovered. When discovery is unavailable we cannot judge allowlisted
  // models, so we leave them untouched to avoid wiping the catalog.
  let deactivated = 0;
  const existing = await storage.getModels();
  for (const model of existing) {
    if (!model.isActive) continue;
    const providerHidden = !VISIBLE_PROVIDER_KEYS.has(model.provider);
    const slugDropped = discoveryAvailable && !discoveredSlugs.has(model.slug);
    if (providerHidden || slugDropped) {
      await storage.updateModel(model.id, { isActive: false });
      deactivated += 1;
    }
  }

  return { upserted, deactivated };
}

// ─── Existing-pipeline stage reconcile ───────────────────────────────────────

/** Fallback slug applied to stages that point at a dead/inactive model. */
const FALLBACK_STAGE_SLUG = "claude-sonnet";

export interface PipelineStageReconcileResult {
  pipelinesUpdated: number;
  stagesRepointed: number;
}

/** Narrow a jsonb stage entry enough to read/repoint its `modelSlug`. */
function isStageRecord(value: unknown): value is Record<string, unknown> & { modelSlug?: unknown } {
  return typeof value === "object" && value !== null;
}

/**
 * Re-point any EXISTING pipeline stage whose `modelSlug` no longer resolves to an
 * active model onto a working default (`claude-sonnet`). Runs against an already
 * populated DB so previously seeded pipelines stop selecting dead local/xai models.
 *
 * Best-effort: never throws, never blocks boot. When the fallback slug itself is
 * not active (e.g. discovery unavailable), it does nothing rather than guess.
 */
export async function reconcileExistingPipelineStages(
  storage: IStorage,
): Promise<PipelineStageReconcileResult> {
  let pipelinesUpdated = 0;
  let stagesRepointed = 0;
  try {
    const activeModels = await storage.getActiveModels();
    const activeSlugs = new Set(activeModels.map((m) => m.slug));
    // Only repoint if we actually have a working fallback to point at.
    if (!activeSlugs.has(FALLBACK_STAGE_SLUG)) {
      return { pipelinesUpdated, stagesRepointed };
    }

    const pipelines = await storage.getPipelines();
    for (const pipeline of pipelines) {
      const stages = pipeline.stages;
      if (!Array.isArray(stages)) continue;

      let changedInPipeline = 0;
      const nextStages = stages.map((stage) => {
        if (!isStageRecord(stage)) return stage;
        const slug = stage.modelSlug;
        if (typeof slug !== "string" || activeSlugs.has(slug)) return stage;
        changedInPipeline += 1;
        return { ...stage, modelSlug: FALLBACK_STAGE_SLUG };
      });

      if (changedInPipeline > 0) {
        await storage.updatePipeline(pipeline.id, { stages: nextStages });
        pipelinesUpdated += 1;
        stagesRepointed += changedInPipeline;
      }
    }
  } catch {
    // Swallow: this is a best-effort startup convenience, never a boot blocker.
  }
  return { pipelinesUpdated, stagesRepointed };
}

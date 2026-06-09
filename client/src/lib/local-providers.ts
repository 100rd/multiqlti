/**
 * Shared, framework-agnostic logic for de-emphasising local model providers
 * (vLLM / Ollama / LM Studio). See GitHub issue #346.
 *
 * Local providers are slow for real pipelines, so they are:
 *   - OFF by default (only active once an endpoint is configured), and
 *   - hidden behind a collapsible block that is COLLAPSED by default.
 *
 * Keeping this logic in one pure module makes the behaviour unit-testable
 * without rendering React, and gives the UI a single source of truth.
 */

/** Provider keys treated as "local / experimental" and de-emphasised in the UI. */
export const LOCAL_PROVIDER_KEYS = ["vllm", "ollama", "lmstudio"] as const;

export type LocalProviderKey = (typeof LOCAL_PROVIDER_KEYS)[number];

/** Label for the collapsible block that hides local model providers. */
export const LOCAL_MODELS_SECTION_TITLE = "Локальные модели (экспериментально)";

/**
 * The local-models block is collapsed on a clean install. Persisted user
 * preference (handled by SettingsSection's localStorage) can still override
 * this at runtime — this constant only controls the first-run default.
 */
export const LOCAL_MODELS_SECTION_DEFAULT_OPEN = false;

/** Subset of gateway status fields used to decide local-provider activity. */
export interface LocalProviderActivity {
  vllm?: boolean;
  ollama?: boolean;
  lmstudio?: boolean;
}

/** True when `provider` is one of the de-emphasised local providers. */
export function isLocalProvider(provider: string): provider is LocalProviderKey {
  return (LOCAL_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/**
 * True when at least one local provider is active (i.e. an endpoint has been
 * configured and the provider registered). On a clean install this is false,
 * so no local model is pre-selected in the default model picker.
 */
export function hasActiveLocalProvider(status: LocalProviderActivity | null | undefined): boolean {
  if (!status) return false;
  return LOCAL_PROVIDER_KEYS.some((key) => status[key] === true);
}

/** Cloud provider keys that stay prominent in the UI (Claude / Gemini / Grok). */
export const CLOUD_PROVIDER_KEYS = ["anthropic", "google", "xai"] as const;

/** True when `provider` is a prominent cloud provider. */
export function isCloudProvider(provider: string): boolean {
  return (CLOUD_PROVIDER_KEYS as readonly string[]).includes(provider);
}

/**
 * Provider keys currently SURFACED to model pickers / catalogues. Mirrors the
 * server-side VISIBLE_PROVIDER_KEYS allowlist (server/gateway/index.ts): only
 * the subscription-CLI providers — Claude ("anthropic"), Antigravity, and the
 * Antigravity "google" mirror. Local providers (vllm/ollama/lmstudio) and the
 * billed cloud APIs (xai, Gemini API) are hidden until properly wired up.
 *
 * Used by client surfaces that build a model list from a static source instead
 * of the (already server-filtered) /api/models endpoints.
 */
export const VISIBLE_PROVIDER_KEYS = ["anthropic", "antigravity", "google"] as const;

/** True when `provider` is on the visible-provider allowlist. */
export function isVisibleProvider(provider: string): boolean {
  return (VISIBLE_PROVIDER_KEYS as readonly string[]).includes(provider);
}

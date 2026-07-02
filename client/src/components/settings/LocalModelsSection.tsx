import { Cpu } from "lucide-react";
import { SettingsSection } from "./SettingsSection";
import { LocalModelStatus } from "./LocalModelStatus";
import { LmStudioPanel } from "./LmStudioPanel";
import {
  LOCAL_MODELS_SECTION_TITLE,
  LOCAL_MODELS_SECTION_DEFAULT_OPEN,
} from "@/lib/local-providers";

interface LocalModelsSectionProps {
  /** Whether the vLLM provider is currently active. */
  vllmActive: boolean;
  /** Configured vLLM endpoint, or null when unset. */
  vllmEndpoint: string | null;
  /** Whether the Ollama provider is currently active. */
  ollamaActive: boolean;
  /** Configured Ollama endpoint, or null when unset. */
  ollamaEndpoint: string | null;
}

/**
 * Collapsible, collapsed-by-default block that hides the de-emphasised local
 * providers (vLLM / Ollama / LM Studio). Cloud providers stay prominent in
 * their own always-open section. Saved endpoints are never deleted here — they
 * are simply tucked away until the user expands and enables them. See #346.
 */
export function LocalModelsSection({
  vllmActive,
  vllmEndpoint,
  ollamaActive,
  ollamaEndpoint,
}: LocalModelsSectionProps) {
  return (
    <SettingsSection
      storageKey="settings-section-local-models"
      title={LOCAL_MODELS_SECTION_TITLE}
      icon={<Cpu className="h-4 w-4" />}
      shortDescription="vLLM, Ollama, and LM Studio — slow, disabled by default."
      longDescription="Local providers (vLLM, Ollama, LM Studio) stay inactive until an endpoint is set. They are tucked under this section so they don't clutter the cloud models. Saved endpoints are not deleted — expand this section and enable a provider to restore the previous behavior."
      defaultOpen={LOCAL_MODELS_SECTION_DEFAULT_OPEN}
    >
      <div className="divide-y divide-border">
        <div className="p-4">
          <LocalModelStatus
            vllm={{
              active: vllmActive,
              endpoint: vllmEndpoint,
              name: "vLLM",
              envVar: "VLLM_ENDPOINT",
            }}
            ollama={{
              active: ollamaActive,
              endpoint: ollamaEndpoint,
              name: "Ollama",
              envVar: "OLLAMA_ENDPOINT",
            }}
          />
        </div>
        <LmStudioPanel />
      </div>
    </SettingsSection>
  );
}

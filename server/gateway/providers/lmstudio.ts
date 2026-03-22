import { OpenAICompatibleProvider } from "./openai-compatible";

export interface LmStudioModel {
  id: string;
  name: string;
  provider: "lmstudio";
  owned_by?: string;
}

/**
 * LM Studio provider — thin wrapper over OpenAICompatibleProvider.
 *
 * LM Studio exposes a fully OpenAI-compatible API on localhost:1234 by default.
 * No API key is required. Timeout is set higher (60 s) because local models
 * can be slower to respond, especially on first inference.
 */
export class LmStudioProvider extends OpenAICompatibleProvider {
  constructor(baseUrl = "http://localhost:1234") {
    super(baseUrl, null, 60_000);
  }

  /** Expose the endpoint URL for status display. */
  get endpoint(): string {
    return this.baseUrl;
  }

  /** GET /v1/models — list currently loaded models. */
  async listModels(): Promise<LmStudioModel[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5_000);

    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) {
        throw new Error(
          `LM Studio list models error ${res.status}: ${await res.text()}`,
        );
      }

      const data = (await res.json()) as {
        data: Array<{ id: string; object?: string; owned_by?: string }>;
      };

      return (data.data ?? []).map((m) => ({
        id: m.id,
        name: m.id,
        provider: "lmstudio" as const,
        owned_by: m.owned_by,
      }));
    } catch (err) {
      clearTimeout(timeoutId);
      const e = err as Error;
      if (e.name === "AbortError") {
        throw new Error("LM Studio is not reachable (timeout)");
      }
      throw e;
    }
  }

  /** Quick health check — tries to reach /v1/models with a short timeout. */
  async healthCheck(): Promise<boolean> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3_000);

    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res.ok;
    } catch {
      clearTimeout(timeoutId);
      return false;
    }
  }
}

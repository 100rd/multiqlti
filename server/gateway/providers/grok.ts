import { OpenAICompatibleProvider } from "./openai-compatible";

const XAI_BASE_URL = "https://api.x.ai";

export class GrokProvider extends OpenAICompatibleProvider {
  constructor(apiKey: string) {
    // xAI uses standard Bearer auth; base URL is fixed
    super(XAI_BASE_URL, apiKey);
  }
  // complete() and stream() are fully inherited from OpenAICompatibleProvider.
  // No overrides needed — xAI's API is OpenAI-wire-compatible.
}

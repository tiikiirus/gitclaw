import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_OPENROUTER_MODEL = "meta-llama/llama-3.1-8b-instruct:free";

// OpenRouter free models - 50 req/day per model, separate quota per model family
const OPENROUTER_MODEL_SCORES: Record<string, { planning: number; coding: number; review: number }> = {
  "meta-llama/llama-3.1-8b-instruct:free": { planning: 80, coding: 82, review: 85 },
  "qwen/qwen-2.5-7b-instruct:free": { planning: 78, coding: 84, review: 83 },
  "deepseek/deepseek-r1:free": { planning: 84, coding: 87, review: 86 },
  "google/gemma-2-9b-it:free": { planning: 76, coding: 80, review: 81 },
  "mistralai/mistral-7b-instruct:free": { planning: 74, coding: 78, review: 80 },
};

function isOpenRouterModel(modelId: string): boolean {
  return modelId in OPENROUTER_MODEL_SCORES;
}

export class OpenRouterAdapter implements ProviderAdapter {
  id = "openrouter";
  name = "openrouter";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.OPENROUTER_API_KEY,
      env.OPENROUTER_API_KEY_BACKUP,
      env.OPENROUTER_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    return Object.entries(OPENROUTER_MODEL_SCORES).map(([modelId, scores]) => ({
      id: modelId,
      providerId: this.id,
      providerName: modelId,
      pricing: { prompt: 0, completion: 0 },
      supportsVision: false,
      contextLength: 131072,
      scores,
    }));
  }

  prepareRequest(
    modelId: string,
    originalBody: Record<string, unknown>,
    env: Record<string, unknown>,
    key?: string
  ): RequestConfig | null {
    const keys = this.getKeys(env);
    if (keys.length === 0) return null;

    const configuredModel = ((env.OPENROUTER_MODEL as string) || "").trim() || DEFAULT_OPENROUTER_MODEL;
    const requestedModel = !modelId || modelId === "auto" ? configuredModel : modelId;

    if (!isOpenRouterModel(requestedModel)) return null;

    const baseUrl = ((env.OPENROUTER_BASE_URL as string) || DEFAULT_OPENROUTER_BASE_URL).trim().replace(/\/+$/, "");
    const chatBase = baseUrl.toLowerCase().endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    return {
      url: `${chatBase}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key || keys[0]}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/tiikiirus/gitclaw",
        "X-Title": "Gitclaw AI Reviewer",
      },
      body: { ...originalBody, model: requestedModel },
    };
  }

  isSuccess(response: Response): boolean {
    return response.ok;
  }
}

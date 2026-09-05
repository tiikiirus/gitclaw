import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_GROQ_MODEL = "llama-3.1-8b-instant";

// Groq free tier models - fast LPU inference, 14k req/day, 30 req/min per model
// Scores tuned for review (critical findings, not generic praise)
const GROQ_MODEL_SCORES: Record<string, { planning: number; coding: number; review: number }> = {
  "llama-3.1-8b-instant": { planning: 82, coding: 85, review: 88 },
  "llama-3.1-70b-versatile": { planning: 88, coding: 86, review: 90 },
  "mixtral-8x7b-32768": { planning: 80, coding: 82, review: 85 },
  "qwen2.5-32b": { planning: 84, coding: 86, review: 87 },
  "gemma2-9b-it": { planning: 78, coding: 80, review: 82 },
};

function isGroqModel(modelId: string): boolean {
  return modelId in GROQ_MODEL_SCORES;
}

export class GroqAdapter implements ProviderAdapter {
  id = "groq";
  name = "groq";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.GROQ_API_KEY,
      env.GROQ_API_KEY_BACKUP,
      env.GROQ_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    return Object.entries(GROQ_MODEL_SCORES).map(([modelId, scores]) => ({
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

    const configuredModel = ((env.GROQ_MODEL as string) || "").trim() || DEFAULT_GROQ_MODEL;
    const requestedModel = !modelId || modelId === "auto" ? configuredModel : modelId;

    if (!isGroqModel(requestedModel)) return null;

    const baseUrl = ((env.GROQ_BASE_URL as string) || DEFAULT_GROQ_BASE_URL).trim().replace(/\/+$/, "");
    const chatBase = baseUrl.toLowerCase().endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;

    return {
      url: `${chatBase}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key || keys[0]}`,
        "Content-Type": "application/json",
      },
      body: { ...originalBody, model: requestedModel },
    };
  }

  isSuccess(response: Response): boolean {
    return response.ok;
  }
}

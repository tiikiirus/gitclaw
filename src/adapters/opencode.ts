import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
const DEFAULT_OPENCODE_MODEL = "hy3-free";

const FREE_MODEL_SCORES: Record<
  string,
  { planning: number; coding: number; review: number }
> = {
  "hy3-free": { planning: 92, coding: 86, review: 91 },
  "laguna-s-2.1-free": { planning: 84, coding: 91, review: 89 },
  "deepseek-v4-flash-free": { planning: 84, coding: 89, review: 87 },
  "mimo-v2.5-free": { planning: 80, coding: 84, review: 82 },
  "nemotron-3-ultra-free": { planning: 83, coding: 82, review: 81 },
  "nemotron-3.5-lightning-free": {
    planning: 76,
    coding: 79,
    review: 77,
  },
  "big-pickle": { planning: 70, coding: 72, review: 70 },
};

function isFreeOpenCodeModel(modelId: string): boolean {
  return (
    modelId === "big-pickle" ||
    (!modelId.includes("/") && modelId.endsWith("-free"))
  );
}

export class OpenCodeAdapter implements ProviderAdapter {
  id = "opencode";
  name = "opencode";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.OPENCODE_API_KEY,
      env.OPENCODE_API_KEY_BACKUP,
      env.OPENCODE_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    let modelIds = Object.keys(FREE_MODEL_SCORES);
    try {
      const response = await fetch(`${this.baseUrl(env)}/models`, {
        headers: { Authorization: `Bearer ${this.getKeys(env)[0]}` },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) {
        const payload = (await response.json()) as {
          data?: Array<{ id?: unknown }>;
        };
        const discovered = (payload.data || [])
          .map((model) => model.id)
          .filter((id): id is string => typeof id === "string")
          .filter(isFreeOpenCodeModel);
        if (discovered.length > 0) modelIds = discovered;
      }
    } catch (error) {
      console.warn(
        "[OpenCode] Model discovery failed; using free fallback list",
        error
      );
    }

    return modelIds.map((modelId) => ({
      id: modelId,
      providerId: this.id,
      providerName: modelId,
      pricing: { prompt: 0, completion: 0 },
      supportsVision: false,
      contextLength: 131072,
      scores: FREE_MODEL_SCORES[modelId] || {
        planning: 70,
        coding: 75,
        review: 72,
      },
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

    const configuredModel =
      ((env.OPENCODE_MODEL as string) || "").trim() || DEFAULT_OPENCODE_MODEL;
    const requestedModel =
      !modelId || modelId === "auto" ? configuredModel : modelId;
    if (!isFreeOpenCodeModel(requestedModel)) return null;

    return {
      url: `${this.baseUrl(env)}/chat/completions`,
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

  private baseUrl(env: Record<string, unknown>): string {
    const value = (
      (env.OPENCODE_BASE_URL as string) || DEFAULT_OPENCODE_BASE_URL
    )
      .trim()
      .replace(/\/+$/, "");
    return value.toLowerCase().endsWith("/v1") ? value : `${value}/v1`;
  }
}

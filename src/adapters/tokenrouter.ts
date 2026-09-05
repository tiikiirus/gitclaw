import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_TOKENROUTER_MODEL = "z-ai/glm-5.3-free";
const DEFAULT_TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";

export class TokenRouterAdapter implements ProviderAdapter {
  id = "tokenrouter";
  name = "tokenrouter";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.TOKENROUTER_API_KEY,
      env.TOKENROUTER_API_KEY_BACKUP,
      env.TOKENROUTER_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    const model =
      ((env.TOKENROUTER_MODEL as string) || "").trim() ||
      DEFAULT_TOKENROUTER_MODEL;
    return [
      {
        id: model,
        providerId: this.id,
        providerName: model,
        pricing: { prompt: 0, completion: 0 },
        supportsVision: false,
        contextLength: 131072,
        scores: { planning: 82, coding: 86, review: 88 },
      },
    ];
  }

  prepareRequest(
    modelId: string,
    originalBody: Record<string, unknown>,
    env: Record<string, unknown>,
    key?: string,
  ): RequestConfig | null {
    const keys = this.getKeys(env);
    if (keys.length === 0) return null;

    const configuredModel =
      ((env.TOKENROUTER_MODEL as string) || "").trim() ||
      DEFAULT_TOKENROUTER_MODEL;
    const requestedModel =
      !modelId || modelId === "auto" ? configuredModel : modelId;

    // TokenRouter is configured for a single model (TOKENROUTER_MODEL, e.g.
    // z-ai/glm-5.3-free). Reject anything else — models like hy3-free or
    // laguna-s-2.1-free belong to OpenCode Zen and only 403 here.
    if (requestedModel !== configuredModel) return null;

    const baseUrl = (
      ((env.TOKENROUTER_BASE_URL as string) ||
        DEFAULT_TOKENROUTER_BASE_URL) as string
    )
      .trim()
      .replace(/\/+$/, "");
    const chatBase = baseUrl.toLowerCase().endsWith("/v1")
      ? baseUrl
      : `${baseUrl}/v1`;

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

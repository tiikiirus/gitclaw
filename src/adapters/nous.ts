import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_NOUS_BASE_URL = "https://inference-api.nousresearch.com/v1";
const DEFAULT_NOUS_MODEL = "stepfun/step-3.7-flash:free";

const NOUS_MODEL_SCORES: Record<
  string,
  { planning: number; coding: number; review: number }
> = {
  "stepfun/step-3.7-flash:free": { planning: 86, coding: 84, review: 87 },
  "poolside/laguna-xs-2.1:free": { planning: 82, coding: 88, review: 86 },
  "z-ai/glm-5.3-flash:free": { planning: 80, coding: 82, review: 83 },
  "minimax/minimax-m3:free": { planning: 78, coding: 80, review: 81 },
};

function isNousModel(modelId: string): boolean {
  return modelId.endsWith(":free") && modelId.includes("/");
}

export class NousAdapter implements ProviderAdapter {
  id = "nous";
  name = "nous";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.NOUS_API_KEY,
      env.NOUS_API_KEY_BACKUP,
      env.NOUS_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    let modelIds = Object.keys(NOUS_MODEL_SCORES);
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
          .filter(isNousModel);
        if (discovered.length > 0) modelIds = discovered;
      }
    } catch (error) {
      console.warn(
        "[Nous] Model discovery failed; using configured fallback list",
        error,
      );
    }

    return modelIds.map((modelId) => ({
      id: modelId,
      providerId: this.id,
      providerName: modelId,
      pricing: { prompt: 0, completion: 0 },
      supportsVision: false,
      contextLength: 131072,
      scores: NOUS_MODEL_SCORES[modelId] || {
        planning: 75,
        coding: 75,
        review: 75,
      },
    }));
  }

  prepareRequest(
    modelId: string | undefined,
    originalBody: Record<string, unknown>,
    env: Record<string, unknown>,
    key?: string,
  ): RequestConfig | null {
    const keys = this.getKeys(env);
    if (keys.length === 0) return null;
    const configuredModel =
      (env.NOUS_MODEL as string | undefined)?.trim() || DEFAULT_NOUS_MODEL;
    const requestedModel =
      !modelId || modelId === "auto" ? configuredModel : modelId;
    if (!isNousModel(requestedModel)) return null;
    const chatBase = this.baseUrl(env).replace(/\/+$/, "");
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

  baseUrl(env: Record<string, unknown>): string {
    return (
      ((env.NOUS_BASE_URL as string | undefined)?.trim() ||
        DEFAULT_NOUS_BASE_URL)
    );
  }
}

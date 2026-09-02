import { ModelInfo, ProviderAdapter, RequestConfig } from "./types";

const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
const DEFAULT_MISTRAL_MODEL = "mistral-small-latest";

// Known Mistral model families (verified against /v1/models on this key). The
// adapter serves exactly these — anything else (qwen, hy3-free, ...) belongs
// to another provider.
const MISTRAL_MODEL_SCORES: Record<
  string,
  { planning: number; coding: number; review: number }
> = {
  // Scores verified empirically (2026-08-17, head-to-head on real PR diffs
  // #57/#59): mistral-small-latest produced concrete, actionable findings,
  // codestral-latest only generic praise — it is a code-completion model, not
  // a critical reviewer. The review scores below order the PASS-2 fallback.
  "mistral-large-latest": { planning: 90, coding: 84, review: 89 },
  "mistral-small-latest": { planning: 80, coding: 82, review: 87 },
  "mistral-medium-latest": { planning: 78, coding: 80, review: 82 },
  "codestral-latest": { planning: 74, coding: 90, review: 82 },
  "devstral-latest": { planning: 76, coding: 88, review: 86 },
  "magistral-small-latest": { planning: 82, coding: 78, review: 80 },
  "ministral-14b-latest": { planning: 72, coding: 76, review: 78 },
  "ministral-8b-latest": { planning: 70, coding: 74, review: 76 },
  "ministral-3b-latest": { planning: 62, coding: 68, review: 70 },
  "voxtral-small-latest": { planning: 85, coding: 78, review: 80 },
};

const VISION_MODELS = new Set(["voxtral-small-latest"]);

function isMistralModel(modelId: string): boolean {
  return modelId in MISTRAL_MODEL_SCORES;
}

export class MistralAdapter implements ProviderAdapter {
  id = "mistral";
  name = "mistral";
  enabled = true;

  getKeys(env: Record<string, unknown>): string[] {
    return [
      env.MISTRAL_API_KEY,
      env.MISTRAL_API_KEY_BACKUP,
      env.MISTRAL_API_KEYS,
    ]
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => value.split(","))
      .map((key) => key.trim())
      .filter(Boolean);
  }

  async fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    if (this.getKeys(env).length === 0) return [];
    return Object.entries(MISTRAL_MODEL_SCORES).map(([modelId, scores]) => ({
      id: modelId,
      providerId: this.id,
      providerName: modelId,
      pricing: null, // paid API — unknown per-token pricing
      supportsVision: VISION_MODELS.has(modelId),
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

    const configuredModel =
      ((env.MISTRAL_MODEL as string) || "").trim() || DEFAULT_MISTRAL_MODEL;
    const requestedModel =
      !modelId || modelId === "auto" ? configuredModel : modelId;

    // Mistral only serves its own model families; reject the others so they
    // cascade to the provider that owns them instead of 404ing here.
    if (!isMistralModel(requestedModel)) return null;

    const baseUrl = (
      ((env.MISTRAL_BASE_URL as string) || DEFAULT_MISTRAL_BASE_URL) as string
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

// === Types for provider adapter architecture ===

export interface Pricing {
  prompt: number; // USD per 1K tokens
  completion: number;
}

export interface ModelInfo {
  id: string; // Internal name: 'claude-opus-4-8'
  providerId: string; // Which provider can serve this: 'tokenrouter' | 'opencode'
  providerName: string; // Provider-specific name: 'anthropic/claude-opus-4-8'
  pricing: Pricing | null; // null = unknown; {prompt:0,completion:0} = free
  supportsVision: boolean;
  contextLength: number;
  scores: {
    planning: number; // 0-100
    coding: number;
    review: number;
  };
}

export interface RequestConfig {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface ProviderAdapter {
  id: string;
  name: string;

  /** Whether this provider is configured (has keys, etc.) */
  enabled: boolean;

  /** Fetch available models from provider API (or return static list) */
  fetchModels(env: Record<string, unknown>): Promise<ModelInfo[]>;

  /** Convert internal model ID to provider-specific request */
  prepareRequest(
    modelId: string,
    originalBody: Record<string, unknown>,
    env: Record<string, unknown>,
    key?: string,
  ): RequestConfig | null;

  /** Check if provider response is a success */
  isSuccess(response: Response): boolean;

  /** Get keys for key rotation */
  getKeys(env: Record<string, unknown>): string[];
}

// Short → full name mapping for model IDs (shared across providers)
export const SHORT_TO_FULL: Record<string, string> = {
  "claude-opus-4-8": "anthropic/claude-opus-4-8",
  "claude-opus-4-1": "anthropic/claude-opus-4-1",
  "claude-sonnet-4-6": "anthropic/claude-sonnet-4-6",
  "claude-haiku-4-5": "anthropic/claude-haiku-4-5",
  "deepseek-v4-pro": "deepseek/deepseek-v4-pro",
  "deepseek-v4-flash": "deepseek/deepseek-v4-flash",
  "gemini-3.1-pro": "google/gemini-3.1-pro-preview",
  "gemini-3.5-flash": "google/gemini-3.5-flash",
  "gpt-5.5": "openai/gpt-5.5",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.4-mini": "openai/gpt-5.4-mini",
  "gpt-5.4-nano": "openai/gpt-5.4-nano",
  "gpt-4.1": "openai/gpt-4.1",
  "gpt-oss-120b": "openai/gpt-oss-120b",
  "gpt-5.1-codex-mini": "openai/gpt-5.1-codex-mini",
  "kimi-k2.6": "moonshotai/kimi-k2.6",
  "kimi-k2.5": "moonshotai/kimi-k2.5",
  "glm-5.1": "z-ai/glm-5.1",
  "glm-4.5-air": "z-ai/glm-4.5-air",
  "grok-4.3": "x-ai/grok-4.3",
  o3: "openai/o3",
  "o4-mini": "openai/o4-mini",
  "mini-max-m2.7": "minimax/MiniMax-M2.7",
  "nemotron-3-super": "nvidia/nemotron-3-super-120b-a12b",
  "owl-alpha": "openrouter/owl-alpha",
  "laguna-m.1": "poolside/laguna-m.1",
  "qwq-32b": "qwen/qwq-32b",
};

/** Expand short model name to full provider path */
export function expandModelName(name: string): string {
  if (!name.includes("/") && SHORT_TO_FULL[name]) {
    return SHORT_TO_FULL[name];
  }
  return name;
}

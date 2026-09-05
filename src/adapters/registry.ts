import { ModelInfo } from "./types";
import { GroqAdapter } from "./groq";
import { MistralAdapter } from "./mistral";
import { OpenCodeAdapter } from "./opencode";
import { OpenRouterAdapter } from "./openrouter";
import { TokenRouterAdapter } from "./tokenrouter";

export type Role = "planner" | "coder" | "reviewer" | "default";

/** Provider priority: lower number = tried first */
const PROVIDER_PRIORITY: Record<string, number> = {
  tokenrouter: 0,
  groq: 1,
  openrouter: 2,
  opencode: 3,
  mistral: 4,
};

export class ModelRegistry {
  private adapters = [
    new TokenRouterAdapter(),
    new GroqAdapter(),
    new OpenRouterAdapter(),
    new OpenCodeAdapter(),
    new MistralAdapter(),
  ];

  private cache: { models: ModelInfo[]; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 300_000; // 5 min

  async getModels(env: Record<string, unknown>): Promise<ModelInfo[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < this.CACHE_TTL_MS) {
      return this.cache.models;
    }

    const allModels: ModelInfo[] = [];
    for (const adapter of this.adapters) {
      if (!adapter.enabled) continue;
      const keys = adapter.getKeys(env);
      if (keys.length === 0) continue;
      try {
        const models = await adapter.fetchModels(env);
        allModels.push(...models);
      } catch (err) {
        console.error(`[Registry] ${adapter.name} fetchModels failed:`, err);
      }
    }

    // Deduplicate by ID: prefer highest provider priority
    const seen = new Map<string, ModelInfo>();
    for (const m of allModels) {
      const key = m.id;
      if (!seen.has(key)) {
        seen.set(key, m);
      } else {
        // Keep the one from higher-priority provider
        const existing = seen.get(key)!;
        if (
          PROVIDER_PRIORITY[m.providerId] <
          PROVIDER_PRIORITY[existing.providerId]
        ) {
          seen.set(key, m);
        }
      }
    }

    const models = Array.from(seen.values());
    this.cache = { models, timestamp: now };
    return models;
  }

  /** Get sorted model list for a role, best first */
  async getModelsForRole(
    role: Role,
    env: Record<string, unknown>
  ): Promise<ModelInfo[]> {
    const allModels = await this.getModels(env);
    const scoreKey =
      role === "planner"
        ? "planning"
        : role === "reviewer"
          ? "review"
          : "coding";

    const sorted = [...allModels].sort((a, b) => {
      // 1. Free models first
      const aFree =
        a.pricing && a.pricing.prompt === 0 && a.pricing.completion === 0
          ? 0
          : 1;
      const bFree =
        b.pricing && b.pricing.prompt === 0 && b.pricing.completion === 0
          ? 0
          : 1;
      if (aFree !== bFree) return aFree - bFree;

      // 2. Higher score first
      const aScore = a.scores[scoreKey as keyof typeof a.scores] || 0;
      const bScore = b.scores[scoreKey as keyof typeof b.scores] || 0;
      if (bScore !== aScore) return bScore - aScore;

      // 3. Higher provider priority
      return (
        (PROVIDER_PRIORITY[a.providerId] || 99) -
        (PROVIDER_PRIORITY[b.providerId] || 99)
      );
    });

    return sorted;
  }

  /** Get vision-capable models sorted by role score */
  async getVisionModelsForRole(
    role: Role,
    env: Record<string, unknown>
  ): Promise<ModelInfo[]> {
    const all = await this.getModelsForRole(role, env);
    return all.filter((m) => m.supportsVision);
  }

  /** Find which adapter can serve a specific model */
  findAdapter(providerId: string) {
    return this.adapters.find((a) => a.id === providerId);
  }

  getProviderNames(): string[] {
    return this.adapters
      .filter((adapter) => adapter.enabled)
      .map((adapter) => adapter.id);
  }

  getProviderConfiguration(
    env: Record<string, unknown>
  ): Array<{ id: string; configured: boolean }> {
    return this.adapters
      .filter((adapter) => adapter.enabled)
      .map((adapter) => ({
        id: adapter.id,
        configured: adapter.getKeys(env).length > 0,
      }));
  }

  getAdapterById(id: string) {
    return this.adapters.find((a) => a.id === id);
  }

  /** Invalidate cache (for manual refresh) */
  invalidateCache(): void {
    this.cache = null;
  }
}

/** Singleton */
let _registry: ModelRegistry | null = null;
export function getRegistry(): ModelRegistry {
  if (!_registry) {
    _registry = new ModelRegistry();
  }
  return _registry;
}

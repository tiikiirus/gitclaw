import { ProviderAdapter, RequestConfig } from "./adapters/types";
import { getRegistry, Role } from "./adapters/registry";
import { expandModelName } from "./adapters/types";
import { isEmptyChatCompletion } from "./chat-completions";

export interface RouterResult {
  response: Response | null;
  providerName: string;
  modelName: string;
  errors: string[];
}

const PROVIDER_ORDER = ["tokenrouter", "groq", "openrouter", "opencode", "mistral"];

// In-memory circuit breaker to prevent blindly retrying dead/rate-limited keys.
// Maps a provider+model+key tuple to the timestamp when it last failed.
const failedKeysCooldown = new Map<string, number>();
// Provider-wide rate-limit breaker: a 429 means the account/key is limited,
// not the specific model — hammering the remaining models/keys (7 models × 2
// keys in one burst) only prolongs the limit. One 429 halts the whole provider.
const providerRateLimitedUntil = new Map<string, number>();
// Short cooldown: agent attempts are spaced ~30-60s apart (model TTFB timeouts),
// so a 60s window would swallow every retry after one transient failure.
// 15s lets the next attempt actually retry the provider.
const CB_COOLDOWN_MS = 15_000;

export class CascadeRouter {
  async route(
    bodyJson: Record<string, unknown>,
    role: Role,
    env: Record<string, unknown>,
    requestUrl: string
  ): Promise<RouterResult> {
    // Inject request path for all adapters
    const parsedUrl = new URL(requestUrl);
    (env as any)._requestPath = parsedUrl.pathname + parsedUrl.search;
    (env as any)._requestedModel = bodyJson.model || "";

    // Truncate tools array to provider limit (128).
    // OpenCode sends all available MCP tools (~209), but providers reject >128.
    const tools = bodyJson.tools as Array<unknown> | undefined;
    if (tools && tools.length > 128) {
      bodyJson = { ...bodyJson, tools: tools.slice(0, 128) };
    }

    const errors: string[] = [];
    const registry = getRegistry();
    const hasImages = this._hasImages(bodyJson);

    // Warm the cache
    await registry.getModels(env);

    // Role-specific target models (short names from env)
    const targetModels = this._getRoleModels(role, env);
    const attemptedModelIds = new Set(
      targetModels.flatMap((modelId) => [modelId, expandModelName(modelId)])
    );

    // === PASS 1: Target models through each provider ===
    const pass1 = await this._tryModels(
      targetModels,
      env,
      bodyJson,
      hasImages,
      errors
    );
    if (pass1) return pass1;

    // === PASS 2: Fallback — best models for role × provider ===
    return await this._fallback(
      role,
      env,
      bodyJson,
      hasImages,
      attemptedModelIds,
      errors
    );
  }

  /** Try an ordered list of model IDs across all providers */
  private async _tryModels(
    modelIds: string[],
    env: Record<string, unknown>,
    bodyJson: Record<string, unknown>,
    hasImages: boolean,
    errors: string[]
  ): Promise<RouterResult | null> {
    for (const modelId of modelIds) {
      const expanded = expandModelName(modelId);
      for (const providerId of PROVIDER_ORDER) {
        const adapter = this._getEnabledAdapter(providerId, env);
        if (!adapter) continue;

        // Vision check: skip if known non-vision (or unknown = conservative skip)
        if (hasImages) {
          const registry = getRegistry();
          const models = await registry.getModels(env);
          const mi = models.find((m) => m.id === expanded || m.id === modelId);
          if (!mi || !mi.supportsVision) continue;
        }

        const result = await this._tryAllKeys(
          adapter,
          modelId,
          bodyJson,
          env,
          errors
        );
        if (result) return result;
      }
    }
    return null;
  }

  /** Fallback: best models for role, sorted, across all providers */
  private async _fallback(
    role: Role,
    env: Record<string, unknown>,
    bodyJson: Record<string, unknown>,
    hasImages: boolean,
    excludeModelIds: Set<string>,
    errors: string[]
  ): Promise<RouterResult> {
    const registry = getRegistry();

    // Get sorted fallback chain from registry (already sorted by score × free × provider)
    let fallbackModels = hasImages
      ? await registry.getVisionModelsForRole(role, env)
      : await registry.getModelsForRole(role, env);

    // Exclude what we already tried in PASS 1
    fallbackModels = fallbackModels.filter((m) => !excludeModelIds.has(m.id));

    for (const model of fallbackModels) {
      const adapter = this._getEnabledAdapter(model.providerId, env);
      if (!adapter) continue;

      const result = await this._tryAllKeys(
        adapter,
        model.id,
        bodyJson,
        env,
        errors
      );
      if (result) return result;
    }

    return { response: null, providerName: "none", modelName: "", errors };
  }

  /** Try all keys of an adapter with a model */
  private async _tryAllKeys(
    adapter: ProviderAdapter,
    modelId: string,
    bodyJson: Record<string, unknown>,
    env: Record<string, unknown>,
    errors: string[]
  ): Promise<RouterResult | null> {
    const keys = adapter.getKeys(env);
    if (keys.length === 0) return null;

    const now = Date.now();

    // A recent 429 halted this provider — skip it entirely instead of
    // bursting through the remaining models/keys of a rate-limited account.
    const haltedAt = providerRateLimitedUntil.get(adapter.id);
    if (haltedAt !== undefined && now - haltedAt < CB_COOLDOWN_MS) {
      const errMsg = `${adapter.name} → skipped (provider rate limited)`;
      console.warn(`[Router] ${errMsg}`);
      errors.push(errMsg);
      return null;
    }

    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const cbKey = `${adapter.id}:${modelId}:${key}`;

      if (failedKeysCooldown.has(cbKey)) {
        if (now - failedKeysCooldown.get(cbKey)! < CB_COOLDOWN_MS) {
          const errMsg = `${adapter.name} key #${i + 1} model ${modelId} → skipped (circuit breaker cooldown)`;
          console.log(`[Router] ${errMsg}`);
          errors.push(errMsg);
          continue;
        } else {
          failedKeysCooldown.delete(cbKey);
        }
      }

      const config = adapter.prepareRequest(modelId, bodyJson, env, key);
      if (!config) {
        errors.push(
          `${adapter.name} key #${i + 1} model ${modelId} → skipped (no request config)`
        );
        continue;
      }

      let timeoutId: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeoutMs = this._getTimeout(adapter.id, env);
        const controller = new AbortController();
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        const resp = await fetch(config.url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify(config.body),
          redirect: "follow",
          signal: controller.signal,
        });
        if (adapter.isSuccess(resp)) {
          // Non-streaming requests: treat an HTTP 200 with no text and no
          // tool calls as a cascade failure — free models (qwen3.8-max-free)
          // sometimes answer 200 with an empty body on long contexts, which
          // the client could only retry in place. Buffer the body, detect
          // the empty reply, and let the next provider/model take over.
          if (!this._isStreamingRequest(bodyJson)) {
            const bodyText = await resp.text();
            if (this._isEmptyChatCompletion(bodyText)) {
              const errMsg = `${adapter.name} key #${i + 1} model ${modelId} → HTTP 200 empty reply (no content, no tool calls)`;
              console.warn(`[Router] ${errMsg}`);
              errors.push(errMsg);
              failedKeysCooldown.set(cbKey, Date.now());
              continue;
            }
            // Re-wrap so the buffered body can be consumed by the client.
            return this._okResult(
              adapter.name,
              modelId,
              config,
              bodyText,
              resp,
              errors
            );
          }
          return this._okResult(
            adapter.name,
            modelId,
            config,
            null,
            resp,
            errors
          );
        }

        // Only put the key on cooldown for rate limits (429), auth errors (401, 403), or server errors (5xx)
        if (
          resp.status === 429 ||
          resp.status === 401 ||
          resp.status === 403 ||
          resp.status >= 500
        ) {
          failedKeysCooldown.set(cbKey, Date.now());
        }
        // Surface the upstream error body (e.g. Mistral's
        // invalid_request_prompt_too_long) so the CI log shows WHY a provider
        // rejected the request, not just the status code. Error responses are
        // never forwarded, so consuming the body here is safe; cap it to keep
        // log lines and X-Provider-Error-* headers short.
        let detail = "";
        if (!this._isStreamingRequest(bodyJson)) {
          try {
            detail = (await resp.text())
              .slice(0, 300)
              .replace(/\s+/g, " ")
              .trim();
          } catch {
            // Body unreadable — keep the status-only message.
          }
        }
        const errMsg = `${adapter.name} key #${i + 1} model ${modelId} → HTTP ${resp.status}${detail ? `: ${detail}` : ""}`;
        console.warn(errMsg);
        errors.push(errMsg);
        // 429 is a provider/account-wide rate limit — stop trying this
        // provider's remaining keys and models instead of bursting them.
        if (resp.status === 429) {
          providerRateLimitedUntil.set(adapter.id, Date.now());
          break;
        }
      } catch (err: any) {
        if (err.name === "AbortError") {
          console.warn(
            `[Router] ${adapter.name} key #${i + 1} timed out after ${this._getTimeout(adapter.id, env)}ms`
          );
        } else {
          console.error(
            `[Router] Fetch error for ${adapter.name}:`,
            err.message
          );
        }
        // If the provider hangs or drops connection, put the key on cooldown so we don't wait 15s for it again
        failedKeysCooldown.set(cbKey, Date.now());
        errors.push(
          `${adapter.name} key #${i + 1} model ${modelId} → ${err.message}`
        );
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    }
    return null;
  }

  private _getEnabledAdapter(
    providerId: string,
    env: Record<string, unknown>
  ): ProviderAdapter | null {
    const registry = getRegistry();
    const adapter = registry.findAdapter(providerId);
    if (!adapter) return null;
    if (adapter.getKeys(env).length === 0) return null;
    return adapter;
  }

  private _hasImages(bodyJson: Record<string, unknown>): boolean {
    const messages = bodyJson.messages as
      Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(messages)) return false;
    return messages.some(
      (m) =>
        m.content &&
        Array.isArray(m.content) &&
        (m.content as Array<Record<string, unknown>>).some(
          (c) => c.type === "image_url"
        )
    );
  }

  private _getRoleModels(role: Role, env: Record<string, unknown>): string[] {
    if (role === "planner") return this._list(env.MODEL_PLANNER);
    if (role === "coder") return this._list(env.MODEL_CODER);
    if (role === "reviewer") return this._list(env.MODEL_REVIEWER);
    const requested = ((env as any)._requestedModel as string | undefined)
      ?.trim()
      .toLowerCase();
    if (requested && requested !== "auto") {
      return [(env as any)._requestedModel as string];
    }
    return [
      ...this._list(env.MODEL_DEFAULT),
      ...this._list(env.MODEL_REVIEWER),
    ];
  }

  /** Build a successful RouterResult; bodyText (if given) re-wraps the response. */
  private _okResult(
    adapterName: string,
    modelId: string,
    config: RequestConfig,
    bodyText: string | null,
    resp: Response,
    errors: string[]
  ): RouterResult {
    console.log(
      `[Router] OK: ${adapterName} model=${modelId} status=${resp.status}`
    );
    return {
      response:
        bodyText === null
          ? resp
          : new Response(bodyText, {
              status: resp.status,
              headers: resp.headers,
            }),
      providerName: adapterName,
      modelName:
        typeof config.body.model === "string" ? config.body.model : modelId,
      errors,
    };
  }

  /** Streaming requests pass through untouched — the body is an SSE stream
   *  that cannot be buffered/checked here. */
  private _isStreamingRequest(bodyJson: Record<string, unknown>): boolean {
    return bodyJson.stream === true;
  }

  /** True when a buffered chat-completions body carries no text and no tool
   *  calls (shared contract with the client — see chat-completions.ts). */
  private _isEmptyChatCompletion(bodyText: string): boolean {
    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      // Not JSON — either an SSE stream we shouldn't buffer or a raw error.
      return bodyText.trim() === "";
    }
    return isEmptyChatCompletion(parsed);
  }

  private _getTimeout(adapterId: string, env: Record<string, unknown>): number {
    // Per-provider upstream fetch timeout (env override:
    // TOKENROUTER_TIMEOUT_MS or OPENCODE_TIMEOUT_MS). The default 90s covers TTFB
    // for large-context reviews (356k prompt); the body is consumed lazily by the SSE converter after
    // fetch() resolves, so this is a connect/first-byte budget, not a total
    // stream budget. Previously 30s caused "The operation was aborted" on large diffs.
    const key = `${adapterId.toUpperCase()}_TIMEOUT_MS`;
    const val = parseInt(env[key] as string, 10);
    return isNaN(val) ? 90000 : Math.min(120_000, Math.max(1_000, val));
  }

  private _list(val: unknown): string[] {
    if (typeof val !== "string") return [];
    return val
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
  }
}

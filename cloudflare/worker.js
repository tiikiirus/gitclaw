// @bun
// src/adapters/mistral.ts
var DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
var DEFAULT_MISTRAL_MODEL = "mistral-small-latest";
var MISTRAL_MODEL_SCORES = {
  "mistral-large-latest": { planning: 90, coding: 84, review: 89 },
  "mistral-small-latest": { planning: 80, coding: 82, review: 87 },
  "mistral-medium-latest": { planning: 78, coding: 80, review: 82 },
  "codestral-latest": { planning: 74, coding: 90, review: 82 },
  "devstral-latest": { planning: 76, coding: 88, review: 86 },
  "magistral-small-latest": { planning: 82, coding: 78, review: 80 },
  "ministral-14b-latest": { planning: 72, coding: 76, review: 78 },
  "ministral-8b-latest": { planning: 70, coding: 74, review: 76 },
  "ministral-3b-latest": { planning: 62, coding: 68, review: 70 },
  "voxtral-small-latest": { planning: 85, coding: 78, review: 80 }
};
var VISION_MODELS = new Set(["voxtral-small-latest"]);
function isMistralModel(modelId) {
  return modelId in MISTRAL_MODEL_SCORES;
}

class MistralAdapter {
  id = "mistral";
  name = "mistral";
  enabled = true;
  getKeys(env) {
    return [
      env.MISTRAL_API_KEY,
      env.MISTRAL_API_KEY_BACKUP,
      env.MISTRAL_API_KEYS
    ].filter((value) => typeof value === "string").flatMap((value) => value.split(",")).map((key) => key.trim()).filter(Boolean);
  }
  async fetchModels(env) {
    if (this.getKeys(env).length === 0)
      return [];
    return Object.entries(MISTRAL_MODEL_SCORES).map(([modelId, scores]) => ({
      id: modelId,
      providerId: this.id,
      providerName: modelId,
      pricing: null,
      supportsVision: VISION_MODELS.has(modelId),
      contextLength: 131072,
      scores
    }));
  }
  prepareRequest(modelId, originalBody, env, key) {
    const keys = this.getKeys(env);
    if (keys.length === 0)
      return null;
    const configuredModel = (env.MISTRAL_MODEL || "").trim() || DEFAULT_MISTRAL_MODEL;
    const requestedModel = !modelId || modelId === "auto" ? configuredModel : modelId;
    if (!isMistralModel(requestedModel))
      return null;
    const baseUrl = (env.MISTRAL_BASE_URL || DEFAULT_MISTRAL_BASE_URL).trim().replace(/\/+$/, "");
    const chatBase = baseUrl.toLowerCase().endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return {
      url: `${chatBase}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key || keys[0]}`,
        "Content-Type": "application/json"
      },
      body: { ...originalBody, model: requestedModel }
    };
  }
  isSuccess(response) {
    return response.ok;
  }
}

// src/adapters/opencode.ts
var DEFAULT_OPENCODE_BASE_URL = "https://opencode.ai/zen/v1";
var DEFAULT_OPENCODE_MODEL = "hy3-free";
var FREE_MODEL_SCORES = {
  "hy3-free": { planning: 92, coding: 86, review: 91 },
  "laguna-s-2.1-free": { planning: 84, coding: 91, review: 89 },
  "deepseek-v4-flash-free": { planning: 84, coding: 89, review: 87 },
  "mimo-v2.5-free": { planning: 80, coding: 84, review: 82 },
  "nemotron-3-ultra-free": { planning: 83, coding: 82, review: 81 },
  "nemotron-3.5-lightning-free": {
    planning: 76,
    coding: 79,
    review: 77
  },
  "big-pickle": { planning: 70, coding: 72, review: 70 }
};
function isFreeOpenCodeModel(modelId) {
  return modelId === "big-pickle" || !modelId.includes("/") && modelId.endsWith("-free");
}

class OpenCodeAdapter {
  id = "opencode";
  name = "opencode";
  enabled = true;
  getKeys(env) {
    return [
      env.OPENCODE_API_KEY,
      env.OPENCODE_API_KEY_BACKUP,
      env.OPENCODE_API_KEYS
    ].filter((value) => typeof value === "string").flatMap((value) => value.split(",")).map((key) => key.trim()).filter(Boolean);
  }
  async fetchModels(env) {
    if (this.getKeys(env).length === 0)
      return [];
    let modelIds = Object.keys(FREE_MODEL_SCORES);
    try {
      const response = await fetch(`${this.baseUrl(env)}/models`, {
        headers: { Authorization: `Bearer ${this.getKeys(env)[0]}` },
        signal: AbortSignal.timeout(1e4)
      });
      if (response.ok) {
        const payload = await response.json();
        const discovered = (payload.data || []).map((model) => model.id).filter((id) => typeof id === "string").filter(isFreeOpenCodeModel);
        if (discovered.length > 0)
          modelIds = discovered;
      }
    } catch (error) {
      console.warn("[OpenCode] Model discovery failed; using free fallback list", error);
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
        review: 72
      }
    }));
  }
  prepareRequest(modelId, originalBody, env, key) {
    const keys = this.getKeys(env);
    if (keys.length === 0)
      return null;
    const configuredModel = (env.OPENCODE_MODEL || "").trim() || DEFAULT_OPENCODE_MODEL;
    const requestedModel = !modelId || modelId === "auto" ? configuredModel : modelId;
    if (!isFreeOpenCodeModel(requestedModel))
      return null;
    return {
      url: `${this.baseUrl(env)}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key || keys[0]}`,
        "Content-Type": "application/json"
      },
      body: { ...originalBody, model: requestedModel }
    };
  }
  isSuccess(response) {
    return response.ok;
  }
  baseUrl(env) {
    const value = (env.OPENCODE_BASE_URL || DEFAULT_OPENCODE_BASE_URL).trim().replace(/\/+$/, "");
    return value.toLowerCase().endsWith("/v1") ? value : `${value}/v1`;
  }
}

// src/adapters/tokenrouter.ts
var DEFAULT_TOKENROUTER_MODEL = "z-ai/glm-5.3-free";
var DEFAULT_TOKENROUTER_BASE_URL = "https://api.tokenrouter.com/v1";

class TokenRouterAdapter {
  id = "tokenrouter";
  name = "tokenrouter";
  enabled = true;
  getKeys(env) {
    return [
      env.TOKENROUTER_API_KEY,
      env.TOKENROUTER_API_KEY_BACKUP,
      env.TOKENROUTER_API_KEYS
    ].filter((value) => typeof value === "string").flatMap((value) => value.split(",")).map((key) => key.trim()).filter(Boolean);
  }
  async fetchModels(env) {
    if (this.getKeys(env).length === 0)
      return [];
    const model = (env.TOKENROUTER_MODEL || "").trim() || DEFAULT_TOKENROUTER_MODEL;
    return [
      {
        id: model,
        providerId: this.id,
        providerName: model,
        pricing: { prompt: 0, completion: 0 },
        supportsVision: false,
        contextLength: 131072,
        scores: { planning: 82, coding: 86, review: 88 }
      }
    ];
  }
  prepareRequest(modelId, originalBody, env, key) {
    const keys = this.getKeys(env);
    if (keys.length === 0)
      return null;
    const configuredModel = (env.TOKENROUTER_MODEL || "").trim() || DEFAULT_TOKENROUTER_MODEL;
    const requestedModel = !modelId || modelId === "auto" ? configuredModel : modelId;
    if (requestedModel !== configuredModel)
      return null;
    const baseUrl = (env.TOKENROUTER_BASE_URL || DEFAULT_TOKENROUTER_BASE_URL).trim().replace(/\/+$/, "");
    const chatBase = baseUrl.toLowerCase().endsWith("/v1") ? baseUrl : `${baseUrl}/v1`;
    return {
      url: `${chatBase}/chat/completions`,
      headers: {
        Authorization: `Bearer ${key || keys[0]}`,
        "Content-Type": "application/json"
      },
      body: { ...originalBody, model: requestedModel }
    };
  }
  isSuccess(response) {
    return response.ok;
  }
}

// src/adapters/registry.ts
var PROVIDER_PRIORITY = {
  tokenrouter: 0,
  opencode: 1,
  mistral: 2
};

class ModelRegistry {
  adapters = [
    new TokenRouterAdapter,
    new OpenCodeAdapter,
    new MistralAdapter
  ];
  cache = null;
  CACHE_TTL_MS = 300000;
  async getModels(env) {
    const now = Date.now();
    if (this.cache && now - this.cache.timestamp < this.CACHE_TTL_MS) {
      return this.cache.models;
    }
    const allModels = [];
    for (const adapter of this.adapters) {
      if (!adapter.enabled)
        continue;
      const keys = adapter.getKeys(env);
      if (keys.length === 0)
        continue;
      try {
        const models2 = await adapter.fetchModels(env);
        allModels.push(...models2);
      } catch (err) {
        console.error(`[Registry] ${adapter.name} fetchModels failed:`, err);
      }
    }
    const seen = new Map;
    for (const m of allModels) {
      const key = m.id;
      if (!seen.has(key)) {
        seen.set(key, m);
      } else {
        const existing = seen.get(key);
        if (PROVIDER_PRIORITY[m.providerId] < PROVIDER_PRIORITY[existing.providerId]) {
          seen.set(key, m);
        }
      }
    }
    const models = Array.from(seen.values());
    this.cache = { models, timestamp: now };
    return models;
  }
  async getModelsForRole(role, env) {
    const allModels = await this.getModels(env);
    const scoreKey = role === "planner" ? "planning" : role === "reviewer" ? "review" : "coding";
    const sorted = [...allModels].sort((a, b) => {
      const aFree = a.pricing && a.pricing.prompt === 0 && a.pricing.completion === 0 ? 0 : 1;
      const bFree = b.pricing && b.pricing.prompt === 0 && b.pricing.completion === 0 ? 0 : 1;
      if (aFree !== bFree)
        return aFree - bFree;
      const aScore = a.scores[scoreKey] || 0;
      const bScore = b.scores[scoreKey] || 0;
      if (bScore !== aScore)
        return bScore - aScore;
      return (PROVIDER_PRIORITY[a.providerId] || 99) - (PROVIDER_PRIORITY[b.providerId] || 99);
    });
    return sorted;
  }
  async getVisionModelsForRole(role, env) {
    const all = await this.getModelsForRole(role, env);
    return all.filter((m) => m.supportsVision);
  }
  findAdapter(providerId) {
    return this.adapters.find((a) => a.id === providerId);
  }
  getProviderNames() {
    return this.adapters.filter((adapter) => adapter.enabled).map((adapter) => adapter.id);
  }
  getProviderConfiguration(env) {
    return this.adapters.filter((adapter) => adapter.enabled).map((adapter) => ({
      id: adapter.id,
      configured: adapter.getKeys(env).length > 0
    }));
  }
  getAdapterById(id) {
    return this.adapters.find((a) => a.id === id);
  }
  invalidateCache() {
    this.cache = null;
  }
}
var _registry = null;
function getRegistry() {
  if (!_registry) {
    _registry = new ModelRegistry;
  }
  return _registry;
}

// src/adapters/types.ts
var SHORT_TO_FULL = {
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
  "qwq-32b": "qwen/qwq-32b"
};
function expandModelName(name) {
  if (!name.includes("/") && SHORT_TO_FULL[name]) {
    return SHORT_TO_FULL[name];
  }
  return name;
}

// src/chat-completions.ts
function messageText(message) {
  if (!message)
    return "";
  const content = message.content;
  if (typeof content === "string")
    return content.trim();
  if (Array.isArray(content)) {
    return content.filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("").trim();
  }
  return "";
}
function messageToolCalls(message) {
  if (!message)
    return [];
  if (Array.isArray(message.tool_calls))
    return message.tool_calls;
  if (Array.isArray(message.toolCalls))
    return message.toolCalls;
  return [];
}
function isEmptyChatCompletion(response) {
  if (!response || typeof response !== "object")
    return true;
  const choices = response.choices;
  if (!Array.isArray(choices) || choices.length === 0)
    return true;
  const choice = choices[0];
  const message = choice?.message ?? choice?.delta ?? {};
  return messageText(message) === "" && messageToolCalls(message).length === 0;
}

// src/router.ts
var PROVIDER_ORDER = ["tokenrouter", "opencode", "mistral"];
var failedKeysCooldown = new Map;
var providerRateLimitedUntil = new Map;
var CB_COOLDOWN_MS = 15000;

class CascadeRouter {
  async route(bodyJson, role, env, requestUrl) {
    const parsedUrl = new URL(requestUrl);
    env._requestPath = parsedUrl.pathname + parsedUrl.search;
    env._requestedModel = bodyJson.model || "";
    const tools = bodyJson.tools;
    if (tools && tools.length > 128) {
      bodyJson = { ...bodyJson, tools: tools.slice(0, 128) };
    }
    const errors = [];
    const registry = getRegistry();
    const hasImages = this._hasImages(bodyJson);
    await registry.getModels(env);
    const targetModels = this._getRoleModels(role, env);
    const attemptedModelIds = new Set(targetModels.flatMap((modelId) => [modelId, expandModelName(modelId)]));
    const pass1 = await this._tryModels(targetModels, env, bodyJson, hasImages, errors);
    if (pass1)
      return pass1;
    return await this._fallback(role, env, bodyJson, hasImages, attemptedModelIds, errors);
  }
  async _tryModels(modelIds, env, bodyJson, hasImages, errors) {
    for (const modelId of modelIds) {
      const expanded = expandModelName(modelId);
      for (const providerId of PROVIDER_ORDER) {
        const adapter = this._getEnabledAdapter(providerId, env);
        if (!adapter)
          continue;
        if (hasImages) {
          const registry = getRegistry();
          const models = await registry.getModels(env);
          const mi = models.find((m) => m.id === expanded || m.id === modelId);
          if (!mi || !mi.supportsVision)
            continue;
        }
        const result = await this._tryAllKeys(adapter, modelId, bodyJson, env, errors);
        if (result)
          return result;
      }
    }
    return null;
  }
  async _fallback(role, env, bodyJson, hasImages, excludeModelIds, errors) {
    const registry = getRegistry();
    let fallbackModels = hasImages ? await registry.getVisionModelsForRole(role, env) : await registry.getModelsForRole(role, env);
    fallbackModels = fallbackModels.filter((m) => !excludeModelIds.has(m.id));
    for (const model of fallbackModels) {
      const adapter = this._getEnabledAdapter(model.providerId, env);
      if (!adapter)
        continue;
      const result = await this._tryAllKeys(adapter, model.id, bodyJson, env, errors);
      if (result)
        return result;
    }
    return { response: null, providerName: "none", modelName: "", errors };
  }
  async _tryAllKeys(adapter, modelId, bodyJson, env, errors) {
    const keys = adapter.getKeys(env);
    if (keys.length === 0)
      return null;
    const now = Date.now();
    const haltedAt = providerRateLimitedUntil.get(adapter.id);
    if (haltedAt !== undefined && now - haltedAt < CB_COOLDOWN_MS) {
      const errMsg = `${adapter.name} \u2192 skipped (provider rate limited)`;
      console.warn(`[Router] ${errMsg}`);
      errors.push(errMsg);
      return null;
    }
    for (let i = 0;i < keys.length; i++) {
      const key = keys[i];
      const cbKey = `${adapter.id}:${modelId}:${key}`;
      if (failedKeysCooldown.has(cbKey)) {
        if (now - failedKeysCooldown.get(cbKey) < CB_COOLDOWN_MS) {
          const errMsg = `${adapter.name} key #${i + 1} model ${modelId} \u2192 skipped (circuit breaker cooldown)`;
          console.log(`[Router] ${errMsg}`);
          errors.push(errMsg);
          continue;
        } else {
          failedKeysCooldown.delete(cbKey);
        }
      }
      const config = adapter.prepareRequest(modelId, bodyJson, env, key);
      if (!config) {
        errors.push(`${adapter.name} key #${i + 1} model ${modelId} \u2192 skipped (no request config)`);
        continue;
      }
      let timeoutId;
      try {
        const timeoutMs = this._getTimeout(adapter.id, env);
        const controller = new AbortController;
        timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const resp = await fetch(config.url, {
          method: "POST",
          headers: config.headers,
          body: JSON.stringify(config.body),
          redirect: "follow",
          signal: controller.signal
        });
        if (adapter.isSuccess(resp)) {
          if (!this._isStreamingRequest(bodyJson)) {
            const bodyText = await resp.text();
            if (this._isEmptyChatCompletion(bodyText)) {
              const errMsg2 = `${adapter.name} key #${i + 1} model ${modelId} \u2192 HTTP 200 empty reply (no content, no tool calls)`;
              console.warn(`[Router] ${errMsg2}`);
              errors.push(errMsg2);
              failedKeysCooldown.set(cbKey, Date.now());
              continue;
            }
            return this._okResult(adapter.name, modelId, config, bodyText, resp, errors);
          }
          return this._okResult(adapter.name, modelId, config, null, resp, errors);
        }
        if (resp.status === 429 || resp.status === 401 || resp.status === 403 || resp.status >= 500) {
          failedKeysCooldown.set(cbKey, Date.now());
        }
        let detail = "";
        if (!this._isStreamingRequest(bodyJson)) {
          try {
            detail = (await resp.text()).slice(0, 300).replace(/\s+/g, " ").trim();
          } catch {}
        }
        const errMsg = `${adapter.name} key #${i + 1} model ${modelId} \u2192 HTTP ${resp.status}${detail ? `: ${detail}` : ""}`;
        console.warn(errMsg);
        errors.push(errMsg);
        if (resp.status === 429) {
          providerRateLimitedUntil.set(adapter.id, Date.now());
          break;
        }
      } catch (err) {
        if (err.name === "AbortError") {
          console.warn(`[Router] ${adapter.name} key #${i + 1} timed out after ${this._getTimeout(adapter.id, env)}ms`);
        } else {
          console.error(`[Router] Fetch error for ${adapter.name}:`, err.message);
        }
        failedKeysCooldown.set(cbKey, Date.now());
        errors.push(`${adapter.name} key #${i + 1} model ${modelId} \u2192 ${err.message}`);
      } finally {
        if (timeoutId)
          clearTimeout(timeoutId);
      }
    }
    return null;
  }
  _getEnabledAdapter(providerId, env) {
    const registry = getRegistry();
    const adapter = registry.findAdapter(providerId);
    if (!adapter)
      return null;
    if (adapter.getKeys(env).length === 0)
      return null;
    return adapter;
  }
  _hasImages(bodyJson) {
    const messages = bodyJson.messages;
    if (!Array.isArray(messages))
      return false;
    return messages.some((m) => m.content && Array.isArray(m.content) && m.content.some((c) => c.type === "image_url"));
  }
  _getRoleModels(role, env) {
    if (role === "planner")
      return this._list(env.MODEL_PLANNER);
    if (role === "coder")
      return this._list(env.MODEL_CODER);
    if (role === "reviewer")
      return this._list(env.MODEL_REVIEWER);
    const requested = env._requestedModel?.trim().toLowerCase();
    if (requested && requested !== "auto") {
      return [env._requestedModel];
    }
    return [
      ...this._list(env.MODEL_DEFAULT),
      ...this._list(env.MODEL_REVIEWER)
    ];
  }
  _okResult(adapterName, modelId, config, bodyText, resp, errors) {
    console.log(`[Router] OK: ${adapterName} model=${modelId} status=${resp.status}`);
    return {
      response: bodyText === null ? resp : new Response(bodyText, {
        status: resp.status,
        headers: resp.headers
      }),
      providerName: adapterName,
      modelName: typeof config.body.model === "string" ? config.body.model : modelId,
      errors
    };
  }
  _isStreamingRequest(bodyJson) {
    return bodyJson.stream === true;
  }
  _isEmptyChatCompletion(bodyText) {
    let parsed;
    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return bodyText.trim() === "";
    }
    return isEmptyChatCompletion(parsed);
  }
  _getTimeout(adapterId, env) {
    const key = `${adapterId.toUpperCase()}_TIMEOUT_MS`;
    const val = parseInt(env[key], 10);
    return isNaN(val) ? 60000 : Math.min(120000, Math.max(1000, val));
  }
  _list(val) {
    if (typeof val !== "string")
      return [];
    return val.split(",").map((m) => m.trim()).filter(Boolean);
  }
}

// src/worker.ts
var corsHeaders = {};
var HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "cookie",
  "set-cookie"
]);
var DEFAULT_MODEL = "z-ai/glm-5.3-free";
var MAX_BODY_BYTES = 1024 * 1024;
var MAX_DIAGNOSTIC_HEADERS = 8;
function safeDiagnosticHeader(value) {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 512);
}
function addProviderHeaders(headers, result) {
  headers.set("X-Provider-Info", `${result.providerName}/${result.modelName}`);
  result.errors.slice(0, MAX_DIAGNOSTIC_HEADERS).forEach((error, index) => {
    headers.set(`X-Provider-Error-${index}`, safeDiagnosticHeader(error));
  });
  if (result.errors.length > MAX_DIAGNOSTIC_HEADERS) {
    headers.set("X-Provider-Errors-Omitted", String(result.errors.length - MAX_DIAGNOSTIC_HEADERS));
  }
  return headers;
}
function safeUpstreamHeaders(response) {
  const headers = new Headers(response.headers);
  for (const name of HOP_BY_HOP)
    headers.delete(name);
  return headers;
}
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/v3/") || url.pathname === "/api/v3") {
      return handleGitHubProxy(request, env);
    }
    if (request.method === "GET" && (url.pathname === "/v1/status" || url.pathname === "/status")) {
      return handleStatus(env);
    }
    if (request.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      return handleModels(env);
    }
    const isChatCompletions = request.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions");
    const isResponses = request.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses");
    if (isChatCompletions || isResponses) {
      const authenticationFailure = checkLlmAuth(request, env);
      if (authenticationFailure)
        return authenticationFailure;
      const role = detectRole(readBearerToken(request), env);
      return isChatCompletions ? handleChatCompletions(request, env, role) : handleResponses(request, env, role);
    }
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return new Response(JSON.stringify({ status: "ok", service: "gitclaw-runtime" }), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
    return new Response("Not found", { status: 404, headers: corsHeaders });
  }
};
function handleStatus(env) {
  const providers = getRegistry().getProviderConfiguration(env);
  const authenticationConfigured = getConfiguredLlmTokens(env).length > 0;
  const ready = authenticationConfigured && providers.some((provider) => provider.configured);
  return new Response(JSON.stringify({
    status: ready ? "ok" : "down",
    service: "gitclaw-runtime",
    ready,
    authentication_configured: authenticationConfigured,
    provider_order: providers.map((provider) => provider.id),
    providers
  }), {
    status: ready ? 200 : 503,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
function readBearerToken(request) {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}
function getConfiguredLlmTokens(env) {
  return [
    env.KEY_PLANNER,
    env.KEY_CODER,
    env.KEY_REVIEWER,
    env.LLM_PROXY_API_KEY
  ].filter((token) => typeof token === "string").map((token) => token.trim()).filter(Boolean);
}
function checkLlmAuth(request, env) {
  const configuredTokens = getConfiguredLlmTokens(env);
  if (configuredTokens.length === 0) {
    return new Response("LLM authentication is not configured", {
      status: 503,
      headers: corsHeaders
    });
  }
  const token = readBearerToken(request);
  if (!token) {
    return new Response("Unauthorized", { status: 401, headers: corsHeaders });
  }
  if (!configuredTokens.includes(token)) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  return null;
}
function bodyTooLargeResponse() {
  return new Response(JSON.stringify({ error: "Request body exceeds 1 MiB limit" }), {
    status: 413,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
async function readBodyWithinLimit(request) {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      return bodyTooLargeResponse();
    }
  }
  if (!request.body)
    return "";
  const reader = request.body.getReader();
  const chunks = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done)
        break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_BODY_BYTES) {
        await reader.cancel();
        return bodyTooLargeResponse();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}
function detectRole(token, env) {
  if (token && token === env.KEY_PLANNER?.trim())
    return "planner";
  if (token && token === env.KEY_CODER?.trim())
    return "coder";
  if (token && token === env.KEY_REVIEWER?.trim())
    return "reviewer";
  return "default";
}
async function handleModels(env) {
  const models = await getRegistry().getModels(env);
  const now = Math.floor(Date.now() / 1000);
  return new Response(JSON.stringify({
    object: "list",
    data: [
      {
        id: "auto",
        object: "model",
        created: now,
        owned_by: "gitclaw-runtime"
      },
      ...models.map((model) => ({
        id: model.id,
        object: "model",
        created: now,
        owned_by: model.providerId
      }))
    ]
  }), {
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
async function handleChatCompletions(request, env, role) {
  const bodyText = await readBodyWithinLimit(request);
  if (bodyText instanceof Response)
    return bodyText;
  let bodyJson;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  if (!bodyJson.model) {
    bodyJson.model = DEFAULT_MODEL;
  }
  const tools = bodyJson.tools;
  if (tools && tools.length > 128) {
    bodyJson = { ...bodyJson, tools: tools.slice(0, 128) };
  }
  const router = new CascadeRouter;
  const result = await router.route(bodyJson, role, env, request.url);
  if (result.response) {
    const headers = addProviderHeaders(safeUpstreamHeaders(result.response), result);
    return new Response(result.response.body, {
      status: result.response.status,
      headers
    });
  }
  const errorBody = JSON.stringify({
    error: {
      message: "All providers failed",
      type: "proxy_error",
      details: result.errors
    }
  });
  return new Response(errorBody, {
    status: 502,
    headers: { "Content-Type": "application/json", ...corsHeaders }
  });
}
function responsesContentToChat(content) {
  if (typeof content === "string")
    return content;
  if (!Array.isArray(content))
    return null;
  const converted = [];
  for (const part of content) {
    if (!part || typeof part !== "object")
      return null;
    const record = part;
    if (record.type === "input_text" || record.type === "output_text") {
      if (typeof record.text !== "string")
        return null;
      converted.push({ type: "text", text: record.text });
    } else if (record.type === "text" && typeof record.text === "string") {
      converted.push(record);
    } else if (record.type === "input_image" && typeof record.image_url === "string") {
      converted.push({
        type: "image_url",
        image_url: { url: record.image_url }
      });
    } else if (record.type === "image_url") {
      converted.push(record);
    } else {
      return null;
    }
  }
  return converted;
}
function responsesInputToMessages(input, instructions) {
  const messages = [];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input))
    return input == null ? messages : null;
  let pendingToolCalls = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls
      });
      pendingToolCalls = [];
    }
  };
  for (const item of input) {
    if (!item || typeof item !== "object")
      return null;
    const record = item;
    if (record.type === "function_call") {
      if (typeof record.name !== "string" || typeof record.arguments !== "string") {
        return null;
      }
      const callId = typeof record.call_id === "string" ? record.call_id : typeof record.id === "string" ? record.id : crypto.randomUUID();
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name: record.name, arguments: record.arguments }
      });
      continue;
    }
    flushToolCalls();
    if (record.type === "function_call_output") {
      if (typeof record.call_id !== "string")
        return null;
      const output = record.output;
      messages.push({
        role: "tool",
        tool_call_id: record.call_id,
        content: typeof output === "string" ? output : JSON.stringify(output ?? "")
      });
      continue;
    }
    if (typeof record.type === "string" && record.type !== "message" && record.type !== "input_message") {
      return null;
    }
    const content = responsesContentToChat(record.content ?? "");
    if (content === null)
      return null;
    messages.push({
      role: typeof record.role === "string" ? record.role : "user",
      content
    });
  }
  flushToolCalls();
  return messages;
}
function responsesToolsToChat(tools) {
  if (tools == null)
    return [];
  if (!Array.isArray(tools))
    return null;
  const converted = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object")
      return null;
    const record = tool;
    if (record.type !== "function")
      return null;
    if (record.function && typeof record.function === "object") {
      converted.push(record);
      continue;
    }
    if (typeof record.name !== "string")
      return null;
    converted.push({
      type: "function",
      function: {
        name: record.name,
        ...typeof record.description === "string" ? { description: record.description } : {},
        ...record.parameters && typeof record.parameters === "object" ? { parameters: record.parameters } : {},
        ...typeof record.strict === "boolean" ? { strict: record.strict } : {}
      }
    });
  }
  return converted;
}
function responsesToolChoiceToChat(toolChoice) {
  if (toolChoice == null || typeof toolChoice === "string")
    return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object")
    return null;
  const record = toolChoice;
  if (record.type !== "function" || typeof record.name !== "string") {
    return null;
  }
  return { type: "function", function: { name: record.name } };
}
function responsesUrlToChatCompletionsUrl(requestUrl) {
  const url = new URL(requestUrl);
  url.pathname = url.pathname.replace(/\/responses$/, "/chat/completions");
  return url.toString();
}
function responsesStreamFromChat(upstream, result) {
  const encoder = new TextEncoder;
  const decoder = new TextDecoder;
  const responseId = `resp_${crypto.randomUUID()}`;
  let sequenceNumber = 0;
  let model = result.modelName;
  let usage;
  let text = "";
  let textItemId = null;
  let textOutputIndex = null;
  let nextOutputIndex = 0;
  const toolCalls = new Map;
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (type, payload) => {
        const event = { type, sequence_number: sequenceNumber++, ...payload };
        controller.enqueue(encoder.encode(`event: ${type}
data: ${JSON.stringify(event)}

`));
      };
      const baseResponse = (status) => ({
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status,
        model,
        output: []
      });
      emit("response.created", { response: baseResponse("in_progress") });
      let buffer = "";
      try {
        const reader = upstream.body?.getReader();
        if (!reader)
          throw new Error("Provider returned an empty stream");
        const processEvent = (block) => {
          const data = block.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join(`
`);
          if (!data || data === "[DONE]")
            return;
          const chunk = JSON.parse(data);
          if (typeof chunk.model === "string")
            model = chunk.model;
          if (chunk.usage)
            usage = chunk.usage;
          const delta = chunk?.choices?.[0]?.delta || {};
          if (typeof delta.content === "string" && delta.content) {
            if (textOutputIndex === null) {
              textOutputIndex = nextOutputIndex++;
              textItemId = `msg_${crypto.randomUUID()}`;
              emit("response.output_item.added", {
                output_index: textOutputIndex,
                item: {
                  id: textItemId,
                  type: "message",
                  role: "assistant",
                  status: "in_progress",
                  content: []
                }
              });
              emit("response.content_part.added", {
                item_id: textItemId,
                output_index: textOutputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] }
              });
            }
            text += delta.content;
            emit("response.output_text.delta", {
              item_id: textItemId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: delta.content
            });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const toolDelta of delta.tool_calls) {
              const index = Number(toolDelta.index ?? 0);
              let call = toolCalls.get(index);
              if (!call) {
                call = {
                  outputIndex: nextOutputIndex++,
                  id: toolDelta.id || `call_${crypto.randomUUID()}`,
                  name: toolDelta.function?.name || "",
                  arguments: ""
                };
                toolCalls.set(index, call);
                emit("response.output_item.added", {
                  output_index: call.outputIndex,
                  item: {
                    type: "function_call",
                    id: call.id,
                    call_id: call.id,
                    name: call.name,
                    arguments: "",
                    status: "in_progress"
                  }
                });
              }
              if (typeof toolDelta.id === "string")
                call.id = toolDelta.id;
              if (typeof toolDelta.function?.name === "string") {
                call.name = toolDelta.function.name;
              }
              const argumentsDelta = toolDelta.function?.arguments;
              if (typeof argumentsDelta === "string" && argumentsDelta) {
                call.arguments += argumentsDelta;
                emit("response.function_call_arguments.delta", {
                  item_id: call.id,
                  output_index: call.outputIndex,
                  delta: argumentsDelta
                });
              }
            }
          }
        };
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array, {
            stream: !done
          });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks)
            processEvent(block);
          if (done)
            break;
        }
        if (buffer.trim())
          processEvent(buffer);
        const output = [];
        if (textOutputIndex !== null) {
          const message = {
            id: textItemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }]
          };
          emit("response.output_text.done", {
            item_id: message.id,
            output_index: textOutputIndex,
            content_index: 0,
            text
          });
          emit("response.content_part.done", {
            item_id: message.id,
            output_index: textOutputIndex,
            content_index: 0,
            part: message.content[0]
          });
          emit("response.output_item.done", {
            output_index: textOutputIndex,
            item: message
          });
          output[textOutputIndex] = message;
        }
        for (const call of toolCalls.values()) {
          const item = {
            type: "function_call",
            id: call.id,
            call_id: call.id,
            name: call.name,
            arguments: call.arguments,
            status: "completed"
          };
          emit("response.function_call_arguments.done", {
            item_id: call.id,
            output_index: call.outputIndex,
            arguments: call.arguments
          });
          emit("response.output_item.done", {
            output_index: call.outputIndex,
            item
          });
          output[call.outputIndex] = item;
        }
        emit("response.completed", {
          response: {
            ...baseResponse("completed"),
            output: output.filter(Boolean),
            ...usage ? { usage } : {}
          }
        });
        controller.enqueue(encoder.encode(`data: [DONE]

`));
        controller.close();
      } catch (error) {
        emit("response.failed", {
          response: {
            ...baseResponse("completed"),
            status: "failed",
            error: {
              code: "stream_conversion_error",
              message: (error?.message || String(error)).slice(0, 300)
            }
          }
        });
        controller.close();
      }
    }
  });
  const headers = addProviderHeaders(new Headers, result);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  return new Response(stream, { status: upstream.status, headers });
}
async function handleResponses(request, env, role) {
  let bodyJson;
  try {
    const bodyText = await readBodyWithinLimit(request);
    if (bodyText instanceof Response)
      return bodyText;
    bodyJson = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  if (bodyJson.previous_response_id != null) {
    return new Response(JSON.stringify({
      error: "previous_response_id is not supported by this stateless proxy; send prior output items in input"
    }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  const messages = responsesInputToMessages(bodyJson.input, bodyJson.instructions);
  if (!messages) {
    return new Response(JSON.stringify({ error: "Unsupported Responses input item" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  const tools = responsesToolsToChat(bodyJson.tools);
  const toolChoice = responsesToolChoiceToChat(bodyJson.tool_choice);
  if (tools === null || toolChoice === null) {
    return new Response(JSON.stringify({ error: "Unsupported Responses tool configuration" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  const stream = bodyJson.stream === true;
  const chatBody = {
    model: bodyJson.model || DEFAULT_MODEL,
    stream,
    messages,
    ...tools.length > 0 ? { tools } : {},
    ...toolChoice != null ? { tool_choice: toolChoice } : {},
    ...typeof bodyJson.max_output_tokens === "number" ? { max_tokens: bodyJson.max_output_tokens } : {},
    ...typeof bodyJson.temperature === "number" ? { temperature: bodyJson.temperature } : {},
    ...typeof bodyJson.top_p === "number" ? { top_p: bodyJson.top_p } : {},
    ...typeof bodyJson.parallel_tool_calls === "boolean" ? { parallel_tool_calls: bodyJson.parallel_tool_calls } : {}
  };
  const router = new CascadeRouter;
  const result = await router.route(chatBody, role, env, responsesUrlToChatCompletionsUrl(request.url));
  if (!result.response) {
    return new Response(JSON.stringify({
      error: {
        message: "All providers failed",
        type: "proxy_error",
        details: result.errors
      }
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  if (stream)
    return responsesStreamFromChat(result.response, result);
  let upstream;
  try {
    upstream = await result.response.json();
  } catch {
    return new Response(JSON.stringify({ error: "Provider returned invalid JSON" }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
  const message = upstream?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: []
        }
      ]
    });
  }
  output.push(...toolCalls.map((toolCall) => ({
    type: "function_call",
    id: toolCall.id,
    call_id: toolCall.id,
    name: toolCall.function?.name,
    arguments: toolCall.function?.arguments || "{}",
    status: "completed"
  })));
  if (output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }]
    });
  }
  const headers = addProviderHeaders(new Headers({ "Content-Type": "application/json" }), result);
  return new Response(JSON.stringify({
    id: `resp_${upstream?.id || crypto.randomUUID()}`,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: "completed",
    model: upstream?.model || result.modelName,
    output,
    ...upstream?.usage ? { usage: upstream.usage } : {}
  }), { status: 200, headers });
}
async function handleGitHubProxy(request, env) {
  const expectedToken = env.KEY_GITHUB_AGENT?.trim();
  if (!expectedToken) {
    return new Response("GitHub proxy is not configured", {
      status: 503,
      headers: corsHeaders
    });
  }
  const authorization = request.headers.get("Authorization") || "";
  const providedToken = authorization.replace(/^(Bearer|token)\s+/i, "").trim();
  if (!providedToken || providedToken !== expectedToken) {
    return new Response("Forbidden", { status: 403, headers: corsHeaders });
  }
  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, POST", ...corsHeaders }
    });
  }
  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api\/v3\/?/, "");
  if (!apiPath || !/^[A-Za-z0-9._\-/]+$/.test(apiPath) || apiPath.includes("..")) {
    return new Response("Bad path", { status: 400, headers: corsHeaders });
  }
  const targetUrl = `https://api.github.com/${apiPath}${url.search}`;
  const upstreamHeaders = new Headers;
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set("User-Agent", "gitclaw-runtime-github-proxy");
  upstreamHeaders.set("Accept", upstreamHeaders.get("Accept") || "application/vnd.github+json");
  upstreamHeaders.set("X-GitHub-Api-Version", "2022-11-28");
  upstreamHeaders.set("Authorization", `token ${providedToken}`);
  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: request.method !== "GET" && request.method !== "HEAD" ? request.body : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(45000)
    });
    const responseHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      responseHeaders.set(key, value);
    }
    responseHeaders.set("X-GitHub-Proxy", "1");
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    responseHeaders.delete("set-cookie");
    return new Response(response.body, {
      status: response.status,
      headers: responseHeaders
    });
  } catch (error) {
    return new Response(JSON.stringify({
      error: "GitHub proxy request failed",
      detail: (error?.message || String(error)).slice(0, 300)
    }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
export {
  worker_default as default
};

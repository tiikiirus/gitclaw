import { describe, expect, test } from "bun:test";
import { OpenRouterAdapter } from "./openrouter";

describe("OpenRouterAdapter", () => {
  test("uses primary, backup, and comma-separated keys in order", () => {
    const adapter = new OpenRouterAdapter();
    expect(
      adapter.getKeys({
        OPENROUTER_API_KEY: "primary",
        OPENROUTER_API_KEY_BACKUP: "backup",
        OPENROUTER_API_KEYS: "third, fourth",
      }),
    ).toEqual(["primary", "backup", "third", "fourth"]);
  });

  test("maps auto to the configured model and preserves tools", () => {
    const adapter = new OpenRouterAdapter();
    const config = adapter.prepareRequest(
      "auto",
      {
        model: "auto",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
      {
        OPENROUTER_API_KEY: "secret",
        OPENROUTER_MODEL: "openrouter/free",
      },
      "secret",
    );

    expect(config).toEqual({
      url: "https://openrouter.ai/api/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/tiikiirus/gitclaw",
        "X-Title": "Gitclaw AI Reviewer",
      },
      body: {
        model: "openrouter/free",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
    });
  });

  test("normalizes a custom base URL without duplicating v1", () => {
    const adapter = new OpenRouterAdapter();
    const config = adapter.prepareRequest(
      "openrouter/free",
      { messages: [] },
      {
        OPENROUTER_API_KEY: "secret",
        OPENROUTER_BASE_URL: "https://openrouter.test/api/v1/",
      },
    );

    expect(config?.url).toBe("https://openrouter.test/api/v1/chat/completions");
  });

  test("serves known OpenRouter free models", () => {
    const adapter = new OpenRouterAdapter();
    const env = { OPENROUTER_API_KEY: "secret" };
    for (const model of [
      "openrouter/free",
      "z-ai/glm-5.2:free",
      "minimax/minimax-m3:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "poolside/laguna-s-2.1:free",
      "cohere/north-mini-code:free",
    ]) {
      expect(
        adapter.prepareRequest(model, { messages: [] }, env),
      ).not.toBeNull();
    }
  });

  test("rejects models owned by other providers", () => {
    const adapter = new OpenRouterAdapter();
    const env = { OPENROUTER_API_KEY: "secret" };
    expect(adapter.prepareRequest("z-ai/glm-5.3-free", {}, env)).toBeNull();
    expect(adapter.prepareRequest("mistral-small-latest", {}, env)).toBeNull();
  });

  test("is disabled at request time when no key is configured", async () => {
    const adapter = new OpenRouterAdapter();
    expect(adapter.prepareRequest("auto", {}, {})).toBeNull();
    await expect(adapter.fetchModels({})).resolves.toEqual([]);
  });
});

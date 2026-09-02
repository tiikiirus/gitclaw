import { describe, expect, test } from "bun:test";
import { TokenRouterAdapter } from "./tokenrouter";

describe("TokenRouterAdapter", () => {
  test("uses primary and backup keys in order", () => {
    const adapter = new TokenRouterAdapter();
    expect(
      adapter.getKeys({
        TOKENROUTER_API_KEY: "primary",
        TOKENROUTER_API_KEY_BACKUP: "backup",
      })
    ).toEqual(["primary", "backup"]);
  });

  test("maps auto to the configured free model and preserves tools", () => {
    const adapter = new TokenRouterAdapter();
    const config = adapter.prepareRequest(
      "auto",
      {
        model: "auto",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
      {
        TOKENROUTER_API_KEY: "secret",
        TOKENROUTER_MODEL: "qwen/qwen3.8-max-free",
      },
      "secret"
    );

    expect(config).toEqual({
      url: "https://api.tokenrouter.com/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: {
        model: "qwen/qwen3.8-max-free",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
    });
  });

  test("normalizes a custom base URL without duplicating v1", () => {
    const adapter = new TokenRouterAdapter();
    const config = adapter.prepareRequest(
      "qwen/qwen3.8-max-free",
      { messages: [] },
      {
        TOKENROUTER_API_KEY: "secret",
        TOKENROUTER_BASE_URL: "https://tokenrouter.test/v1/",
      }
    );

    expect(config?.url).toBe("https://tokenrouter.test/v1/chat/completions");
  });

  test("rejects models it is not configured to serve (OpenCode Zen models)", () => {
    const adapter = new TokenRouterAdapter();
    const env = {
      TOKENROUTER_API_KEY: "secret",
      TOKENROUTER_MODEL: "qwen/qwen3.8-max-free",
    };
    expect(
      adapter.prepareRequest("hy3-free", { messages: [] }, env)
    ).toBeNull();
    expect(
      adapter.prepareRequest("laguna-s-2.1-free", { messages: [] }, env)
    ).toBeNull();
    // Its own configured model still passes through.
    expect(
      adapter.prepareRequest("qwen/qwen3.8-max-free", { messages: [] }, env)
    ).not.toBeNull();
  });

  test("is disabled at request time when no key is configured", async () => {
    const adapter = new TokenRouterAdapter();
    expect(adapter.prepareRequest("auto", {}, {})).toBeNull();
    await expect(adapter.fetchModels({})).resolves.toEqual([]);
  });
});

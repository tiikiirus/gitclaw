import { describe, expect, test } from "bun:test";
import { GroqAdapter } from "./groq";

describe("GroqAdapter", () => {
  test("uses primary, backup, and comma-separated keys in order", () => {
    const adapter = new GroqAdapter();
    expect(
      adapter.getKeys({
        GROQ_API_KEY: "primary",
        GROQ_API_KEY_BACKUP: "backup",
        GROQ_API_KEYS: "third, fourth",
      }),
    ).toEqual(["primary", "backup", "third", "fourth"]);
  });

  test("maps auto to the configured model and preserves tools", () => {
    const adapter = new GroqAdapter();
    const config = adapter.prepareRequest(
      "auto",
      {
        model: "auto",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
      {
        GROQ_API_KEY: "secret",
        GROQ_MODEL: "openai/gpt-oss-120b",
      },
      "secret",
    );

    expect(config).toEqual({
      url: "https://api.groq.com/openai/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: {
        model: "openai/gpt-oss-120b",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
    });
  });

  test("normalizes a custom base URL without duplicating v1", () => {
    const adapter = new GroqAdapter();
    const config = adapter.prepareRequest(
      "openai/gpt-oss-120b",
      { messages: [] },
      {
        GROQ_API_KEY: "secret",
        GROQ_BASE_URL: "https://groq.test/openai/v1/",
      },
    );

    expect(config?.url).toBe("https://groq.test/openai/v1/chat/completions");
  });

  test("serves known Groq models", () => {
    const adapter = new GroqAdapter();
    const env = { GROQ_API_KEY: "secret" };
    for (const model of [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
    ]) {
      expect(
        adapter.prepareRequest(model, { messages: [] }, env),
      ).not.toBeNull();
    }
  });

  test("rejects models owned by other providers", () => {
    const adapter = new GroqAdapter();
    const env = { GROQ_API_KEY: "secret" };
    expect(adapter.prepareRequest("z-ai/glm-5.3-free", {}, env)).toBeNull();
    expect(adapter.prepareRequest("mistral-small-latest", {}, env)).toBeNull();
  });

  test("is disabled at request time when no key is configured", async () => {
    const adapter = new GroqAdapter();
    expect(adapter.prepareRequest("auto", {}, {})).toBeNull();
    await expect(adapter.fetchModels({})).resolves.toEqual([]);
  });
});

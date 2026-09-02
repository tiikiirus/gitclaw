import { describe, expect, test } from "bun:test";
import { MistralAdapter } from "./mistral";

describe("MistralAdapter", () => {
  test("uses primary, backup, and comma-separated keys in order", () => {
    const adapter = new MistralAdapter();
    expect(
      adapter.getKeys({
        MISTRAL_API_KEY: "primary",
        MISTRAL_API_KEY_BACKUP: "backup",
        MISTRAL_API_KEYS: "third, fourth",
      })
    ).toEqual(["primary", "backup", "third", "fourth"]);
  });

  test("maps auto to the configured model and preserves tools", () => {
    const adapter = new MistralAdapter();
    const config = adapter.prepareRequest(
      "auto",
      {
        model: "auto",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
      {
        MISTRAL_API_KEY: "secret",
        MISTRAL_MODEL: "mistral-small-latest",
      },
      "secret"
    );

    expect(config).toEqual({
      url: "https://api.mistral.ai/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: {
        model: "mistral-small-latest",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "readRepoFile" } }],
      },
    });
  });

  test("normalizes a custom base URL without duplicating v1", () => {
    const adapter = new MistralAdapter();
    const config = adapter.prepareRequest(
      "mistral-small-latest",
      { messages: [] },
      {
        MISTRAL_API_KEY: "secret",
        MISTRAL_BASE_URL: "https://mistral.test/v1/",
      }
    );

    expect(config?.url).toBe("https://mistral.test/v1/chat/completions");
  });

  test("serves any known Mistral model family", () => {
    const adapter = new MistralAdapter();
    const env = { MISTRAL_API_KEY: "secret" };
    for (const model of [
      "mistral-large-latest",
      "codestral-latest",
      "voxtral-small-latest",
    ]) {
      expect(
        adapter.prepareRequest(model, { messages: [] }, env)
      ).not.toBeNull();
    }
  });

  test("rejects models owned by other providers (qwen, Zen free models)", () => {
    const adapter = new MistralAdapter();
    const env = { MISTRAL_API_KEY: "secret" };
    expect(adapter.prepareRequest("qwen/qwen3.8-max-free", {}, env)).toBeNull();
    expect(adapter.prepareRequest("hy3-free", {}, env)).toBeNull();
  });

  test("marks only voxtral as vision-capable", async () => {
    const models = await new MistralAdapter().fetchModels({
      MISTRAL_API_KEY: "secret",
    });
    expect(
      models.find((m) => m.id === "voxtral-small-latest")?.supportsVision
    ).toBe(true);
    expect(
      models.find((m) => m.id === "mistral-small-latest")?.supportsVision
    ).toBe(false);
  });

  test("is disabled at request time when no key is configured", async () => {
    const adapter = new MistralAdapter();
    expect(adapter.prepareRequest("auto", {}, {})).toBeNull();
    await expect(adapter.fetchModels({})).resolves.toEqual([]);
  });
});

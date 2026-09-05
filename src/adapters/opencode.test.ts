import { afterEach, describe, expect, mock, test } from "bun:test";
import { OpenCodeAdapter } from "./opencode";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenCodeAdapter", () => {
  test("keeps primary, backup, and comma-separated keys in order", () => {
    const adapter = new OpenCodeAdapter();
    expect(
      adapter.getKeys({
        OPENCODE_API_KEY: "primary",
        OPENCODE_API_KEY_BACKUP: "backup",
        OPENCODE_API_KEYS: "third, fourth",
      }),
    ).toEqual(["primary", "backup", "third", "fourth"]);
  });

  test("discovers only currently free Zen chat models", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "gpt-5.6-sol" },
              { id: "hy3-free" },
              { id: "laguna-s-2.1-free" },
              { id: "big-pickle" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const models = await new OpenCodeAdapter().fetchModels({
      OPENCODE_API_KEY: "secret",
    });

    expect(models.map((model) => model.id)).toEqual([
      "hy3-free",
      "laguna-s-2.1-free",
      "big-pickle",
    ]);
    expect(models.every((model) => model.pricing?.prompt === 0)).toBe(true);
  });

  test("maps auto to Hy3 and preserves Gitclaw tools", () => {
    const config = new OpenCodeAdapter().prepareRequest(
      "auto",
      {
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "searchCode" } }],
      },
      { OPENCODE_API_KEY: "secret" },
    );

    expect(config).toEqual({
      url: "https://opencode.ai/zen/v1/chat/completions",
      headers: {
        Authorization: "Bearer secret",
        "Content-Type": "application/json",
      },
      body: {
        model: "hy3-free",
        messages: [{ role: "user", content: "review" }],
        tools: [{ type: "function", function: { name: "searchCode" } }],
      },
    });
  });

  test("does not send TokenRouter-only model IDs to Zen", () => {
    const config = new OpenCodeAdapter().prepareRequest(
      "qwen/qwen3.8-max-free",
      { messages: [] },
      { OPENCODE_API_KEY: "secret" },
    );

    expect(config).toBeNull();
  });
});

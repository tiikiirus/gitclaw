import { afterEach, describe, expect, mock, test } from "bun:test";
import { NousAdapter } from "./nous";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("NousAdapter", () => {
  test("keeps primary, backup, and comma-separated keys in order", () => {
    const adapter = new NousAdapter();
    expect(
      adapter.getKeys({
        NOUS_API_KEY: "primary",
        NOUS_API_KEY_BACKUP: "backup",
        NOUS_API_KEYS: "third, fourth",
      }),
    ).toEqual(["primary", "backup", "third", "fourth"]);
  });

  test("discovers only :free Portal models", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "anthropic/claude-sonnet-4.6" },
              { id: "stepfun/step-3.7-flash:free" },
              { id: "poolside/laguna-xs-2.1:free" },
              { id: "nousresearch/hermes-4-70b" },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    ) as unknown as typeof fetch;

    const models = await new NousAdapter().fetchModels({
      NOUS_API_KEY: "secret",
    });

    expect(models.map((model) => model.id)).toEqual([
      "stepfun/step-3.7-flash:free",
      "poolside/laguna-xs-2.1:free",
    ]);
    expect(models.every((model) => model.pricing?.prompt === 0)).toBe(true);
  });

  test("maps auto to the configured Nous model and preserves the body", () => {
    const adapter = new NousAdapter();
    const request = adapter.prepareRequest(
      "auto",
      { messages: [{ role: "user", content: "hi" }], temperature: 0.1 },
      { NOUS_API_KEY: "secret", NOUS_MODEL: "stepfun/step-3.7-flash:free" },
      "secret",
    );
    expect(request).not.toBeNull();
    expect(request?.url).toBe(
      "https://inference-api.nousresearch.com/v1/chat/completions",
    );
    expect((request?.body as { model: string }).model).toBe(
      "stepfun/step-3.7-flash:free",
    );
    expect((request?.body as { messages: unknown[] }).messages).toHaveLength(1);
  });

  test("declines non-free models so they route to paid providers", () => {
    const adapter = new NousAdapter();
    const request = adapter.prepareRequest(
      "anthropic/claude-sonnet-4.6",
      {},
      { NOUS_API_KEY: "secret" },
    );
    expect(request).toBeNull();
  });

  test("returns no request and no models without keys", async () => {
    const adapter = new NousAdapter();
    expect(adapter.prepareRequest("auto", {}, {})).toBeNull();
    expect((await adapter.fetchModels({})).length).toBe(0);
  });
});

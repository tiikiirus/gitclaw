import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { getRegistry } from "./adapters/registry";
import { CascadeRouter } from "./router";
import worker from "./worker";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  getRegistry().invalidateCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  getRegistry().invalidateCache();
});

describe("Responses API compatibility", () => {
  test("reports provider readiness without exposing key material", async () => {
    const unavailable = await worker.fetch(
      new Request("https://worker.test/v1/status"),
      {}
    );

    expect(unavailable.status).toBe(503);
    await expect(unavailable.json()).resolves.toMatchObject({
      status: "down",
      service: "gitclaw-runtime",
      ready: false,
      authentication_configured: false,
      provider_order: ["tokenrouter", "opencode", "mistral"],
      providers: [
        { id: "tokenrouter", configured: false },
        { id: "opencode", configured: false },
        { id: "mistral", configured: false },
      ],
    });

    const available = await worker.fetch(
      new Request("https://worker.test/v1/status"),
      {
        TOKENROUTER_API_KEY: "not-returned-to-client",
        LLM_PROXY_API_KEY: "proxy-key-not-returned",
      }
    );
    expect(available.status).toBe(200);
    const payload = await available.json();
    expect(payload).toMatchObject({
      status: "ok",
      ready: true,
      authentication_configured: true,
      providers: expect.arrayContaining([
        { id: "tokenrouter", configured: true },
      ]),
    });
    expect(JSON.stringify(payload)).not.toContain("not-returned-to-client");
    expect(JSON.stringify(payload)).not.toContain("proxy-key-not-returned");
  });

  test("converts non-streaming Responses input to chat completions and maps the reply back", async () => {
    const upstreamBodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock(
      async (url: string | Request, init?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://provider.test/v1/chat/completions") {
          upstreamBodies.push(JSON.parse(init?.body as string));
          return new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              model: "openai/gpt-5.5",
              choices: [
                { message: { role: "assistant", content: "review complete" } },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected upstream URL: ${target}`);
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          stream: false,
          input: [
            { role: "system", content: "system prompt" },
            { role: "user", content: "review this" },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "lookup",
                description: "Lookup a term.",
                parameters: {
                  type: "object",
                  properties: { term: { type: "string" } },
                },
              },
            },
          ],
        }),
      }),
      {
        TOKENROUTER_API_KEY: "upstream-key",
        TOKENROUTER_BASE_URL: "https://provider.test/v1",
        LLM_PROXY_API_KEY: "test-proxy-key",
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "review complete" }],
        },
      ],
    });
    expect(upstreamBodies).toEqual([
      expect.objectContaining({
        stream: false,
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "review this" },
        ],
        tools: [
          {
            type: "function",
            function: expect.objectContaining({ name: "lookup" }),
          },
        ],
      }),
    ]);
  });

  test("falls back from TokenRouter to OpenCode Zen with tools intact", async () => {
    const upstreamBodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock(
      async (url: string | Request, init?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://opencode.ai/zen/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "hy3-free" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (target === "https://api.tokenrouter.com/v1/chat/completions") {
          return new Response("unavailable", { status: 503 });
        }
        if (target === "https://opencode.ai/zen/v1/chat/completions") {
          upstreamBodies.push(JSON.parse(init?.body as string));
          return new Response(
            JSON.stringify({
              id: "chatcmpl-opencode",
              model: "hy3-free",
              choices: [
                { message: { role: "assistant", content: "fallback review" } },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected upstream URL: ${target}`);
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
          tools: [{ type: "function", function: { name: "searchCode" } }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        TOKENROUTER_API_KEY: "tokenrouter-key",
        OPENCODE_API_KEY: "opencode-key",
        MODEL_DEFAULT: "hy3-free",
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Provider-Info")).toBe("opencode/hy3-free");
    expect(response.headers.get("X-Provider-Error-0")).toBe(
      "tokenrouter key #1 model hy3-free ? skipped (no request config)"
    );
    expect(upstreamBodies).toEqual([
      expect.objectContaining({
        model: "hy3-free",
        tools: [{ type: "function", function: { name: "searchCode" } }],
      }),
    ]);
  });

  test("treats an empty 200 reply as a cascade failure and falls back to the next provider", async () => {
    globalThis.fetch = mock(
      async (url: string | Request, init?: RequestInit) => {
        const target = url instanceof Request ? url.url : String(url);
        if (target === "https://opencode.ai/zen/v1/models") {
          return new Response(JSON.stringify({ data: [{ id: "hy3-free" }] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        if (target === "https://api.tokenrouter.com/v1/chat/completions") {
          // Free models occasionally return 200 with an empty reply.
          return new Response(
            JSON.stringify({ id: "chatcmpl-empty", choices: [] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        if (target === "https://opencode.ai/zen/v1/chat/completions") {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-opencode",
              model: "hy3-free",
              choices: [
                { message: { role: "assistant", content: "fallback review" } },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        throw new Error(`Unexpected upstream URL: ${target}`);
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        TOKENROUTER_API_KEY: "empty-200-key",
        TOKENROUTER_MODEL: "empty-200-model",
        OPENCODE_API_KEY: "opencode-key",
        MODEL_DEFAULT: "empty-200-model",
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Provider-Info")).toBe("opencode/hy3-free");
    expect(response.headers.get("X-Provider-Error-0")).toContain(
      "HTTP 200 empty reply"
    );
  });

  test("empty 200 from both providers yields 502 carrying every failure", async () => {
    globalThis.fetch = mock(async (url: string | Request) => {
      const target = url instanceof Request ? url.url : String(url);
      if (target === "https://opencode.ai/zen/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "hy3-free" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (
        target === "https://api.tokenrouter.com/v1/chat/completions" ||
        target === "https://opencode.ai/zen/v1/chat/completions"
      ) {
        // Both free models answer empty 200 on the long context.
        return new Response(
          JSON.stringify({ id: "chatcmpl-empty", choices: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected upstream URL: ${target}`);
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        TOKENROUTER_API_KEY: "tr-key",
        TOKENROUTER_MODEL: "qwen/qwen3.8-max-free",
        OPENCODE_API_KEY: "oc-key",
        MODEL_DEFAULT: "qwen/qwen3.8-max-free",
        MODEL_REVIEWER: "qwen/qwen3.8-max-free,hy3-free,laguna-s-2.1-free",
      }
    );

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error.message).toBe("All providers failed");
    const joined = payload.error.details.join("\n");
    // tokenrouter empty on its model…
    expect(joined).toContain("HTTP 200 empty reply");
    // …cascade reached opencode with hy3-free and it was empty too.
    expect(joined).toMatch(
      /opencode key #[12] model hy3-free → HTTP 200 empty reply/
    );
    // OpenCode rejected the tokenrouter model (guard), not silently skipped.
    expect(joined).toContain("skipped (no request config)");
  });

  test("surfaces the upstream error body when a provider rejects with 4xx", async () => {
    globalThis.fetch = mock(async (url: string | Request) => {
      const target = url instanceof Request ? url.url : String(url);
      if (target.includes("api.mistral.ai")) {
        // Mistral rejects an over-long prompt with a JSON 400 — the router
        // must surface the reason (prompt too long), not just the status.
        return new Response(
          JSON.stringify({
            object: "error",
            message: "Prompt 356355 > 262144 maximum context length",
            type: "invalid_request_prompt_too_long",
            code: "3059",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } }
        );
      }
      throw new Error(`Unexpected upstream URL: ${target}`);
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        MISTRAL_API_KEY: "mistral-key",
        MODEL_DEFAULT: "mistral-small-latest",
      }
    );

    expect(response.status).toBe(502);
    const payload = await response.json();
    expect(payload.error.message).toBe("All providers failed");
    const joined = payload.error.details.join("\n");
    expect(joined).toContain("HTTP 400");
    expect(joined).toContain("Prompt 356355 > 262144 maximum context length");
    expect(joined).toContain("invalid_request_prompt_too_long");
  });

  test("a 429 stops further attempts to that provider (no 14-request burst)", async () => {
    let opencodeChatCalls = 0;
    globalThis.fetch = mock(async (url: string | Request) => {
      const target = url instanceof Request ? url.url : String(url);
      if (target === "https://opencode.ai/zen/v1/models") {
        return new Response(JSON.stringify({ data: [{ id: "hy3-free" }] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (target === "https://api.tokenrouter.com/v1/chat/completions") {
        // tokenrouter answers empty 200, forcing the cascade to opencode.
        return new Response(
          JSON.stringify({ id: "chatcmpl-empty", choices: [] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (target === "https://opencode.ai/zen/v1/chat/completions") {
        opencodeChatCalls += 1;
        // Rate-limited: further models/keys of this provider must not be tried.
        return new Response("rate limited", { status: 429 });
      }
      throw new Error(`Unexpected upstream URL: ${target}`);
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        TOKENROUTER_API_KEY: "tr-key-1,tr-key-2",
        TOKENROUTER_MODEL: "qwen/qwen3.8-max-free",
        OPENCODE_API_KEY: "oc-key-1,oc-key-2",
        MODEL_DEFAULT: "qwen/qwen3.8-max-free",
        MODEL_REVIEWER: "qwen/qwen3.8-max-free,hy3-free,laguna-s-2.1-free",
      }
    );

    expect(response.status).toBe(502);
    // One 429 trips the provider-wide breaker — no burst across models/keys.
    expect(opencodeChatCalls).toBe(1);
    const payload = await response.json();
    const joined = payload.error.details.join("\n");
    expect(joined).toContain("HTTP 429");
    expect(joined).toContain("skipped (provider rate limited)");
  });

  test("routes default-role auto through configured model fallbacks", async () => {
    const attemptedModels: string[] = [];
    globalThis.fetch = mock(
      async (_url: string | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string);
        attemptedModels.push(body.model);
        const headers = (init?.headers ?? {}) as Record<string, string>;
        if (headers.Authorization === "Bearer tokenrouter-key-1") {
          return new Response("temporary provider outage", { status: 503 });
        }
        return new Response(
          JSON.stringify({
            id: "chatcmpl-tokenrouter",
            model: body.model,
            choices: [
              { message: { role: "assistant", content: "fallback ok" } },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "review" }],
        }),
      }),
      {
        LLM_PROXY_API_KEY: "proxy-key",
        TOKENROUTER_API_KEYS: "tokenrouter-key-1,tokenrouter-key-2",
        MODEL_REVIEWER: "z-ai/glm-5.3-free",
      }
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("X-Provider-Info")).toBe(
      "tokenrouter/z-ai/glm-5.3-free"
    );
    expect(attemptedModels).toEqual(["z-ai/glm-5.3-free", "z-ai/glm-5.3-free"]);
  });

  test("reports circuit-breaker cooldown skips in 502 details instead of an empty array", async () => {
    // Every model 503s so every key lands on the circuit-breaker cooldown.
    globalThis.fetch = mock(
      async () => new Response("temporary provider outage", { status: 503 })
    ) as unknown as typeof fetch;

    const env = {
      LLM_PROXY_API_KEY: "proxy-key",
      TOKENROUTER_API_KEYS: "tokenrouter-key",
      MODEL_REVIEWER: "z-ai/glm-5.3-free",
    };
    const request = (body: string) =>
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer proxy-key",
          "Content-Type": "application/json",
        },
        body,
      });

    // First call: provider 503 everywhere → keys go on cooldown, 502 with reasons.
    const first = await worker.fetch(
      request(
        JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
        })
      ),
      env
    );
    expect(first.status).toBe(502);
    const firstPayload = await first.json();
    expect(firstPayload.error.details.length).toBeGreaterThan(0);

    // Second call within the cooldown window: keys are skipped, but the
    // 502 must still carry the cooldown reason instead of an empty array.
    const second = await worker.fetch(
      request(
        JSON.stringify({
          model: "auto",
          messages: [{ role: "user", content: "hi" }],
        })
      ),
      env
    );
    expect(second.status).toBe(502);
    const payload = await second.json();
    expect(payload.error.message).toBe("All providers failed");
    expect(payload.error.details.length).toBeGreaterThan(0);
    expect(payload.error.details[0]).toContain("circuit breaker cooldown");
  });

  test("maps native Responses content, tools, and tool history to Chat Completions", async () => {
    const upstreamBodies: Record<string, unknown>[] = [];
    globalThis.fetch = mock(
      async (_url: string | Request, init?: RequestInit) => {
        upstreamBodies.push(JSON.parse(init?.body as string));
        return new Response(
          JSON.stringify({
            id: "chatcmpl-tool-history",
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "done",
                  tool_calls: [
                    {
                      id: "call_next",
                      type: "function",
                      function: { name: "save", arguments: '{"ok":true}' },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "auto",
          instructions: "Be concise.",
          input: [
            {
              type: "message",
              role: "user",
              content: [{ type: "input_text", text: "Look it up" }],
            },
            {
              type: "function_call",
              call_id: "call_lookup",
              name: "lookup",
              arguments: '{"term":"x"}',
            },
            {
              type: "function_call_output",
              call_id: "call_lookup",
              output: { value: 7 },
            },
          ],
          tools: [
            {
              type: "function",
              name: "lookup",
              description: "Lookup a term.",
              parameters: { type: "object" },
            },
          ],
          tool_choice: { type: "function", name: "lookup" },
        }),
      }),
      {
        LLM_PROXY_API_KEY: "test-proxy-key",
        TOKENROUTER_API_KEY: "upstream-key",
        TOKENROUTER_BASE_URL: "https://provider.test/v1",
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      output: [
        { type: "message", content: [{ text: "done" }] },
        { type: "function_call", name: "save", arguments: '{"ok":true}' },
      ],
    });
    expect(upstreamBodies[0]).toMatchObject({
      messages: [
        { role: "system", content: "Be concise." },
        { role: "user", content: [{ type: "text", text: "Look it up" }] },
        {
          role: "assistant",
          tool_calls: [
            {
              id: "call_lookup",
              function: { name: "lookup", arguments: '{"term":"x"}' },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: "call_lookup",
          content: '{"value":7}',
        },
      ],
      tools: [{ type: "function", function: { name: "lookup" } }],
      tool_choice: { type: "function", function: { name: "lookup" } },
    });
  });

  test("rejects previous_response_id rather than pretending to retain state", async () => {
    const response = await worker.fetch(
      new Request("https://worker.test/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer test-proxy-key",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          previous_response_id: "resp_missing",
          input: "continue",
        }),
      }),
      { LLM_PROXY_API_KEY: "test-proxy-key" }
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("stateless proxy");
  });
});

describe("Streaming compatibility", () => {
  test("preserves an upstream Chat Completions event stream and caps diagnostics", async () => {
    const route = spyOn(CascadeRouter.prototype, "route").mockResolvedValue({
      response: new Response('data: {"choices":[]}\n\ndata: [DONE]\n\n', {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Set-Cookie": "must-not-leak=1",
        },
      }),
      providerName: "test-provider",
      modelName: "test-model",
      errors: Array.from({ length: 10 }, (_, index) => `failure ${index}`),
    });

    try {
      const response = await worker.fetch(
        new Request("https://worker.test/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer proxy-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stream: true, messages: [] }),
        }),
        { LLM_PROXY_API_KEY: "proxy-key" }
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "text/event-stream"
      );
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(response.headers.get("X-Provider-Error-7")).toBe("failure 7");
      expect(response.headers.get("X-Provider-Error-8")).toBeNull();
      expect(response.headers.get("X-Provider-Errors-Omitted")).toBe("2");
      expect(await response.text()).toContain("data: [DONE]");
    } finally {
      route.mockRestore();
    }
  });

  test("converts Chat Completions SSE into Responses API events", async () => {
    const chatEvents = [
      {
        id: "chatcmpl-stream",
        model: "hy3-free",
        choices: [{ delta: { role: "assistant", content: "Hel" } }],
      },
      {
        id: "chatcmpl-stream",
        model: "hy3-free",
        choices: [
          {
            delta: {
              content: "lo",
              tool_calls: [
                {
                  index: 0,
                  id: "call_1",
                  function: { name: "lookup", arguments: '{"x"' },
                },
              ],
            },
          },
        ],
      },
      {
        id: "chatcmpl-stream",
        model: "hy3-free",
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: ":1}" } }],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      },
    ];
    const sse =
      chatEvents.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") +
      "data: [DONE]\n\n";
    const route = spyOn(CascadeRouter.prototype, "route").mockResolvedValue({
      response: new Response(sse, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      providerName: "opencode",
      modelName: "hy3-free",
      errors: [],
    });

    try {
      const response = await worker.fetch(
        new Request("https://worker.test/v1/responses", {
          method: "POST",
          headers: {
            Authorization: "Bearer proxy-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ stream: true, input: "hello" }),
        }),
        { LLM_PROXY_API_KEY: "proxy-key" }
      );
      const body = await response.text();

      expect(response.status).toBe(200);
      expect(response.headers.get("Content-Type")).toContain(
        "text/event-stream"
      );
      expect(body).toContain("event: response.output_text.delta");
      expect(body).toContain('"delta":"Hel"');
      expect(body).toContain("event: response.function_call_arguments.done");
      expect(body).toContain('"arguments":"{\\"x\\":1}"');
      expect(body).toContain("event: response.completed");
      expect(body).toContain('"total_tokens":5');
      expect(body).toContain("data: [DONE]");
    } finally {
      route.mockRestore();
    }
  });
});

describe("Worker authentication and roles", () => {
  test("fails closed when no LLM bearer token is configured", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error(
        "Unconfigured auth must reject before any upstream request"
      );
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "auto", messages: [] }),
      }),
      { TOKENROUTER_API_KEY: "upstream-key" }
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  test("rejects an oversized LLM request before parsing or routing", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error(
        "Oversized input must reject before any upstream request"
      );
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Length": String(1024 * 1024 + 1),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "auto", messages: [] }),
      }),
      { LLM_PROXY_API_KEY: "valid" }
    );

    expect(response.status).toBe(413);
  });

  test("enforces the body cap when Content-Length is absent", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Streamed oversized input must reject before routing");
    }) as unknown as typeof fetch;
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1024 * 1024 + 1));
        controller.close();
      },
    });

    const response = await worker.fetch(
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer valid",
          "Content-Type": "application/json",
        },
        body: oversizedBody,
      }),
      { LLM_PROXY_API_KEY: "valid" }
    );

    expect(response.status).toBe(413);
  });

  test("rejects a missing or invalid bearer token when LLM auth is configured", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("LLM auth must reject before any upstream request");
    }) as unknown as typeof fetch;
    const makeRequest = (authorization?: string) =>
      new Request("https://worker.test/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ model: "auto", messages: [] }),
      });

    const missing = await worker.fetch(makeRequest(), {
      LLM_PROXY_API_KEY: "valid",
    });
    expect(missing.status).toBe(401);

    const invalid = await worker.fetch(makeRequest("Bearer wrong"), {
      LLM_PROXY_API_KEY: "valid",
    });
    expect(invalid.status).toBe(403);
  });

  test("routes KEY_REVIEWER requests through the reviewer model role", async () => {
    const route = spyOn(CascadeRouter.prototype, "route").mockResolvedValue({
      response: new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "reviewed" } }],
        })
      ),
      providerName: "test-provider",
      modelName: "test-model",
      errors: [],
    });

    try {
      const response = await worker.fetch(
        new Request("https://worker.test/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: "Bearer reviewer-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: "auto", messages: [] }),
        }),
        { KEY_REVIEWER: "reviewer-key" }
      );

      expect(response.status).toBe(200);
      expect(route).toHaveBeenCalledWith(
        expect.any(Object),
        "reviewer",
        expect.objectContaining({ KEY_REVIEWER: "reviewer-key" }),
        "https://worker.test/v1/chat/completions"
      );
    } finally {
      route.mockRestore();
    }
  });
});

describe("GitHub API proxy", () => {
  test("requires its dedicated token and forwards the caller token upstream", async () => {
    const upstreamRequests: Array<{ url: string; headers: Headers }> = [];
    globalThis.fetch = mock(
      async (url: string | Request, init?: RequestInit) => {
        upstreamRequests.push({
          url: url instanceof Request ? url.url : String(url),
          headers: new Headers(init?.headers),
        });
        return new Response(JSON.stringify({ login: "octocat" }), {
          status: 200,
        });
      }
    ) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/api/v3/user", {
        headers: { Authorization: "Bearer github-proxy-key" },
      }),
      { KEY_GITHUB_AGENT: "github-proxy-key" }
    );

    expect(response.status).toBe(200);
    expect(upstreamRequests).toEqual([
      expect.objectContaining({
        url: "https://api.github.com/user",
        headers: expect.any(Headers),
      }),
    ]);
    expect(upstreamRequests[0].headers.get("Authorization")).toBe(
      "token github-proxy-key"
    );
  });

  test("forwards a validated multi-segment GitHub API path", async () => {
    const upstreamUrls: string[] = [];
    globalThis.fetch = mock(async (url: string | Request) => {
      upstreamUrls.push(url instanceof Request ? url.url : String(url));
      return new Response(JSON.stringify({ number: 7 }), { status: 200 });
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request(
        "https://worker.test/api/v3/repos/owner/repository/issues/7?state=open",
        { headers: { Authorization: "Bearer github-proxy-key" } }
      ),
      { KEY_GITHUB_AGENT: "github-proxy-key" }
    );

    expect(response.status).toBe(200);
    expect(upstreamUrls).toEqual([
      "https://api.github.com/repos/owner/repository/issues/7?state=open",
    ]);
  });

  test("rejects proxy methods outside the explicit GET/POST allowlist", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("Disallowed methods must not reach GitHub");
    }) as unknown as typeof fetch;

    const response = await worker.fetch(
      new Request("https://worker.test/api/v3/repos/owner/repository", {
        method: "DELETE",
        headers: { Authorization: "Bearer github-proxy-key" },
      }),
      { KEY_GITHUB_AGENT: "github-proxy-key" }
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
  });
});

describe("Registry request-path handling", () => {
  test("does not overwrite the router's current request path during cache warmup", async () => {
    const env: Record<string, unknown> = { _requestPath: "/v1/responses" };

    await getRegistry().getModels(env);

    expect(env._requestPath).toBe("/v1/responses");
  });

  test("uses planning scores for the planner role", async () => {
    globalThis.fetch = mock(async (url: string | Request) => {
      expect(url instanceof Request ? url.url : String(url)).toBe(
        "https://opencode.ai/zen/v1/models"
      );
      return new Response(
        JSON.stringify({
          data: [{ id: "laguna-s-2.1-free" }, { id: "hy3-free" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as unknown as typeof fetch;

    const models = await getRegistry().getModelsForRole("planner", {
      OPENCODE_API_KEY: "test-key",
    });

    expect(models.map((model) => model.id)).toEqual([
      "hy3-free",
      "laguna-s-2.1-free",
    ]);
  });
});

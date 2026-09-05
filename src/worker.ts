// @gitclaw/runtime — Cloudflare Worker
// Authenticated LLM proxy with adapter-based provider routing.
// Project-agnostic: receives OpenAI-compatible model requests and routes
// them through TokenRouter with OpenCode Zen as a free-model fallback.

import { getRegistry } from "./adapters/registry";
import { CascadeRouter, RouterResult } from "./router";

// The Worker is an authenticated server-to-server proxy. Do not permit
// browser-origin access to bearer-protected endpoints.
const corsHeaders: Record<string, string> = {};

// Hop-by-hop headers that must not be forwarded upstream (RFC 7230 §6.1)
const HOP_BY_HOP = new Set([
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
  "set-cookie",
]);

// Default model if none specified in the request
const DEFAULT_MODEL = "z-ai/glm-5.3-free";

// Max body size to read (1MB)
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_DIAGNOSTIC_HEADERS = 8;

function safeDiagnosticHeader(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, "?").slice(0, 512);
}

function addProviderHeaders(headers: Headers, result: RouterResult): Headers {
  headers.set("X-Provider-Info", `${result.providerName}/${result.modelName}`);
  result.errors.slice(0, MAX_DIAGNOSTIC_HEADERS).forEach((error, index) => {
    headers.set(`X-Provider-Error-${index}`, safeDiagnosticHeader(error));
  });
  if (result.errors.length > MAX_DIAGNOSTIC_HEADERS) {
    headers.set(
      "X-Provider-Errors-Omitted",
      String(result.errors.length - MAX_DIAGNOSTIC_HEADERS),
    );
  }
  return headers;
}

function safeUpstreamHeaders(response: Response): Headers {
  const headers = new Headers(response.headers);
  for (const name of HOP_BY_HOP) headers.delete(name);
  return headers;
}

export interface WorkerEnv {
  LLM_PROXY_API_KEY?: string;
  KEY_PLANNER?: string;
  KEY_CODER?: string;
  KEY_REVIEWER?: string;
  KEY_GITHUB_AGENT?: string;
  [key: string]: any;
}

type AgentRole = "planner" | "coder" | "reviewer" | "default";

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);

    // GitHub API proxy — bypass GitHub API rate limits in CI
    if (url.pathname.startsWith("/api/v3/") || url.pathname === "/api/v3") {
      return handleGitHubProxy(request, env);
    }

    // Status endpoint
    if (
      request.method === "GET" &&
      (url.pathname === "/v1/status" || url.pathname === "/status")
    ) {
      return handleStatus(env);
    }

    // Models endpoint — OpenAI-compatible
    if (
      request.method === "GET" &&
      (url.pathname === "/v1/models" || url.pathname === "/models")
    ) {
      return handleModels(env);
    }

    const isChatCompletions =
      request.method === "POST" &&
      (url.pathname === "/v1/chat/completions" ||
        url.pathname === "/chat/completions");
    const isResponses =
      request.method === "POST" &&
      (url.pathname === "/v1/responses" || url.pathname === "/responses");

    if (isChatCompletions || isResponses) {
      const authenticationFailure = checkLlmAuth(request, env);
      if (authenticationFailure) return authenticationFailure;
      const role = detectRole(readBearerToken(request), env);
      return isChatCompletions
        ? handleChatCompletions(request, env, role)
        : handleResponses(request, env, role);
    }

    // Health check at root
    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/health")
    ) {
      return new Response(
        JSON.stringify({ status: "ok", service: "gitclaw-runtime" }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    return new Response("Not found", { status: 404, headers: corsHeaders });
  },
};

function handleStatus(env: WorkerEnv): Response {
  const providers = getRegistry().getProviderConfiguration(env);
  const authenticationConfigured = getConfiguredLlmTokens(env).length > 0;
  const ready =
    authenticationConfigured &&
    providers.some((provider) => provider.configured);
  return new Response(
    JSON.stringify({
      status: ready ? "ok" : "down",
      service: "gitclaw-runtime",
      ready,
      authentication_configured: authenticationConfigured,
      provider_order: providers.map((provider) => provider.id),
      providers,
    }),
    {
      status: ready ? 200 : 503,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

function readBearerToken(request: Request): string {
  const authorization = request.headers.get("Authorization") || "";
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || "";
}

function getConfiguredLlmTokens(env: WorkerEnv): string[] {
  return [
    env.KEY_PLANNER,
    env.KEY_CODER,
    env.KEY_REVIEWER,
    env.LLM_PROXY_API_KEY,
  ]
    .filter((token): token is string => typeof token === "string")
    .map((token) => token.trim())
    .filter(Boolean);
}

function checkLlmAuth(request: Request, env: WorkerEnv): Response | null {
  const configuredTokens = getConfiguredLlmTokens(env);
  if (configuredTokens.length === 0) {
    return new Response("LLM authentication is not configured", {
      status: 503,
      headers: corsHeaders,
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

function bodyTooLargeResponse(): Response {
  return new Response(
    JSON.stringify({ error: "Request body exceeds 1 MiB limit" }),
    {
      status: 413,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

async function readBodyWithinLimit(
  request: Request,
): Promise<string | Response> {
  const contentLength = request.headers.get("Content-Length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
      return bodyTooLargeResponse();
    }
  }

  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
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

function detectRole(token: string, env: WorkerEnv): AgentRole {
  if (token && token === env.KEY_PLANNER?.trim()) return "planner";
  if (token && token === env.KEY_CODER?.trim()) return "coder";
  if (token && token === env.KEY_REVIEWER?.trim()) return "reviewer";
  return "default";
}

async function handleModels(env: WorkerEnv): Promise<Response> {
  const models = await getRegistry().getModels(env);
  const now = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({
      object: "list",
      data: [
        {
          id: "auto",
          object: "model",
          created: now,
          owned_by: "gitclaw-runtime",
        },
        ...models.map((model) => ({
          id: model.id,
          object: "model",
          created: now,
          owned_by: model.providerId,
        })),
      ],
    }),
    {
      headers: { "Content-Type": "application/json", ...corsHeaders },
    },
  );
}

async function handleChatCompletions(
  request: Request,
  env: WorkerEnv,
  role: AgentRole,
): Promise<Response> {
  const bodyText = await readBodyWithinLimit(request);
  if (bodyText instanceof Response) return bodyText;

  let bodyJson: Record<string, unknown>;
  try {
    bodyJson = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  // Inject default model
  if (!bodyJson.model) {
    bodyJson.model = DEFAULT_MODEL;
  }

  // Truncate tools array to provider limit (128).
  const tools = bodyJson.tools as Array<unknown> | undefined;
  if (tools && tools.length > 128) {
    bodyJson = { ...bodyJson, tools: tools.slice(0, 128) };
  }

  const router = new CascadeRouter();
  const result: RouterResult = await router.route(
    bodyJson,
    role,
    env,
    request.url,
  );

  if (result.response) {
    const headers = addProviderHeaders(
      safeUpstreamHeaders(result.response),
      result,
    );

    return new Response(result.response.body, {
      status: result.response.status,
      headers,
    });
  }

  // All providers failed
  const errorBody = JSON.stringify({
    error: {
      message: "All providers failed",
      type: "proxy_error",
      details: result.errors,
    },
  });
  return new Response(errorBody, {
    status: 502,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function responsesContentToChat(content: unknown): unknown | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;

  const converted: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return null;
    const record = part as Record<string, unknown>;
    if (record.type === "input_text" || record.type === "output_text") {
      if (typeof record.text !== "string") return null;
      converted.push({ type: "text", text: record.text });
    } else if (record.type === "text" && typeof record.text === "string") {
      converted.push(record);
    } else if (
      record.type === "input_image" &&
      typeof record.image_url === "string"
    ) {
      converted.push({
        type: "image_url",
        image_url: { url: record.image_url },
      });
    } else if (record.type === "image_url") {
      converted.push(record);
    } else {
      return null;
    }
  }
  return converted;
}

function responsesInputToMessages(
  input: unknown,
  instructions?: unknown,
): Array<Record<string, unknown>> | null {
  const messages: Array<Record<string, unknown>> = [];
  if (typeof instructions === "string" && instructions.trim()) {
    messages.push({ role: "system", content: instructions });
  }
  if (typeof input === "string") {
    messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return input == null ? messages : null;

  let pendingToolCalls: Array<Record<string, unknown>> = [];
  const flushToolCalls = () => {
    if (pendingToolCalls.length > 0) {
      messages.push({
        role: "assistant",
        content: null,
        tool_calls: pendingToolCalls,
      });
      pendingToolCalls = [];
    }
  };
  for (const item of input) {
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    if (record.type === "function_call") {
      if (
        typeof record.name !== "string" ||
        typeof record.arguments !== "string"
      ) {
        return null;
      }
      const callId =
        typeof record.call_id === "string"
          ? record.call_id
          : typeof record.id === "string"
            ? record.id
            : crypto.randomUUID();
      pendingToolCalls.push({
        id: callId,
        type: "function",
        function: { name: record.name, arguments: record.arguments },
      });
      continue;
    }
    flushToolCalls();
    if (record.type === "function_call_output") {
      if (typeof record.call_id !== "string") return null;
      const output = record.output;
      messages.push({
        role: "tool",
        tool_call_id: record.call_id,
        content:
          typeof output === "string" ? output : JSON.stringify(output ?? ""),
      });
      continue;
    }
    if (
      typeof record.type === "string" &&
      record.type !== "message" &&
      record.type !== "input_message"
    ) {
      return null;
    }
    const content = responsesContentToChat(record.content ?? "");
    if (content === null) return null;
    messages.push({
      role: typeof record.role === "string" ? record.role : "user",
      content,
    });
  }
  flushToolCalls();
  return messages;
}

function responsesToolsToChat(tools: unknown): Array<unknown> | null {
  if (tools == null) return [];
  if (!Array.isArray(tools)) return null;
  const converted: Array<unknown> = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== "object") return null;
    const record = tool as Record<string, unknown>;
    if (record.type !== "function") return null;
    if (record.function && typeof record.function === "object") {
      converted.push(record);
      continue;
    }
    if (typeof record.name !== "string") return null;
    converted.push({
      type: "function",
      function: {
        name: record.name,
        ...(typeof record.description === "string"
          ? { description: record.description }
          : {}),
        ...(record.parameters && typeof record.parameters === "object"
          ? { parameters: record.parameters }
          : {}),
        ...(typeof record.strict === "boolean"
          ? { strict: record.strict }
          : {}),
      },
    });
  }
  return converted;
}

function responsesToolChoiceToChat(toolChoice: unknown): unknown | null {
  if (toolChoice == null || typeof toolChoice === "string") return toolChoice;
  if (!toolChoice || typeof toolChoice !== "object") return null;
  const record = toolChoice as Record<string, unknown>;
  if (record.type !== "function" || typeof record.name !== "string") {
    return null;
  }
  return { type: "function", function: { name: record.name } };
}

function responsesUrlToChatCompletionsUrl(requestUrl: string): string {
  const url = new URL(requestUrl);
  url.pathname = url.pathname.replace(/\/responses$/, "/chat/completions");
  return url.toString();
}

function responsesStreamFromChat(
  upstream: Response,
  result: RouterResult,
): Response {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const responseId = `resp_${crypto.randomUUID()}`;
  let sequenceNumber = 0;
  let model = result.modelName;
  let usage: unknown;
  let text = "";
  let textItemId: string | null = null;
  let textOutputIndex: number | null = null;
  let nextOutputIndex = 0;
  const toolCalls = new Map<
    number,
    { outputIndex: number; id: string; name: string; arguments: string }
  >();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = (type: string, payload: Record<string, unknown>) => {
        const event = { type, sequence_number: sequenceNumber++, ...payload };
        controller.enqueue(
          encoder.encode(`event: ${type}\ndata: ${JSON.stringify(event)}\n\n`),
        );
      };
      const baseResponse = (status: "in_progress" | "completed") => ({
        id: responseId,
        object: "response",
        created_at: Math.floor(Date.now() / 1000),
        status,
        model,
        output: [],
      });
      emit("response.created", { response: baseResponse("in_progress") });

      let buffer = "";
      try {
        const reader = upstream.body?.getReader();
        if (!reader) throw new Error("Provider returned an empty stream");

        const processEvent = (block: string) => {
          const data = block
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data || data === "[DONE]") return;
          const chunk = JSON.parse(data);
          if (typeof chunk.model === "string") model = chunk.model;
          if (chunk.usage) usage = chunk.usage;
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
                  content: [],
                },
              });
              emit("response.content_part.added", {
                item_id: textItemId,
                output_index: textOutputIndex,
                content_index: 0,
                part: { type: "output_text", text: "", annotations: [] },
              });
            }
            text += delta.content;
            emit("response.output_text.delta", {
              item_id: textItemId,
              output_index: textOutputIndex,
              content_index: 0,
              delta: delta.content,
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
                  arguments: "",
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
                    status: "in_progress",
                  },
                });
              }
              if (typeof toolDelta.id === "string") call.id = toolDelta.id;
              if (typeof toolDelta.function?.name === "string") {
                call.name = toolDelta.function.name;
              }
              const argumentsDelta = toolDelta.function?.arguments;
              if (typeof argumentsDelta === "string" && argumentsDelta) {
                call.arguments += argumentsDelta;
                emit("response.function_call_arguments.delta", {
                  item_id: call.id,
                  output_index: call.outputIndex,
                  delta: argumentsDelta,
                });
              }
            }
          }
        };

        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value || new Uint8Array(), {
            stream: !done,
          });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || "";
          for (const block of blocks) processEvent(block);
          if (done) break;
        }
        if (buffer.trim()) processEvent(buffer);

        const output: Array<Record<string, unknown>> = [];
        if (textOutputIndex !== null) {
          const message = {
            id: textItemId,
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text, annotations: [] }],
          };
          emit("response.output_text.done", {
            item_id: message.id,
            output_index: textOutputIndex,
            content_index: 0,
            text,
          });
          emit("response.content_part.done", {
            item_id: message.id,
            output_index: textOutputIndex,
            content_index: 0,
            part: message.content[0],
          });
          emit("response.output_item.done", {
            output_index: textOutputIndex,
            item: message,
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
            status: "completed",
          };
          emit("response.function_call_arguments.done", {
            item_id: call.id,
            output_index: call.outputIndex,
            arguments: call.arguments,
          });
          emit("response.output_item.done", {
            output_index: call.outputIndex,
            item,
          });
          output[call.outputIndex] = item;
        }
        emit("response.completed", {
          response: {
            ...baseResponse("completed"),
            output: output.filter(Boolean),
            ...(usage ? { usage } : {}),
          },
        });
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (error: any) {
        emit("response.failed", {
          response: {
            ...baseResponse("completed"),
            status: "failed",
            error: {
              code: "stream_conversion_error",
              message: (error?.message || String(error)).slice(0, 300),
            },
          },
        });
        controller.close();
      }
    },
  });

  const headers = addProviderHeaders(new Headers(), result);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache");
  return new Response(stream, { status: upstream.status, headers });
}

async function handleResponses(
  request: Request,
  env: WorkerEnv,
  role: AgentRole,
): Promise<Response> {
  let bodyJson: Record<string, unknown>;
  try {
    const bodyText = await readBodyWithinLimit(request);
    if (bodyText instanceof Response) return bodyText;
    bodyJson = JSON.parse(bodyText);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  if (bodyJson.previous_response_id != null) {
    return new Response(
      JSON.stringify({
        error:
          "previous_response_id is not supported by this stateless proxy; send prior output items in input",
      }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const messages = responsesInputToMessages(
    bodyJson.input,
    bodyJson.instructions,
  );
  if (!messages) {
    return new Response(
      JSON.stringify({ error: "Unsupported Responses input item" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
  const tools = responsesToolsToChat(bodyJson.tools);
  const toolChoice = responsesToolChoiceToChat(bodyJson.tool_choice);
  if (tools === null || toolChoice === null) {
    return new Response(
      JSON.stringify({ error: "Unsupported Responses tool configuration" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
  const stream = bodyJson.stream === true;
  const chatBody: Record<string, unknown> = {
    model: bodyJson.model || DEFAULT_MODEL,
    stream,
    messages,
    ...(tools.length > 0 ? { tools } : {}),
    ...(toolChoice != null ? { tool_choice: toolChoice } : {}),
    ...(typeof bodyJson.max_output_tokens === "number"
      ? { max_tokens: bodyJson.max_output_tokens }
      : {}),
    ...(typeof bodyJson.temperature === "number"
      ? { temperature: bodyJson.temperature }
      : {}),
    ...(typeof bodyJson.top_p === "number" ? { top_p: bodyJson.top_p } : {}),
    ...(typeof bodyJson.parallel_tool_calls === "boolean"
      ? { parallel_tool_calls: bodyJson.parallel_tool_calls }
      : {}),
  };
  const router = new CascadeRouter();
  const result = await router.route(
    chatBody,
    role,
    env,
    responsesUrlToChatCompletionsUrl(request.url),
  );

  if (!result.response) {
    return new Response(
      JSON.stringify({
        error: {
          message: "All providers failed",
          type: "proxy_error",
          details: result.errors,
        },
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  if (stream) return responsesStreamFromChat(result.response, result);

  let upstream: any;
  try {
    upstream = await result.response.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Provider returned invalid JSON" }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }

  const message = upstream?.choices?.[0]?.message || {};
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const output: Array<Record<string, unknown>> = [];
  if (typeof message.content === "string" && message.content.length > 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [
        {
          type: "output_text",
          text: message.content,
          annotations: [],
        },
      ],
    });
  }
  output.push(
    ...toolCalls.map((toolCall: any) => ({
      type: "function_call",
      id: toolCall.id,
      call_id: toolCall.id,
      name: toolCall.function?.name,
      arguments: toolCall.function?.arguments || "{}",
      status: "completed",
    })),
  );
  if (output.length === 0) {
    output.push({
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "", annotations: [] }],
    });
  }

  const headers = addProviderHeaders(
    new Headers({ "Content-Type": "application/json" }),
    result,
  );
  return new Response(
    JSON.stringify({
      id: `resp_${upstream?.id || crypto.randomUUID()}`,
      object: "response",
      created_at: Math.floor(Date.now() / 1000),
      status: "completed",
      model: upstream?.model || result.modelName,
      output,
      ...(upstream?.usage ? { usage: upstream.usage } : {}),
    }),
    { status: 200, headers },
  );
}

async function handleGitHubProxy(
  request: Request,
  env: WorkerEnv,
): Promise<Response> {
  const expectedToken = env.KEY_GITHUB_AGENT?.trim();
  if (!expectedToken) {
    return new Response("GitHub proxy is not configured", {
      status: 503,
      headers: corsHeaders,
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
      headers: { Allow: "GET, POST", ...corsHeaders },
    });
  }

  const url = new URL(request.url);
  const apiPath = url.pathname.replace(/^\/api\/v3\/?/, "");
  if (
    !apiPath ||
    !/^[A-Za-z0-9._\-/]+$/.test(apiPath) ||
    apiPath.includes("..")
  ) {
    return new Response("Bad path", { status: 400, headers: corsHeaders });
  }
  const targetUrl = `https://api.github.com/${apiPath}${url.search}`;

  const upstreamHeaders = new Headers();
  for (const [key, value] of request.headers.entries()) {
    if (!HOP_BY_HOP.has(key.toLowerCase())) {
      upstreamHeaders.set(key, value);
    }
  }
  upstreamHeaders.set("User-Agent", "gitclaw-runtime-github-proxy");
  upstreamHeaders.set(
    "Accept",
    upstreamHeaders.get("Accept") || "application/vnd.github+json",
  );
  upstreamHeaders.set("X-GitHub-Api-Version", "2022-11-28");
  upstreamHeaders.set("Authorization", `token ${providedToken}`);

  try {
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? request.body
          : undefined,
      redirect: "follow",
      signal: AbortSignal.timeout(45_000),
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
      headers: responseHeaders,
    });
  } catch (error: any) {
    return new Response(
      JSON.stringify({
        error: "GitHub proxy request failed",
        detail: (error?.message || String(error)).slice(0, 300),
      }),
      {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
}

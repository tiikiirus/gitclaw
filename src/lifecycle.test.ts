// lifecycle/shared.test.ts — bun:test for the generic readLinearIssueTool.
//
// Run with:  bun test lifecycle/shared.test.ts
//
// Verifies:
//   1. Happy path: valid PROJECT-<n> issueId → fetch called with parameterized
//      GraphQL query (variables, no string interpolation).
//   2. Invalid format: regex rejection → "Invalid" result, NO fetch call.
//   3. Injection attempts: closed-quote / `}) { ... }` payloads → blocked by
//      regex, NO fetch call (cannot reach the GraphQL string).
//   4. Not-found (server returns no issue): same "Not Found" UX as before.
//   5. 4xx from Linear: throws (not a graceful result — action item for the agent).
//   6. GraphQL errors from Linear: throws.

import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { z } from "zod";
import {
  buildStaticContext,
  createTools,
  runAgent,
  parseEvent,
  truncateToolResult,
  type EventInfo,
} from "./lifecycle";

function makeEvent(): EventInfo {
  return {
    eventName: "issues",
    repo: "owner/example-repo",
    token: "gh-test-token",
    apiKey: "sk-test",
    baseURL: "https://openai-proxy.example/v1",
    issueNumber: 234,
    isPullRequest: false,
    userRequest: "test",
    prDiff: "",
  };
}

test("buildStaticContext includes optional policy files from the supplied repository root", () => {
  const root = mkdtempSync(join(tmpdir(), "gitclaw-context-"));
  try {
    writeFileSync(join(root, "AGENTS.md"), "fixture agent rules");
    writeFileSync(join(root, ".hermes.md"), "fixture project policy");
    writeFileSync(join(root, "README.md"), "fixture README");

    expect(buildStaticContext(root)).toContain("fixture agent rules");
    expect(buildStaticContext(root)).toContain("fixture project policy");
    expect(buildStaticContext(root)).toContain("fixture README");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function findReadLinearIssue(tools: any[]): any {
  // The @openrouter/agent tool() wrapper returns
  // { type: "function", function: { name, inputSchema, execute, ... } }
  // (OpenAI function-calling format). Both the name and the execute
  // function live at .function.
  const t = tools.find((x) => x.function?.name === "readLinearIssue");
  if (!t)
    throw new Error("readLinearIssue tool not found in createTools() result");
  return t.function;
}

const LINEAR_KEY = "lin_api_test_key_xxxxxxxxxxxxxxxxxxxxxx";
const ISSUE_OK = "ABC-234";
const ISSUE_PAYLOAD = {
  data: {
    issue: {
      title: "Fix GraphQL injection in readLinearIssueTool",
      description: "Defence-in-depth fix for ABC-234.",
      state: { name: "In Progress" },
    },
  },
};

let originalFetch: typeof fetch;
let fetchCalls: { url: string; init: RequestInit | undefined }[];
let fetchResponder: (
  url: string,
  init: RequestInit | undefined
) => Promise<Response>;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  fetchCalls = [];
  fetchResponder = async () =>
    new Response(JSON.stringify(ISSUE_PAYLOAD), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  globalThis.fetch = mock(async (url: any, init?: RequestInit) => {
    const u =
      url instanceof Request
        ? url.url
        : typeof url === "string"
          ? url
          : url.toString();
    fetchCalls.push({ url: u, init });
    return fetchResponder(u, init);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("readLinearIssueTool — happy path", () => {
  test("valid ABC-<n> → fetch with parameterized variables, no string interpolation", async () => {
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    const result = await tool.execute({ issueId: ISSUE_OK });

    // Result shape unchanged
    expect(result).toEqual({
      title: "Fix GraphQL injection in readLinearIssueTool",
      description: "Defence-in-depth fix for ABC-234.",
      state: "In Progress",
    });

    // Exactly one fetch, against the right endpoint, with Bearer auth
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.linear.app/graphql");
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(LINEAR_KEY);
    expect(headers["Content-Type"]).toBe("application/json");

    // Body: variables, not string interpolation
    const body = JSON.parse(fetchCalls[0].init?.body as string);
    expect(body).toEqual({
      query:
        "query($id: String!) { issue(id: $id) { title description state { name } } }",
      variables: { id: ISSUE_OK },
    });

    // Defence-in-depth assertion: the issueId value is NEVER present
    // in the query string itself, only in variables.
    expect(body.query).not.toContain(ISSUE_OK);
  });

  test("valid project-specific Linear key also uses parameterized variables", async () => {
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);

    await expect(tool.execute({ issueId: "FAN-47" })).resolves.toMatchObject({
      title: "Fix GraphQL injection in readLinearIssueTool",
    });
    expect(fetchCalls).toHaveLength(1);
    expect(JSON.parse(fetchCalls[0].init?.body as string).variables).toEqual({
      id: "FAN-47",
    });
  });
});

describe("readLinearIssueTool — invalid format (regex rejection)", () => {
  test.each([
    ["empty string", ""],
    ["one-character prefix", "F-123"],
    ["project key without number", "ABC-"],
    ["non-numeric suffix", "ABC-12a"],
    ["trailing semicolon", "ABC-12;DROP"],
    ["with whitespace", "ABC- 12"],
    ["with newline", "ABC-12\n"],
    ["unicode digits", "ABC-١٢٣"],
  ])("rejects %s without calling fetch", async (_name, badId) => {
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    const result = await tool.execute({ issueId: badId });

    expect(result).toEqual({
      title: "Invalid",
      description: expect.stringContaining("Invalid issueId format"),
      state: "Unknown",
    });
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("readLinearIssueTool — injection attempts", () => {
  // Each of these would have been a valid GraphQL injection against the
  // old `query { issue(id: "${issueId}") { ... } }` string interpolation.
  // They MUST be blocked by the regex before reaching the transport.
  test.each([
    ["closed-quote + brace", `ABC-1") { users { email } }`],
    ["full GraphQL break", `ABC-1") { teams { name } } } #`],
    ["SQL-ish", `ABC-1' OR '1'='1`],
    ["shell-style", `ABC-1"; cat /etc/passwd; echo "`],
    ["path traversal", `ABC-../../etc/passwd`],
    ["10kB junk", ";".repeat(10000)],
  ])("blocks injection attempt: %s", async (_name, payload) => {
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    const result = await tool.execute({ issueId: payload });

    expect(result.title).toBe("Invalid");
    expect(fetchCalls).toHaveLength(0);
  });
});

describe("readLinearIssueTool — server response handling", () => {
  test("issue not found → graceful 'Not Found' result (no throw)", async () => {
    fetchResponder = async () =>
      new Response(JSON.stringify({ data: { issue: null } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    const result = await tool.execute({ issueId: "ABC-99999" });
    expect(result).toEqual({
      title: "Not Found",
      description: "Issue ABC-99999 not found in Linear.",
      state: "Unknown",
    });
  });

  test("GraphQL errors array → throws", async () => {
    fetchResponder = async () =>
      new Response(JSON.stringify({ errors: [{ message: "auth failed" }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    expect(tool.execute({ issueId: "ABC-1" })).rejects.toThrow(
      /Linear GraphQL Error/
    );
  });

  test("HTTP 4xx → throws", async () => {
    fetchResponder = async () =>
      new Response("nope", { status: 401, statusText: "Unauthorized" });
    const tools = createTools(makeEvent(), LINEAR_KEY);
    const tool = findReadLinearIssue(tools);
    expect(tool.execute({ issueId: "ABC-1" })).rejects.toThrow(
      /Linear API request failed/
    );
  });
});

describe("runAgent — Chat Completions API", () => {
  test("sends one non-streaming chat request and returns output text", async () => {
    fetchResponder = async (url, init) => {
      expect(url).toBe("https://openai-proxy.example/v1/chat/completions");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toMatchObject({
        Authorization: expect.any(String),
        "Content-Type": "application/json",
      });

      const body = JSON.parse(init?.body as string);
      expect(body).toMatchObject({
        model: "auto",
        stream: false,
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "review this" },
        ],
      });

      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "review complete" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await expect(
      runAgent("system prompt", [], "review this", makeEvent())
    ).resolves.toBe("review complete");
    expect(fetchCalls).toHaveLength(1);
  });

  test("logs the resolving provider/model from X-Provider-Info", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };
    try {
      fetchResponder = async () =>
        new Response(
          JSON.stringify({
            choices: [
              { message: { role: "assistant", content: "review complete" } },
            ],
          }),
          {
            status: 200,
            headers: {
              "Content-Type": "application/json",
              "X-Provider-Info": "tokenrouter/qwen/qwen3.8-max-free",
            },
          }
        );

      await runAgent("system prompt", [], "review this", makeEvent());
      expect(
        logs.some((l) => l.includes("tokenrouter/qwen/qwen3.8-max-free"))
      ).toBe(true);
    } finally {
      console.log = originalLog;
    }
  });

  test("retries transient empty replies instead of failing the whole run", async () => {
    let requestCount = 0;
    fetchResponder = async () => {
      requestCount += 1;
      if (requestCount <= 2) {
        // Free models occasionally return 200 with an empty reply.
        return new Response(
          JSON.stringify({ choices: [{ message: { content: null } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "review recovered" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await expect(
      runAgent("system prompt", [], "review this", makeEvent())
    ).resolves.toBe("review recovered");
    expect(requestCount).toBe(3);
  });

  test("executes a requested tool and includes its result in the next request", async () => {
    let requestCount = 0;
    const calls: string[] = [];
    const lookupTool = {
      type: "function",
      function: {
        name: "lookup",
        description: "Find a value by term.",
        inputSchema: z.object({ term: z.string() }),
        execute: async ({ term }: { term: string }) => {
          calls.push(term);
          return { value: `found:${term}` };
        },
      },
    };

    fetchResponder = async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(init?.body as string);
      if (requestCount === 1) {
        expect(body.tools).toMatchObject([
          {
            type: "function",
            function: { name: "lookup", description: "Find a value by term." },
          },
        ]);
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_lookup",
                      type: "function",
                      function: {
                        name: "lookup",
                        arguments: '{"term":"prospect"}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      expect(body.messages.slice(-2)).toEqual([
        expect.objectContaining({
          role: "assistant",
          tool_calls: [expect.objectContaining({ id: "call_lookup" })],
        }),
        {
          role: "tool",
          tool_call_id: "call_lookup",
          content: '{"value":"found:prospect"}',
        },
      ]);
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "final review" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await expect(
      runAgent("system prompt", [lookupTool], "review this", makeEvent())
    ).resolves.toBe("final review");
    expect(calls).toEqual(["prospect"]);
    expect(requestCount).toBe(2);
  });

  test("caps oversized tool results so the context stays within provider limits", async () => {
    let requestCount = 0;
    const hugeTool = {
      type: "function",
      function: {
        name: "fetchHuge",
        description: "Returns an oversized payload (like a full PR diff).",
        inputSchema: z.object({ prNumber: z.number() }),
        execute: async () => ({ diff: "x".repeat(500_000) }),
      },
    };

    fetchResponder = async (_url, init) => {
      requestCount += 1;
      const body = JSON.parse(init?.body as string);
      if (requestCount === 1) {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: "assistant",
                  content: null,
                  tool_calls: [
                    {
                      id: "call_huge",
                      type: "function",
                      function: {
                        name: "fetchHuge",
                        arguments: '{"prNumber": 58}',
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      const toolMessage = body.messages[body.messages.length - 1];
      expect(toolMessage.role).toBe("tool");
      expect(toolMessage.content.length).toBeLessThan(200_000);
      expect(toolMessage.content).toContain("[tool result truncated");
      return new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "final review" } },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    await expect(
      runAgent("system prompt", [hugeTool], "review this", makeEvent())
    ).resolves.toBe("final review");
    expect(requestCount).toBe(2);
  });

  test("truncateToolResult keeps small results intact and marks truncation", () => {
    expect(truncateToolResult("short")).toBe("short");
    const big = truncateToolResult("y".repeat(150_000));
    expect(big.length).toBeLessThan(150_000);
    expect(
      big.endsWith(
        "[tool result truncated: 150000 chars, showing first 120000]"
      )
    ).toBe(true);
  });
});

describe("readRepoFile — PR-head fallback", () => {
  function makePrEvent(): EventInfo {
    return {
      eventName: "pull_request_target",
      repo: "owner/example-repo",
      token: "gh-test-token",
      apiKey: "test-api-key",
      baseURL: "https://openai-proxy.example/v1",
      prNumber: 29,
      isPullRequest: true,
      userRequest: "review PR",
      prDiff:
        "diff --git a/sources/example/brand_new_file.py b/sources/example/brand_new_file.py\nnew file mode 100644\n",
    };
  }

  function findReadRepoFile(tools: any[]): any {
    const t = tools.find(
      (x) => x?.function?.name === "readRepoFile" || x?.name === "readRepoFile"
    );
    if (!t)
      throw new Error("readRepoFile tool not found in createTools() result");
    return t.function ?? t;
  }

  test("reads PR-only files from the PR head via the GitHub API", async () => {
    const fakeContent = "export const live = true;";
    const encoded = Buffer.from(fakeContent, "utf-8").toString("base64");
    const fetchMock = mock(async (url: string) => {
      expect(url).toContain("contents/sources%2Fexample%2Fbrand_new_file.py");
      expect(url).toContain("ref=abc123");
      return new Response(
        JSON.stringify({ content: encoded, encoding: "base64" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    const prevFetch = globalThis.fetch;
    // @ts-expect-error - override for test
    globalThis.fetch = fetchMock;

    try {
      const tools = createTools(
        { ...makePrEvent(), headSha: "abc123" },
        "LINEAR_KEY"
      );
      const tool = findReadRepoFile(tools);
      const result = await tool.execute({
        filePath: "sources/example/brand_new_file.py",
      });
      expect(result.content).toBe(fakeContent);
      expect(fetchMock).toHaveBeenCalled();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });

  test("rejects PR-head reads for files not in the PR diff", async () => {
    const fetchMock = mock(async () => {
      throw new Error("should not be called");
    });
    const prevFetch = globalThis.fetch;
    // @ts-expect-error - override for test
    globalThis.fetch = fetchMock;

    try {
      const tools = createTools(
        { ...makePrEvent(), headSha: "abc123" },
        "LINEAR_KEY"
      );
      const tool = findReadRepoFile(tools);
      await expect(
        tool.execute({ filePath: "secret/config.env" })
      ).rejects.toThrow(/not part of PR/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = prevFetch;
    }
  });
});

describe("parseEvent — smoke (regression: headSha must be in scope)", () => {
  let prevPath: string | undefined;
  let tmp: string;

  beforeEach(() => {
    prevPath = process.env.GITHUB_EVENT_PATH;
    tmp = mkdtempSync(join(tmpdir(), "gitclaw-parse-"));
    process.env.GITHUB_EVENT_NAME = "pull_request_target";
    process.env.GITHUB_REPOSITORY = "owner/example-repo";
    process.env.GITHUB_TOKEN = "gh-test-token";
    process.env.LLM_PROXY_API_KEY = "proxy-test-key";
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevPath === undefined) delete process.env.GITHUB_EVENT_PATH;
    else process.env.GITHUB_EVENT_PATH = prevPath;
  });

  test("reads headSha from the PR payload without ReferenceError", async () => {
    const event = {
      pull_request: {
        number: 42,
        head: { sha: "deadbeefcafe" },
        user: { login: "octocat" },
        title: "test PR",
        body: "body",
      },
    };
    const p = join(tmp, "event.json");
    writeFileSync(p, JSON.stringify(event));
    process.env.GITHUB_EVENT_PATH = p;

    const info = await parseEvent();
    expect(info.isPullRequest).toBe(true);
    expect(info.prNumber).toBe(42);
    expect(info.headSha).toBe("deadbeefcafe");
  });
});

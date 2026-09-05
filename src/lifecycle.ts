// @gitclaw/runtime — shared lifecycle module
// Project-agnostic: event parsing, GitHub API helpers, review submission,
// tool factory, and agent runner. Each consuming project provides its own
// system prompts and agent configuration via the AgentConfig interface.

import { readFileSync, readdirSync, statSync } from "fs";
import { resolve, relative, isAbsolute, sep } from "path";
import { spawnSync } from "child_process";
import { tool } from "@openrouter/agent";
import { z } from "zod";
import { isEmptyChatCompletion } from "./chat-completions";

// --- Project configuration interface ---
// Each project provides its own implementation; the shared module
// only knows about the structure, not the content.

export interface ProjectConfig {
  repoDescription: string;
}

// --- Path safety ---
// Repository root, captured at module load. All tool-executed filesystem
// paths are checked against this root before any I/O.
// GITCLAW_REPO_ROOT lets a CI job point the tools at a separate checkout of
// the reviewed repository (e.g. a reusable workflow that checks out this
// runtime and the target repo side by side). Defaults to the process cwd.
export const REPO_ROOT = resolve(process.env.GITCLAW_REPO_ROOT || ".");

export function isInsideRepo(p: string): boolean {
  const norm =
    process.platform === "win32"
      ? (s: string) => s.toLowerCase()
      : (s: string) => s;
  const rel = relative(norm(REPO_ROOT), norm(p));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  if (rel.startsWith(".." + sep) || rel.startsWith("../")) return false;
  return true;
}

// --- GitHub API helpers ---

async function fetchPrDiff(
  repo: string,
  prNumber: number,
  token: string
): Promise<string> {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github.diff",
      "User-Agent": "Bun-GitHub-Actions",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch PR diff: ${response.statusText} (${await response.text()})`
    );
  }
  return await response.text();
}

/**
 * Reads a file from a PR's head commit via the GitHub Contents API.
 * Used as a fallback by `readRepoFile` when a file exists only in the PR
 * (i.e. it is not present in the base checkout that the reviewer runs against).
 * The requested path is restricted to files touched by the PR diff to avoid
 * exposing arbitrary repository contents through an untrusted PR ref.
 */
async function fetchPrFile(
  repo: string,
  prNumber: number,
  token: string,
  filePath: string,
  headSha: string,
  allowedPaths: Set<string>
): Promise<string> {
  if (!allowedPaths.has(filePath)) {
    throw new Error(
      `Permission denied: '${filePath}' is not part of PR #${prNumber} and cannot be read from the PR head.`
    );
  }
  const url = `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(
    filePath
  )}?ref=${headSha}`;
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Bun-GitHub-Actions",
    },
  });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch PR file '${filePath}': ${response.statusText} (${await response.text()})`
    );
  }
  const data: any = await response.json();
  if (typeof data.content !== "string") {
    throw new Error(`PR file '${filePath}' has no readable content.`);
  }
  return Buffer.from(data.content, data.encoding || "base64").toString("utf-8");
}

export async function submitPrReview(
  repo: string,
  prNumber: number,
  body: string,
  eventType: "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
  comments: any[],
  token: string
) {
  const url = `https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "Bun-GitHub-Actions",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      body: body,
      event: eventType,
      comments: comments && comments.length > 0 ? comments : undefined,
    }),
  });

  if (response.ok) {
    console.log("PR Review submitted successfully.");
    return;
  }

  const errorBody = await response.text();
  console.error(
    `PR review API error: HTTP ${response.status} ${response.statusText}`
  );
  console.error(`Response body: ${errorBody.substring(0, 500)}`);

  if (response.status === 422 && comments && comments.length > 0) {
    console.warn(
      "422 from PR review API — retrying without inline comments..."
    );
    const retryResponse = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ body, event: eventType }),
    });
    if (retryResponse.ok) {
      console.log(
        "PR Review submitted successfully (without inline comments)."
      );
      return;
    }
    const retryBody = await retryResponse.text();
    console.error(
      `Retry also failed: HTTP ${retryResponse.status} — ${retryBody.substring(0, 300)}`
    );
  }

  throw new Error(
    `Failed to submit PR review: ${response.statusText} (${errorBody.substring(0, 200)})`
  );
}

export async function postIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
  token: string
) {
  const url = `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "Bun-GitHub-Actions",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ body }),
  });
  if (!response.ok) {
    throw new Error(
      `Failed to post issue comment: ${response.statusText} (${await response.text()})`
    );
  }
  console.log("Issue comment posted successfully.");
}

// --- Event parsing ---

export interface EventInfo {
  eventName: string;
  repo: string;
  token: string;
  apiKey: string;
  baseURL: string;
  prNumber?: number;
  issueNumber?: number;
  isPullRequest: boolean;
  userRequest: string;
  prDiff: string;
  /** Head commit SHA of the PR, used to read PR-only files via the GitHub API. */
  headSha?: string;
}

export function buildStaticContext(repoRoot = REPO_ROOT): string {
  const contextFiles = [
    [
      "AGENTS.md",
      "AGENTS.md (Critical rules and invariants. You MUST follow them strictly!)",
      100_000,
    ],
    [".hermes.md", ".hermes.md (Project policy and hard constraints)", 40_000],
    ["README.md", "README.md", 20_000],
    [
      ".gitclaw/worker.json",
      ".gitclaw/worker.json (Optional reviewer configuration)",
      20_000,
    ],
  ] as const;

  let staticContext = "";
  for (const [fileName, label, maxChars] of contextFiles) {
    const filePath = resolve(repoRoot, fileName);
    try {
      if (statSync(filePath).isFile()) {
        staticContext += `${label}:\n${readFileSync(filePath, "utf-8").substring(0, maxChars)}\n\n`;
      }
    } catch {
      // Every file is optional so this runtime works in repositories with
      // different policy/configuration layouts.
    }
  }
  return staticContext;
}

export async function parseEvent(): Promise<EventInfo> {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    console.error("Error: No GITHUB_EVENT_PATH environment variable found.");
    process.exit(1);
  }

  let event: any;
  try {
    event = JSON.parse(readFileSync(eventPath, "utf-8"));
  } catch (error) {
    console.error("Error: Failed to parse GITHUB_EVENT_PATH JSON file.", error);
    process.exit(1);
  }

  const eventName = process.env.GITHUB_EVENT_NAME;
  const repo = process.env.GITHUB_REPOSITORY || event.repository?.full_name;
  const token = process.env.GITHUB_TOKEN;
  const apiKey = process.env.LLM_PROXY_API_KEY;
  const baseURL =
    process.env.CF_WORKER_URL || "https://openai-proxy.amatjkay.workers.dev/v1";

  if (!repo) {
    console.error("Error: Could not determine repository name.");
    process.exit(1);
  }
  if (!token) {
    console.error("Error: GITHUB_TOKEN environment variable is missing.");
    process.exit(1);
  }
  if (!apiKey) {
    console.error("Error: LLM_PROXY_API_KEY environment variable is missing.");
    process.exit(1);
  }

  let userRequest = "";
  let prNumber: number | undefined = undefined;
  let issueNumber: number | undefined = undefined;
  let isPullRequest = false;
  let prDiff = "";
  let headSha: string | undefined = undefined;

  if (eventName === "pull_request" || eventName === "pull_request_target") {
    isPullRequest = true;
    prNumber = event.pull_request?.number;
    headSha = event.pull_request?.head?.sha;
    const author = event.pull_request?.user?.login;
    const title = event.pull_request?.title;
    const body = event.pull_request?.body || "";
    userRequest = `Pull Request #${prNumber} "${title}" opened by ${author}:\n\n${body}`;

    console.log(`Fetching Pull Request Diff for PR #${prNumber}...`);
    try {
      prDiff = await fetchPrDiff(repo, prNumber, token);
    } catch (diffErr) {
      console.error("Failed to fetch PR diff, proceeding without it:", diffErr);
    }
  } else if (eventName === "issue_comment") {
    issueNumber = event.issue?.number;
    const author = event.comment?.user?.login;
    userRequest = `Comment by ${author} in issue #${issueNumber}:\n\n${event.comment.body}`;
  } else if (eventName === "issues") {
    issueNumber = event.issue?.number;
    const author = event.issue?.user?.login;
    userRequest = `Issue #${issueNumber} "${event.issue.title}" opened by ${author}:\n\n${event.issue.body}`;
  } else {
    console.error(`Error: Unsupported GitHub event name: ${eventName}`);
    process.exit(1);
  }

  const targetNumber = prNumber || issueNumber;
  if (!targetNumber) {
    console.error(
      "Error: Could not determine Issue/PR number from event payload."
    );
    process.exit(1);
  }

  void buildStaticContext;

  return {
    eventName,
    repo,
    token,
    apiKey,
    baseURL,
    prNumber,
    issueNumber,
    isPullRequest,
    userRequest,
    prDiff,
    headSha,
  };
}

// --- Review submission ---

export interface Finding {
  file?: string;
  line?: number;
  severity: string;
  message: string;
}

export interface ReviewResult {
  summary: string;
  recommendation: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  findings: Finding[];
}

export async function submitReview(
  event: EventInfo,
  result: ReviewResult,
  agentName: string,
  agentMarker: string
): Promise<void> {
  const { isPullRequest, prNumber, issueNumber, repo, token, baseURL } = event;
  const targetNumber = prNumber || issueNumber!;

  const isApprove = result.recommendation === "APPROVE";
  const isRequestChanges = result.recommendation === "REQUEST_CHANGES";
  const commentsArray: any[] = [];

  const agentFooter = `\n\n---\n<!-- ${agentMarker} -->\n*🤖 Answered by ${agentName}*\n- **Model**: \`auto\` (Cloudflare Worker cascade; check CI log's \`X-Provider-Info\` header for the resolved provider/model)\n- **Router**: \`${baseURL}\``;

  let prBody = `### ${agentName} Review\n\n**Summary:**\n${result.summary}\n\n**Recommendation:** \`${result.recommendation}\`${agentFooter}`;

  for (const finding of result.findings) {
    let emoji = "🟢";
    if (finding.severity === "critical") emoji = "🔴";
    if (finding.severity === "warning") emoji = "🟡";

    const findingMsg = `${emoji} **[${(finding.severity || "info").toUpperCase()}]** ${finding.message}`;
    if (isPullRequest && finding.file) {
      commentsArray.push({
        path: finding.file,
        line: finding.line || undefined,
        body: findingMsg,
      });
    } else {
      prBody += `\n\n${findingMsg}`;
    }
  }

  console.log("Response compiled. Submitting feedback back to GitHub...");
  console.log(
    `submitReview: isPullRequest=${isPullRequest} prNumber=${prNumber} issueNumber=${issueNumber} repo=${repo}`
  );

  if (isPullRequest && prNumber) {
    try {
      const eventType = isRequestChanges
        ? "REQUEST_CHANGES"
        : isApprove
          ? "APPROVE"
          : "COMMENT";
      console.log(
        `submitReview: calling submitPrReview (event=${eventType}, comments=${commentsArray.length})`
      );
      await submitPrReview(
        repo,
        prNumber,
        prBody,
        eventType,
        commentsArray,
        token
      );
    } catch (reviewError) {
      console.warn(
        "Failed to submit PR review, falling back to standard issue comment:",
        reviewError
      );
      await postIssueComment(repo, prNumber, prBody, token);
    }
  } else {
    await postIssueComment(repo, targetNumber, prBody, token);
  }

  console.log("Success! Feedback posted successfully.");
}

// --- Agent tools factory ---

export function createTools(event: EventInfo, linearApiKey?: string) {
  const { repo, token, prDiff, prNumber, issueNumber, headSha } = event;
  const targetNumber = prNumber || issueNumber!;

  // Files touched by the PR, used to restrict PR-head file reads.
  const prFilePaths = new Set<string>();
  if (prDiff) {
    const re = /^diff --git a\/(.+?) b\/(.+?)$/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(prDiff)) !== null) {
      prFilePaths.add(m[1]);
      prFilePaths.add(m[2]);
    }
  }

  const fetchPrDiffTool = tool({
    name: "fetchPrDiff",
    description:
      "Fetches the raw git diff of a specific Pull Request from the GitHub API.",
    inputSchema: z.object({
      prNumber: z
        .number()
        .describe("The number of the Pull Request to fetch the diff for."),
    }),
    outputSchema: z.object({
      diff: z.string(),
    }),
    execute: async ({ prNumber }: { prNumber: number }) => {
      if (prDiff && prNumber === targetNumber) {
        return { diff: prDiff };
      }
      const fetchedDiff = await fetchPrDiff(repo, prNumber, token);
      return { diff: fetchedDiff };
    },
  });

  const readRepoFileTool = tool({
    name: "readRepoFile",
    description:
      "Reads the content of a specific file inside the repository workspace.",
    inputSchema: z.object({
      filePath: z
        .string()
        .describe(
          "The relative path of the file to read (e.g. 'src/engine.py')."
        ),
    }),
    outputSchema: z.object({
      content: z.string(),
    }),
    execute: async ({ filePath }: { filePath: string }) => {
      const resolvedPath = resolve(REPO_ROOT, filePath);
      if (!isInsideRepo(resolvedPath)) {
        throw new Error(
          `Permission denied: Cannot read file outside repository workspace: ${filePath}`
        );
      }
      // Local checkout is the base branch; PR-only files live on the PR head.
      try {
        const content = readFileSync(resolvedPath, "utf-8");
        return { content };
      } catch (err: any) {
        if (err?.code === "ENOENT" && prNumber && headSha) {
          if (prFilePaths.has(filePath)) {
            const content = await fetchPrFile(
              repo,
              prNumber,
              token,
              filePath,
              headSha,
              prFilePaths
            );
            return { content };
          }
          throw new Error(
            `Permission denied: '${filePath}' is not part of PR #${prNumber} and cannot be read from the PR head.`
          );
        }
        throw err;
      }
    },
  });

  const listRepoDirectoryTool = tool({
    name: "listRepoDirectory",
    description:
      "Lists the contents (files and directories) of a specific folder in the repository workspace.",
    inputSchema: z.object({
      dirPath: z
        .string()
        .describe(
          "The relative path of the directory to list (e.g. 'src/core'). Use '.' for root."
        ),
    }),
    outputSchema: z.object({
      files: z.array(z.string()),
    }),
    execute: async ({ dirPath }: { dirPath: string }) => {
      const resolvedPath = resolve(REPO_ROOT, dirPath);
      if (!isInsideRepo(resolvedPath)) {
        throw new Error(
          `Permission denied: Cannot list directory outside repository workspace: ${dirPath}`
        );
      }
      const files = readdirSync(resolvedPath);
      return { files };
    },
  });

  // Defence-in-depth for issueId: validate the generic Linear project-key
  // format before any API call. This still keeps untrusted input out of the
  // GraphQL query, which is always parameterized below.
  const LINEAR_ISSUE_ID_RE = /^[A-Z][A-Z0-9]{1,19}-[1-9]\d*$/;

  const readLinearIssueTool = tool({
    name: "readLinearIssue",
    description:
      "Fetches issue details from Linear. Use this if the PR references an issue ID like 'ABC-123'.",
    inputSchema: z.object({
      issueId: z
        .string()
        .describe("The Linear issue identifier (e.g., 'ABC-123')."),
    }),
    outputSchema: z.object({
      title: z.string(),
      description: z.string(),
      state: z.string(),
    }),
    execute: async ({ issueId }: { issueId: string }) => {
      if (!linearApiKey) {
        throw new Error(
          "A Linear API key is not configured in the environment."
        );
      }
      if (!LINEAR_ISSUE_ID_RE.test(issueId)) {
        return {
          title: "Invalid",
          description: `Invalid issueId format: \"${issueId}\". Expected PROJECT-<n> (e.g. ABC-123).`,
          state: "Unknown",
        };
      }
      const response = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: linearApiKey,
        },
        body: JSON.stringify({
          query:
            "query($id: String!) { issue(id: $id) { title description state { name } } }",
          variables: { id: issueId },
        }),
      });
      if (!response.ok) {
        throw new Error(`Linear API request failed: ${response.statusText}`);
      }
      const json = await response.json();
      if (json.errors) {
        throw new Error(`Linear GraphQL Error: ${JSON.stringify(json.errors)}`);
      }
      if (!json.data || !json.data.issue) {
        return {
          title: "Not Found",
          description: `Issue ${issueId} not found in Linear.`,
          state: "Unknown",
        };
      }
      return {
        title: json.data.issue.title,
        description: json.data.issue.description || "No description provided.",
        state: json.data.issue.state.name,
      };
    },
  });

  const searchCodeTool = tool({
    name: "searchCode",
    description: "Searches the codebase for a given pattern using grep.",
    inputSchema: z.object({
      query: z.string().describe("The search pattern (e.g. 'functionName')."),
    }),
    outputSchema: z.object({
      results: z.string(),
    }),
    execute: async ({ query }: { query: string }) => {
      // Use spawnSync with an argv array — no shell interpolation.
      // Self-healing: register REPO_ROOT as safe before git grep.
      spawnSync(
        "git",
        ["config", "--global", "--add", "safe.directory", REPO_ROOT],
        {
          cwd: REPO_ROOT,
          encoding: "utf-8",
          maxBuffer: 1024 * 1024 * 5,
        }
      );
      const result = spawnSync("git", ["grep", "--", query], {
        cwd: REPO_ROOT,
        encoding: "utf-8",
        maxBuffer: 1024 * 1024 * 5,
      });
      if (result.status === 1) {
        return { results: "No matches found." };
      }
      if (result.error) {
        throw new Error(`grep failed: ${result.error.message}`);
      }
      if (result.status !== 0) {
        throw new Error(
          `grep failed: ${(result.stderr || "").trim() || `exit ${result.status}`}`
        );
      }
      return { results: (result.stdout || "").substring(0, 15000) };
    },
  });

  const tools: any[] = [
    fetchPrDiffTool,
    readRepoFileTool,
    listRepoDirectoryTool,
    searchCodeTool,
  ];
  if (linearApiKey) tools.push(readLinearIssueTool);
  return tools;
}

// --- Non-streaming agent runner ---
const MAX_AGENT_RETRIES = 3;
const MAX_AGENT_STEPS = 15;
const EMPTY_RESPONSE_RETRIES = 2;
const AGENT_TIMEOUT_MS = Number(process.env.AGENT_TIMEOUT_MS) || 300_000;

// Tool results can be arbitrarily large — fetchPrDiff returns the whole PR
// diff. An unbounded diff pushed the conversation over provider context
// windows: Mistral rejects it with HTTP 400 invalid_request_prompt_too_long
// (262144 tokens, all models), qwen empty-200s on long contexts. Cap each
// tool result so the conversation stays within every provider's window; the
// user message already embeds a diff excerpt, so the tail is a bonus, not
// the primary source.
const MAX_TOOL_RESULT_CHARS = 30_000;

export function truncateToolResult(content: string): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) return content;
  return `${content.slice(
    0,
    MAX_TOOL_RESULT_CHARS
  )}\n...[tool result truncated: ${content.length} chars, showing first ${MAX_TOOL_RESULT_CHARS}]`;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function chatCompletionsUrl(baseURL: string): string {
  return `${baseURL.replace(/\/+$/, "")}/chat/completions`;
}

function extractChatCompletionText(response: any): string {
  const content = response?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (item: any) => item?.type === "text" && typeof item.text === "string"
      )
      .map((item: any) => item.text)
      .join("");
  }
  return "";
}

interface ChatToolCall {
  id: string;
  name: string;
  arguments: string | Record<string, unknown>;
}

function toChatCompletionTools(tools: any[]): Array<Record<string, unknown>> {
  return tools.map((toolDefinition) => {
    const definition = toolDefinition.function || toolDefinition;
    const schema = definition.inputSchema || definition.parameters || {};
    return {
      type: "function",
      function: {
        name: definition.name,
        description: definition.description || "",
        parameters:
          schema && typeof schema === "object" && "_zod" in schema
            ? z.toJSONSchema(schema)
            : schema,
      },
    };
  });
}

function extractChatCompletionToolCalls(response: any): ChatToolCall[] {
  return (response?.choices?.[0]?.message?.tool_calls || [])
    .filter(
      (item: any) =>
        item?.type === "function" && typeof item?.function?.name === "string"
    )
    .map((item: any, index: number) => ({
      id: typeof item.id === "string" ? item.id : `call_${index}`,
      name: item.function.name,
      arguments: item.function.arguments || "{}",
    }));
}

async function invokeTool(tools: any[], call: ChatToolCall): Promise<unknown> {
  const toolDefinition = tools.find(
    (candidate) => (candidate.function || candidate).name === call.name
  );
  const execute =
    toolDefinition && (toolDefinition.function || toolDefinition).execute;
  if (typeof execute !== "function") {
    throw new Error(`Model requested unavailable tool: ${call.name}`);
  }

  const args =
    typeof call.arguments === "string"
      ? JSON.parse(call.arguments)
      : call.arguments;
  console.log(
    `🔧 [Tool Call] Using tool "${call.name}" with arguments:`,
    JSON.stringify(args)
  );
  return execute(args);
}

async function callChatCompletionsApi(
  event: EventInfo,
  messages: ChatMessage[],
  tools: any[]
): Promise<any> {
  const response = await fetch(chatCompletionsUrl(event.baseURL), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${event.apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "auto",
      messages,
      stream: false,
      max_tokens: 2000,
      ...(tools.length ? { tools: toChatCompletionTools(tools) } : {}),
    }),
    signal: AbortSignal.timeout(AGENT_TIMEOUT_MS),
  });

  // The Worker always stamps X-Provider-Info (e.g. "tokenrouter/qwen/qwen3.8-max-free")
  // and X-Provider-Error-N when a provider failed — surface them in the CI log
  // so every review shows which provider/model actually answered.
  const providerInfo = response.headers.get("X-Provider-Info");
  const providerErrors = Array.from({ length: 8 }, (_, i) =>
    response.headers.get(`X-Provider-Error-${i}`)
  ).filter((e): e is string => !!e);
  console.log(
    `[Provider] ${providerInfo ?? "unknown"}${providerErrors.length ? ` | errors: ${providerErrors.join(" | ")}` : ""}`
  );

  if (!response.ok) {
    // 502 details list every provider/model/key failure, but GitHub Actions
    // truncates long log lines — log each reason on its own line so the full
    // cascade is visible (e.g. whether hy3-free also answered empty 200).
    const detail = await response.text();
    try {
      const parsed = JSON.parse(detail);
      const details = parsed?.error?.details;
      if (Array.isArray(details)) {
        console.warn(`[Provider] 502 with ${details.length} failures:`);
        details.forEach((d: string) => console.warn(`[Provider]   - ${d}`));
      } else {
        console.warn(`[Provider] 502: ${detail}`);
      }
    } catch {
      console.warn(`[Provider] 502: ${detail}`);
    }
    throw new Error(`Worker HTTP ${response.status}: ${detail}`);
  }
  return response.json();
}

export async function runAgent(
  systemPrompt: string,
  tools: any[],
  userMessage: string,
  event: EventInfo
): Promise<string> {
  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= MAX_AGENT_RETRIES; attempt++) {
    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ];

    try {
        for (let step = 1; step <= MAX_AGENT_STEPS; step++) {
          console.log(
            `🤖 [Agent request] (attempt ${attempt}/${MAX_AGENT_RETRIES}, step ${step}/${MAX_AGENT_STEPS})`
          );
          const isLastStep = step === MAX_AGENT_STEPS;
          if (isLastStep) {
            messages.push({
              role: "user",
              content:
                "Step budget reached. Do not invoke any tools. Synthesize all findings collected so far and return the final JSON review object immediately.",
            });
          }
          const stepTools = isLastStep ? [] : tools;
          // Free models (qwen3.8-max-free) occasionally return HTTP 200 with an
          // empty reply (no text, no tool calls) on long tool-heavy contexts.
          // Retry the same request a few times before giving up — a fresh draw
          // usually yields a real answer, and losing the whole agent run over a
          // transient empty response wastes the review.
          let replyText = "";
          let toolCalls: ChatToolCall[] = [];
          for (let empty = 0; empty <= EMPTY_RESPONSE_RETRIES; empty++) {
            const response = await callChatCompletionsApi(
              event,
              messages,
              stepTools
            );
            replyText = extractChatCompletionText(response);
            toolCalls = extractChatCompletionToolCalls(response);
            // Same empty-reply contract as the Worker router (chat-completions.ts).
            if (!isEmptyChatCompletion(response)) break;
            console.warn(
              `⚠️ [Agent request] (attempt ${attempt}/${MAX_AGENT_RETRIES}, step ${step}/${MAX_AGENT_STEPS}) model returned an empty reply; retrying (${empty + 1}/${EMPTY_RESPONSE_RETRIES})`
            );
          }

        if (toolCalls.length === 0) {
          if (!replyText.trim()) throw new Error("Empty response from model");
          return replyText;
        }

        messages.push({
          role: "assistant",
          content: replyText || null,
          tool_calls: toolCalls.map((toolCall) => ({
            id: toolCall.id,
            type: "function",
            function: {
              name: toolCall.name,
              arguments:
                typeof toolCall.arguments === "string"
                  ? toolCall.arguments
                  : JSON.stringify(toolCall.arguments),
            },
          })),
        });
        for (const toolCall of toolCalls) {
          const result = await invokeTool(tools, toolCall);
          messages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: truncateToolResult(JSON.stringify(result)),
          });
        }
      }
      throw new Error(`Agent exceeded max steps (${MAX_AGENT_STEPS})`);
    } catch (err: any) {
      lastError = err;
      const msg = err?.message || String(err);
      if (attempt < MAX_AGENT_RETRIES) {
        console.warn(`⚠️ [Attempt ${attempt} failed]: ${msg}. Retrying...`);
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Agent failed after all retries");
}

// --- JSON parsing ---

export function parseJsonReview(replyText: string): ReviewResult {
  let clean = replyText.trim();
  if (clean.startsWith("```json")) {
    clean = clean.substring(7);
    if (clean.endsWith("```")) clean = clean.slice(0, -3);
    clean = clean.trim();
  }
  const parsed = JSON.parse(clean);
  return {
    summary: parsed.summary || "No summary provided.",
    recommendation: parsed.recommendation || "COMMENT",
    findings: Array.isArray(parsed.findings) ? parsed.findings : [],
  };
}

export function parseJsonReviewSafe(replyText: string): ReviewResult {
  try {
    return parseJsonReview(replyText);
  } catch {
    return {
      summary: replyText.trim() || "No summary provided.",
      recommendation: "COMMENT",
      findings: [],
    };
  }
}

// --- Re-export types and re-export the openrouter agent for convenience ---
export type {
  Tool,
  StopCondition,
  StreamableOutputItem,
  CompletionResult,
} from "@openrouter/agent";

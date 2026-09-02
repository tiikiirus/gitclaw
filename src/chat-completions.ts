// Shared "is this chat-completions payload empty?" contract.
// Both the Worker router (empty-200 cascade) and the client (empty-reply
// retry) must agree on what "empty" means, or the router can pass through a
// payload the client then treats as an empty reply (and vice versa).

interface ChatMessageLike {
  content?: unknown;
  tool_calls?: unknown;
  toolCalls?: unknown;
}

function messageText(message: ChatMessageLike | undefined): string {
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter(
        (item: any) => item?.type === "text" && typeof item.text === "string"
      )
      .map((item: any) => item.text)
      .join("")
      .trim();
  }
  return "";
}

function messageToolCalls(message: ChatMessageLike | undefined): unknown[] {
  if (!message) return [];
  if (Array.isArray(message.tool_calls)) return message.tool_calls;
  if (Array.isArray(message.toolCalls)) return message.toolCalls;
  return [];
}

/**
 * True when the payload carries no usable text and no tool calls in the
 * first choice (the one the client reads). The router uses this to treat an
 * HTTP 200 as a cascade failure; the client uses it to retry the request.
 */
export function isEmptyChatCompletion(response: unknown): boolean {
  if (!response || typeof response !== "object") return true;
  const choices = (response as any).choices as unknown[] | undefined;
  if (!Array.isArray(choices) || choices.length === 0) return true;
  const choice = choices[0] as
    { message?: ChatMessageLike; delta?: ChatMessageLike } | undefined;
  const message = choice?.message ?? choice?.delta ?? {};
  return messageText(message) === "" && messageToolCalls(message).length === 0;
}

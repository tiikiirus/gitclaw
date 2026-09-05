import { describe, expect, test } from "bun:test";
import { isEmptyChatCompletion } from "./chat-completions";

describe("isEmptyChatCompletion — shared router/client contract", () => {
  test("no choices → empty", () => {
    expect(isEmptyChatCompletion({ choices: [] })).toBe(true);
  });

  test("missing payload → empty", () => {
    expect(isEmptyChatCompletion(null)).toBe(true);
    expect(isEmptyChatCompletion(undefined)).toBe(true);
    expect(isEmptyChatCompletion({})).toBe(true);
  });

  test("content string → not empty", () => {
    expect(
      isEmptyChatCompletion({
        choices: [{ message: { content: "review ok" } }],
      }),
    ).toBe(false);
  });

  test("whitespace-only content → empty", () => {
    expect(
      isEmptyChatCompletion({
        choices: [{ message: { content: "   " } }],
      }),
    ).toBe(true);
  });

  test("null content without tool calls → empty", () => {
    expect(
      isEmptyChatCompletion({
        choices: [{ message: { content: null } }],
      }),
    ).toBe(true);
  });

  test("tool calls → not empty even with null content", () => {
    expect(
      isEmptyChatCompletion({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                { id: "c1", type: "function", function: { name: "lookup" } },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  test("text content parts (array) → not empty", () => {
    expect(
      isEmptyChatCompletion({
        choices: [
          {
            message: {
              content: [
                { type: "text", text: "first" },
                { type: "text", text: " second" },
              ],
            },
          },
        ],
      }),
    ).toBe(false);
  });

  test("delta variant is honoured (streaming-shaped payload)", () => {
    expect(
      isEmptyChatCompletion({ choices: [{ delta: { content: "" } }] }),
    ).toBe(true);
    expect(
      isEmptyChatCompletion({ choices: [{ delta: { content: "ok" } }] }),
    ).toBe(false);
  });

  test("non-object payload → empty (callers parse JSON first)", () => {
    expect(isEmptyChatCompletion("")).toBe(true);
  });
});

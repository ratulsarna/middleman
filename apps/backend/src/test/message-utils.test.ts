import { describe, expect, it } from "vitest";
import { extractMessageText, extractMessageThinking } from "../swarm/message-utils.js";

describe("extractMessageThinking", () => {
  it("returns undefined for null/undefined message", () => {
    expect(extractMessageThinking(null)).toBeUndefined();
    expect(extractMessageThinking(undefined)).toBeUndefined();
  });

  it("returns undefined for non-object message", () => {
    expect(extractMessageThinking("hello")).toBeUndefined();
    expect(extractMessageThinking(42)).toBeUndefined();
  });

  it("returns undefined when thinking field is absent", () => {
    expect(extractMessageThinking({ role: "assistant", content: [] })).toBeUndefined();
  });

  it("returns undefined when thinking is not a string", () => {
    expect(extractMessageThinking({ thinking: 123 })).toBeUndefined();
    expect(extractMessageThinking({ thinking: true })).toBeUndefined();
    expect(extractMessageThinking({ thinking: {} })).toBeUndefined();
    expect(extractMessageThinking({ thinking: [] })).toBeUndefined();
  });

  it("returns undefined for empty string thinking", () => {
    expect(extractMessageThinking({ thinking: "" })).toBeUndefined();
  });

  it("returns undefined for whitespace-only thinking", () => {
    expect(extractMessageThinking({ thinking: "   " })).toBeUndefined();
    expect(extractMessageThinking({ thinking: "\n\t\n" })).toBeUndefined();
  });

  it("returns trimmed thinking text", () => {
    expect(extractMessageThinking({ thinking: "  reasoning here  " })).toBe("reasoning here");
  });

  it("returns thinking text from a complete message object", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "response" }],
      thinking: "I should analyze this carefully",
    };
    expect(extractMessageThinking(message)).toBe("I should analyze this carefully");
  });
});

describe("extractMessageText", () => {
  it("returns undefined for null/undefined message", () => {
    expect(extractMessageText(null)).toBeUndefined();
    expect(extractMessageText(undefined)).toBeUndefined();
  });

  it("returns string content directly", () => {
    expect(extractMessageText({ content: "hello" })).toBe("hello");
  });

  it("extracts text from content block arrays", () => {
    const message = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
    };
    expect(extractMessageText(message)).toBe("first\nsecond");
  });

  it("ignores non-text content blocks", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "reasoning" },
        { type: "text", text: "response" },
        { type: "image", data: "abc" },
      ],
    };
    expect(extractMessageText(message)).toBe("response");
  });

  it("returns undefined for empty content array", () => {
    expect(extractMessageText({ content: [] })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  isConversationMessageEvent,
  isConversationEntryEvent,
} from "../swarm/conversation-validators.js";

function validConversationMessage(overrides: Record<string, unknown> = {}) {
  return {
    type: "conversation_message",
    agentId: "agent-1",
    role: "assistant",
    text: "hello",
    timestamp: "2026-03-03T11:00:00.000Z",
    source: "speak_to_user",
    ...overrides,
  };
}

describe("isConversationMessageEvent", () => {
  it("accepts a valid conversation_message without thinking", () => {
    expect(isConversationMessageEvent(validConversationMessage())).toBe(true);
  });

  it("accepts a conversation_message with string thinking", () => {
    expect(
      isConversationMessageEvent(
        validConversationMessage({ thinking: "I need to analyze this" })
      )
    ).toBe(true);
  });

  it("accepts a conversation_message with undefined thinking", () => {
    expect(
      isConversationMessageEvent(
        validConversationMessage({ thinking: undefined })
      )
    ).toBe(true);
  });

  it("rejects a conversation_message with non-string thinking", () => {
    expect(
      isConversationMessageEvent(validConversationMessage({ thinking: 42 }))
    ).toBe(false);

    expect(
      isConversationMessageEvent(validConversationMessage({ thinking: true }))
    ).toBe(false);

    expect(
      isConversationMessageEvent(validConversationMessage({ thinking: {} }))
    ).toBe(false);

    expect(
      isConversationMessageEvent(validConversationMessage({ thinking: [] }))
    ).toBe(false);
  });

  it("rejects null and non-object values", () => {
    expect(isConversationMessageEvent(null)).toBe(false);
    expect(isConversationMessageEvent(undefined)).toBe(false);
    expect(isConversationMessageEvent("string")).toBe(false);
  });
});

describe("isConversationEntryEvent", () => {
  it("accepts a conversation_message with thinking via the entry guard", () => {
    expect(
      isConversationEntryEvent(
        validConversationMessage({ thinking: "reasoning text" })
      )
    ).toBe(true);
  });

  it("accepts a conversation_message without thinking via the entry guard", () => {
    expect(isConversationEntryEvent(validConversationMessage())).toBe(true);
  });
});

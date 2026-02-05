/**
 * Tests for reaction operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { addReaction, removeReaction, type ConnectedSpace } from "../../src";

// Mock ConnectedSpace
const mockSendEvent = vi.fn();
const mockSpace = {
  sendEvent: mockSendEvent,
  streamDid: "did:web:test.example",
} as unknown as ConnectedSpace;

beforeEach(() => {
  mockSendEvent.mockClear();
});

describe("addReaction", () => {
  it("creates an add reaction event with emoji", async () => {
    const result = await addReaction(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      reaction: "👍",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/); // ULID format
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.reaction.addReaction.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reactionTo: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reaction: "👍",
    });
  });

  it("creates an add reaction event with custom emoji", async () => {
    await addReaction(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      reaction: "custom_emoji_name",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.reaction).toBe("custom_emoji_name");
  });

  it("creates an add reaction event with text reaction", async () => {
    await addReaction(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      reaction: "+1",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.reaction).toBe("+1");
  });
});

describe("removeReaction", () => {
  it("creates a remove reaction event", async () => {
    const result = await removeReaction(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      reactionId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/); // ULID format
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.reaction.removeReaction.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reactionId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

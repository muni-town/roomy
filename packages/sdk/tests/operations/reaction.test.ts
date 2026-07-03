/**
 * Tests for reaction operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { addReaction, removeReaction } from "../../src";

const mockSendEvent = vi.fn();

beforeEach(() => {
  mockSendEvent.mockClear();
});

describe("addReaction", () => {
  it("creates an add reaction event with emoji", async () => {
    const result = await addReaction({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reaction: "👍",
    }, mockSendEvent);

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
    await addReaction({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reaction: "custom_emoji_name",
    }, mockSendEvent);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.reaction).toBe("custom_emoji_name");
  });

  it("creates an add reaction event with text reaction", async () => {
    await addReaction({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reaction: "+1",
    }, mockSendEvent);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.reaction).toBe("+1");
  });
});

describe("removeReaction", () => {
  it("creates a remove reaction event", async () => {
    const result = await removeReaction({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      reactionId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    }, mockSendEvent);

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

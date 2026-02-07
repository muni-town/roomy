/**
 * Tests for message operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { ULID } from "ulidx";
import {
  createMessage,
  editMessage,
  deleteMessage,
  reorderMessage,
  forwardMessages,
  type ConnectedSpace,
} from "../../src";

// Mock ConnectedSpace
const mockSendEvent = vi.fn();
const mockSpace = {
  sendEvent: mockSendEvent,
  streamDid: "did:web:test.example",
} as unknown as ConnectedSpace;

beforeEach(() => {
  mockSendEvent.mockClear();
});

describe("createMessage", () => {
  it("creates a basic message event", async () => {
    const result = await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Hello, world!",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/); // ULID format
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.message.createMessage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      body: {
        mimeType: "text/markdown",
      },
    });
    // Verify data is a CBOR-encoded bytes object
    expect(event.body.data).toHaveProperty("$bytes");
    expect(typeof event.body.data.$bytes).toBe("string");
  });

  it("creates a message with custom MIME type", async () => {
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "plain text",
      mimeType: "text/plain",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.body.mimeType).toBe("text/plain");
  });

  it("creates a message with reply attachment", async () => {
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Reply message",
      replyTo: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.attachments).toEqual([
      {
        $type: "space.roomy.attachment.reply.v0",
        target: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    ]);
  });

  it("creates a message with attachments extension", async () => {
    const attachments = [
      {
        $type: "space.roomy.attachment.image.v0",
        uri: "https://example.com/image.png",
        mimeType: "image/png",
      },
    ];

    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Image message",
      attachments,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.extensions).toMatchObject({
      "space.roomy.extension.attachments.v0": {
        $type: "space.roomy.extension.attachments.v0",
        attachments,
      },
    });
  });

  it("creates a message with author override extension", async () => {
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Message",
      authorDid: "did:discord:12345",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.extensions).toMatchObject({
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: "did:discord:12345",
      },
    });
  });

  it("creates a message with timestamp override extension", async () => {
    const timestamp = 1704067200000; // 2024-01-01
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Message",
      timestamp,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.extensions).toMatchObject({
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp,
      },
    });
  });

  it("creates a message with custom extensions", async () => {
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Message",
      extensions: {
        "custom.extension.v1": { custom: "data" },
      },
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.extensions).toMatchObject({
      "custom.extension.v1": { custom: "data" },
    });
  });

  it("includes both reply attachments and custom extensions", async () => {
    await createMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Message",
      replyTo: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      extensions: {
        "custom.extension.v1": { custom: "data" },
      },
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.attachments).toHaveLength(1);
    expect(event.attachments).toEqual([
      {
        $type: "space.roomy.attachment.reply.v0",
        target: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      },
    ]);
    expect(event.extensions).toMatchObject({
      "custom.extension.v1": { custom: "data" },
    });
  });
});

describe("editMessage", () => {
  it("creates an edit message event", async () => {
    const result = await editMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Edited message",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.message.editMessage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      body: {
        mimeType: "text/markdown",
      },
    });
    expect(event.body.data).toHaveProperty("$bytes");
  });

  it("creates an edit with custom MIME type", async () => {
    await editMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "edited",
      mimeType: "text/plain",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.body.mimeType).toBe("text/plain");
  });

  it("creates an edit with timestamp override", async () => {
    const timestamp = 1704067200000;
    await editMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "Edited message",
      timestamp,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.extensions).toMatchObject({
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp,
      },
    });
  });
});

describe("deleteMessage", () => {
  it("creates a delete message event", async () => {
    const result = await deleteMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.message.deleteMessage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("reorderMessage", () => {
  it("creates a reorder message event", async () => {
    const result = await reorderMessage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      after: "01KXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.message.reorderMessage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      after: "01KXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("forwardMessages", () => {
  it("creates a forward messages event", async () => {
    const result = await forwardMessages(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      fromRoomId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageIds: ["01KXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "01LXXXXXXXXXXXXXXXXXXXXXXXXXXXX"] as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.message.forwardMessages.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      fromRoomId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      messageIds: ["01KXXXXXXXXXXXXXXXXXXXXXXXXXXXX", "01LXXXXXXXXXXXXXXXXXXXXXXXXXXXX"],
    });
  });

  it("creates a forward with a single message", async () => {
    await forwardMessages(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      fromRoomId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      messageIds: ["01KXXXXXXXXXXXXXXXXXXXXXXXXXXXX"] as any,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.messageIds).toHaveLength(1);
  });
});

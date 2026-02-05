/**
 * Tests for room operations.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createRoom,
  updateRoom,
  deleteRoom,
  createThread,
  createPage,
  editPage,
  createRoomLink,
  removeRoomLink,
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

describe("createRoom", () => {
  it("creates a channel room", async () => {
    const result = await createRoom(mockSpace, {
      kind: "space.roomy.channel",
      name: "general",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/); // ULID format
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "general",
    });
  });

  it("creates a thread room", async () => {
    await createRoom(mockSpace, {
      kind: "space.roomy.thread",
      name: "Thread name",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.kind).toBe("space.roomy.thread");
  });

  it("creates a page room", async () => {
    await createRoom(mockSpace, {
      kind: "space.roomy.page",
      name: "Page name",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.kind).toBe("space.roomy.page");
  });

  it("creates a category room", async () => {
    await createRoom(mockSpace, {
      kind: "space.roomy.category",
      name: "Category name",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.kind).toBe("space.roomy.category");
  });

  it("creates a room with description", async () => {
    await createRoom(mockSpace, {
      kind: "space.roomy.channel",
      name: "general",
      description: "General discussion channel",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.description).toBe("General discussion channel");
  });

  it("creates a room with avatar", async () => {
    await createRoom(mockSpace, {
      kind: "space.roomy.channel",
      name: "general",
      avatar: "https://example.com/avatar.png",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.avatar).toBe("https://example.com/avatar.png");
  });
});

describe("updateRoom", () => {
  it("updates room name", async () => {
    const result = await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "new-name",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.room.updateRoom.v0",
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      name: "new-name",
    });
  });

  it("updates room kind", async () => {
    await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      kind: "space.roomy.thread",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.kind).toBe("space.roomy.thread");
  });

  it("changes room kind to null", async () => {
    await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      kind: null,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.kind).toBeNull();
  });

  it("updates room description", async () => {
    await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      description: "New description",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.description).toBe("New description");
  });

  it("updates room avatar", async () => {
    await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      avatar: "https://example.com/new-avatar.png",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.avatar).toBe("https://example.com/new-avatar.png");
  });

  it("updates multiple properties at once", async () => {
    await updateRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "new-name",
      description: "New description",
      kind: "space.roomy.thread",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      name: "new-name",
      description: "New description",
      kind: "space.roomy.thread",
    });
  });
});

describe("deleteRoom", () => {
  it("deletes a room", async () => {
    const result = await deleteRoom(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.room.deleteRoom.v0",
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("createThread", () => {
  it("creates a thread and links it to parent", async () => {
    const result = await createThread(mockSpace, {
      linkToRoom: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Thread name",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(2); // createRoom + createRoomLink

    // First call: create the thread room
    const createEvent = mockSendEvent.mock.calls[0][0];
    expect(createEvent).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.thread",
      name: "Thread name",
    });

    // Second call: link the thread to parent
    const linkEvent = mockSendEvent.mock.calls[1][0];
    expect(linkEvent).toMatchObject({
      $type: "space.roomy.link.createRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkToRoom: result.id,
    });
  });

  it("creates a thread with description", async () => {
    await createThread(mockSpace, {
      linkToRoom: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Thread name",
      description: "Thread description",
    });

    const createEvent = mockSendEvent.mock.calls[0][0];
    expect(createEvent.description).toBe("Thread description");
  });
});

describe("createPage", () => {
  it("creates a page without content", async () => {
    const result = await createPage(mockSpace, {
      parentRoomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Page name",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1); // Only createRoom

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.page",
      name: "Page name",
    });
  });

  it("creates a page with initial content", async () => {
    const result = await createPage(mockSpace, {
      parentRoomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Page name",
      content: "# Page Title\n\nPage content here",
    });

    expect(mockSendEvent).toHaveBeenCalledTimes(2); // createRoom + editPage

    // Second call: edit the page with content
    const editEvent = mockSendEvent.mock.calls[1][0];
    expect(editEvent).toMatchObject({
      $type: "space.roomy.page.editPage.v0",
      room: result.id,
      body: {
        mimeType: "text/markdown",
      },
    });
    expect(editEvent.body.data).toHaveProperty("$bytes");
  });
});

describe("editPage", () => {
  it("edits a page", async () => {
    const result = await editPage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "# Updated content",
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.page.editPage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      body: {
        mimeType: "text/markdown",
      },
    });
    expect(event.body.data).toHaveProperty("$bytes");
  });

  it("edits a page with custom MIME type", async () => {
    await editPage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "content",
      mimeType: "text/plain",
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.body.mimeType).toBe("text/plain");
  });

  it("edits a page with previous edit reference", async () => {
    await editPage(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "New content",
      previous: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    const event = mockSendEvent.mock.calls[0][0];
    expect(event.previous).toBe("01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  });
});

describe("createRoomLink", () => {
  it("creates a room link", async () => {
    const result = await createRoomLink(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.link.createRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("removeRoomLink", () => {
  it("removes a room link", async () => {
    const result = await removeRoomLink(mockSpace, {
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      linkId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(result.id).toMatch(/^[\w-]{26}$/);
    expect(mockSendEvent).toHaveBeenCalledTimes(1);

    const event = mockSendEvent.mock.calls[0][0];
    expect(event).toMatchObject({
      $type: "space.roomy.link.removeRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkId: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

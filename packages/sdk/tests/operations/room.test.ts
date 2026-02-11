/**
 * Tests for room operations.
 */

import { describe, it, expect } from "vitest";
import {
  createRoom,
  updateRoom,
  deleteRoom,
  createThread,
  createPage,
  editPage,
  createRoomLink,
  removeRoomLink,
} from "../../src";

describe("createRoom", () => {
  it("creates a channel room", () => {
    const events = createRoom({
      kind: "space.roomy.channel",
      name: "general",
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/); // ULID format
    expect(events[0]).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: "general",
    });
  });

  it("creates a thread room", () => {
    const events = createRoom({
      kind: "space.roomy.thread",
      name: "Thread name",
    });

    expect(events[0].kind).toBe("space.roomy.thread");
  });

  it("creates a page room", () => {
    const events = createRoom({
      kind: "space.roomy.page",
      name: "Page name",
    });

    expect(events[0].kind).toBe("space.roomy.page");
  });

  it("creates a category room", () => {
    const events = createRoom({
      kind: "space.roomy.category",
      name: "Category name",
    });

    expect(events[0].kind).toBe("space.roomy.category");
  });

  it("creates a room with description", () => {
    const events = createRoom({
      kind: "space.roomy.channel",
      name: "general",
      description: "General discussion channel",
    });

    expect(events[0].description).toBe("General discussion channel");
  });

  it("creates a room with avatar", () => {
    const events = createRoom({
      kind: "space.roomy.channel",
      name: "general",
      avatar: "https://example.com/avatar.png",
    });

    expect(events[0].avatar).toBe("https://example.com/avatar.png");
  });
});

describe("updateRoom", () => {
  it("updates room name", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "new-name",
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.room.updateRoom.v0",
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      name: "new-name",
    });
  });

  it("updates room kind", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      kind: "space.roomy.thread",
    });

    expect(events[0].kind).toBe("space.roomy.thread");
  });

  it("changes room kind to null", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      kind: null,
    });

    expect(events[0].kind).toBeNull();
  });

  it("updates room description", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      description: "New description",
    });

    expect(events[0].description).toBe("New description");
  });

  it("updates room avatar", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      avatar: "https://example.com/new-avatar.png",
    });

    expect(events[0].avatar).toBe("https://example.com/new-avatar.png");
  });

  it("updates multiple properties at once", () => {
    const events = updateRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "new-name",
      description: "New description",
      kind: "space.roomy.thread",
    });

    expect(events[0]).toMatchObject({
      name: "new-name",
      description: "New description",
      kind: "space.roomy.thread",
    });
  });
});

describe("deleteRoom", () => {
  it("deletes a room", () => {
    const events = deleteRoom({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.room.deleteRoom.v0",
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("createThread", () => {
  it("creates a thread and links it to parent", () => {
    const events = createThread({
      linkToRoom: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Thread name",
    });

    expect(events).toHaveLength(2); // createRoom + createRoomLink
    expect(events[0].id).toMatch(/^[\w-]{26}$/);

    // First event: create the thread room
    expect(events[0]).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.thread",
      name: "Thread name",
    });

    // Second event: link the thread to parent
    expect(events[1]).toMatchObject({
      $type: "space.roomy.link.createRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkToRoom: events[0].id,
    });
  });

  it("creates a thread with description", () => {
    const events = createThread({
      linkToRoom: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Thread name",
      description: "Thread description",
    });

    expect(events[0].description).toBe("Thread description");
  });
});

describe("createPage", () => {
  it("creates a page without content", () => {
    const events = createPage({
      parentRoomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Page name",
    });

    expect(events).toHaveLength(1); // Only createRoom
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.page",
      name: "Page name",
    });
  });

  it("creates a page with initial content", () => {
    const events = createPage({
      parentRoomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      name: "Page name",
      content: "# Page Title\n\nPage content here",
    });

    expect(events).toHaveLength(2); // createRoom + editPage

    // Second event: edit the page with content
    expect(events[1]).toMatchObject({
      $type: "space.roomy.page.editPage.v0",
      room: events[0].id,
      body: {
        mimeType: "text/markdown",
      },
    });
    expect(events[1].body.data).toHaveProperty("$bytes");
  });
});

describe("editPage", () => {
  it("edits a page", () => {
    const events = editPage({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "# Updated content",
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.page.editPage.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      body: {
        mimeType: "text/markdown",
      },
    });
    expect(events[0].body.data).toHaveProperty("$bytes");
  });

  it("edits a page with custom MIME type", () => {
    const events = editPage({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "content",
      mimeType: "text/plain",
    });

    expect(events[0].body.mimeType).toBe("text/plain");
  });

  it("edits a page with previous edit reference", () => {
    const events = editPage({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      body: "New content",
      previous: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(events[0].previous).toBe("01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX");
  });
});

describe("createRoomLink", () => {
  it("creates a room link", () => {
    const events = createRoomLink({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.link.createRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

describe("removeRoomLink", () => {
  it("removes a room link", () => {
    const events = removeRoomLink({
      roomId: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX" as any,
    });

    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[\w-]{26}$/);
    expect(events[0]).toMatchObject({
      $type: "space.roomy.link.removeRoomLink.v0",
      room: "01HXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      linkToRoom: "01JXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    });
  });
});

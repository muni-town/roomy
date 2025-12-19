import { backend } from "$lib/workers";
import type { EventType, DidStream, Ulid } from "$lib/workers/types";
import { monotonicFactory } from "ulidx";

const ulid = monotonicFactory();

export async function createPage(opts: {
  spaceId: DidStream;
  roomId: Ulid;
  pageName: string;
}) {
  const events: EventType[] = [];

  // Create a new room for the page
  const pageId = newUlid();
  events.push({
    ulid: pageId,
    parent: opts.roomId,
    variant: {
      kind: "space.roomy.room.createRoom.v0",
      data: undefined,
    },
  });

  // Mark the room as a page
  events.push({
    ulid: newUlid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.room.kind.v0",
      data: {
        kind: "space.roomy.page.v0",
        data: undefined,
      },
    },
  });

  // Set the page name
  events.push({
    ulid: newUlid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.info.v0",
      data: {
        name: { set: opts.pageName },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });

  events.push({
    ulid: newUlid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.room.editPage.v0",
      data: {
        content: {
          content: new TextEncoder().encode(
            `# ${opts.pageName}\n\nNew page. Fill me with something awesome. ✨`,
          ),
          mimeType: "text/markdown",
        },
      },
    },
  });

  await backend.sendEventBatch(opts.spaceId, events);
  return pageId;
}

export async function promoteToChannel(opts: {
  spaceId: DidStream;
  room: {
    id: Ulid;
    name: string;
    parent?: {
      id: string;
      name: string;
      kind: string;
      parent: string | null;
    } | null;
  };
  channelName?: string;
}) {
  const channelName = opts.channelName || opts.room.name;
  const ulid = monotonicFactory();

  const events: EventType[] = [];

  // Mark the thread as a channel
  events.push({
    ulid: newUlid(),
    parent: opts.room.id,
    variant: {
      kind: "space.roomy.room.kind.v0",
      data: { kind: "space.roomy.channel.v0", data: undefined },
    },
  });

  // Make the thread a sibling of it's parent channel
  events.push({
    ulid: newUlid(),
    parent: opts.room.id,
    variant: {
      kind: "space.roomy.parent.update.v0",
      data: {
        parent: opts.room.parent?.parent || undefined,
      },
    },
  });

  // If a new name was specified
  if (channelName != opts.room.name) {
    // Rename it
    events.push({
      ulid: newUlid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.info.v0",
        data: {
          name: { set: channelName },
          avatar: { ignore: undefined },
          description: { ignore: undefined },
        },
      },
    });
  }

  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToThread(opts: {
  spaceId: DidStream;
  roomId: Ulid;
}) {
  const events: EventType[] = [
    {
      ulid: newUlid(),
      parent: opts.roomId,
      variant: {
        kind: "space.roomy.room.kind.v0",
        data: {
          kind: "space.roomy.thread.v0",
          data: undefined,
        },
      },
    },
  ];
  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToPage(opts: {
  spaceId: DidStream;
  room: { id: Ulid; name: string };
}) {
  const events: EventType[] = [
    {
      ulid: newUlid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.room.kind.v0",
        data: {
          kind: "space.roomy.page.v0",
          data: undefined,
        },
      },
    },
    {
      ulid: newUlid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.room.editPage.v0",
        data: {
          content: {
            content: new TextEncoder().encode(
              `# ${opts.room.name}\n\nConverted channel to page.`,
            ),
            mimeType: "text/markdown",
          },
        },
      },
    },
  ];
  await backend.sendEventBatch(opts.spaceId, events);
}

export async function setPageReadMarker(opts: {
  personalStreamId: DidStream;
  streamId: DidStream;
  roomId: Ulid;
}) {
  await backend.sendEvent(opts.personalStreamId, {
    ulid: newUlid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.room.setLastRead.v0",
      data: {
        streamId: opts.streamId,
        roomId: opts.roomId,
      },
    },
  });
}

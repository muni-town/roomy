import { backend } from "$lib/workers";
import type { EventType, StreamHashId, Ulid } from "$lib/workers/types";
import { monotonicFactory } from "ulidx";

const ulid = monotonicFactory();

export async function createPage(opts: {
  spaceId: StreamHashId;
  roomId: Ulid;
  pageName: string;
}) {
  const events: EventType[] = [];

  // Create a new room for the page
  const pageId = ulid();
  events.push({
    ulid: pageId,
    parent: opts.roomId,
    variant: {
      kind: "space.roomy.room.create.0",
      data: undefined,
    },
  });

  // Mark the room as a page
  events.push({
    ulid: ulid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.page.mark.0",
      data: undefined,
    },
  });

  // Set the page name
  events.push({
    ulid: ulid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.info.0",
      data: {
        name: { set: opts.pageName },
        avatar: { ignore: undefined },
        description: { ignore: undefined },
      },
    },
  });

  events.push({
    ulid: ulid(),
    parent: pageId,
    variant: {
      kind: "space.roomy.page.edit.0",
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
  spaceId: StreamHashId;
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

  // Unmark the thread as a thread
  events.push({
    ulid: ulid(),
    parent: opts.room.id,
    variant: {
      kind: "space.roomy.thread.unmark.0",
      data: undefined,
    },
  });

  // Mark the thread as a channel
  events.push({
    ulid: ulid(),
    parent: opts.room.id,
    variant: {
      kind: "space.roomy.channel.mark.0",
      data: undefined,
    },
  });

  // Make the thread a sibling of it's parent channel
  events.push({
    ulid: ulid(),
    parent: opts.room.id,
    variant: {
      kind: "space.roomy.parent.update.0",
      data: {
        parent: opts.room.parent?.parent || undefined,
      },
    },
  });

  // If a new name was specified
  if (channelName != opts.room.name) {
    // Rename it
    events.push({
      ulid: ulid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.info.0",
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
  spaceId: StreamHashId;
  roomId: Ulid;
}) {
  const events: EventType[] = [
    {
      ulid: ulid(),
      parent: opts.roomId,
      variant: {
        kind: "space.roomy.channel.unmark.0",
        data: undefined,
      },
    },
    {
      ulid: ulid(),
      parent: opts.roomId,
      variant: {
        kind: "space.roomy.thread.mark.0",
        data: undefined,
      },
    },
  ];
  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToPage(opts: {
  spaceId: StreamHashId;
  room: { id: Ulid; name: string };
}) {
  const events: EventType[] = [
    {
      ulid: ulid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.channel.unmark.0",
        data: undefined,
      },
    },
    {
      ulid: ulid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.page.mark.0",
        data: undefined,
      },
    },
    {
      ulid: ulid(),
      parent: opts.room.id,
      variant: {
        kind: "space.roomy.page.edit.0",
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
  personalStreamId: StreamHashId;
  streamId: StreamHashId;
  roomId: Ulid;
}) {
  await backend.sendEvent(opts.personalStreamId, {
    ulid: ulid(),
    parent: undefined,
    variant: {
      kind: "space.roomy.room.lastRead.0",
      data: {
        streamId: opts.streamId,
        roomId: opts.roomId,
      },
    },
  });
}

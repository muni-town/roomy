import { ignore, newUlid, set, toBytes, Ulid } from "$lib/schema";
import { backend } from "$lib/workers";
import type { Event, StreamDid } from "$lib/schema";

export async function createPage(opts: {
  spaceId: StreamDid;
  roomId: Ulid;
  pageName: string;
}) {
  const events: Event[] = [];

  // Create a new room for the page
  const pageId = newUlid();
  events.push({
    id: pageId,
    room: opts.roomId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
    },
  });

  // Mark the room as a page
  events.push({
    id: newUlid(),
    room: pageId,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: "page",
    },
  });

  // Set the page name
  events.push({
    id: newUlid(),
    room: pageId,
    variant: {
      $type: "space.roomy.common.setInfo.v0",
      name: set(opts.pageName),
      avatar: ignore,
      description: ignore,
    },
  });

  events.push({
    id: newUlid(),
    room: pageId,
    variant: {
      $type: "space.roomy.room.editPage.v0",
      body: {
        data: toBytes(
          new TextEncoder().encode(
            `# ${opts.pageName}\n\nNew page. Fill me with something awesome. ✨`,
          ),
        ),
        mimeType: "text/markdown",
      },
    },
  });

  await backend.sendEventBatch(opts.spaceId, events);
  return pageId;
}

export async function promoteToChannel(opts: {
  spaceId: StreamDid;
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

  const events: Event[] = [];

  // Mark the thread as a channel
  events.push({
    id: newUlid(),
    room: opts.room.id,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: "channel",
    },
  });

  // Make the thread a sibling of it's parent channel
  if (opts.room.parent?.parent) {
    events.push({
      id: newUlid(),
      room: opts.room.id,
      variant: {
        $type: "space.roomy.room.updateParent.v0",
        parent: Ulid.assert(opts.room.parent?.parent),
      },
    });
  }

  // If a new name was specified
  if (channelName != opts.room.name) {
    // Rename it
    events.push({
      id: newUlid(),
      room: opts.room.id,
      variant: {
        $type: "space.roomy.common.setInfo.v0",
        name: set(channelName),
        avatar: ignore,
        description: ignore,
      },
    });
  }

  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToThread(opts: {
  spaceId: StreamDid;
  roomId: Ulid;
}) {
  const events: Event[] = [
    {
      id: newUlid(),
      room: opts.roomId,
      variant: {
        $type: "space.roomy.room.setKind.v0",
        kind: "thread",
      },
    },
  ];
  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToPage(opts: {
  spaceId: StreamDid;
  room: { id: Ulid; name: string };
}) {
  const events: Event[] = [
    {
      id: newUlid(),
      room: opts.room.id,
      variant: {
        $type: "space.roomy.room.setKind.v0",
        kind: "page",
      },
    },
    {
      id: newUlid(),
      room: opts.room.id,
      variant: {
        $type: "space.roomy.room.editPage.v0",
        body: {
          data: toBytes(
            new TextEncoder().encode(
              `# ${opts.room.name}\n\nConverted channel to page.`,
            ),
          ),
          mimeType: "text/markdown",
        },
      },
    },
  ];
  await backend.sendEventBatch(opts.spaceId, events);
}

export async function setPageReadMarker(opts: {
  personalStreamId: StreamDid;
  streamId: StreamDid;
  roomId: Ulid;
}) {
  await backend.sendEvent(opts.personalStreamId, {
    id: newUlid(),
    room: undefined,
    variant: {
      $type: "space.roomy.room.setLastRead.v0",
      streamId: opts.streamId,
      roomId: opts.roomId,
    },
  });
}

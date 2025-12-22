import { ignore, newUlid, set, setOrIgnore, toBytes, Ulid } from "$lib/schema";
import { backend } from "$lib/workers";
import type { Event, StreamDid } from "$lib/schema";
import type { RoomKind } from "$lib/schema/events/room";

function setKindEvent(opts: {
  spaceId: StreamDid;
  roomId: Ulid;
  kind: RoomKind;
}) {
  return {
    id: newUlid(),
    room: opts.roomId,
    variant: {
      $type: "space.roomy.room.setKind.v0",
      kind: opts.kind,
    },
  } as const;
}

interface CreateRoomOpts {
  spaceId: StreamDid;
  parentRoomId?: Ulid;
  kind: RoomKind;
  info?: {
    name?: string;
    description?: string;
    avatar?: string;
  };
}

function createRoomEvents(opts: CreateRoomOpts) {
  const newRoomId = newUlid();
  const events: Event[] = [];
  events.push({
    id: newRoomId,
    room: opts.parentRoomId,
    variant: {
      $type: "space.roomy.room.createRoom.v0",
    },
  });
  events.push(setKindEvent({ ...opts, roomId: newRoomId }));

  if (opts.info)
    events.push({
      id: newUlid(),
      room: newRoomId,
      variant: {
        $type: "space.roomy.common.setInfo.v0",
        name: setOrIgnore(opts.info.name),
        avatar: setOrIgnore(opts.info.avatar),
        description: setOrIgnore(opts.info.description),
      },
    });
  return { roomId: newRoomId, events };
}

export async function createRoom(opts: CreateRoomOpts) {
  const { roomId, events } = createRoomEvents(opts);
  await backend.sendEventBatch(opts.spaceId, events);
  return roomId;
}

export async function createPage(opts: {
  spaceId: StreamDid;
  parentRoomId: Ulid;
  pageName: string;
}) {
  // Create a new room for the page
  const { roomId: pageId, events } = createRoomEvents({
    ...opts,
    kind: "page",
    info: {
      name: opts.pageName,
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
  events.push(setKindEvent({ ...opts, roomId: opts.room.id, kind: "channel" }));

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
  await backend.sendEvent(
    opts.spaceId,
    setKindEvent({ ...opts, kind: "thread" }),
  );
}

export async function convertToPage(opts: {
  spaceId: StreamDid;
  room: { id: Ulid; name: string };
}) {
  const events: Event[] = [
    setKindEvent({ ...opts, roomId: opts.room.id, kind: "page" }),
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

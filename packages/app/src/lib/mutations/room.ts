import { newUlid, toBytes, Ulid } from "$lib/schema";
import { backend } from "$lib/workers";
import type { Event, StreamDid } from "$lib/schema";
import { RoomKind } from "$lib/schema/events/room";

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
      kind: opts.kind,
      name: opts.info?.name,
      avatar: opts.info?.avatar,
      description: opts.info?.description,
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
    kind: "space.roomy.page",
    info: {
      name: opts.pageName,
    },
  });

  events.push({
    id: newUlid(),
    room: pageId,
    variant: {
      $type: "space.roomy.page.editPage.v0",
      body: {
        data: toBytes(new TextEncoder().encode(`# ${opts.pageName}\n\n`)),
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
      $type: "space.roomy.room.updateRoom.v0",
      kind: "space.roomy.channel",
      name: channelName,
    },
  });
  events.push({
    id: newUlid(),
    room: opts.room.id,
    variant: {
      $type: "space.roomy.room.move.v0",
      toRoom: opts.room.parent?.parent
        ? Ulid.assert(opts.room.parent.parent)
        : null,
    },
  });

  await backend.sendEventBatch(opts.spaceId, events);
}

export async function convertToThread(opts: {
  spaceId: StreamDid;
  roomId: Ulid;
}) {
  await backend.sendEvent(opts.spaceId, {
    id: newUlid(),
    room: opts.roomId,
    variant: {
      $type: "space.roomy.room.updateRoom.v0",
      kind: "space.roomy.thread",
    },
  });
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
        $type: "space.roomy.room.updateRoom.v0",
        kind: "space.roomy.page",
      },
    },
    {
      id: newUlid(),
      room: opts.room.id,
      variant: {
        $type: "space.roomy.page.editPage.v0",
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
      $type: "space.roomy.stream.personal.setLastRead.v0",
      streamDid: opts.streamId,
      roomId: opts.roomId,
    },
  });
}

import type {
  SqlStatement,
  StreamEvent,
  MaterializerConfig,
} from "./backendWorker";
import {
  _void,
  str,
  Struct,
  Option,
  Enum,
  Vector,
  Bytes,
  u64,
  type CodecType,
  type Codec,
} from "scale-ts";
import { Hash, Kinds, Ulid } from "./encoding";
import { schema } from "./db/schema";
import { decodeTime, ulid } from "ulidx";
import { backend } from ".";

export type EventType = ReturnType<(typeof eventCodec)["dec"]>;

/** Database materializer config. */
export const config: MaterializerConfig = {
  initSql: Object.values(schema).map((sql) => ({
    sql,
  })),
  materializer,
};

export const ValueUpdate = <T>(ty: Codec<T>) =>
  Enum({
    set: ty,
    delete: _void,
    ignore: _void,
  });

/** Read permission or write permission */
export const ReadOrWrite = Enum({
  read: _void,
  write: _void,
});

/** Codec for a member in a group. */
export const GroupMember = Enum({
  /** Everybody, including unauthenticated users. */
  anonymous: _void,
  /** Authenticated users that have joined the space. */
  authenticated: _void,
  /** A user ID. */
  user: str,
  /** The ID of another room to use as a group. That room's member list will be used. */
  room: Ulid,
});

/** Content encoding. */
export const Content = Struct({
  /** The Mime type of the message content */
  mimeType: str,
  /**
   * The actual content. This is usually going to be text, but we allow freeform binary data here
   * just in case.
   *
   * The mime type will specify the precise encoding.
   * */
  content: Bytes(),
});

export const eventVariantCodec = Kinds({
  /** Join a Roomy space: used to track joined spaces in the user's personal space. */
  "space.roomy.joinSpace.0": Struct({
    spaceId: Hash,
  }),
  /** Leave a Roomy space: used to track joined spaces in the users personal space. */
  "space.roomy.leaveSpace.0": Struct({
    spaceId: Hash,
  }),
  /**
   * A room is the most general container smaller than a space for events.
   *
   * Each event has a room that it is a part of except for top-level events which considered at the
   * space level.
   *
   * If a room.create event is sent in another room, it creates a sub-room.
   *
   * The read and write groups are then allowed to inherit from it's parent room.
   *
   * Creator of a room, and admins, should be allowed to modify the read group and write group of
   * the room and therefor control access to the room.
   *
   * Every event can be treated as a "room" by having other events target it as a parent. If there
   * has not been a read/write groups specified for an event, though, for example, by using a
   * `room.update` event, only the creator of the event ( and admins ) are allowed to send events
   * that target it as a parent.
   *
   * For example, chat message, when sent, can have edit and overrideMeta events sent by the
   * messages author that have the original message event as it's parent.
   * */
  "space.roomy.room.create.0": _void,
  /**
   * Update the info for a room. Note that a room might be anything.
   */
  "space.roomy.entity.info.0": Struct({
    name: ValueUpdate(str),
    avatar: ValueUpdate(str),
    description: ValueUpdate(str),
  }),
  /**
   * Add a member to the Room's member list. Each room has a member list, and some Rooms are created
   * intentionally to use as groups, so that their member list is all they are used for.
   *
   * Each member is granted either read or write access to the room.
   * */
  "space.roomy.room.addMember.0": Struct({
    member_id: GroupMember,
    access: ReadOrWrite,
  }),
  /**
   * Remove a member from the room. A reason may be supplied to clarify in case of, for example, a
   * ban.
   */
  "space.roomy.room.removeMember.0": Struct({
    member_id: GroupMember,
    access: ReadOrWrite,
    reason: Option(str),
  }),
  /** Create a new chat message. */
  "space.roomy.message.create.0": Struct({
    content: Content,
    replyTo: Option(Ulid),
  }),
  /** Edit a previously sent message */
  "space.roomy.message.edit.0": Struct({
    /** The message content */
    content: Content,
    /** The message this message is in reply to, if any. */
    replyTo: Option(Ulid),
    /** List of attached media or other entities. */
    attachments: Vector(Ulid),
  }),
  /**
   * Set an override for the author and timestamp of a previously sent message. This is used by chat
   * bridges, to send messages as remote users. */
  "space.roomy.message.overrideMeta.0": Struct({
    /** And identifier for the original / source ID of the bridged message. */
    source: str,
    /** The override for the author ID. */
    author: str,
    /** The override for the unix timestamp in milliseconds. */
    timestamp: u64,
  }),
  /** Delete a message. */
  "space.roomy.message.delete.0": Struct({
    reason: Option(str),
  }),
  /** Create a reaction to a message. */
  "space.roomy.reaction.create.0": Struct({
    /** The message that is being reacted to. */
    reaction_to: Ulid,
    /**
     * This is usually a unicode code point, and otherwise should be a URI describing the reaction.
     * */
    reaction: str,
  }),
  /** Delete a reaction. The parent is the reaction that should be deleted. */
  "space.roomy.reaction.delete.0": _void,
  /** Create new media that can, for example, be attached to messages. */
  "space.roomy.media.create.0": Struct({
    /** For now all media is external and we use a URI to load it. */
    uri: str,
  }),
  "space.roomy.media.delete.0": _void,
});

export const eventCodec = Struct({
  /** The ULID here serves to uniquely represent the event and provide a timestamp. */
  ulid: Ulid,
  /** The room that the event is sent in. If none, it is considered to be at the space level. */
  parent: Option(Ulid),
  /** The event variant. */
  variant: eventVariantCodec,
});

export async function materializer(
  streamId: string,
  streamEvent: StreamEvent,
): Promise<SqlStatement[]> {
  try {
    const event = eventCodec.dec(streamEvent.payload);
    const statements = await eventToStatements(
      streamId,
      streamEvent.user,
      event,
    );
    return statements;
  } catch (e) {
    console.warn("Could not process event, ignoring:", e);
    return [];
  }
}

type Event = CodecType<typeof eventCodec>;
type EventVariants = CodecType<typeof eventVariantCodec>;
type EventVairantStr = EventVariants["kind"];
type EventVariant<K extends EventVairantStr> = Extract<
  EventVariants,
  { kind: K }
>["data"];

async function eventToStatements(
  streamId: string,
  user: string,
  event: Event,
): Promise<SqlStatement[]> {
  switch (event.variant.kind) {
    case "space.roomy.joinSpace.0":
      return joinSpace(streamId, user, event, event.variant.data);
    case "space.roomy.leaveSpace.0":
      return leaveSpace(streamId, user, event, event.variant.data);
    case "space.roomy.room.create.0":
      return createRoom(streamId, user, event, event.variant.data);
    case "space.roomy.entity.info.0":
      return entityInfo(streamId, user, event, event.variant.data);
    case "space.roomy.room.addMember.0":
      return addRoomMember(streamId, user, event, event.variant.data);
    case "space.roomy.room.removeMember.0":
      return removeRoomMember(streamId, user, event, event.variant.data);
    case "space.roomy.message.create.0":
      return createMessage(streamId, user, event, event.variant.data);
    case "space.roomy.message.edit.0":
      return editMessage(streamId, user, event, event.variant.data);
    case "space.roomy.reaction.create.0":
      return createReaction(streamId, user, event, event.variant.data);
    case "space.roomy.reaction.delete.0":
      return deleteReaction(streamId, user, event, event.variant.data);
    case "space.roomy.message.overrideMeta.0":
      return overrideMessageMeta(streamId, user, event, event.variant.data);
    case "space.roomy.message.delete.0":
      return deleteMessage(streamId, user, event, event.variant.data);
    case "space.roomy.media.create.0":
      return createMedia(streamId, user, event, event.variant.data);
    case "space.roomy.media.delete.0":
      return deleteMedia(streamId, user, event, event.variant.data);
    default:
      console.warn(`Unknown event type: ${(event.variant as any).kind}`);
      return [];
  }
}

function joinSpace(
  streamId: string,
  _user: string,
  _event: Event,
  variant: EventVariant<"space.roomy.joinSpace.0">,
): SqlStatement[] {
  return [
    {
      sql: `insert into spaces (id, stream) values (?, ?)
            on conflict update hidden = 0`,
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ];
}
function leaveSpace(
  streamId: string,
  _user: string,
  _event: Event,
  variant: EventVariant<"space.roomy.leaveSpace.0">,
): SqlStatement[] {
  return [
    {
      sql: "update spaces set hidden = 1 where id = ? and stream = ?",
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ];
}

function createRoom(
  streamId: string,
  _user: string,
  event: Event,
  _variant: EventVariant<"space.roomy.room.create.0">,
): SqlStatement[] {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_room (entity, parent) values (?, ?)",
      params: [
        Ulid.enc(event.ulid),
        event.parent ? Ulid.enc(event.parent) : null,
      ],
    },
  ];
}

function entityInfo(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.entity.info.0">,
): SqlStatement[] {
  const updates = [
    { key: "name", ...variant.name },
    { key: "avatar", ...variant.avatar },
    { key: "description", ...variant.description },
  ];
  const setUpdates = updates.filter((x) => x.tag == "set");
  const deleteUpdates = updates.filter((x) => x.tag == "delete");

  // If this is an update to a room
  if (event.parent) {
    return [
      ensureEntity(streamId, event.ulid, event.parent),
      {
        sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)}) on conflict update
            set ${[...setUpdates, ...deleteUpdates].map((x) => `${x.key} = :${x.key}`)}`,
        params: Object.fromEntries([
          [":entity", Ulid.enc(event.parent)],
          ...setUpdates.map((x) => [":" + x.key, x.value]),
          ...deleteUpdates.map((x) => [":" + x.key, null]),
        ]),
      },
    ];

    // If this is an update to a space
  } else {
    return [
      ensureEntity(streamId, event.ulid, event.parent),
      {
        sql: `update spaces
            set ${[...setUpdates, ...deleteUpdates].map((x) => `${x.key} = :${x.key}`)}
            where id = :id`,
        params: Object.fromEntries([
          [":id", Hash.enc(streamId)],
          ...setUpdates.map((x) => [":" + x.key, x.value]),
          ...deleteUpdates.map((x) => [":" + x.key, null]),
        ]),
      },
    ];
  }
}

async function addRoomMember(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.room.addMember.0">,
): Promise<SqlStatement[]> {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    ...(await ensureProfile(variant.member_id)),
    {
      sql: event.parent
        ? `insert into comp_room_members (room, member, access) values (?, ?, ?)`
        : `insert into space_members (space_id, member, access) values (?, ?, ?)`,
      params: [
        event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
        GroupMember.enc(variant.member_id),
        ReadOrWrite.enc(variant.access),
      ],
    },
  ];
}

function removeRoomMember(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.room.removeMember.0">,
): SqlStatement[] {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: event.parent
        ? "delete from comp_room_members where room = ? and member = ? and access = ?"
        : "delete from space_members where space_id = ? and member = ? and access = ?",
      params: [
        event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
        GroupMember.enc(variant.member_id),
        ReadOrWrite.enc(variant.access),
      ],
    },
  ];
}

async function createMessage(
  streamId: string,
  user: string,
  event: Event,
  variant: EventVariant<"space.roomy.message.create.0">,
): Promise<SqlStatement[]> {
  const statements = [
    ensureEntity(streamId, event.ulid, event.parent),
    ...(await ensureProfile({ tag: "user", value: user })),
    {
      sql: "insert into comp_content (entity, mime_type, data) values (?, ?, ?)",
      params: [
        Ulid.enc(event.ulid),
        variant.content.mimeType,
        variant.content.content,
      ],
    },
  ];

  if (variant.replyTo) {
    statements.push({
      sql: "insert into comp_reply (entity, reply_to) values (?, ?)",
      params: [Ulid.enc(event.ulid), Ulid.enc(variant.replyTo)],
    });
  }

  return statements;
}

function editMessage(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.message.edit.0">,
): SqlStatement[] {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "update comp_content set mime_type = ?, data = ? where entity = ?",
      params: [
        variant.content.mimeType,
        variant.content.content,
        Ulid.enc(event.ulid),
      ],
    },
  ];
}

function overrideMessageMeta(
  _streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.message.overrideMeta.0">,
): SqlStatement[] {
  if (!event.parent) {
    console.warn("Missing target for message meta override.");
    return [];
  }
  return [
    {
      sql: "insert into comp_override_meta (entity, source, author, timestamp) values (?, ?, ?, ?)",
      params: [
        Ulid.enc(event.parent),
        variant.source,
        variant.author,
        variant.timestamp,
      ],
    },
  ];
}

function deleteMessage(
  _streamId: string,
  _user: string,
  event: Event,
  _variant: EventVariant<"space.roomy.message.delete.0">,
): SqlStatement[] {
  if (event.parent) {
    return [
      {
        sql: "delete from entities where ulid = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  }
  return [];
}

function createReaction(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.reaction.create.0">,
): SqlStatement[] {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_reaction (entity, reaction_to, reaction) values (?, ?, ?)",
      params: [
        Ulid.enc(event.ulid),
        Ulid.enc(variant.reaction_to),
        variant.reaction,
      ],
    },
  ];
}

function deleteReaction(
  _streamId: string,
  _user: string,
  event: Event,
  _variant: EventVariant<"space.roomy.reaction.delete.0">,
): SqlStatement[] {
  if (!event.parent) {
    console.warn("Delete reaction missing parent");
    return [];
  }
  return [
    {
      sql: "delete from entities where ulid = ?",
      params: [Ulid.enc(event.parent)],
    },
  ];
}

function createMedia(
  streamId: string,
  _user: string,
  event: Event,
  variant: EventVariant<"space.roomy.media.create.0">,
): SqlStatement[] {
  return [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_media (entity, mime_type, uri) values (?, ?, ?)",
      params: [Ulid.enc(event.ulid), variant.uri],
    },
  ];
}

function deleteMedia(
  _streamId: string,
  _user: string,
  event: Event,
  _variant: EventVariant<"space.roomy.media.delete.0">,
): SqlStatement[] {
  if (!event.parent) {
    console.warn("Delete media missing parent");
    return [];
  }
  return [
    {
      sql: "delete from entities where ulid = ?",
      params: [Ulid.enc(event.parent)],
    },
  ];
}

// UTILS

function ensureEntity(
  streamId: string,
  ulid: string,
  parent: string | undefined,
): SqlStatement {
  const unixTimeMs = decodeTime(ulid);
  return {
    sql: `
    INSERT INTO entities (id, stream, parent, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `,
    params: [
      Ulid.enc(ulid),
      Hash.enc(streamId),
      parent ? Ulid.enc(parent) : null,
      unixTimeMs,
    ],
  };
}

async function ensureProfile(
  member: CodecType<typeof GroupMember>,
): Promise<SqlStatement[]> {
  if (member.tag == "user") {
    const did = member.value;
    const profileFromDb = await backend.runQuery(
      "select 1 from profiles where did = ?",
      [did],
    );
    if (!profileFromDb.rows?.length) {
      return [];
    }

    const profile = await backend.getProfile(did);
    if (!profile) return [];
    return [
      {
        sql: "insert into profiles (did, handle, display_name, avatar) values (?, ?, ?, ?)",
        params: [did, profile.handle, profile.displayName, profile.avatar],
      },
    ];
  } else {
    return [];
  }
}

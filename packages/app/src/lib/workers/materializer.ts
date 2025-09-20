import {
  type SqlStatement,
  type StreamEvent,
  type MaterializerConfig,
  sqliteWorker,
  getProfile,
} from "./backendWorker";
import { _void, type CodecType } from "scale-ts";
import {
  eventCodec,
  eventVariantCodec,
  GroupMember,
  Hash,
  ReadOrWrite,
  Ulid,
} from "./encoding";
import schemaSql from "./db/schema.sql?raw";
import { decodeTime } from "ulidx";

export type EventType = ReturnType<(typeof eventCodec)["dec"]>;

/** Database materializer config. */
export const config: MaterializerConfig = {
  initSql: schemaSql
    .split(";")
    .filter((x) => !!x)
    .map((sql) => ({ sql })),
  materializer,
};

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
    case "space.roomy.space.join.0":
      return joinSpace(streamId, user, event, event.variant.data);
    case "space.roomy.space.leave.0":
      return leaveSpace(streamId, user, event, event.variant.data);
    case "space.roomy.admin.add.0":
      return addAdmin(streamId, user, event, event.variant.data);
    case "space.roomy.admin.remove.0":
      return removeAdmin(streamId, user, event, event.variant.data);
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
  variant: EventVariant<"space.roomy.space.join.0">,
): SqlStatement[] {
  return [
    {
      sql: `insert into spaces (id, stream) values (?, ?)
            on conflict do update set hidden = 0`,
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ];
}
function leaveSpace(
  streamId: string,
  _user: string,
  _event: Event,
  variant: EventVariant<"space.roomy.space.leave.0">,
): SqlStatement[] {
  return [
    {
      sql: "update spaces set hidden = 1 where id = ? and stream = ?",
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ];
}
function addAdmin(
  streamId: string,
  _user: string,
  _event: Event,
  variant: EventVariant<"space.roomy.admin.add.0">,
): SqlStatement[] {
  return [
    {
      sql: "insert into space_admins (space_id, admin_id) values (?, ?)",
      params: [Hash.enc(streamId), variant.adminId],
    },
  ];
}
function removeAdmin(
  streamId: string,
  _user: string,
  _event: Event,
  variant: EventVariant<"space.roomy.admin.remove.0">,
): SqlStatement[] {
  return [
    {
      sql: "delete from space_admins where space_id = ? and admin_id = ?",
      params: [Hash.enc(streamId), variant.adminId],
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

  // If this is an update to a room
  if (event.parent) {
    return [
      ensureEntity(streamId, event.ulid, event.parent),
      {
        sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)}) on conflict update
            set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
        params: Object.fromEntries([
          [":entity", Ulid.enc(event.parent)],
          ...setUpdates.map((x) => [":" + x.key, x.value]),
        ]),
      },
    ];

    // If this is an update to a space
  } else {
    return [
      ensureEntity(streamId, event.ulid, event.parent),
      {
        sql: `update spaces
            set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}
            where id = :id`,
        params: Object.fromEntries([
          [":id", Hash.enc(streamId)],
          ...setUpdates.map((x) => [":" + x.key, x.value]),
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
    INSERT INTO entities (ulid, stream, parent, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(ulid) DO NOTHING
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
    const profileFromDb = await sqliteWorker!.runQuery(
      "select 1 from profiles where did = ?",
      [did],
    );
    if (!profileFromDb.rows?.length) {
      return [];
    }

    const profile = await getProfile(did);
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

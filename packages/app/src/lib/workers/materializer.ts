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
    return await materializers[event.variant.kind](
      streamId,
      streamEvent.user,
      event,
      event.variant.data as never,
    );
  } catch (e) {
    console.warn("Could not process event, ignoring:", e);
    return [];
  }
}

type Event = CodecType<typeof eventCodec>;
type EventVariants = CodecType<typeof eventVariantCodec>;
type EventVariantStr = EventVariants["kind"];
type EventVariant<K extends EventVariantStr> = Extract<
  EventVariants,
  { kind: K }
>["data"];

const materializers: {
  [K in EventVariantStr]: (
    streamId: string,
    user: string,
    event: Event,
    variant: EventVariant<K>,
  ) => Promise<SqlStatement[]>;
} = {
  // Space
  "space.roomy.space.join.0": async (streamId, _user, _event, variant) => [
    {
      sql: `insert into spaces (id, stream) values (?, ?)
            on conflict do update set hidden = 0`,
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ],
  "space.roomy.space.leave.0": async (streamId, _user, _event, variant) => [
    {
      sql: "update spaces set hidden = 1 where id = ? and stream = ?",
      params: [Hash.enc(variant.spaceId), Hash.enc(streamId)],
    },
  ],

  // Admin
  "space.roomy.admin.add.0": async (streamId, _user, _event, variant) => [
    {
      sql: "insert into space_admins (space_id, admin_id) values (?, ?)",
      params: [Hash.enc(streamId), variant.adminId],
    },
  ],
  "space.roomy.admin.remove.0": async (streamId, _user, _event, variant) => [
    {
      sql: "delete from space_admins where space_id = ? and admin_id = ?",
      params: [Hash.enc(streamId), variant.adminId],
    },
  ],

  // Info
  "space.roomy.info.0": async (streamId, _user, event, variant) => {
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
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)}) on conflict do update
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
  },

  // Room
  "space.roomy.room.create.0": async (streamId, _user, event) => [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_room (entity, parent) values (?, ?)",
      params: [
        Ulid.enc(event.ulid),
        event.parent ? Ulid.enc(event.parent) : null,
      ],
    },
  ],
  "space.roomy.room.delete.0": async (_streamId, _user, event, _variant) => {
    if (!event.parent) {
      console.warn("Delete room missing parent");
      return [];
    }
    return [
      {
        sql: "update comp_room set deleted = 1 where id = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },
  "space.roomy.room.member.add.0": async (streamId, _user, event, variant) => [
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
  ],
  "space.roomy.room.member.remove.0": async (
    streamId,
    _user,
    event,
    variant,
  ) => [
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
  ],

  // Message
  "space.roomy.message.create.0": async (streamId, user, event, variant) => {
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
  },
  "space.roomy.message.edit.0": async (streamId, _user, event, variant) => [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "update comp_content set mime_type = ?, data = ? where entity = ?",
      params: [
        variant.content.mimeType,
        variant.content.content,
        Ulid.enc(event.ulid),
      ],
    },
  ],
  "space.roomy.message.overrideMeta.0": async (
    _streamId,
    _user,
    event,
    variant,
  ) => {
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
  },
  "space.roomy.message.delete.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [
      {
        sql: "delete from entities where ulid = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },

  // Reaction
  "space.roomy.reaction.create.0": async (streamId, _user, event, variant) => [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_reaction (entity, reaction_to, reaction) values (?, ?, ?)",
      params: [
        Ulid.enc(event.ulid),
        Ulid.enc(variant.reaction_to),
        variant.reaction,
      ],
    },
  ],
  "space.roomy.reaction.delete.0": async (
    _streamId,
    _user,
    event,
    _variant,
  ) => {
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
  },

  // Media
  "space.roomy.media.create.0": async (streamId, _user, event, variant) => [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: "insert into comp_media (entity, mime_type, uri) values (?, ?, ?)",
      params: [Ulid.enc(event.ulid), variant.uri],
    },
  ],

  "space.roomy.media.delete.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for media delete.");
      return [];
    }
    return [
      {
        sql: "delete from entities where ulid = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },

  // Channels
  "space.roomy.channel.mark.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for channel mark.");
      return [];
    }
    return [
      {
        sql: "insert into comp_channel values (?)",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },
  "space.roomy.channel.unmark.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for channel unmark.");
      return [];
    }
    return [
      {
        sql: "delete from comp_channel where entity = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },

  // Categories
  "space.roomy.category.mark.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for category mark.");
      return [];
    }
    return [
      {
        sql: "insert into comp_category values (?)",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },
  "space.roomy.category.unmark.0": async (_streamId, _user, event) => {
    if (!event.parent) {
      console.warn("Missing target for category unmark.");
      return [];
    }
    return [
      {
        sql: "delete from comp_category where entity = ?",
        params: [Ulid.enc(event.parent)],
      },
    ];
  },
};

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

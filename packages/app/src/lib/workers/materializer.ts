import type {
  SqlStatement,
  StreamEvent,
  MaterializerConfig,
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
import { sql } from "$lib/utils/sqlTemplate";
import type { SqliteWorkerInterface } from ".";
import type { Agent } from "@atproto/api";

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
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  streamId: string,
  events: StreamEvent[],
): Promise<void> {
  console.time("convert");
  const batch: SqlStatement[][] = [];
  for (const incoming of events) {
    try {
      // Decode the event payload
      const event = eventCodec.dec(incoming.payload);

      // Get the SQL statements to be executed for this event
      const statements = await materializers[event.variant.kind]({
        sqliteWorker,
        streamId,
        agent,
        user: incoming.user,
        event,
        variant: event.variant.data,
      } as never);

      batch.push(statements);

      // // Add a savepoint to the list
      // savepoints.push({ name: "event", items: statements });
    } catch (e) {
      console.error(e);
    }
  }
  console.timeEnd("convert");

  // Execute all of the statements in a transaction
  console.time("runSql");
  await sqliteWorker.runSavepoint({ name: "batch", items: batch.flat() });
  console.timeEnd("runSql");
}

type Event = CodecType<typeof eventCodec>;
type EventVariants = CodecType<typeof eventVariantCodec>;
type EventVariantStr = EventVariants["kind"];
type EventVariant<K extends EventVariantStr> = Extract<
  EventVariants,
  { kind: K }
>["data"];

const materializers: {
  [K in EventVariantStr]: (opts: {
    sqliteWorker: SqliteWorkerInterface;
    streamId: string;
    agent: Agent;
    user: string;
    event: Event;
    variant: EventVariant<K>;
  }) => Promise<SqlStatement[]>;
} = {
  // Space
  "space.roomy.space.join.0": async ({ streamId, variant }) => [
    sql`
      insert into spaces (id, stream)
      values (
        ${Hash.enc(variant.spaceId)},
        ${Hash.enc(streamId)}
      )
      on conflict do update set hidden = 0
    `,
  ],
  "space.roomy.space.leave.0": async ({ streamId, variant }) => [
    sql`
      update spaces set hidden = 1
      where
        id = ${Hash.enc(variant.spaceId)}
          and
        stream = ${Hash.enc(streamId)}
    `,
  ],

  // Admin
  "space.roomy.admin.add.0": async ({
    sqliteWorker,
    agent,
    streamId,
    variant,
  }) => [
    ...(await ensureProfile(sqliteWorker, agent, {
      tag: "user",
      value: variant.adminId,
    })),
    sql`
      insert into space_admins (space_id, admin_id)
      values (
        ${Hash.enc(streamId)},
        ${variant.adminId}
      )
    `,
  ],
  "space.roomy.admin.remove.0": async ({ streamId, variant }) => [
    sql`
      delete from space_admins
      where 
        space_id = ${Hash.enc(streamId)}
          and
        admin_id = ${variant.adminId}
    `,
  ],

  // Info
  "space.roomy.info.0": async ({ streamId, event, variant }) => {
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
  "space.roomy.room.create.0": async ({ streamId, event }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_room (entity, parent)
      values (
        ${Ulid.enc(event.ulid)},
        ${event.parent ? Ulid.enc(event.parent) : null}
      )
    `,
  ],
  "space.roomy.room.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Delete room missing parent");
      return [];
    }
    return [
      sql`
        update comp_room
        set deleted = 1
        where id = ${Ulid.enc(event.parent)}
      `,
    ];
  },
  "space.roomy.room.member.add.0": async ({
    sqliteWorker,
    streamId,
    event,
    agent,
    variant,
  }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    ...(await ensureProfile(sqliteWorker, agent, variant.member_id)),
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
  "space.roomy.room.member.remove.0": async ({ streamId, event, variant }) => [
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
  "space.roomy.message.create.0": async ({
    sqliteWorker,
    streamId,
    user,
    event,
    agent,
    variant,
  }) => {
    const statements = [
      ensureEntity(streamId, event.ulid, event.parent),
      ...(await ensureProfile(sqliteWorker, agent, {
        tag: "user",
        value: user,
      })),
      sql`
        insert into comp_content (entity, mime_type, data)
        values (
          ${Ulid.enc(event.ulid)},
          ${variant.content.mimeType},
          ${variant.content.content}
        )`,
      sql`
        insert into comp_author (entity, author)
        values (
          ${Ulid.enc(event.ulid)},
          ${user}
        )`,
    ];

    if (variant.replyTo) {
      statements.push(sql`
        insert into comp_reply (entity, reply_to)
        values (
          ${Ulid.enc(event.ulid)},
          ${Ulid.enc(variant.replyTo)}
        )
      `);
    }

    return statements;
  },
  "space.roomy.message.edit.0": async ({ streamId, event, variant }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      update comp_content
      set 
        mime_type = ${variant.content.mimeType},
        data = ${variant.content.content}
      where entity = ${Ulid.enc(event.ulid)}
    `,
  ],
  "space.roomy.message.overrideMeta.0": async ({ event, variant }) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [
      sql`
        insert or replace into comp_override_meta (entity, source, author, timestamp)
        values (
          ${Ulid.enc(event.parent)},
          ${variant.source},
          ${variant.author},
          ${variant.timestamp}
        )`,
    ];
  },
  "space.roomy.message.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [sql`delete from entities where ulid = ${Ulid.enc(event.parent)}`];
  },

  // Reaction
  "space.roomy.reaction.create.0": async ({ streamId, event, variant }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_reaction (entity, reaction_to, reaction)
      values (
        ${Ulid.enc(event.ulid)},
        ${Ulid.enc(variant.reaction_to)},
        ${variant.reaction}
      )
    `,
  ],
  "space.roomy.reaction.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Delete reaction missing parent");
      return [];
    }
    return [sql`delete from entities where ulid = ${Ulid.enc(event.parent)}`];
  },

  // Media
  "space.roomy.media.create.0": async ({ streamId, event, variant }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_media (entity, uri)
      values (
        ${Ulid.enc(event.ulid)},
        ${variant.uri}
      )
    `,
  ],

  "space.roomy.media.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for media delete.");
      return [];
    }
    return [sql`delete from entities where ulid = ${Ulid.enc(event.parent)}`];
  },

  // Channels
  "space.roomy.channel.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for channel mark.");
      return [];
    }
    return [sql`insert into comp_channel values (${Ulid.enc(event.parent)})`];
  },
  "space.roomy.channel.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for channel unmark.");
      return [];
    }
    return [
      sql`delete from comp_channel where entity = ${Ulid.enc(event.parent)}`,
    ];
  },

  // Categories
  "space.roomy.category.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for category mark.");
      return [];
    }
    return [sql`insert into comp_category values (${Ulid.enc(event.parent)})`];
  },
  "space.roomy.category.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for category unmark.");
      return [];
    }
    return [
      sql`delete from comp_category where entity = ${Ulid.enc(event.parent)}`,
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
  return sql`
    insert into entities (ulid, stream, parent, created_at)
    values (
      ${Ulid.enc(ulid)},
      ${Hash.enc(streamId)},
      ${parent ? Ulid.enc(parent) : null},
      ${unixTimeMs}
    )
    on conflict(ulid) do nothing
  `;
}

async function ensureProfile(
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  member: CodecType<typeof GroupMember>,
): Promise<SqlStatement[]> {
  try {
    if (member.tag == "user") {
      const did = member.value;
      const profileFromDb = await sqliteWorker.runQuery(
        sql`select 1 from profiles where did = ${did}`,
      );
      if (profileFromDb.rows?.length) {
        // The profile is already in the DB so we don't need to update it.
        return [];
      }

      const profile = await agent.getProfile({ actor: did });
      if (!profile.success) return [];
      // FIXME: troubleshoot the fact that we are somehow making extraneous profile requests to the
      // atproto PDS in the backend worker.
      return [
        sql`
        insert or ignore into profiles (did, handle, display_name, avatar)
        values (
           ${did},
           ${profile.data.handle},
           ${profile.data.displayName},
           ${profile.data.avatar}
        )
      `,
      ];
    } else {
      return [];
    }
  } catch (e) {
    console.error("Could not ensure profile");
    return [];
  }
  // return [];
}

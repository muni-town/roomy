import type {
  SqlStatement,
  StreamEvent,
  MaterializerConfig,
} from "./backendWorker";
import { _void, type CodecType } from "scale-ts";
import { eventCodec, eventVariantCodec, GroupMember, id } from "./encoding";
import schemaSql from "./db/schema.sql?raw";
import { decodeTime } from "ulidx";
import { sql } from "$lib/utils/sqlTemplate";
import type { SqliteWorkerInterface } from "./types";
import type { Agent } from "@atproto/api";
import type { EdgesMap } from "./db/types/edges";
import type { LeafClient } from "@muni-town/leaf-client";

export type EventType = ReturnType<(typeof eventCodec)["dec"]>;

/** Database materializer config. */
export const config: MaterializerConfig = {
  initSql: schemaSql
    .split(";")
    .filter((x) => !!x)
    .map((sql) => ({ sql })),
  materializer,
};

/** Map a batch of incoming events to SQL that applies the event to the entities,
 * components and edges, then execute them all as a single transaction.
 */
export async function materializer(
  sqliteWorker: SqliteWorkerInterface,
  leafClient: LeafClient,
  agent: Agent,
  streamId: string,
  events: StreamEvent[],
): Promise<void> {
  const batch: SqlStatement[] = [];

  // reset ensured flags for each new batch
  ensuredProfiles = new Set();

  console.time("convert-events-to-sql");
  for (const incoming of events) {
    try {
      // Decode the event payload
      const event = eventCodec.dec(incoming.payload);

      // Get the SQL statements to be executed for this event
      const statements = await materializers[event.variant.kind]({
        sqliteWorker,
        streamId,
        leafClient,
        agent,
        user: incoming.user,
        event,
        data: event.variant.data,
      } as never);

      statements.push(sql`
        update events set applied = 1 
        where stream_id = ${id(streamId)} 
          and
        idx = ${incoming.idx} `);

      batch.push(...statements);
    } catch (e) {
      console.error(e);
    }
  }
  console.timeEnd("convert-events-to-sql");

  // Execute all of the statements in a transaction
  console.time("run-events-sql-transaction");
  await sqliteWorker.runSavepoint({ name: "batch", items: batch });
  console.timeEnd("run-events-sql-transaction");
}

type Event = CodecType<typeof eventCodec>;
type EventVariants = CodecType<typeof eventVariantCodec>;
type EventVariantStr = EventVariants["kind"];
type EventVariant<K extends EventVariantStr> = Extract<
  EventVariants,
  { kind: K }
>["data"];

/** SQL mapping for each event variant */
const materializers: {
  [K in EventVariantStr]: (opts: {
    sqliteWorker: SqliteWorkerInterface;
    leafClient: LeafClient;
    streamId: string;
    agent: Agent;
    user: string;
    event: Event;
    data: EventVariant<K>;
  }) => Promise<SqlStatement[]>;
} = {
  // Space
  "space.roomy.space.join.0": async ({ streamId, data }) => {
    return [
      ensureEntity(streamId, data.spaceId),
      sql`
        insert into comp_space (entity)
        values (${id(data.spaceId)})
        on conflict do update set hidden = 0
      `,
    ];
  },
  "space.roomy.space.leave.0": async ({ data }) => [
    sql`
      update comp_space set hidden = 1
      where entity = ${id(data.spaceId)}
    `,
  ],

  // Admin
  "space.roomy.admin.add.0": async ({
    sqliteWorker,
    agent,
    streamId,
    data,
    leafClient,
  }) => {
    return [
      ...(await ensureProfile(
        sqliteWorker,
        agent,
        {
          tag: "user",
          value: data.adminId,
        },
        streamId,
        leafClient,
      )),
      sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${id(streamId)},
        ${id(data.adminId)},
        'member',
        ${edgePayload({
          can: "admin",
        })} 
      )
    `,
    ];
  },
  "space.roomy.admin.remove.0": async ({ streamId, data }) => [
    sql`
      update edges set payload = (${JSON.stringify({ can: "post" })})
      where 
        head = ${id(streamId)}
          and
        tail = ${id(data.adminId)}
          and
        label = 'member'
    `,
  ],

  // Info
  "space.roomy.info.0": async ({ streamId, event, data }) => {
    const updates = [
      { key: "name", ...data.name },
      { key: "avatar", ...data.avatar },
      { key: "description", ...data.description },
    ];
    const setUpdates = updates.filter((x) => x.tag == "set");

    const entityId = event.parent ? event.parent : streamId;

    return [
      ensureEntity(streamId, event.ulid),
      {
        sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
        params: Object.fromEntries([
          [":entity", id(entityId)],
          ...setUpdates.map((x) => [":" + x.key, x.value]),
        ]),
      },
    ];
  },

  // Room
  "space.roomy.room.create.0": async ({ streamId, event }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_room (entity, parent)
      values (
        ${id(event.ulid)},
        ${event.parent ? id(event.parent) : null}
      ) on conflict do update set parent = excluded.parent
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
        where id = ${id(event.parent)}
      `,
    ];
  },
  // TODO
  "space.roomy.room.member.add.0": async (
    {
      // sqliteWorker,
      // streamId,
      // event,
      // agent,
      // data,
      // leafClient,
    },
  ) => [
    // ensureEntity(streamId, event.ulid, event.parent),
    // ...(await ensureProfile(
    //   sqliteWorker,
    //   agent,
    //   data.member_id,
    //   streamId,
    //   leafClient,
    // )),
    // {
    //   sql: event.parent
    //     ? `insert into comp_room_members (room, member, access) values (?, ?, ?)`
    //     : `insert into space_members (space_id, member, access) values (?, ?, ?)`,
    //   params: [
    //     event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
    //     GroupMember.enc(data.member_id),
    //     ReadOrWrite.enc(data.access),
    //   ],
    // },
  ],
  // TODO
  "space.roomy.room.member.remove.0": async ({}) => [
    // ensureEntity(streamId, event.ulid, event.parent),
    // {
    //   sql: event.parent
    //     ? "delete from comp_room_members where room = ? and member = ? and access = ?"
    //     : "delete from space_members where space_id = ? and member = ? and access = ?",
    //   params: [
    //     event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
    //     GroupMember.enc(data.member_id),
    //     ReadOrWrite.enc(data.access),
    //   ],
    // },
  ],

  // Message
  "space.roomy.message.create.0": async ({
    sqliteWorker,
    streamId,
    user,
    event,
    agent,
    data,
    leafClient,
  }) => {
    const statements = [
      ensureEntity(streamId, event.ulid, event.parent),
      ...(await ensureProfile(
        sqliteWorker,
        agent,
        {
          tag: "user",
          value: user,
        },
        streamId,
        leafClient,
      )),
      sql`
        insert into edges (head, tail, label)
        values (
          ${id(event.ulid)},
          ${id(user)},
          'author'
        )
      `,
      sql`
        insert or replace into comp_content (entity, mime_type, data)
        values (
          ${id(event.ulid)},
          ${data.content.mimeType},
          ${data.content.content}
        )`,
    ];

    if (data.replyTo) {
      statements.push(sql`
        insert into edges (head, tail, label)
        values (
          ${id(event.ulid)},
          ${id(data.replyTo)},
          'reply'
        )
      `);
    }

    return statements;
  },
  "space.roomy.message.edit.0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      update comp_content
      set 
        mime_type = ${data.content.mimeType},
        data = ${data.content.content}
      where entity = ${id(event.ulid)}
    `,
  ],
  "space.roomy.message.overrideMeta.0": async ({ event, data }) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [
      sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${id(event.parent)},
          ${id(data.author)},
          ${Number(data.timestamp)}
        )`,
    ];
  },
  "space.roomy.message.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [sql`delete from entities where id = ${id(event.parent)}`];
  },

  // Reaction
  "space.roomy.reaction.create.0": async ({ streamId, event }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    // TODO: insert edge for reaction
  ],
  "space.roomy.reaction.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Delete reaction missing parent");
      return [];
    }
    return [sql`delete from entities where id = ${id(event.parent)}`];
  },

  // Media
  "space.roomy.media.create.0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_media (entity, uri)
      values (
        ${id(event.ulid)},
        ${data.uri}
      )
    `,
  ],

  "space.roomy.media.delete.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for media delete.");
      return [];
    }
    return [sql`delete from entities where id = ${id(event.parent)}`];
  },

  // Channels
  "space.roomy.channel.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for channel mark.");
      return [];
    }
    return [
      sql`
      update comp_room set label = 'channel' where entity = ${id(event.parent)}
      `,
    ];
  },
  "space.roomy.channel.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for channel unmark.");
      return [];
    }
    return [
      sql`update comp_room set label = null where entity = ${id(event.parent)} and label = 'channel'`,
    ];
  },

  // Categories
  "space.roomy.category.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for category mark.");
      return [];
    }
    return [
      sql`update comp_room set label = 'category' where entity = ${id(event.parent)}`,
    ];
  },
  "space.roomy.category.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for category unmark.");
      return [];
    }
    return [
      sql`update comp_room set label = null where entity = ${id(event.parent)} and label = 'category'`,
    ];
  },
};

// UTILS

function ensureEntity(
  streamId: string,
  entityId: string,
  parent?: string,
): SqlStatement {
  let unixTimeMs = Date.now();

  // If the entity ID is a ulid, decode the time and use that as the created time.
  try {
    unixTimeMs = decodeTime(entityId);
  } catch (_) {}

  const statement = sql`
    insert into entities (id, stream_id, parent, created_at)
    values (
      ${id(entityId)},
      ${id(streamId)},
      ${parent ? id(parent) : undefined},
      ${unixTimeMs}
    )
    on conflict(id) do nothing
  `;
  return statement;
}

/** When mapping incoming events to SQL, 'ensureProfile' checks whether a DID
 * exists in the profiles table. If not, it makes an API call to bsky to get some
 * basic info, and then returns SQL to add it to the profiles table. Rather than
 * inserting it immediately and breaking transaction atomicity, this is just a set
 * of flags to indicate that the profile doesn't need to be re-fetched.
 */
let ensuredProfiles = new Set();

async function ensureProfile(
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  member: CodecType<typeof GroupMember>,
  streamId: string,
  _client: LeafClient,
): Promise<SqlStatement[]> {
  try {
    if (member.tag == "user") {
      const did = member.value;

      const existingProfile = await sqliteWorker.runQuery(
        sql`select 1 from entities where id = ${id(did)}`,
      );

      // We already have the profile.
      if (existingProfile.rows?.length) return [];

      if (ensuredProfiles.has(did)) {
        // The profile has already been fetched and the statement to insert it is in the batch
        return [];
      }

      const profile = await agent.getProfile({ actor: did });

      if (!profile.success) return [];

      if (ensuredProfiles.has(did)) return [];

      return [
        sql`
          insert into entities (id, stream_id)
          values (${id(did)}, ${id(streamId)})
          on conflict(id) do nothing
        `,
        sql`
          insert into comp_user (did, handle)
          values (
            ${id(did)},
            ${profile.data.handle}
          )
          on conflict(did) do nothing
        `,
        sql`
          insert into comp_info (entity, name, avatar)
          values (
            ${id(did)},
            ${profile.data.displayName},
            ${profile.data.avatar}
          )
          on conflict(entity) do nothing
        `,
      ];
    } else {
      return [];
    }
  } catch (e) {
    console.error("Could not ensure profile", e);
    return [];
  }
}

function edgePayload<EdgeLabel extends "reaction" | "member" | "ban">(
  payload: EdgesMap[EdgeLabel],
) {
  return JSON.stringify(payload);
}

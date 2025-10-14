import type {
  SqlStatement,
  StreamEvent,
  MaterializerConfig,
} from "./backendWorker";
import { _void, type CodecType } from "scale-ts";
import { eventCodec, eventVariantCodec, id } from "./encoding";
import schemaSql from "./schema.sql?raw";
import { decodeTime } from "ulidx";
import { sql } from "$lib/utils/sqlTemplate";
import type { SqliteWorkerInterface } from "./types";
import type { Agent } from "@atproto/api";
import type { LeafClient } from "@muni-town/leaf-client";
import { AsyncChannel } from "./asyncChannel";

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
export function materializer(
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  streamId: string,
  eventChannel: AsyncChannel<StreamEvent[]>,
): AsyncChannel<{ sqlStatements: SqlStatement[]; latestEvent: number }> {
  const sqlChannel = new AsyncChannel<{
    sqlStatements: SqlStatement[];
    latestEvent: number;
  }>();

  (async () => {
    for await (const events of eventChannel) {
      const batch: SqlStatement[] = [];

      console.time("convert-events-to-sql");

      // reset ensured flags for each new batch
      ensuredProfiles = new Set();

      const decodedEvents = events.map(
        (e) => [e, eventCodec.dec(e.payload)] as const,
      );

      // Make sure all of the profiles we need are downloaded and inserted
      const neededProfiles = new Set<string>();
      decodedEvents.forEach(([i, ev]) =>
        ev.variant.kind == "space.roomy.message.create.0"
          ? neededProfiles.add(i.user)
          : undefined,
      );

      batch.push(
        ...(await ensureProfiles(
          streamId,
          neededProfiles,
          sqliteWorker,
          agent,
        )),
      );

      let latestEvent = 0;
      for (const [incoming, event] of decodedEvents) {
        latestEvent = Math.max(latestEvent, incoming.idx);
        try {
          // Get the SQL statements to be executed for this event
          const statements = await materializers[event.variant.kind]({
            sqliteWorker,
            streamId,
            agent,
            user: incoming.user,
            event,
            data: event.variant.data,
          } as never);

          statements.push(sql`
            update events set applied = 1 
            where stream_id = ${id(streamId)} 
              and
            idx = ${incoming.idx}
          `);

          batch.push(...statements);
        } catch (e) {
          console.error(e);
        }
      }
      sqlChannel.push({ sqlStatements: batch, latestEvent });
      console.timeEnd("convert-events-to-sql");
    }
    sqlChannel.finish();
  })();

  return sqlChannel;
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
  "space.roomy.admin.add.0": async ({ streamId, data }) => {
    return [
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
    const setUpdates = updates.filter((x) => "set" in x);

    const entityId = event.parent ? event.parent : streamId;

    return [
      ensureEntity(streamId, event.ulid),
      {
        sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
        params: Object.fromEntries([
          [":entity", id(entityId)],
          ...setUpdates.map((x) => [":" + x.key, x.set]),
        ]),
      },
    ];
  },

  // Room
  "space.roomy.room.create.0": async ({ streamId, event }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_room ( entity )
      values ( ${id(event.ulid)} )
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
  "space.roomy.parent.update.0": async ({ event, data }) => {
    if (!event.parent) {
      console.warn("Update room parent missing parent");
      return [];
    }
    return [
      sql`
        update entities set parent = ${data.parent ? id(data.parent) : null}
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
  "space.roomy.message.create.0": async ({ streamId, user, event, data }) => {
    const statements = [
      ensureEntity(streamId, event.ulid, event.parent),
      sql`
        insert into edges (head, tail, label)
        select 
          ${id(event.ulid)},
          ${id(user)},
          'author'
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

  // TODO: make sure there is valid permission to send override metadata
  "space.roomy.user.overrideMeta.0": async ({ event, data }) => {
    if (!event.parent) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [
      sql`
        insert into comp_user (did, handle)
        values (
          ${id(event.parent)},
          ${data.handle}
        )
        on conflict(did) do update set handle = ${data.handle}
      `,
    ];
  },
  "space.roomy.message.overrideMeta.0": async ({ streamId, event, data }) => {
    // Note using the stream ID is kind of a special case for a "system" user if you want to have
    // the space itself be able to send messages.
    const userId = event.parent || streamId;
    return [
      sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${id(userId)},
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
  "space.roomy.reaction.create.0": async ({ data, user }) => {
    return [
      sql`
        insert into edges (head, tail, label, payload)
        values (
          ${id(user)},
          ${id(data.reactionTo)},
          'reaction',
          ${data.reaction}
        )
      `,
    ];
  },
  "space.roomy.reaction.delete.0": async ({ event, user, data }) => {
    if (!event.parent) {
      console.warn("Delete reaction missing parent");
      return [];
    }
    return [
      sql`
      delete from edges
      where
        head = ${id(user)} and
        label = 'reaction' and
        tail = ${id(data.reaction_to)} and
        payload = ${data.reaction}
    `,
    ];
  },

  // TODO: make sure there is valid permission to send bridged reaction
  "space.roomy.reaction.bridged.create.0": async ({ data }) => {
    return [
      sql`
        insert into edges (head, tail, label, payload)
        values (
          ${id(data.reactingUser)},
          ${id(data.reactionTo)},
          'reaction',
          ${data.reaction}
        )
      `,
    ];
  },
  "space.roomy.reaction.bridged.delete.0": async ({ event, data }) => {
    if (!event.parent) {
      console.warn("Delete reaction missing parent");
      return [];
    }
    return [
      sql`
      delete from edges
      where
        head = ${id(data.reactingUser)} and
        label = 'reaction' and
        tail = ${id(data.reaction_to)} and
        payload = ${data.reaction}
    `,
    ];
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

  // Threads
  "space.roomy.thread.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for thread mark.");
      return [];
    }
    return [
      sql`
      update comp_room set label = 'thread' where entity = ${id(event.parent)}
      `,
    ];
  },
  "space.roomy.thread.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for thread unmark.");
      return [];
    }
    return [
      sql`update comp_room set label = null where entity = ${id(event.parent)} and label = 'thread'`,
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
let ensuredProfiles = new Set<string>();

async function ensureProfiles(
  streamId: string,
  profileDids: Set<string>,
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
): Promise<SqlStatement[]> {
  try {
    // This only knows how to fetch Bluesky DIDs for now
    const dids = [...profileDids].filter(
      (x) =>
        x.startsWith("did:plc:") ||
        x.startsWith("did:web:") ||
        ensuredProfiles.has(x),
    );
    if (dids.length == 0) return [];

    const missingProfilesResp = await sqliteWorker.runQuery<{ did: string }>({
      sql: `with existing(did) as (
        values ${dids.map((_) => `(?)`).join(",")}
      )
      select id(did) as did
      from existing
      left join entities ent on ent.id = existing.did
      where ent.id is null
      `,
      params: dids.map(id),
    });
    const missingDids = missingProfilesResp.rows?.map((x) => x.did) || [];
    if (missingDids.length == 0) return [];

    const statements = [];

    for (const did of missingDids) {
      ensuredProfiles.add(did);

      const profile = await agent.getProfile({ actor: did });
      if (!profile.success) continue;

      statements.push(
        ...[
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
            ${profile.data.displayName || profile.data.handle},
            ${profile.data.avatar}
          )
          on conflict(entity) do nothing
        `,
        ],
      );
    }

    return statements;
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

export type EdgeLabel =
  | "child"
  | "parent"
  | "subscribe"
  | "member"
  | "ban"
  | "hide"
  | "pin"
  | "last_read"
  | "embed"
  | "reply"
  | "link"
  | "author"
  | "reorder"
  | "source"
  | "avatar"
  | "reaction";

type EntityId = string;
export interface EdgeReaction {
  reaction: string;
}

export interface EdgeBan {
  reason: string;
  banned_by: EntityId;
}

export interface EdgeMember {
  // delegation?: string;
  can: "read" | "post" | "admin";
}

export type EdgesMap = {
  [K in Exclude<EdgeLabel, "reaction" | "member" | "ban">]: null;
} & {
  reaction: EdgeReaction;
  ban: EdgeBan;
  member: EdgeMember;
};

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], EntityId];
};

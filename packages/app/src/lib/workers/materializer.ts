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
  console.time("convert");
  const batch: SqlStatement[][] = [];

  // reset ensured flags for each new batch
  ensuredProfiles = new Map();

  for (const incoming of events) {
    try {
      // Decode the event payload
      const event = eventCodec.dec(incoming.payload);

      console.log("Materialising event #", incoming.idx, "of type", event.variant.kind, "in stream", streamId)

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

      console.log("materialisations mapped")

      statements.push(sql`
        update events set applied = 1 
        where stream_hash_id = ${Hash.enc(streamId)} 
          and
        idx = ${incoming.idx} `)

      batch.push(statements);

      // // Add a savepoint to the list
      // savepoints.push({ name: "event", items: statements });
    } catch (e) {
      console.error(e);
    }
  }
  console.timeEnd("convert");

  console.log("Running batch of materialisations for stream", streamId)

  // Execute all of the statements in a transaction
  console.time("runSql");
  await sqliteWorker.runSavepoint({ name: "batch", items: batch.flat() });
  console.log("Batch of materialisations run successfully for stream", streamId)
  console.timeEnd("runSql");
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
  "space.roomy.space.join.0": async ({ streamId, data, leafClient }) => {
    console.log("getting stamp for spaceId", data.spaceId)
    const { stamp } = await leafClient.streamInfo(data.spaceId);
    console.log('space streaminfo stamp', stamp);
    return [
      ensureEntity(streamId, stamp),
      sql`
      insert into comp_space (entity, leaf_space_hash_id, personal_stream_hash_id)
      values (
        ${Ulid.enc(stamp)},
        ${Hash.enc(data.spaceId)},
        ${Hash.enc(streamId)}
      )
      on conflict do update set hidden = 0
    `,
    ];
  },
  "space.roomy.space.leave.0": async ({ streamId, data }) => [
    sql`
      update comp_space set hidden = 1
      where
        leaf_space_hash_id = ${Hash.enc(data.spaceId)}
          and
        personal_stream_hash_id = ${Hash.enc(streamId)}
    `,
  ],

  // Admin
  "space.roomy.admin.add.0": async ({
    sqliteWorker,
    agent,
    streamId,
    data,
    leafClient
  }) => {
    const userUlid = ensuredProfiles.get(data.adminId);
    console.log("space.roomy.admin.add.0 streamId", streamId)
    const spaceUlid = await sqliteWorker.runQuery(sql`select entity from comp_space where leaf_space_hash_id = ${Hash.enc(streamId)}`)
    console.log("userUlid", userUlid)
    console.log("spaceUlid", spaceUlid)
    return [
      ...(await ensureProfile(
        sqliteWorker,
        agent,
        {
          tag: "user",
          value: data.adminId,
        },
        streamId,
        leafClient
      )),
      sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        (select entity from comp_space where leaf_space_hash_id = ${Hash.enc(streamId)}),
        (select entity from comp_user where did = ${data.adminId}),
        'member',
        ${edgePayload({
        can: "admin",
      })} 
      )
    `,
    ]
  },
  "space.roomy.admin.remove.0": async ({ streamId, data }) => [
    sql`
      update space_admins (payload)
      values (${JSON.stringify({ can: "post" })})
      where 
        head = (select entity from comp_space where leaf_space_hash_id = ${Hash.enc(streamId)})
          and
        tail = (select entity from comp_user where did = ${data.adminId})
          and
        label = 'member'
    `,
  ],

  // Info
  "space.roomy.info.0": async ({ streamId, event, data, sqliteWorker }) => {
    const updates = [
      { key: "name", ...data.name },
      { key: "avatar", ...data.avatar },
      { key: "description", ...data.description },
    ];
    const setUpdates = updates.filter((x) => x.tag == "set");

    const check = await sqliteWorker.runQuery(sql`
      select format_ulid(entity) from comp_space where leaf_space_hash_id = ${Hash.enc(streamId)}`)
    console.log("check", check, "streamId", streamId)
    console.log("setUpdates", setUpdates)

    if (!event.parent) {
      return [
        ensureEntity(streamId, event.ulid),
        {
          sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES ((select entity from comp_space where leaf_space_hash_id = :stream_id), ${setUpdates.map((x) => `:${x.key}`)}) on conflict do update
            set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
          params: Object.fromEntries([
            [":stream_id", Hash.enc(streamId)],
            ...setUpdates.map((x) => [":" + x.key, x.value]),
          ]),
        },
      ];
    } else {
      return [
        ensureEntity(streamId, event.ulid, event.parent),
        {
          sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:ulid, ${setUpdates.map((x) => `:${x.key}`)}) on conflict do update
            set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
          params: Object.fromEntries([
            [":ulid", Ulid.enc(event.ulid)],
            ...setUpdates.map((x) => [":" + x.key, x.value]),
          ]),
        },
      ]
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
        where id = ${Ulid.enc(event.parent)}
      `,
    ];
  },
  "space.roomy.room.member.add.0": async ({
    sqliteWorker,
    streamId,
    event,
    agent,
    data,
    leafClient
  }) => [
      ensureEntity(streamId, event.ulid, event.parent),
      ...(await ensureProfile(sqliteWorker, agent, data.member_id, streamId, leafClient)),
      {
        sql: event.parent
          ? `insert into comp_room_members (room, member, access) values (?, ?, ?)`
          : `insert into space_members (space_id, member, access) values (?, ?, ?)`,
        params: [
          event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
          GroupMember.enc(data.member_id),
          ReadOrWrite.enc(data.access),
        ],
      },
    ],
  "space.roomy.room.member.remove.0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    {
      sql: event.parent
        ? "delete from comp_room_members where room = ? and member = ? and access = ?"
        : "delete from space_members where space_id = ? and member = ? and access = ?",
      params: [
        event.parent ? Ulid.enc(event.parent) : Hash.enc(streamId),
        GroupMember.enc(data.member_id),
        ReadOrWrite.enc(data.access),
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
    data,
    leafClient
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
        leafClient
      )),
      sql`
        insert or replace into comp_content (entity, mime_type, data)
        values (
          ${Ulid.enc(event.ulid)},
          ${data.content.mimeType},
          ${data.content.content}
        )`,
    ];

    if (data.replyTo) {
      statements.push(sql`
        insert or replace into comp_reply (entity, reply_to)
        values (
          ${Ulid.enc(event.ulid)},
          ${Ulid.enc(data.replyTo)}
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
      where entity = ${Ulid.enc(event.ulid)}
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
          ${Ulid.enc(event.parent)},
          ${data.author},
          ${Number(data.timestamp)}
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
  "space.roomy.reaction.create.0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_reaction (entity, reaction_to, reaction)
      values (
        ${Ulid.enc(event.ulid)},
        ${Ulid.enc(data.reaction_to)},
        ${data.reaction}
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
  "space.roomy.media.create.0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.ulid, event.parent),
    sql`
      insert into comp_media (entity, uri)
      values (
        ${Ulid.enc(event.ulid)},
        ${data.uri}
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
    return [
      sql`
      insert into comp_room (entity, label) values (${Ulid.enc(event.parent)}, 'channel')
      on conflict do update set label = excluded.label
      `,
    ];
  },
  "space.roomy.channel.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for channel unmark.");
      return [];
    }
    return [
      sql`update comp_room (label) where entity = ${Ulid.enc(event.parent)} values (null)`,
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
  parent?: string,
): SqlStatement {
  const unixTimeMs = decodeTime(ulid);
  const statement = sql`
    insert into entities (ulid, stream_hash_id, parent, created_at)
    values (
      ${Ulid.enc(ulid)},
      ${Hash.enc(streamId)},
      ${parent ? Ulid.enc(parent) : null},
      ${unixTimeMs}
    )
    on conflict(ulid) do nothing
  `;
  console.log("ensureEntity ulid", ulid, Ulid.enc(ulid))
  console.log("ensureEntity statement", statement)
  return statement
}

/** When mapping incoming events to SQL, 'ensureProfile' checks whether a DID
 * exists in the profiles table. If not, it makes an API call to bsky to get some
 * basic info, and then returns SQL to add it to the profiles table. Rather than
 * inserting it immediately and breaking transaction atomicity, this is just a set
 * of flags to indicate that the profile doesn't need to be re-fetched.
 */
let ensuredProfiles = new Map();

async function ensureProfile(
  sqliteWorker: SqliteWorkerInterface,
  agent: Agent,
  member: CodecType<typeof GroupMember>,
  streamId: string,
  client: LeafClient
): Promise<SqlStatement[]> {
  try {
    if (member.tag == "user") {
      const did = member.value;
      if (ensuredProfiles.has(did)) {
        // The profile has already been fetched and the statement to insert it is in the batch
        return [];
      }

      const profile = await agent.getProfile({ actor: did });

      const user = await sqliteWorker.runQuery(sql`
        select entity from comp_user where did = ${did}
      `);
      console.log("user", user, "for did", did)
      const { stamp } = await client.streamInfo(streamId);

      console.log("stamp", stamp)
      ensuredProfiles.set(did, stamp);

      if (!profile.success) return [];

      // FIXME: troubleshoot the fact that we are somehow making extraneous profile requests to the
      // atproto PDS in the backend worker.
      return [
        sql`
          insert into entities (ulid, stream_hash_id)
          values (${Ulid.enc(stamp)}, ${Hash.enc(streamId)})
          on conflict(ulid) do nothing
          `,
        sql`
        insert into comp_user (entity, did, handle)
        values (
           ${Ulid.enc(stamp)},
           ${did},
           ${profile.data.handle}
        )
        on conflict(entity) do nothing
      `,
        // sql`
        //   insert into comp_info (entity, name, avatar)
        //   values (
        //     ${Ulid.enc(stamp)},
        //     ${profile.data.displayName},
        //     ${profile.data.avatar}
        //   )
        //   on conflict(entity) do nothing
        //   `,
      ];
    } else {
      return [];
    }
  } catch (e) {
    console.error("Could not ensure profile", e);
    return [];
  }
}

let ensuredSpaces = new Map();

async function ensureSpace(streamId: string): Promise<SqlStatement[]> {
  try {
    // space has already been added
    if (ensuredSpaces.has(streamId)) return [];
    return []
  } catch (e) {
    console.error("Could not ensure space", e);
    return [];
  }
}

function edgePayload<EdgeLabel extends "reaction" | "member" | "ban">(
  payload: EdgesMap[EdgeLabel],
) {
  return JSON.stringify(payload);
}

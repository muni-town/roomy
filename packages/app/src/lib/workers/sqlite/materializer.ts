import type { Bundle, StreamIndex } from "../types";
import { decodeTime } from "ulidx";
import { sql } from "$lib/utils/sqlTemplate";
import type { SqlStatement } from "./types";
import {
  type Event,
  type EventVariant,
  type EventType,
  fromBytes,
  type Ulid,
  UserDid,
  StreamDid,
} from "$lib/schema";
import { WithParent, WithTarget } from "$lib/schema/events/dependencies";

/** SQL mapping for each event variant */
const materializers: {
  [K in EventType]: (opts: {
    streamId: StreamDid;
    user: UserDid;
    event: Event<K>;
    data: EventVariant<K>;
  }) => Promise<SqlStatement[]>;
} = {
  // Space
  "space.roomy.stream.personal.joinSpace.v0": async ({ streamId, data }) => {
    return [
      ensureEntity(streamId, data.spaceDid),
      // because we are materialising a non-personal-stream space, we infer that we are backfilling in the background
      sql`
        insert into comp_space (entity)
        values (${data.spaceDid})
        on conflict do update set hidden = 0
      `,
    ];
  },
  "space.roomy.stream.personal.leaveSpace.v0": async ({ data }) => [
    sql`
      update comp_space set hidden = 1,
      where entity = ${data.spaceDid}
    `,
  ],
  "space.roomy.room.joinRoom.v0": async ({ streamId, user, event }) => [
    // if event has parent, it's for joining a room; if not, it's for joining the space
    sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${event.room ? event.room : streamId},
        ${user},
        'member',
        ${edgePayload({
          can: "post",
        })}
      )
    `,
    // Create a virtual message announcing the member joining
    sql`
    insert into entities (id, stream_id, parent)
    values (
      ${event.id},
      ${streamId},
      (
        select entity
          from comp_room join entities e on e.id = entity
          where label = 'channel' and deleted = 0 and e.stream_id = ${streamId}
          order by entity
          limit 1
      )
    )
  `,
    // Set author on the virtual message to be the stream itself
    sql`
        insert into edges (head, tail, label)
        select 
          ${event.id},
          ${streamId},
          'author'
      `,
    sql`
      insert or replace into comp_content (entity, mime_type, data)
      values (
        ${event.id},
        'text/markdown',
        cast(('[@' || (select handle from comp_user where did = ${user}) || '](/user/' || ${user} || ') joined the space.') as blob)
    )`,
  ],
  "space.roomy.room.leaveRoom.v0": async ({ streamId, user, event }) => [
    sql`
      delete from edges
      where 
        head = ${event.room ? event.room : streamId}
          and
        tail = ${user}
          and
        label = 'member'
    `,
  ],
  "space.roomy.stream.setHandleAccount.v0": async ({ streamId, data }) => [
    sql`
      update comp_space set handle_account = ${data.did || null}
      where entity = ${streamId}
    `,
  ],

  // Admin
  "space.roomy.stream.addAdmin.v0": async ({ streamId, data }) => {
    return [
      sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${streamId},
        ${data.userDid},
        'member',
        ${edgePayload({
          can: "admin",
        })} 
      )
    `,
    ];
  },
  "space.roomy.stream.removeAdmin.v0": async ({ streamId, data }) => [
    sql`
      update edges set payload = (${JSON.stringify({ can: "post" })})
      where 
        head = ${streamId}
          and
        tail = ${data.userDid}
          and
        label = 'member'
    `,
  ],

  // Info
  "space.roomy.stream.updateStreamInfo.v0": async ({
    streamId,
    event,
    data,
  }) => {
    const updates = [
      { key: "name", value: data.name },
      { key: "avatar", value: data.avatar },
      { key: "description", value: data.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    return [
      ensureEntity(streamId, event.id),
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", streamId],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ].filter((x) => !!x);
  },

  // Info
  "space.roomy.user.updateProfile.v0": async ({ streamId, event, data }) => {
    const updates = [
      { key: "name", value: data.name },
      { key: "avatar", value: data.avatar },
      { key: "description", value: data.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    return [
      ensureEntity(streamId, event.id),
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", data.did],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ].filter((x) => !!x);
  },

  // Room
  "space.roomy.room.createRoom.v0": async ({ streamId, event, data }) => [
    ensureEntity(streamId, event.id, event.room),
    sql`
      insert into comp_info ( entity, name, avatar, description)
      values ( ${event.id}, ${data.name || null}, ${data.avatar || null}, ${data.description || null})
    `,
    sql`
      insert into comp_room ( entity, label )
      values ( ${event.id}, ${data.kind} ) on conflict do nothing
    `,
  ],
  "space.roomy.room.deleteRoom.v0": async ({ event }) => {
    if (!event.room) {
      console.warn("Delete room missing room");
      return [];
    }
    return [
      sql`
        update comp_room
        set deleted = 1
        where id = ${event.room}
      `,
    ];
  },

  "space.roomy.room.updateParent.v0": async ({ event, data }) => {
    // Update the parent room
    return [
      sql`
        update entities set parent = ${data.parent || null}
        where id = ${event.room}
        `,
    ];
  },

  "space.roomy.room.updateRoom.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Update room parent missing room");
      return [];
    }

    const updates = [
      { key: "name", value: data.name },
      { key: "avatar", value: data.avatar },
      { key: "description", value: data.description },
    ];
    const setUpdates = updates.filter((x) => x.value !== undefined);

    return [
      // Update the room kind
      data.kind !== undefined
        ? sql`
          update comp_room set label = ${data.kind} where entity = ${event.room}
          `
        : undefined,

      // Update the room info
      setUpdates.length > 0
        ? {
            sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
            params: Object.fromEntries([
              [":entity", event.room],
              ...setUpdates.map((x) => [
                ":" + x.key,
                "value" in x ? x.value : undefined,
              ]),
            ]),
          }
        : undefined,
    ].filter((x) => !!x);
  },
  // TODO
  "space.roomy.room.addMember.v0": async (
    {
      // sqliteWorker,
      // streamId,
      // event,
      // agent,
      // data,
      // leafClient,
    },
  ) => [
    // ensureEntity(streamId, event.id, event.room),
    // ...(await ensureProfile(
    //   sqliteWorker,
    //   agent,
    //   data.member_id,
    //   streamId,
    //   leafClient,
    // )),
    // {
    //   sql: event.room
    //     ? `insert into comp_room_members (room, member, access) values (?, ?, ?)`
    //     : `insert into space_members (space_id, member, access) values (?, ?, ?)`,
    //   params: [
    //     event.room ? Ulid.enc(event.room) : Hash.enc(streamId),
    //     GroupMember.enc(data.member_id),
    //     ReadOrWrite.enc(data.access),
    //   ],
    // },
  ],
  // TODO
  "space.roomy.room.updateMember.v0": async ({}) => [],
  // TODO
  "space.roomy.room.removeMember.v0": async ({}) => [
    // ensureEntity(streamId, event.id, event.room),
    // {
    //   sql: event.room
    //     ? "delete from comp_room_members where room = ? and member = ? and access = ?"
    //     : "delete from space_members where space_id = ? and member = ? and access = ?",
    //   params: [
    //     event.room ? Ulid.enc(event.room) : Hash.enc(streamId),
    //     GroupMember.enc(data.member_id),
    //     ReadOrWrite.enc(data.access),
    //   ],
    // },
  ],

  // Message v0
  "space.roomy.message.sendMessage.v0": async ({
    streamId,
    user,
    event,
    data,
  }) => {
    if (!event.room) throw new Error("No room for message");
    const statements = [
      ensureEntity(streamId, event.id, event.room),
      sql`
        insert or replace into edges (head, tail, label)
        select 
          ${event.id},
          ${user},
          'author'
      `,
      sql`
        insert or replace into comp_content (entity, mime_type, data, last_edit)
        values (
          ${event.id},
          ${data.body.mimeType},
          ${fromBytes(data.body.data)},
          ${event.id}
        )`,
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
          values (${event.room}, 1, 1)
          on conflict(entity) do update set
            unread_count = case
              when ${decodeTime(event.id)} > comp_last_read.timestamp
              then comp_last_read.unread_count + 1
              else comp_last_read.unread_count
            end,
            updated_at = (unixepoch() * 1000)
      `,
    ];

    for (const att of data.extensions["space.roomy.extension.attachments.v0"]
      ?.attachments || []) {
      // Handle replies
      if (att.$type == "space.roomy.attachment.reply.v0") {
        // TODO: allow multiple replies
        statements.push(sql`
          insert or ignore into edges (head, tail, label)
          values (
            ${event.id},
            ${att.target},
            'reply'
          )
        `);
      } else if (att.$type == "space.roomy.attachment.comment.v0") {
        statements.push(
          sql`
          insert into comp_comment (entity, version, snippet, idx_from, idx_to, updated_at)
          values (
            ${event.id},
            ${att.version},
            ${att.snippet || ""},
            ${att.from},
            ${att.to},
            (unixepoch() * 1000)
          )`,
        );
      } else if (att.$type == "space.roomy.attachment.image.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        // TODO: allow multiple images in the db schema
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_image (entity, mime_type, alt, width, height, blurhash, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.video.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        // TODO: allow multiple videos in the db schema
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_video (entity, mime_type, alt, width, height, length, blurhash, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.alt},
              ${att.width ? Number(att.width) : null},
              ${att.height ? Number(att.height) : null},
              ${att.length ? Number(att.length) : null},
              ${att.blurhash || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.file.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
            insert or replace into comp_file (entity, mime_type, name, size)
            values (
              ${uriWithUlidQuery},
              ${att.mimeType},
              ${att.name || null},
              ${att.size ? Number(att.size) : null}
            )
        `,
        );
      } else if (att.$type == "space.roomy.attachment.link.v0") {
        const uriWithUlidQuery = att.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
          insert into comp_link (entity, show_preview)
          values (
            ${uriWithUlidQuery},
            ${att.showPreview ? 1 : 0}
          )
        `,
        );
      }
    }

    // Handle overrideAuthorDid, overrideTimestamp extensions - comp_override_meta
    const overrideAuthorExt =
      data.extensions["space.roomy.extension.authorOverride.v0"]?.did;
    const overrideTimestampExt =
      data.extensions["space.roomy.extension.timestampOverride.v0"]?.timestamp;

    if (overrideAuthorExt || overrideTimestampExt) {
      statements.push(sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${event.id},
          ${overrideAuthorExt ? overrideAuthorExt : null},
          ${overrideTimestampExt ? Number(overrideTimestampExt) : null}
        )
      `);
    }

    return statements;
  },

  "space.roomy.message.editMessage.v0": async ({ streamId, event, data }) => {
    if (!event.room) {
      console.warn("Edit event missing room");
      return [];
    }

    // TODO: implement edited extensions like replies / attachments
    return [
      ensureEntity(streamId, event.id, event.room),
      data.body.mimeType == "text/x-dmp-patch"
        ? // If this is a patch, apply the patch using our SQL user-defined-function
          sql`
          update comp_content
          set 
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode(fromBytes(data.body.data))}) as blob),
            last_edit = ${event.id}
          where
            entity = ${data.target}
              and
            mime_type like 'text/%'
        `
        : // If this is not a patch, just replace the previous value
          sql`
          update comp_content
          set
            mime_type = ${data.body.mimeType},
            data = ${fromBytes(data.body.data)},
            last_edit = ${event.id} -- dependency tracking must ensure this is monotonic
          where
            entity = ${data.target}
        `,
    ];
  },
  "space.roomy.page.editPage.v0": async ({ user, streamId, event, data }) => {
    if (!event.room) {
      console.warn("Edit event missing room");
      return [];
    }

    return [
      ensureEntity(streamId, event.id, event.room),
      sql`
        insert into comp_page_edits (edit_id, entity, mime_type, data, user_id) 
        values (
          ${event.id},
          ${event.room},
          ${data.body.mimeType},
          ${data.body.data},
          ${user}
        )
      `,
      data.body.mimeType == "text/x-dmp-patch"
        ? // If this is a patch, apply the patch using our SQL user-defined-function
          sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${event.room},
            'text/markdown',
            cast(apply_dmp_patch('', ${new TextDecoder().decode(fromBytes(data.body.data))}) as blob)
          )
          on conflict do update set
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode(fromBytes(data.body.data))}) as blob)
        `
        : // If this is not a patch, just replace the previous value
          sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${event.room},
            ${data.body.mimeType},
            ${data.body.data}
          )
          on conflict do update
          set
            mime_type = ${data.body.mimeType},
            data = ${data.body.data}
          where
            entity = ${event.room}
        `,
    ];
  },

  // TODO: make sure there is valid permission to send override metadata
  "space.roomy.user.overrideHandle.v0": async ({ data }) => {
    return [
      sql`
        insert into comp_user (did, handle)
        values (
          ${data.did},
          ${data.handle}
        )
        on conflict(did) do update set handle = ${data.handle}
      `,
    ];
  },
  "space.roomy.message.deleteMessage.v0": async ({ event }) => {
    if (!event.room) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [sql`delete from entities where id = ${event.room}`];
  },

  // Reaction
  "space.roomy.reaction.addReaction.v0": async ({ data, event, user }) => {
    return [
      sql`
        insert or replace into comp_reaction (entity, user, reaction, add_event)
        values (
          ${data.target},
          ${user},
          ${data.reaction},
          ${event.id}
        )
      `,
    ];
  },
  "space.roomy.reaction.removeReaction.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        entity = ${data.target} and
        add_event = ${data.previous}
    `,
    ];
  },

  // TODO: make sure there is valid permission to send bridged reaction
  "space.roomy.reaction.addBridgedReaction.v0": async ({ data }) => {
    return [
      sql`
        insert into comp_reaction (entity, user, reaction)
        values (
          ${data.target},
          ${data.reactingUser},
          ${data.reaction}
        )
      `,
    ];
  },
  "space.roomy.reaction.removeBridgedReaction.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        entity = ${data.target} and
        add_event = ${data.previous}
    `,
    ];
  },

  /**
   * Mark a room as read. This event is sent to the user's personal stream.
   * The event ULID timestamp indicates when the room was last read.
   * We ensure the room entity exists using the streamId from the event data,
   * not the wrapper streamId (which would be the user's personal stream).
   */
  "space.roomy.stream.personal.setLastRead.v0": async ({ event, data }) => {
    // Extract timestamp from the event's ULID
    const timestamp = decodeTime(event.id);

    return [
      // Ensure the room entity exists in the target stream
      // Note: we use data.streamId here, not the wrapper's streamId
      ensureEntity(data.streamDid, data.roomId),
      // Insert or update the last read timestamp
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
        values (${data.roomId}, ${timestamp}, 0)
        on conflict(entity) do update set
          timestamp = excluded.timestamp,
          updated_at = excluded.timestamp,
          unread_count = excluded.unread_count
      `,
    ];
  },
};

// UTILS

/**
 * Helper to wrap materializer logic and automatically create success/error bundles.
 * This eliminates the repetitive bundle-wrapping code in each materializer.
 */
function bundleSuccess(
  event: Event,
  idx: StreamIndex,
  user: UserDid,
  statements: SqlStatement | SqlStatement[],
  dependsOn: Ulid | null,
): Bundle.Statement {
  return {
    status: "success",
    event: event,
    eventIdx: idx,
    user,
    statements: Array.isArray(statements) ? statements : [statements],
    dependsOn,
  };
}

/**
 * Helper to create an error bundle with a consistent format.
 */
function bundleError(
  event: Event,
  error: Error | string,
): Bundle.StatementError {
  return {
    eventId: event.id,
    status: "error",
    message: typeof error === "string" ? error : error.message,
  };
}

/**
 * Main materialize function called by the sqlite worker for each event.
 */
export async function materialize(
  event: Event,
  opts: { streamId: StreamDid; user: UserDid },
  idx: StreamIndex,
): Promise<Bundle.Statement> {
  const kind = event.variant.$type;
  const data = event.variant;

  try {
    const handler = materializers[kind];
    if (!handler) {
      throw new Error(`No materializer found for event kind: ${kind}`);
    }

    const statements = await handler({
      ...opts,
      event,
      data,
    } as any);

    // some types have a chain of dependencies, in which case 'parent' is most recent one.
    // others just have a target
    const dependsOn = WithParent.allows(event.variant)
      ? event.variant.previous
      : WithTarget.allows(event.variant)
        ? event.variant.target
        : null;

    return bundleSuccess(event, idx, opts.user, statements, dependsOn || null);
  } catch (error) {
    console.error(`Error materializing event ${event.id}:`, error);
    return bundleError(event, error instanceof Error ? error : String(error));
  }
}

export function ensureEntity(
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
      ${entityId},
      ${streamId},
      ${parent ? parent : undefined},
      ${unixTimeMs}
    )
    on conflict(id) do update set
      parent = coalesce(entities.parent, excluded.parent),
      updated_at = case 
        when entities.parent is null and excluded.parent is not null 
        then excluded.updated_at 
        else entities.updated_at 
      end
  `;
  return statement;
}

function edgePayload<EdgeLabel extends keyof EdgesWithPayload>(
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
  | "embed"
  | "reply"
  | "link"
  | "author"
  | "reorder"
  | "source"
  | "avatar";

type EntityId = string;

export interface EdgeBan {
  reason: string;
  banned_by: EntityId;
}

export interface EdgeMember {
  // delegation?: string;
  can: "read" | "post" | "admin";
}

interface EdgesWithPayload {
  ban: EdgeBan;
  member: EdgeMember;
}

export type EdgesMap = {
  [K in Exclude<EdgeLabel, keyof EdgesWithPayload>]: null;
} & EdgesWithPayload;

/** Given a tuple of edge names, produces a record whose keys are exactly
 * those edge names and whose values are arrays of the corresponding edge types.
 */
export type EdgesRecord<TRequired extends readonly EdgeLabel[]> = {
  [K in TRequired[number]]: [EdgesMap[K], EntityId];
};

import { type CodecType } from "scale-ts";
import { eventCodec, eventVariantCodec, id } from "../encoding";

import { decodeTime } from "ulidx";
import { sql } from "$lib/utils/sqlTemplate";
import type {
  EdgesMap,
  EdgesWithPayload,
  SqlStatement,
  StatementBundle,
  Ulid,
} from "../types";

type Event = CodecType<typeof eventCodec>;
type EventVariants = CodecType<typeof eventVariantCodec>;
type EventVariantStr = EventVariants["kind"];
type EventVariant<K extends EventVariantStr> = Extract<
  EventVariants,
  { kind: K }
>["data"];

interface StatementMapOpts<K extends EventVariantStr> {
  streamId: string;
  user: string;
  event: Event;
  data: EventVariant<K>;
}

type StatementMap<K extends EventVariantStr> = (
  opts: StatementMapOpts<K>,
) => Promise<SqlStatement[]> | SqlStatement[];

/** Pure SQL statement generation for each event variant */
const statementMap: {
  [K in EventVariantStr]: StatementMap<K>;
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
  "space.roomy.space.leave.0": async ({ data }) => {
    return [
      sql`
      update comp_space set hidden = 1
      where entity = ${id(data.spaceId)}
    `,
    ];
  },

  "space.roomy.stream.handle.account.0": async ({ streamId, data }) => {
    return [
      sql`
      update comp_space set handle_account = ${data.did || null}
      where entity = ${id(streamId)}
    `,
    ];
  },

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
      // streamId,
      // event,
      // data,
    },
  ) => [
    // ensureEntity(streamId, event.ulid, event.parent),
    // ...(await ensureProfile(
    //   data.member_id,
    //   streamId,
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
    if (!event.parent) throw new Error("No room for message");
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
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
        values (${id(event.parent)}, 1, 1)
        on conflict(entity) do update set
          unread_count = case
            when ${decodeTime(event.ulid)} > comp_last_read.timestamp
            then comp_last_read.unread_count + 1
            else comp_last_read.unread_count
          end,
          updated_at = (unixepoch() * 1000)`,
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

  // Message v1
  "space.roomy.message.create.1": async ({ streamId, user, event, data }) => {
    if (!event.parent) throw new Error("No room for message");
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
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
          values (${id(event.parent)}, 1, 1)
          on conflict(entity) do update set
            unread_count = case
              when ${decodeTime(event.ulid)} > comp_last_read.timestamp
              then comp_last_read.unread_count + 1
              else comp_last_read.unread_count
            end,
            updated_at = (unixepoch() * 1000)
      `,
    ];

    // Handle replyTo extensions
    data.extensions
      .filter((ext) => ext.kind === "space.roomy.replyTo.0")
      .forEach((reply) => {
        statements.push(sql`
        insert into edges (head, tail, label)
        values (
          ${id(event.ulid)},
          ${id(reply.data)},
          'reply'
        )
      `);
      });

    // Handle comment extensions - comp_comment
    data.extensions
      .filter((ext) => ext.kind === "space.roomy.comment.0")
      .forEach((comment) => {
        statements.push(
          sql`
          insert into comp_comment (entity, version, snippet, idx_from, idx_to, updated_at)
          values (
            ${id(event.ulid)},
            ${id(comment.data.version)},
            ${comment.data.snippet || ""},
            ${comment.data.from},
            ${comment.data.to},
            (unixepoch() * 1000)
          )`,
        );
      });

    // Handle overrideAuthorDid, overrideTimestamp extensions - comp_override_meta
    const overrideAuthorExt = data.extensions.find(
      (ext) => ext.kind === "space.roomy.overrideAuthorDid.0",
    );
    const overrideTimestampExt = data.extensions.find(
      (ext) => ext.kind === "space.roomy.overrideTimestamp.0",
    );

    if (overrideAuthorExt || overrideTimestampExt) {
      statements.push(sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${id(event.ulid)},
          ${overrideAuthorExt ? id(overrideAuthorExt.data as string) : null},
          ${overrideTimestampExt ? Number(overrideTimestampExt.data) : null}
        )
      `);
    }

    // Handle image extensions - comp_image
    // Each image becomes a separate child entity with deterministic hash-based ID
    for (const img of data.extensions.filter(
      (ext) => ext.kind === "space.roomy.image.0",
    )) {
      if (img.data instanceof Uint8Array) continue; // Skip unknown variants
      const uriWithUlidQuery = img.data.uri + "?message=" + event.ulid;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.ulid),
        sql`
          insert or replace into comp_image (entity, mime_type, alt, width, height, blurhash, size)
          values (
            ${id(uriWithUlidQuery)},
            ${img.data.mimeType},
            ${img.data.alt},
            ${img.data.width ? Number(img.data.width) : null},
            ${img.data.height ? Number(img.data.height) : null},
            ${img.data.blurhash || null},
            ${img.data.size ? Number(img.data.size) : null}
          )
        `,
      );
    }

    // Handle video extensions - comp_video
    // Each video becomes a separate child entity with deterministic hash-based ID
    for (const vid of data.extensions.filter(
      (ext) => ext.kind === "space.roomy.video.0",
    )) {
      if (vid.data instanceof Uint8Array) continue; // Skip unknown variants
      const uriWithUlidQuery = vid.data.uri + "?message=" + event.ulid;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.ulid),
        sql`
          insert or replace into comp_video (entity, mime_type, alt, width, height, length, blurhash, size)
          values (
            ${id(uriWithUlidQuery)},
            ${vid.data.mimeType},
            ${vid.data.alt},
            ${vid.data.width ? Number(vid.data.width) : null},
            ${vid.data.height ? Number(vid.data.height) : null},
            ${vid.data.length ? Number(vid.data.length) : null},
            ${vid.data.blurhash || null},
            ${vid.data.size ? Number(vid.data.size) : null}
          )
        `,
      );
    }

    // Handle file extensions - comp_file
    // Each file becomes a separate child entity with deterministic hash-based ID
    for (const file of data.extensions.filter(
      (ext) => ext.kind === "space.roomy.file.0",
    )) {
      if (file.data instanceof Uint8Array) continue; // Skip unknown variants
      const uriWithUlidQuery = file.data.uri + "?message=" + event.ulid;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.ulid),
        sql`
          insert or replace into comp_file (entity, mime_type, name, size)
          values (
            ${id(uriWithUlidQuery)},
            ${file.data.mimeType},
            ${file.data.name || null},
            ${file.data.size ? Number(file.data.size) : null}
          )
        `,
      );
    }
    // Handle link extensions - comp_link
    data.extensions
      .filter((ext) => ext.kind === "space.roomy.link.0")
      .forEach((link) => {
        if (link.data instanceof Uint8Array) return; // Skip unknown variants
        const uriWithUlidQuery = link.data.uri + "?message=" + event.ulid;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.ulid),
          sql`
          insert into comp_link (entity, show_preview)
          values (
            ${id(uriWithUlidQuery)},
            ${link.data.showPreview ? 1 : 0}
          )
        `,
        );
      });

    return statements;
  },

  "space.roomy.message.edit.0": async ({ streamId, event, data }) => {
    if (!event.parent) {
      console.warn("Edit event missing parent");
      return [];
    }

    return [
      ensureEntity(streamId, event.ulid, event.parent),
      data.content.mimeType == "text/x-dmp-patch"
        ? // If this is a patch, apply the patch using our SQL user-defined-function
          sql`
          update comp_content
          set 
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode(data.content.content)}) as blob)
          where
            entity = ${id(event.parent)}
              and
            mime_type like 'text/%'
        `
        : // If this is not a patch, just replace the previous value
          sql`
          update comp_content
          set
            mime_type = ${data.content.mimeType}
            data = ${data.content.content}
          where
            entity = ${id(event.parent)}
        `,
    ];
  },
  "space.roomy.page.edit.0": async ({ user, streamId, event, data }) => {
    if (!event.parent) {
      console.warn("Edit event missing parent");
      return [];
    }

    return [
      ensureEntity(streamId, event.ulid, event.parent),
      sql`
        insert into comp_page_edits (edit_id, entity, mime_type, data, user_id) 
        values (
          ${id(event.ulid)},
          ${id(event.parent)},
          ${data.content.mimeType},
          ${data.content.content},
          ${id(user)}
        )
      `,
      data.content.mimeType == "text/x-dmp-patch"
        ? // If this is a patch, apply the patch using our SQL user-defined-function
          sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${id(event.parent)},
            'text/markdown',
            cast(apply_dmp_patch('', ${new TextDecoder().decode(data.content.content)}) as blob)
          )
          on conflict do update set
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode(data.content.content)}) as blob)
        `
        : // If this is not a patch, just replace the previous value
          sql`
          insert into comp_content (entity, mime_type, data)
          values (
            ${id(event.parent)},
            ${data.content.mimeType},
            ${data.content.content}
          )
          on conflict do update
          set
            mime_type = ${data.content.mimeType},
            data = ${data.content.content}
          where
            entity = ${id(event.parent)}
        `,
    ];
  },

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
  "space.roomy.media.create.0": async ({ streamId, event, data }) => {
    const mimeType = data.mimeType.toLowerCase();

    const uriWithUlidQuery = data.uri + "?message=" + event.parent;
    const statements = [ensureEntity(streamId, uriWithUlidQuery, event.parent)];

    if (mimeType.startsWith("image/")) {
      statements.push(sql`
        insert into comp_image (entity, mime_type)
        values (
          ${id(uriWithUlidQuery)},
          ${data.mimeType}
        )
      `);
    } else if (mimeType.startsWith("video/")) {
      statements.push(sql`
        insert into comp_video (entity, mime_type)
        values (
          ${id(uriWithUlidQuery)},
          ${data.mimeType}
        )
      `);
    } else {
      // Default to file for everything else
      statements.push(sql`
        insert into comp_file (entity, mime_type)
        values (
          ${id(uriWithUlidQuery)},
          ${data.mimeType}
        )
      `);
    }

    return statements;
  },

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

  // Pages
  "space.roomy.page.mark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for page mark.");
      return [];
    }
    return [
      sql`update comp_room set label = 'page' where entity = ${id(event.parent)}`,
    ];
  },
  "space.roomy.page.unmark.0": async ({ event }) => {
    if (!event.parent) {
      console.warn("Missing target for page unmark.");
      return [];
    }
    return [
      sql`update comp_room set label = null where entity = ${id(event.parent)} and label = 'page'`,
    ];
  },

  /**
   * Mark a room as read. This event is sent to the user's personal stream.
   * The event ULID timestamp indicates when the room was last read.
   * We ensure the room entity exists using the streamId from the event data,
   * not the wrapper streamId (which would be the user's personal stream).
   */
  "space.roomy.room.lastRead.0": async ({ event, data }) => {
    // Extract timestamp from the event's ULID
    const timestamp = decodeTime(event.ulid);

    return [
      // Ensure the room entity exists in the target stream
      // Note: we use data.streamId here, not the wrapper's streamId
      ensureEntity(data.streamId, data.roomId),
      // Insert or update the last read timestamp
      sql`
        insert into comp_last_read (entity, timestamp, unread_count)
        values (${id(data.roomId)}, ${timestamp}, 0)
        on conflict(entity) do update set
          timestamp = excluded.timestamp,
          updated_at = excluded.timestamp,
          unread_count = excluded.unread_count
      `,
    ];
  },
} as const;

// UTILS

/**
 * Helper to wrap materializer logic and automatically create success/error bundles.
 * This eliminates the repetitive bundle-wrapping code in each materializer.
 */
function bundleSuccess(
  event: Event,
  statements: SqlStatement | SqlStatement[],
): StatementBundle {
  return {
    eventId: event.ulid as Ulid,
    status: "success",
    statements: Array.isArray(statements) ? statements : [statements],
  };
}

/**
 * Helper to create an error bundle with a consistent format.
 */
function bundleError(event: Event, error: Error | string): StatementBundle {
  return {
    eventId: event.ulid as Ulid,
    status: "error",
    message: typeof error === "string" ? error : error.message,
  };
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
      ${id(entityId)},
      ${id(streamId)},
      ${parent ? id(parent) : undefined},
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

// Type-safe materializer dispatcher that maintains the relationship between
// event variant kind and its data type
export async function materialize(
  event: Event,
  opts: Omit<StatementMapOpts<any>, "event" | "data">,
): Promise<StatementBundle> {
  const kind = event.variant.kind;
  const data = event.variant.data;

  try {
    const materializer = statementMap[kind];
    if (!materializer) {
      throw new Error(`No materializer found for event kind: ${kind}`);
    }

    const statements = await materializer({
      ...opts,
      event,
      data,
    } as any);

    return bundleSuccess(event, statements);
  } catch (error) {
    console.error(`Error materializing event ${event.ulid}:`, error);
    return bundleError(event, error instanceof Error ? error : String(error));
  }
}

// Legacy export for backwards compatibility if needed
export const materializers = statementMap;

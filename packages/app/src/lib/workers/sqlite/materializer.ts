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
  "space.roomy.personal.joinSpace.v0": async ({ streamId, data }) => {
    return [
      ensureEntity(streamId, data.spaceId),
      // because we are materialising a non-personal-stream space, we infer that we are backfilling in the background
      sql`
        insert into comp_space (entity)
        values (${data.spaceId})
        on conflict do update set hidden = 0
      `,
    ];
  },
  "space.roomy.personal.leaveSpace.v0": async ({ data }) => [
    sql`
      update comp_space set hidden = 1,
      where entity = ${data.spaceId}
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
  "space.roomy.room.leave.v0": async ({ streamId, user, event }) => [
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
  "space.roomy.stream.handleAccount.v0": async ({ streamId, data }) => [
    sql`
      update comp_space set handle_account = ${data.did || null}
      where entity = ${streamId}
    `,
  ],

  // Admin
  "space.roomy.space.addAdmin.v0": async ({ streamId, data }) => {
    return [
      sql`
      insert or replace into edges (head, tail, label, payload)
      values (
        ${streamId},
        ${data.userId},
        'member',
        ${edgePayload({
          can: "admin",
        })} 
      )
    `,
    ];
  },
  "space.roomy.space.removeAdmin.v0": async ({ streamId, data }) => [
    sql`
      update edges set payload = (${JSON.stringify({ can: "post" })})
      where 
        head = ${streamId}
          and
        tail = ${data.userId}
          and
        label = 'member'
    `,
  ],

  // Info
  "space.roomy.common.setInfo.v0": async ({ streamId, event, data }) => {
    const updates = [
      { key: "name", ...data.name },
      { key: "avatar", ...data.avatar },
      { key: "description", ...data.description },
    ];

    const setUpdates = updates.filter((x) => x.$type == "space.roomy.defs#set");
    const entityId = event.room ? event.room : streamId;

    return [
      ensureEntity(streamId, event.id),
      {
        sql: `insert into comp_info (entity, ${setUpdates.map((x) => `${x.key}`).join(", ")})
            VALUES (:entity, ${setUpdates.map((x) => `:${x.key}`)})
            on conflict do update set ${[...setUpdates].map((x) => `${x.key} = :${x.key}`)}`,
        params: Object.fromEntries([
          [":entity", entityId],
          ...setUpdates.map((x) => [
            ":" + x.key,
            "value" in x ? x.value : undefined,
          ]),
        ]),
      },
    ];
  },

  // Room
  "space.roomy.room.createRoom.v0": async ({ streamId, event }) => [
    ensureEntity(streamId, event.id, event.room),
    sql`
      insert into comp_room ( entity )
      values ( ${event.id} ) on conflict do nothing
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
    if (!event.room) {
      console.warn("Update room parent missing room");
      return [];
    }
    return [
      sql`
        update entities set parent = ${data.parent ? data.parent : null}
        where id = ${event.room}
      `,
    ];
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

  // Message v0 - deprecated
  // "space.roomy.room.sendMessage.v0": async ({ streamId, user, event, data }) => {
  //   if (!event.room) throw new Error("No room for message");
  //   const statements = [
  //     ensureEntity(streamId, event.id, event.room),
  //     sql`
  //       insert into edges (head, tail, label)
  //       select
  //         ${event.id},
  //         ${user},
  //         'author'
  //     `,
  //     sql`
  //       insert or replace into comp_content (entity, mime_type, data)
  //       values (
  //         ${event.id},
  //         ${data.content.mimeType},
  //         ${data.content.content}
  //       )`,
  //     sql`
  //       insert into comp_last_read (entity, timestamp, unread_count)
  //       values (${event.room}, 1, 1)
  //       on conflict(entity) do update set
  //         unread_count = case
  //           when ${decodeTime(event.id)} > comp_last_read.timestamp
  //           then comp_last_read.unread_count + 1
  //           else comp_last_read.unread_count
  //         end,
  //         updated_at = (unixepoch() * 1000)`,
  //   ];

  //   if (data.replyTo) {
  //     statements.push(sql`
  //       insert into edges (head, tail, label)
  //       values (
  //         ${event.id},
  //         ${data.replyTo},
  //         'reply'
  //       )
  //     `);
  //   }

  //   return statements;
  // },

  // Message v1
  "space.roomy.room.sendMessage.v1": async ({
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
        insert or replace into comp_content (entity, mime_type, data)
        values (
          ${event.id},
          ${data.body.mimeType},
          ${fromBytes(data.body.data)}
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

    // Handle replyTo extensions
    const replies = data.extensions.filter(
      (ext) => ext.$type === "space.roomy.extension.replyTo.v0",
    );

    // at an event encoding level we support messages replying to multiple messages;
    // TODO: redesign schema to support materialising multiple replies
    if (replies[0]) {
      statements.push(sql`
      insert into edges (head, tail, label)
      values (
        ${event.id},
        ${replies[0].target},
        'reply'
      )
    `);
    }

    // Handle comment extensions - comp_comment
    const comments = data.extensions.filter(
      (ext) => ext.$type === "space.roomy.extension.comment.v0",
    );

    // TODO: redesign schema to support materialising multiple comments
    if (comments[0]) {
      statements.push(
        sql`
          insert into comp_comment (entity, version, snippet, idx_from, idx_to, updated_at)
          values (
            ${event.id},
            ${comments[0].version},
            ${comments[0].snippet || ""},
            ${comments[0].from},
            ${comments[0].to},
            (unixepoch() * 1000)
          )`,
      );
    }

    // Handle overrideAuthorDid, overrideTimestamp extensions - comp_override_meta
    const overrideAuthorExt = data.extensions.find(
      (ext) => ext.$type === "space.roomy.extension.overrideAuthor.v0",
    );
    const overrideTimestampExt = data.extensions.find(
      (ext) => ext.$type === "space.roomy.extension.overrideTimestamp.v0",
    );

    if (overrideAuthorExt || overrideTimestampExt) {
      statements.push(sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${event.id},
          ${overrideAuthorExt ? (overrideAuthorExt.did as string) : null},
          ${overrideTimestampExt ? Number(overrideTimestampExt.timestamp) : null}
        )
      `);
    }

    // Handle image extensions - comp_image
    // Each image becomes a separate child entity with URI ID, including query with message ID to differentiate
    for (const img of data.extensions.filter(
      (ext) => ext.$type === "space.roomy.extension.image.v0",
    )) {
      const uriWithUlidQuery = img.uri + "?message=" + event.id;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.id),
        sql`
          insert or replace into comp_image (entity, mime_type, alt, width, height, blurhash, size)
          values (
            ${uriWithUlidQuery},
            ${img.mimeType},
            ${img.alt},
            ${img.width ? Number(img.width) : null},
            ${img.height ? Number(img.height) : null},
            ${img.blurhash || null},
            ${img.size ? Number(img.size) : null}
          )
        `,
      );
    }

    // Handle video extensions - comp_video
    // Each video becomes a separate child entity with URI + query ID
    for (const vid of data.extensions.filter(
      (ext) => ext.$type === "space.roomy.extension.video.v0",
    )) {
      const uriWithUlidQuery = vid.uri + "?message=" + event.id;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.id),
        sql`
          insert or replace into comp_video (entity, mime_type, alt, width, height, length, blurhash, size)
          values (
            ${uriWithUlidQuery},
            ${vid.mimeType},
            ${vid.alt},
            ${vid.width ? Number(vid.width) : null},
            ${vid.height ? Number(vid.height) : null},
            ${vid.length ? Number(vid.length) : null},
            ${vid.blurhash || null},
            ${vid.size ? Number(vid.size) : null}
          )
        `,
      );
    }

    // Handle file extensions - comp_file
    // Each file becomes a separate child entity with URI + query ID
    for (const file of data.extensions.filter(
      (ext) => ext.$type === "space.roomy.extension.file.v0",
    )) {
      const uriWithUlidQuery = file.uri + "?message=" + event.id;
      statements.push(
        ensureEntity(streamId, uriWithUlidQuery, event.id),
        sql`
          insert or replace into comp_file (entity, mime_type, name, size)
          values (
            ${uriWithUlidQuery},
            ${file.mimeType},
            ${file.name || null},
            ${file.size ? Number(file.size) : null}
          )
        `,
      );
    }
    // Handle link extensions - comp_link - URI + query ID
    data.extensions
      .filter((ext) => ext.$type === "space.roomy.extension.link.v0")
      .forEach((link) => {
        const uriWithUlidQuery = link.uri + "?message=" + event.id;
        statements.push(
          ensureEntity(streamId, uriWithUlidQuery, event.id),
          sql`
          insert into comp_link (entity, show_preview)
          values (
            ${uriWithUlidQuery},
            ${link.showPreview ? 1 : 0}
          )
        `,
        );
      });

    return statements;
  },

  "space.roomy.room.editMessage.v0": async ({ streamId, event, data }) => {
    if (!event.room) {
      console.warn("Edit event missing room");
      return [];
    }

    return [
      ensureEntity(streamId, event.id, event.room),
      data.body.mimeType == "text/x-dmp-patch"
        ? // If this is a patch, apply the patch using our SQL user-defined-function
          sql`
          update comp_content
          set 
            data = cast(apply_dmp_patch(cast(data as text), ${new TextDecoder().decode(fromBytes(data.body.data))}) as blob)
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
            data = ${fromBytes(data.body.data)}
          where
            entity = ${data.target}
        `,
    ];
  },
  "space.roomy.room.editPage.v0": async ({ user, streamId, event, data }) => {
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
  "space.roomy.space.overrideUserMeta.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [
      sql`
        insert into comp_user (did, handle)
        values (
          ${event.room},
          ${data.handle}
        )
        on conflict(did) do update set handle = ${data.handle}
      `,
    ];
  },
  "space.roomy.message.overrideMeta.v0": async ({ streamId, event, data }) => {
    // Note using the stream ID is kind of a special case for a "system" user if you want to have
    // the space itself be able to send messages.
    const userId = event.room || streamId;
    return [
      sql`
        insert or replace into comp_override_meta (entity, author, timestamp)
        values (
          ${userId},
          ${data.author},
          ${Number(data.timestamp)}
        )`,
    ];
  },
  "space.roomy.room.deleteMessage.v0": async ({ event }) => {
    if (!event.room) {
      console.warn("Missing target for message meta override.");
      return [];
    }
    return [sql`delete from entities where id = ${event.room}`];
  },

  // Reaction
  "space.roomy.room.addReaction.v0": async ({ data, user }) => {
    return [
      sql`
        insert or replace into comp_reaction (entity, user, reaction)
        values (
          ${data.target},
          ${user},
          ${data.reaction}
        )
      `,
    ];
  },
  "space.roomy.room.removeReaction.v0": async ({ event, user, data }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        entity = ${data.target} and
        user = ${user} and
        reaction = ${data.reaction}
    `,
    ];
  },

  // TODO: make sure there is valid permission to send bridged reaction
  "space.roomy.room.addBridgedReaction.v0": async ({ data }) => {
    return [
      sql`
        insert into comp_reaction (entity, user, reaction)
        values (
          ${data.reactingUser},
          ${data.target},
          ${data.reaction}
        )
      `,
    ];
  },
  "space.roomy.room.removeBridgedReaction.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Delete reaction missing room");
      return [];
    }
    return [
      sql`
      delete from comp_reaction
      where
        entity = ${data.target} and
        user = ${data.reactingUser} and
        reaction = ${data.reaction}
    `,
    ];
  },

  // Media
  // "space.roomy.media.create.v0": async ({ streamId, event, data }) => {
  //   const mimeType = data.mimeType.toLowerCase();

  //   const uriWithUlidQuery = data.uri + "?message=" + event.room;
  //   const statements = [ensureEntity(streamId, uriWithUlidQuery, event.room)];

  //   if (mimeType.startsWith("image/")) {
  //     statements.push(sql`
  //       insert into comp_image (entity, mime_type)
  //       values (
  //         ${uriWithUlidQuery},
  //         ${data.mimeType}
  //       )
  //     `);
  //   } else if (mimeType.startsWith("video/")) {
  //     statements.push(sql`
  //       insert into comp_video (entity, mime_type)
  //       values (
  //         ${uriWithUlidQuery},
  //         ${data.mimeType}
  //       )
  //     `);
  //   } else {
  //     // Default to file for everything else
  //     statements.push(sql`
  //       insert into comp_file (entity, mime_type)
  //       values (
  //         ${uriWithUlidQuery},
  //         ${data.mimeType}
  //       )
  //     `);
  //   }

  //   return statements;
  // },

  // deprecated
  // "space.roomy.media.delete.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for media delete.");
  //     return [];
  //   }
  //   return [sql`delete from entities where id = ${event.room}`];
  // },

  // Room Kinds
  "space.roomy.room.setKind.v0": async ({ event, data }) => {
    if (!event.room) {
      console.warn("Missing target for room kind mark.");
      return [];
    }
    return [
      sql`
      update comp_room set label = ${data.kind} where entity = ${event.room}
      `,
    ];
  },

  // Channels
  // "space.roomy.channel.mark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for channel mark.");
  //     return [];
  //   }
  //   return [
  //     sql`
  //     update comp_room set label = 'channel' where entity = ${event.room}
  //     `,
  //   ];
  // },
  // "space.roomy.channel.unmark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for channel unmark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = null where entity = ${event.room} and label = 'channel'`,
  //   ];
  // },

  // // Threads
  // "space.roomy.thread.mark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for thread mark.");
  //     return [];
  //   }
  //   return [
  //     sql`
  //     update comp_room set label = 'thread' where entity = ${event.room}
  //     `,
  //   ];
  // },
  // "space.roomy.thread.unmark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for thread unmark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = null where entity = ${event.room} and label = 'thread'`,
  //   ];
  // },

  // // Categories
  // "space.roomy.category.mark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for category mark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = 'category' where entity = ${event.room}`,
  //   ];
  // },
  // "space.roomy.category.unmark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for category unmark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = null where entity = ${event.room} and label = 'category'`,
  //   ];
  // },

  // // Pages
  // "space.roomy.page.mark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for page mark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = 'page' where entity = ${event.room}`,
  //   ];
  // },
  // "space.roomy.page.unmark.v0": async ({ event }) => {
  //   if (!event.room) {
  //     console.warn("Missing target for page unmark.");
  //     return [];
  //   }
  //   return [
  //     sql`update comp_room set label = null where entity = ${event.room} and label = 'page'`,
  //   ];
  // },

  /**
   * Mark a room as read. This event is sent to the user's personal stream.
   * The event ULID timestamp indicates when the room was last read.
   * We ensure the room entity exists using the streamId from the event data,
   * not the wrapper streamId (which would be the user's personal stream).
   */
  "space.roomy.room.setLastRead.v0": async ({ event, data }) => {
    // Extract timestamp from the event's ULID
    const timestamp = decodeTime(event.id);

    return [
      // Ensure the room entity exists in the target stream
      // Note: we use data.streamId here, not the wrapper's streamId
      ensureEntity(data.streamId, data.roomId),
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

const dependentEvents = [
  "space.roomy.room.editMessage.v0",
  "space.roomy.room.editPage.v0",
  "space.roomy.room.deleteMessage.v0",
  "space.roomy.room.addReaction.v0",
  "space.roomy.room.addBridgedReaction.v0",
  "space.roomy.room.removeReaction.v0",
  "space.roomy.room.removeBridgedReaction.v0",
  "space.roomy.media.delete.v0",
];

/**
 * Helper to wrap materializer logic and automatically create success/error bundles.
 * This eliminates the repetitive bundle-wrapping code in each materializer.
 */
function bundleSuccess(
  event: Event,
  idx: StreamIndex,
  statements: SqlStatement | SqlStatement[],
  dependsOn: Ulid | null,
): Bundle.Statement {
  return {
    status: "success",
    eventId: event.id,
    eventIdx: idx,
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
  opts: { streamId: string; user: string },
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

    // Insert event into events table
    statements.push(sql`
      INSERT INTO events (idx, stream_id, entity_ulid, payload, applied)
      VALUES (${idx}, ${opts.streamId}, ${event.id}, ${JSON.stringify(event)}, 0)
    `);

    // TODO: these are probably all wrong now we have room instead of parent
    // on the envelope, since dependencies on rooms are unproblematic for
    // partial loading
    const dependsOn =
      dependentEvents.includes(kind) && event.room ? event.room : null;

    return bundleSuccess(event, idx, statements, dependsOn);
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

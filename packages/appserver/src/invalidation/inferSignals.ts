/**
 * Pure function mapping an applied event → invalidation signals.
 *
 * This is the single source of truth for "what query results changed when
 * event X fires". Both the WS handler and the server-side cache consume
 * signals produced here.
 *
 * Design principle: when in doubt, over-invalidate. A spurious re-fetch is
 * cheap; stale data is a bug. We can tighten signals later based on
 * observability.
 *
 * Each event type is handled by a dedicated function. The main `inferSignals`
 * entry point dispatches by `$type`.
 *
 * IMPORTANT: The server-side query response cache (`src/cache/`) subscribes to
 * these signals via `attachCacheEvictionListener` and evicts stale entries.
 * When adding a new event type, you MUST add a handler here — a missing
 * handler means the cache will serve stale data until the TTL safety net
 * expires it (default 60s).
 */

import type { StreamDid, Ulid, UserDid } from "@roomy-space/sdk";
import type { AppliedEvent, InvalidationEvent, MessageDiffOp, QueryNsid } from "./types.ts";
import type { DbLike } from "../db/types.ts";
import { openReadStateDb, openSpaceDb, tryOpenGlobalDb } from "../db/db.ts";
import { selectMessages, type MessageDto } from "../queries/selectMessages.ts";
import { getRoomReadPositionUsers } from "../queries/readPositions.ts";
import { getMentionedDidsForMessage, resolveReplyToAuthors } from "../queries/mentions.ts";
import { readRoomBoardFacts, roomActivityDiff } from "./roomActivity.ts";

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Infer invalidation signals for a single applied event.
 * Returns an array (can be empty for events that don't affect query results,
 * e.g. synthetic backfill events).
 *
 * @param event - The applied event to infer signals for.
 * @param db - Optional database instance. For per-space reads (`selectMessages`)
 *   this defaults to `openSpaceDb(event.streamDid)`; for read-state reads
 *   (`getRoomReadPositionUsers`) it defaults to `openReadStateDb()`.
 * @param messageSnapshots - Optional pre-fetched message rows keyed by
 *   message id. When the caller has already batch-fetched the messages a
 *   batch of events will reference (e.g. `Router.onEventsApplied`), passing
 *   the map here lets `handleCreateMessage` / `handleEditMessage` skip the
 *   per-event `selectMessages` re-read — turning 5N queries into 5 per
 *   batch. Handlers fall back to their own read when the map is absent or
 *   does not contain the relevant id (direct callers like tests).
 */
export async function inferSignals(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
  replyToAuthors?: ReadonlyMap<Ulid, UserDid>,
): Promise<InvalidationEvent[]> {
  // Suppress signals for synthetic query events — they're bulk hydration,
  // not incremental changes.
  if (event.type.startsWith("space.roomy.query.")) return [];

  const handler = HANDLERS[event.type as keyof typeof HANDLERS];
  if (!handler) return [];
  return await handler(event, db, messageSnapshots, replyToAuthors);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function invalidate(
  nsid: QueryNsid,
  params: Record<string, string>,
  affectedUser?: UserDid,
): InvalidationEvent {
  return {
    kind: "queryInvalidation",
    signal: { nsid, params, affectedUser },
  };
}

/**
 * Invalidate for the server-side response cache ONLY — no `#invalidate` frame
 * is sent to connected clients.
 *
 * Used where a query's cached *body* is stale but connected clients are kept
 * fresh by a diff frame instead: the client patches from the diff (no refetch),
 * while a client loading the page fresh has no diff to apply and must not be
 * served the stale cached body. See `QueryInvalidation.cacheEvictionOnly`.
 */
function evictOnly(
  nsid: QueryNsid,
  params: Record<string, string>,
): InvalidationEvent {
  return {
    kind: "queryInvalidation",
    signal: { nsid, params, cacheEvictionOnly: true },
  };
}

function invalidateSpace(spaceId: StreamDid): InvalidationEvent[] {
  return [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
    invalidate("space.roomy.space.getThreads", { spaceId }),
    invalidate("space.roomy.space.getMembers", { spaceId }),
  ];
}

/**
 * Invalidations a message in `spaceId` triggers on every space that has one
 * of `spaceId`'s rooms federated INTO it (receiving spaces). The receiving
 * spaces' sidebars render those rooms as federated rows, so a new message
 * there must refresh their unread markers even though it never lands on the
 * receiving space's event stream.
 *
 * Only channel messages call this (thread messages don't render on the
 * receiving side; the fed row is the channel). Returns one `roomMetadataDiff`
 * per receiving space (the receiving-side patch for the fed room row and the
 * space's room-count badge) plus the `space.getMetadata`/`getSpaces`
 * invalidations — the frames patch receiving-space connections directly; the
 * invalidations catch other tabs/connections and keep the server-side query
 * cache coherent.
 */
async function federatedReceiversInvalidation(
  globalDb: DbLike | null,
  spaceId: StreamDid,
  roomId: Ulid,
  signal: {
    delta: number;
    users: ReadonlyArray<UserDid>;
    roomUnreadDeltas: ReadonlyMap<UserDid, number>;
  },
): Promise<InvalidationEvent[]> {
  if (!globalDb) return [];

  const fedRows = await globalDb
    .query(
      `select frp.federating_space_did as home
         from federation_room_permissions frp
         join space_federations sf
           on sf.space_id = frp.space_id
          and sf.federating_space_did = frp.federating_space_did
        where frp.space_id = ?
          and frp.room_id = ?
          and sf.status = 'active'`,
    )
    .all<{ home: string }>([spaceId, roomId]);
  if (fedRows.length === 0) return [];

  const signals: InvalidationEvent[] = [];
  for (const r of fedRows) {
    signals.push({
      kind: "roomMetadataDiff",
      signal: {
        spaceId: r.home as StreamDid,
        roomId,
        delta: signal.delta,
        users: [...signal.users],
        roomUnreadDeltas: signal.roomUnreadDeltas,
      },
    });
    // Receiving-space sidebar + space list refetch for clients the live
    // frame missed (other tabs/connections, cache coherence).
    signals.push(invalidate("space.roomy.space.getMetadata", { spaceId: r.home as StreamDid }));
    signals.push(invalidate("space.roomy.space.getSpaces", {}));
  }
  return signals;
}

function invalidateRoom(roomId: Ulid, spaceId: StreamDid): InvalidationEvent[] {
  return [
    invalidate("space.roomy.room.getMetadata", { roomId }),
    invalidate("space.roomy.room.getThreads", { roomId }),
    invalidate("space.roomy.room.getLinks", { roomId }),
    // Space sidebar may show unread counts for this room.
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

// ─── Message events ─────────────────────────────────────────────────────


/**
 * A `#mention` op variant — only add/update ops carry `kind` (remove ops
 * have no message to classify).
 */
type MentionableOp = Extract<MessageDiffOp, { op: "add" | "update" }>;

/**
 * Build `mentionDiff` signals for a message that mentions users.
 *
 * Emits one `MentionDiff` per mentioned DID, self-mentions included — the
 * bridge/client-side filter is the customization point (self-mentions flow
 * through the normal mentions index, #mention frames, and getMentions; the
 * Roomy UI mention list showing its own self-mentions is accepted). The DID
 * is the stable ID carried by `#didMention` facets / the mentions extension;
 * it never changes, unlike handles or display names.
 */
function mentionDiffs(
  event: AppliedEvent,
  roomId: Ulid,
  mentionedDids: readonly string[] | undefined,
  op: MentionableOp,
  kind: "mention" | "reply",
): InvalidationEvent[] {
  if (!mentionedDids || mentionedDids.length === 0) return [];
  const signals: InvalidationEvent[] = [];
  for (const did of mentionedDids) {
    signals.push({
      kind: "mentionDiff",
      signal: {
        did: did as UserDid,
        spaceId: event.streamDid,
        roomId,
        ops: [{ ...op, kind }],
      },
    });
  }
  return signals;
}

/**
 * Build a `mentionDiff` signal for a depth-1 reply: the author of the
 * replied-to message receives a `kind: 'reply'` op. Only direct replies
 * notify — the replied-to author must differ from the reply's author, and
 * no reply-chain walk happens (replies further downstream never notify the
 * chain root). When the replied-to author is ALSO mentioned, the caller
 * drops the duplicate `kind: 'mention'` op so each did receives exactly one
 * op, the reply (mirroring the mentions-index overlap row upgrade).
 */
function replyDiff(
  event: AppliedEvent,
  roomId: Ulid,
  replyAuthor: UserDid | undefined,
  op: MentionableOp,
): InvalidationEvent[] {
  if (!replyAuthor || replyAuthor === event.user) return [];
  return [
    {
      kind: "mentionDiff",
      signal: {
        did: replyAuthor,
        spaceId: event.streamDid,
        roomId,
        ops: [{ ...op, kind: "reply" }],
      },
    },
  ];
}

/**
 * Resolve the replied-to message's author for the event's message entity.
 * Prefers the router's pre-resolved batch map (one query per stream);
 * falls back to a per-space DB read for direct callers/tests.
 */
async function replyAuthorFor(
  event: AppliedEvent,
  db: DbLike | undefined,
  replyToAuthors: ReadonlyMap<Ulid, UserDid> | undefined,
): Promise<UserDid | undefined> {
  const messageId =
    event.type === "space.roomy.message.editMessage.v0"
      ? ((event.details?.messageId as Ulid | undefined) ?? event.id)
      : event.id;
  if (replyToAuthors) return replyToAuthors.get(messageId);
  const spaceDb = db ?? openSpaceDb(event.streamDid);
  const map = await resolveReplyToAuthors(spaceDb, [messageId]);
  return map.get(messageId);
}

async function handleCreateMessage(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
  replyToAuthors?: ReadonlyMap<Ulid, UserDid>,
): Promise<InvalidationEvent[]> {
  const roomId = event.roomId;
  if (!roomId) return [];

  const spaceId = event.streamDid;
  const details = event.details ?? {};

  // Resolve the full message row to carry in the #messageDiff. The client
  // validates the diff against the `room.getMessages` response schema and
  // silently drops it if any field is missing, so the payload must match
  // the exact shape `selectMessages` returns.
  //
  // Prefer a pre-fetched snapshot from the batch (Router.onEventsApplied
  // collects all message ids in a batch and reads them with a single
  // `selectMessages` call — 5 queries per batch instead of 5N). Fall back
  // to a per-event read for direct callers (tests, standalone use).
  const message = messageSnapshots?.get(event.id) ?? (
    await selectMessages(db ?? openSpaceDb(event.streamDid), { kind: "ids", ids: [event.id] })
  ).messages[0];

  const signals: InvalidationEvent[] = [];
  if (message) {
    // Message diff — applied directly to WS client cache, no HTTP re-fetch.
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId,
        ops: [{ op: "add", key: event.id, message }],
      },
    });
    const mentions = details.mentions as string[] | undefined;
    // Depth-1 reply — notify the replied-to message's author (unless they
    // wrote the reply). Overlap (replied-to author also mentioned) yields a
    // single `kind: 'reply'` op for that did, mirroring the mentions-index
    // row upgrade — so drop them from the plain-mention list first.
    const replyAuthor = await replyAuthorFor(event, db, replyToAuthors);
    const mentionDids = mentions?.filter((d) => d !== replyAuthor);
    // Mentions — route to connections subscribed to `mentions:<did>`.
    signals.push(
      ...mentionDiffs(event, roomId, mentionDids, {
        op: "add",
        key: event.id,
        message,
      }, "mention"),
    );
    signals.push(...replyDiff(event, roomId, replyAuthor, {
      op: "add",
      key: event.id,
      message,
    }));
  }

  // Per-user unread-count diff. The materializer already bumped
  // `unread_count + 1` for every user with a `read_positions` row for
  // this room; one read here yields the affected user set. The
  // SyncManager sends a dedicated `#roomMetadataDiff` frame to each
  // user's connection, which patches `room.getMetadata.unreadCount`,
  // the matching `SpaceRow.unreadCount` in `getSpaces`, and the channel
  // entry in the `space.getMetadata` sidebar tree — all with `delta +1`,
  // no refetch.
  const users = await getRoomReadPositionUsers(db ?? openReadStateDb(), roomId);
  if (users.length > 0) {
    // Determine which users became newly-unread: their unread_count went
    // 0 → 1 with this message's +1 bump. Those users' room-count badges
    // (channels-with-unreads / engaged-threads-with-unreads) increment.
    const readState = db ?? openReadStateDb();
    const ph = users.map(() => "?").join(",");
    const unreadRows = await readState
      .query(
        `select user_did, unread_count from read_positions
          where user_did in (${ph}) and room_id = ?`,
      )
      .all<{ user_did: string; unread_count: number }>([...users, roomId]);
    const newlyUnread = unreadRows
      .filter((r) => r.unread_count === 1)
      .map((r) => r.user_did as UserDid);

    // Thread messages only bump engaged users and carry the parent channel
    // so the client can patch the channel-scoped thread count.
    const spaceDb = db ?? openSpaceDb(event.streamDid);
    const roomRow = await spaceDb
      .query("select label from comp_room where entity = ?")
      .get<{ label: string | null }>(roomId);
    const isThread = roomRow?.label === "space.roomy.thread";
    let parentChannelId: string | undefined;
    if (isThread) {
      const parent = await spaceDb
        .query(
          `select head from edges
            where tail = ? and label = 'link'
              and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
            limit 1`,
        )
        .get<{ head: string }>(roomId);
      parentChannelId = parent?.head;
    }

    signals.push({
      kind: "roomMetadataDiff",
      signal: {
        spaceId,
        roomId,
        delta: 1,
        users,
        ...(parentChannelId ? { parentChannelId } : {}),
        ...(isThread
          ? {
              threadUnreadDeltas: new Map(
                newlyUnread.map((u) => [u, 1] as const),
              ),
            }
          : {
              roomUnreadDeltas: new Map(
                newlyUnread.map((u) => [u, 1] as const),
              ),
            }),
      },
    });

    // Federation: if this room is federated into other (receiving) spaces,
    // those spaces' sidebars show it as an unread row. Send the same live
    // roomMetadataDiff (room id, +1 delta) scoped to each receiving space's
    // connections, plus broadcast metadata invalidations for the spaces
    // themselves — the message never lands on their event streams, so
    // without this their sidebar unread markers only update on refetch.
    // Thread messages are skipped: B's sidebar renders the federated
    // CHANNEL row (bumped by channel messages), not individual threads.
    if (!isThread) {
      signals.push(
        ...(await federatedReceiversInvalidation(
          // Production passes the routed pool handle (Router.onEventsApplied);
          // direct callers/tests fall back to the process-wide registry.
          (db as { global?: () => DbLike } | undefined)?.global?.()
            ?? tryOpenGlobalDb(),
          spaceId,
          roomId,
          {
            delta: 1,
            users,
            roomUnreadDeltas: new Map(
              newlyUnread.map((u) => [u, 1] as const),
            ),
          },
        )),
      );
    }
  }

  // The new message is now this room's latest activity, which reorders the
  // activity-ordered views: the boards (`space.getThreads`, `room.getThreads`)
  // and `room.getMetadata.recentThreads`. Those are ORDERED LISTS, so a diff
  // rather than an invalidation is what keeps them fresh — broadcast the one
  // row that moved and let each client move it, instead of making every reader
  // refetch every board (see `RoomActivityDiff`).
  if (message) {
    const facts = await readRoomBoardFacts(
      db ?? openSpaceDb(event.streamDid),
      roomId,
    );
    signals.push({
      kind: "roomActivityDiff",
      signal: roomActivityDiff(spaceId, roomId, facts, message),
    });
  }

  // The boards' CACHED bodies are still stale (their ordering changed), so the
  // server-side response cache must drop them — but a connected client is
  // patching from the diff above and must not be told to refetch. Evict
  // without a frame.
  signals.push(evictOnly("space.roomy.room.getMetadata", { roomId }));
  signals.push(evictOnly("space.roomy.room.getThreads", { roomId }));
  signals.push(evictOnly("space.roomy.space.getThreads", { spaceId }));

  // A new message may carry a previously-unseen link, which changes the
  // room's and the space's link index (newest-first ordering + a new URL).
  signals.push(invalidate("space.roomy.room.getLinks", { roomId }));
  signals.push(invalidate("space.roomy.space.getLinks", { spaceId }));

  // A new message is a new activity-feed item (and bumps the feed's unread
  // counts for every subscriber). The feed hydrates full message media/link
  // embeds per item, which the activity diff does not carry, so it stays a
  // broadcast invalidation. The activity feed is a global per-user query, so
  // invalidate with no params — broadcast to all users.
  signals.push(invalidate("space.roomy.space.getActivityFeed", {}));

  // A message in a thread may update the author's `activeThreads` in the
  // space sidebar. The `roomMetadataDiff` only patches `unreadCount`, not
  // `activeThreads`, so invalidate `space.getMetadata` for the author only.
  signals.push(
    invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
  );

  return signals;
}

async function handleEditMessage(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
  replyToAuthors?: ReadonlyMap<Ulid, UserDid>,
): Promise<InvalidationEvent[]> {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  // editMessage's `event.id` is the edit event's own ULID, NOT the message
  // id. The message being edited is `details.messageId` (surfaced by
  // `toAppliedEvent`). Key the diff by the message id so the client can
  // match it to the existing cache entry; fall back to `event.id` only for
  // events that pre-date this field.
  const messageId = (details.messageId as Ulid | undefined) ?? event.id;

  // Re-read the full message row post-materialization so the diff carries
  // the complete, schema-valid shape (see `handleCreateMessage`). Prefer a
  // pre-fetched batch snapshot when available (see `handleCreateMessage`
  // for the rationale).
  const message = messageSnapshots?.get(messageId) ?? (
    await selectMessages(db ?? openSpaceDb(event.streamDid), { kind: "ids", ids: [messageId] })
  ).messages[0];

  const signals: InvalidationEvent[] = [];
  if (message) {
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId,
        ops: [{ op: "update", key: messageId, message }],
      },
    });
    // Mentions may have changed on edit — re-route to `mentions:<did>`.
    // The replied-to author gets one `kind: 'reply'` op (or the mention op
    // when the overlap filter drops them), mirroring the index upgrade.
    const mentions = details.mentions as string[] | undefined;
    const replyAuthor = await replyAuthorFor(event, db, replyToAuthors);
    const mentionDids = mentions?.filter((d) => d !== replyAuthor);
    signals.push(
      ...mentionDiffs(event, roomId, mentionDids, {
        op: "update",
        key: messageId,
        message,
      }, "mention"),
    );
    signals.push(...replyDiff(event, roomId, replyAuthor, {
      op: "update",
      key: messageId,
      message,
    }));
  }
  // Edit doesn't change unread count, but room metadata's recentThreads
  // might reference this message's activity, and the space index board
  // shows the edited message as its latest activity.
  signals.push(invalidate("space.roomy.room.getMetadata", { roomId }));
  signals.push(
    invalidate("space.roomy.space.getThreads", { spaceId: event.streamDid }),
  );
  // An edit may add/remove link attachments, changing both link indexes.
  signals.push(invalidate("space.roomy.room.getLinks", { roomId }));
  signals.push(invalidate("space.roomy.space.getLinks", { spaceId: event.streamDid }));
  // An edited message may change the activity feed's rendered item.
  signals.push(invalidate("space.roomy.space.getActivityFeed", {}));

  return signals;
}

async function handleDeleteMessage(
  event: AppliedEvent,
  db?: DbLike,
): Promise<InvalidationEvent[]> {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  // deleteMessage's `event.id` is the delete event's own ULID; the message
  // being removed is `details.messageId`. Key the `remove` op by the
  // message id so the client can match and drop the right cache entry.
  const messageId = (details.messageId as Ulid | undefined) ?? event.id;

  const signals: InvalidationEvent[] = [
    {
      kind: "messageDiff",
      signal: {
        roomId,
        ops: [{ op: "remove", key: messageId }],
      },
    },
    ...invalidateRoom(roomId, event.streamDid),
    // The space index board (space.getThreads) may drop this room or reorder
    // it when its latest message is deleted — broadcast invalidation.
    invalidate("space.roomy.space.getThreads", { spaceId: event.streamDid }),
    // The deleted message may have been the only share of a link.
    invalidate("space.roomy.space.getLinks", { spaceId: event.streamDid }),
    // A deleted message may remove an activity-feed item.
    invalidate("space.roomy.space.getActivityFeed", {}),
  ];

  // Emit `remove` mention ops for every DID the deleted message mentioned,
  // so connections subscribed to `mentions:<did>` drop it too. Resolve the
  // DIDs from the global mentions index (the message's rows are removed by
  // syncMentionsIndex in the router before inferSignals runs).
  const globalDb = (db as { global?: () => DbLike } | undefined)?.global?.();
  if (globalDb) {
    const dids = await getMentionedDidsForMessage(globalDb, messageId);
    for (const did of dids) {
      signals.push({
        kind: "mentionDiff",
        signal: {
          did,
          spaceId: event.streamDid,
          roomId,
          ops: [{ op: "remove", key: messageId }],
        },
      });
    }
  }

  return signals;
}

/**
 * A `moveMessages` event: the messages left the source room (the event
 * envelope's `room`) and now live in `details.toRoomId`.
 *
 * Clients hold `staleTime: Infinity` and refresh ONLY from WS invalidation
 * frames, so a move must be delivered as two independent message diffs —
 * a `remove` in the source room and an `add` in the destination — or the
 * message visibly stays in the source room and never appears in the
 * destination until the client navigates. (A single `update` diff cannot
 * express it: the diff stream is keyed by room, so the client would only
 * ever be told about one of the two rooms.)
 *
 * Both rooms are then invalidated on the query channels: each room's
 * `getMetadata`/`getThreads` counts and the space's sidebar/index totals
 * change, and the space list's unread rollup follows. The invalidations
 * also keep the server-side response cache coherent and catch clients whose
 * live frames were missed (other tabs, backgrounded sockets).
 *
 * The `add` carries the message row re-read AFTER materialization, so its
 * `room` (and sort_idx) reflect the move — the client validates the frame
 * against the SDK `Message` schema and needs the same shape
 * `room.getMessages` returns.
 */
async function handleMoveMessages(
  event: AppliedEvent,
  db?: DbLike,
  messageSnapshots?: ReadonlyMap<Ulid, MessageDto>,
): Promise<InvalidationEvent[]> {
  const sourceRoomId = event.roomId;
  const details = event.details ?? {};
  const toRoomId = details.toRoomId as Ulid | undefined;
  const messageIds = details.messageIds as Ulid[] | undefined;
  if (!sourceRoomId || !toRoomId || !Array.isArray(messageIds) || messageIds.length === 0) {
    return [];
  }

  const spaceId = event.streamDid;
  const signals: InvalidationEvent[] = [];

  for (const messageId of messageIds) {
    // Source: drop the message from the room it left.
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId: sourceRoomId,
        ops: [{ op: "remove", key: messageId }],
      },
    });

    // Destination: add the post-move row (preferring the router's batched
    // snapshot; falling back to a read for direct callers/tests).
    const message =
      messageSnapshots?.get(messageId) ??
      (
        await selectMessages(db ?? openSpaceDb(event.streamDid), {
          kind: "ids",
          ids: [messageId],
        })
      ).messages[0];
    if (!message) continue;
    signals.push({
      kind: "messageDiff",
      signal: {
        roomId: toRoomId,
        ops: [{ op: "add", key: messageId, message }],
      },
    });
  }

  // NB: the mentions index rows are re-pointed at the destination room by
  // `syncMentionsIndex` (the router runs it for this event), so a later
  // delete reports the message's new room. No `mentionDiff` is emitted for
  // the move: `mentions:<did>` subscribers would need an `add` carrying the
  // destination room, but the SDK's SyncRouter consumes no `#mention` frames
  // today (only `#invalidate`, `#messageDiff`, `#roomMetadataDiff`), so the
  // frame would be speculative — the rows are correct and the client's
  // mentions list refetches from `mention.getMentions`.

  // Both rooms' metadata/threads and the space-level rollups change: the
  // source loses a message (and may drop out of the index board entirely),
  // the destination gains one, and unread totals move between them.
  signals.push(...invalidateRoom(sourceRoomId, spaceId));
  signals.push(...invalidateRoom(toRoomId, spaceId));
  signals.push(invalidate("space.roomy.room.getMessages", { roomId: sourceRoomId }));
  signals.push(invalidate("space.roomy.room.getMessages", { roomId: toRoomId }));
  signals.push(invalidate("space.roomy.space.getThreads", { spaceId }));
  signals.push(invalidate("space.roomy.space.getLinks", { spaceId }));
  signals.push(invalidate("space.roomy.space.getActivityFeed", {}));

  return signals;
}

// ─── Reaction events ────────────────────────────────────────────────────

function handleReactionChange(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];

  const details = event.details ?? {};
  const spaceId = event.streamDid;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.room.getMessages", { roomId }),
    // A reaction on (or removing one from) a room's latest message changes
    // that feed item's rendered reactions. The activity feed is a global
    // per-user query (like getSpaces), so invalidate with no params — the
    // client prefix-matches every activity-feed query key (any space/limit).
    // Per the "over-invalidate" principle this broadcasts to all users;
    // a reaction on a non-latest message triggers a harmless no-op refetch.
    invalidate("space.roomy.space.getActivityFeed", {}),
    // A reaction on a room's latest message changes the space index board's
    // `latestMembers` (recent participants) for that room — broadcast.
    invalidate("space.roomy.space.getThreads", { spaceId }),
    ...(details.messageId
      ? [
          invalidate("space.roomy.message.getMessage", {
            messageId: details.messageId as string,
          }),
        ]
      : []),
  ];

  // Reaction in a thread may update the user's activeThreads sidebar.
  // Scope invalidation to the reacting user only.
  if (roomId) {
    signals.push(
      invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
    );
  }

  return signals;
}

// ─── Room events ────────────────────────────────────────────────────────

function handleCreateRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const roomId = event.id; // For createRoom events, the event's id IS the room ID

  const signals: InvalidationEvent[] = [
    ...invalidateSpace(spaceId),
    // New room means sidebar changed.
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    // Room-scoped queries need invalidation so the client can fetch
    // metadata and messages for the newly created room. Without these,
    // a client that navigated to the room before the materializer
    // processed the event (or that re-subscribes to a room while the
    // materializer is still catching up) gets stuck with stale/empty data.
    invalidate("space.roomy.room.getMessages", { roomId }),
    invalidate("space.roomy.room.getMetadata", { roomId }),
    invalidate("space.roomy.room.getThreads", { roomId }),
  ];

  return signals;
}

function handleUpdateRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = (details.roomId as Ulid | undefined) ?? event.roomId;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];

  if (roomId) {
    signals.push(...invalidateRoom(roomId, spaceId));
  }

  return signals;
}

function handleDeleteRoom(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = (details.roomId as Ulid | undefined) ?? event.roomId;

  const signals: InvalidationEvent[] = [
    ...invalidateSpace(spaceId),
    // Deleting a room removes its activity items from every feed.
    invalidate("space.roomy.space.getActivityFeed", {}),
  ];
  if (roomId) {
    signals.push(invalidate("space.roomy.room.getMetadata", { roomId }));
  }
  return signals;
}

function handleRestoreRoom(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateRoom(event);
}

// ─── Space events ───────────────────────────────────────────────────────

function handleUpdateSpaceInfo(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

function handleUpdateSidebar(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getMetadata", { spaceId })];
}

function handleJoinSpace(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    ...invalidateSpace(spaceId),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
    // Joining a space adds its recent activity to the caller's feed.
    invalidate("space.roomy.space.getActivityFeed", {}, event.user),
  ];
}

function handleLeaveSpace(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    ...invalidateSpace(spaceId),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
    // Leaving a space removes its activity from the caller's feed.
    invalidate("space.roomy.space.getActivityFeed", {}, event.user),
  ];
}

function handleAddAdmin(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
          invalidate("space.roomy.space.getMembers", { spaceId }),
        ]
      : []),
  ];
}

function handleRemoveAdmin(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
          invalidate("space.roomy.space.getMembers", { spaceId }),
        ]
      : []),
  ];
}

function handleBanAccount(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    ...invalidateSpace(spaceId),
    ...(targetUser
      ? [invalidate("space.roomy.space.getSpaces", {}, targetUser)]
      : []),
  ];
}

function handleUnbanAccount(event: AppliedEvent): InvalidationEvent[] {
  return handleBanAccount(event);
}

// ─── Link events ────────────────────────────────────────────────────────

function handleCreateRoomLink(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  const spaceId = event.streamDid;
  if (!roomId) return [];
  return [
    ...invalidateRoom(roomId, spaceId),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getThreads", { spaceId }),
  ];
}

function handleRemoveRoomLink(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateRoomLink(event);
}

// ─── Role events ────────────────────────────────────────────────────────

function handleCreateRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getRoles", { spaceId })];
}

function handleDeleteRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

function handleUpdateRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [invalidate("space.roomy.space.getRoles", { spaceId })];
}

function handleAddMemberRole(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const targetUser = details.userDid as UserDid | undefined;

  return [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMembers", { spaceId }),
    ...(targetUser
      ? [
          invalidate("space.roomy.space.getSpaces", {}, targetUser),
          invalidate("space.roomy.space.getMetadata", { spaceId }, targetUser),
        ]
      : []),
  ];
}

function handleRemoveMemberRole(event: AppliedEvent): InvalidationEvent[] {
  return handleAddMemberRole(event);
}

function handleSetRoleRoomPermission(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const details = event.details ?? {};
  const roomId = details.roomId as Ulid | undefined;

  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.space.getRoles", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];

  if (roomId) {
    signals.push(...invalidateRoom(roomId, spaceId));
  }

  return signals;
}

// ─── Invite events ──────────────────────────────────────────────────────

function handleCreateInvite(event: AppliedEvent): InvalidationEvent[] {
  return [
    invalidate("space.roomy.space.getInvites", { spaceId: event.streamDid }),
  ];
}

function handleRevokeInvite(event: AppliedEvent): InvalidationEvent[] {
  return handleCreateInvite(event);
}

// ─── User / profile events ──────────────────────────────────────────────

function handleUpdateProfile(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  // Profile update in a space affects member display names/avatars.
  return [invalidate("space.roomy.space.getMembers", { spaceId })];
}

// ─── State events ───────────────────────────────────────────────────────

function handleMarkRead(event: AppliedEvent): InvalidationEvent[] {
  const roomId = event.roomId;
  if (!roomId) return [];
  const spaceId = event.streamDid;

  return [
    invalidate("space.roomy.room.getMetadata", { roomId }, event.user),
    invalidate("space.roomy.space.getMetadata", { spaceId }, event.user),
    invalidate("space.roomy.space.getSpaces", {}, event.user),
  ];
}

// ─── Federation events ──────────────────────────────────────────────────

/**
 * A federation request was submitted (stream A). A's admins' request list
 * and outgoing view change.
 */
function handleFederationRequest(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.federation.getRequests", { spaceId }),
    invalidate("space.roomy.federation.getOutgoing", { spaceId }),
  ];
}

/**
 * A request was approved/rejected (stream A). A's request/outgoing/grants
 * views change; B's incoming view and (on approval) B's sidebar federated
 * channels change too.
 */
function handleFederationRespond(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const b = event.details?.federatingSpaceDid as string | undefined;
  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.federation.getRequests", { spaceId }),
    invalidate("space.roomy.federation.getOutgoing", { spaceId }),
    invalidate("space.roomy.federation.getGrants", { spaceId }),
  ];
  if (b) {
    signals.push(invalidate("space.roomy.federation.getIncoming", { spaceId: b }));
    signals.push(invalidate("space.roomy.space.getMetadata", { spaceId: b }));
    signals.push(invalidate("space.roomy.space.getSpaces", {}));
  }
  return signals;
}

/**
 * A federation was removed (stream A, initiated by an A or B admin). Grants
 * are dropped; A's outgoing/grants views and B's incoming/sidebar change.
 */
function handleFederationRemove(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const b = event.details?.federatingSpaceDid as string | undefined;
  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.federation.getOutgoing", { spaceId }),
    invalidate("space.roomy.federation.getGrants", { spaceId }),
  ];
  if (b) {
    signals.push(invalidate("space.roomy.federation.getIncoming", { spaceId: b }));
    signals.push(invalidate("space.roomy.space.getMetadata", { spaceId: b }));
    signals.push(invalidate("space.roomy.space.getSpaces", {}));
  }
  return signals;
}

/**
 * An origin grant changed (stream A). A's outgoing/grants views change; B's
 * sidebar visibility of the channel changes (the channel may appear, hide,
 * or flip read→readwrite).
 */
function handleSetRoomPermission(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  const b = event.details?.federatingSpaceDid as string | undefined;
  const signals: InvalidationEvent[] = [
    invalidate("space.roomy.federation.getOutgoing", { spaceId }),
    invalidate("space.roomy.federation.getGrants", { spaceId }),
  ];
  if (b) {
    signals.push(invalidate("space.roomy.space.getMetadata", { spaceId: b }));
    signals.push(invalidate("space.roomy.space.getSpaces", {}));
  }
  return signals;
}

/**
 * A receiver grant changed (stream B — B admins author these). B's grants
 * view and B members' sidebar visibility change.
 */
function handleSetReceiverPermission(event: AppliedEvent): InvalidationEvent[] {
  const spaceId = event.streamDid;
  return [
    invalidate("space.roomy.federation.getGrants", { spaceId }),
    invalidate("space.roomy.space.getMetadata", { spaceId }),
    invalidate("space.roomy.space.getSpaces", {}),
  ];
}

// ─── Dispatch table ─────────────────────────────────────────────────────

const HANDLERS: Record<string, (event: AppliedEvent, db?: DbLike, messageSnapshots?: ReadonlyMap<Ulid, MessageDto>, replyToAuthors?: ReadonlyMap<Ulid, UserDid>) => InvalidationEvent[] | Promise<InvalidationEvent[]>> = {
  // Messages
  "space.roomy.message.createMessage.v0": handleCreateMessage,
  "space.roomy.message.editMessage.v0": handleEditMessage,
  "space.roomy.message.deleteMessage.v0": handleDeleteMessage,
  "space.roomy.message.moveMessages.v0": handleMoveMessages,
  "space.roomy.message.reorderMessage.v0": () => [],
  "space.roomy.message.forwardMessages.v0": handleCreateMessage,

  // Reactions
  "space.roomy.reaction.addReaction.v0": handleReactionChange,
  "space.roomy.reaction.removeReaction.v0": handleReactionChange,
  "space.roomy.reaction.addBridgedReaction.v0": handleReactionChange,
  "space.roomy.reaction.removeBridgedReaction.v0": handleReactionChange,

  // Rooms
  "space.roomy.room.createRoom.v0": handleCreateRoom,
  "space.roomy.room.updateRoom.v0": handleUpdateRoom,
  "space.roomy.room.deleteRoom.v0": handleDeleteRoom,
  "space.roomy.room.restoreRoom.v0": handleRestoreRoom,

  // Space
  "space.roomy.space.joinSpace.v0": handleJoinSpace,
  "space.roomy.space.leaveSpace.v0": handleLeaveSpace,
  "space.roomy.space.updateSpaceInfo.v0": handleUpdateSpaceInfo,
  "space.roomy.space.updateSidebar.v0": handleUpdateSidebar,
  "space.roomy.space.updateSidebar.v1": handleUpdateSidebar,
  "space.roomy.space.addAdmin.v0": handleAddAdmin,
  "space.roomy.space.removeAdmin.v0": handleRemoveAdmin,
  "space.roomy.space.banAccount.v0": handleBanAccount,
  "space.roomy.space.unbanAccount.v0": handleUnbanAccount,
  "space.roomy.space.setHandleProvider.v0": handleUpdateSpaceInfo,

  // Links
  "space.roomy.link.createRoomLink.v0": handleCreateRoomLink,
  "space.roomy.link.removeRoomLink.v0": handleRemoveRoomLink,

  // Roles
  "space.roomy.role.createRole.v0": handleCreateRole,
  "space.roomy.role.deleteRole.v0": handleDeleteRole,
  "space.roomy.role.updateRole.v0": handleUpdateRole,
  "space.roomy.role.addMemberRole.v0": handleAddMemberRole,
  "space.roomy.role.removeMemberRole.v0": handleRemoveMemberRole,
  "space.roomy.role.setRoleRoomPermission.v0": handleSetRoleRoomPermission,

  // Invites
  "space.roomy.space.createInvite.v0": handleCreateInvite,
  "space.roomy.space.revokeInvite.v0": handleRevokeInvite,

  // User profile
  "space.roomy.user.updateProfile.v0": handleUpdateProfile,

  // State
  "space.roomy.state.markRead.v0": handleMarkRead,

  // Channel federation
  "space.roomy.federation.request.v0": handleFederationRequest,
  "space.roomy.federation.respond.v0": handleFederationRespond,
  "space.roomy.federation.remove.v0": handleFederationRemove,
  "space.roomy.federation.setRoomPermission.v0": handleSetRoomPermission,
  "space.roomy.federation.setReceiverPermission.v0": handleSetReceiverPermission,

  // Calendar — no XRPC endpoints yet
  "space.roomy.openmeet.configure.v0": () => [],

  // Pages — out of scope
  "space.roomy.page.editPage.v0": () => [],
};

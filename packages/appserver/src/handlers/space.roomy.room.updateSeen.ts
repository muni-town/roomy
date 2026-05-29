/**
 * XRPC: space.roomy.room.updateSeen (procedure).
 *
 * Mark messages in a room as read up to a given message entity. The appserver
 * is the source of truth for read positions — this replaces the Leaf state
 * event `space.roomy.state.markRead.v0`.
 */

import { type, UserDid } from "@roomy-space/sdk";
import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, ProcedureHandler, QueryParams } from "../xrpc/types.ts";
import { Router } from "../invalidation/router.ts";
import type { InvalidationEvent, QueryNsid } from "../invalidation/types.ts";

interface UpdateSeenBody {
  roomId?: unknown;
  seenUpTo?: unknown;
}

export const updateSeenHandler: ProcedureHandler<UpdateSeenBody, void> = async (
  _params: QueryParams,
  auth: AuthCtx,
  body: UpdateSeenBody,
) => {
  const userDid = UserDid(auth.did);
  if (userDid instanceof type.errors) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Caller DID is not a valid UserDid: ${userDid.summary}`,
    );
  }

  // Body params (not URL query params — this is a POST procedure).
  if (typeof body.roomId !== "string" || body.roomId === "") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Missing or empty required field: roomId",
    );
  }
  const roomId = body.roomId;

  const seenUpToRaw = body.seenUpTo;
  if (seenUpToRaw !== undefined && typeof seenUpToRaw !== "string") {
    throw new XrpcError(
      400,
      "InvalidRequest",
      "Field seenUpTo must be a string if provided",
    );
  }

  await hydrateUserMembership(userDid);

  const db = openDb();
  const access = requireRoomRead(db, roomId, userDid);

  let seenUpTo: string;
  let unreadCount: number;

  if (seenUpToRaw === undefined) {
    // No watermark → mark everything as read up to the latest message.
    const maxRow = db
      .query<
        { max_sort: string | null },
        [string]
      >("select max(sort_idx) as max_sort from entities where room = ?")
      .get(roomId);

    seenUpTo = maxRow?.max_sort ?? "";
    unreadCount = 0;
  } else {
    // Validate that the message exists and belongs to this room.
    const msgRow = db
      .query<
        { sort_idx: string },
        [string, string]
      >("select sort_idx from entities where id = ? and room = ?")
      .get(seenUpToRaw, roomId);

    if (!msgRow) {
      throw new XrpcError(
        400,
        "InvalidRequest",
        `Message ${seenUpToRaw} does not exist in room ${roomId}`,
      );
    }

    seenUpTo = msgRow.sort_idx;

    // One-time count of remaining messages after the watermark.
    const countRow = db
      .query<
        { n: number },
        [string, string]
      >("select count(*) as n from entities where room = ? and sort_idx > ?")
      .get(roomId, seenUpTo);

    unreadCount = countRow?.n ?? 0;
  }

  db.prepare(
    `insert into readstate.read_positions (user_did, room_id, seen_up_to, unread_count, updated_at)
     values (?, ?, ?, ?, (unixepoch() * 1000))
     on conflict(user_did, room_id) do update set
       seen_up_to = excluded.seen_up_to,
       unread_count = excluded.unread_count,
       updated_at = excluded.updated_at`,
  ).run(userDid, roomId, seenUpTo, unreadCount);

  // Push invalidation signals to the sync manager so the caller's WS
  // connection re-fetches stale data.
  const router = Router.getInstance();
  if (router && access.spaceId) {
    const signals: InvalidationEvent[] = [
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.room.getMetadata" as QueryNsid,
          params: { roomId },
          affectedUser: userDid,
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getMetadata" as QueryNsid,
          params: { spaceId: access.spaceId },
          affectedUser: userDid,
        },
      },
      {
        kind: "queryInvalidation",
        signal: {
          nsid: "space.roomy.space.getSpaces" as QueryNsid,
          params: {},
          affectedUser: userDid,
        },
      },
    ];
    router.emit(signals);
  }
};

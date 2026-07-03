/**
 * XRPC: space.roomy.message.getReactions (query).
 *
 * Returns the list of reactors for each emoji on a message.
 * Called on hover/tooltip — not part of the message DTO to keep
 * message payloads small.
 */

import { openDb } from "../db/db.ts";
import { hydrateUserMembership } from "../hydration/userHydration.ts";
import { parseUserDid, requireRoomRead } from "../xrpc/authGuards.ts";
import { XrpcError } from "../xrpc/errors.ts";
import { requireString } from "../xrpc/params.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";

interface ReactorInfo {
  did: string;
  name: string;
  handle?: string;
  avatar?: string;
}

interface ReactionGroup {
  emoji: string;
  reactors: ReactorInfo[];
}

interface GetReactionsResult {
  reactions: ReactionGroup[];
}

export const getReactionsHandler: QueryHandler<
  QueryParams,
  GetReactionsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const userDid = parseUserDid(auth);
  const messageId = requireString(params, "messageId");

  if (userDid !== null) {
    await hydrateUserMembership(userDid);
  }

  const db = openDb();

  // Resolve the message's room for access control.
  const row = await db
    .query("select room from entities where id = ?")
    .get<{ room: string | null }>(messageId);

  if (row === null) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }
  if (!row.room) {
    throw new XrpcError(
      400,
      "InvalidRequest",
      `Entity ${messageId} is not a message (no room)`,
    );
  }

  await requireRoomRead(db, row.room, userDid);

  // Fetch reactions with user profile info.
  const rows = await db
    .query(
      `select r.reaction, r.user, u.handle, i.name, i.avatar
       from comp_reaction r
       left join comp_user u on u.did = r.user
       left join comp_info i on i.entity = r.user
       where r.entity = ?
       order by r.created_at asc`,
    )
    .all<{
      reaction: string;
      user: string;
      name: string | null;
      handle: string | null;
      avatar: string | null;
    }>(messageId);

  // Group by emoji.
  const groups = new Map<string, ReactorInfo[]>();
  for (const r of rows) {
    let reactors = groups.get(r.reaction);
    if (!reactors) {
      reactors = [];
      groups.set(r.reaction, reactors);
    }
    reactors.push({
      did: r.user,
      name: r.name ?? r.user,
      ...(r.handle ? { handle: r.handle } : {}),
      ...(r.avatar ? { avatar: r.avatar } : {}),
    });
  }

  const reactions: ReactionGroup[] = [];
  for (const [emoji, reactors] of groups) {
    reactions.push({ emoji, reactors });
  }

  return { reactions };
};

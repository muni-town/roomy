/**
 * XRPC: space.roomy.message.getReactions (query).
 *
 * Returns the list of reactors for each emoji on a message.
 * Called on hover/tooltip — not part of the message DTO to keep
 * message payloads small.
 */

import { openSpaceDbForEntity } from "../db/db.ts";
import { resolveProfiles } from "../queries/profileStore.ts";
import { hiddenBy } from "../queries/userBlocks.ts";
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


  const db = await openSpaceDbForEntity(messageId);
  if (!db) {
    throw new XrpcError(404, "NotFound", `Message not found: ${messageId}`);
  }

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
  // NOTE: the per-space comp_user/comp_info joins are only populated for
  // users whose profile entity lives in *this* space's stream. A user's
  // profile lives in their own stream, so cross-stream reactors resolve as
  // NULL here. The global `profiles` store (written by the profile fetch
  // path) is authoritative; the per-space value acts as a fallback, exactly
  // as for message authors (see selectMessages → hydrateProfiles).
  const reactionRows = await db
    .query(
      `select r.reaction, r.user, u.handle, i.name, i.avatar
       from comp_reaction r
       left join comp_user u on u.did = r.user
       left join comp_info i on i.entity = r.user
       where r.entity = ?
       order by r.created_at asc, r.reaction_id asc`,
    )
    .all<{
      reaction: string;
      user: string;
      name: string | null;
      handle: string | null;
      avatar: string | null;
    }>(messageId);

  // A reactor hidden from the viewer — in either direction — is dropped here,
  // before any profile is resolved, so a blocked reactor's name and avatar
  // never enter the process. Grouping the survivors means an emoji whose every
  // reactor is hidden simply has no group. The emoji count on the message DTO
  // is computed in selectMessages, not here, and is untouched.
  const hidden = userDid ? await hiddenBy(userDid) : undefined;
  const rows = hidden
    ? reactionRows.filter((r) => !hidden.has(r.user))
    : reactionRows;

  // Resolve reactor profiles from the global store (with an in-memory
  // cache), filling in name/handle/avatar that the per-space join missed.
  const profiles = await resolveProfiles(rows.map((r) => r.user));

  // Group by emoji.
  const groups = new Map<string, ReactorInfo[]>();
  for (const r of rows) {
    let reactors = groups.get(r.reaction);
    if (!reactors) {
      reactors = [];
      groups.set(r.reaction, reactors);
    }
    const p = profiles.get(r.user);
    const handle = p?.handle ?? r.handle ?? undefined;
    const avatar = p?.avatar ?? r.avatar ?? undefined;
    reactors.push({
      did: r.user,
      name: p?.name ?? r.name ?? r.user,
      ...(handle ? { handle } : {}),
      ...(avatar ? { avatar } : {}),
    });
  }

  const reactions: ReactionGroup[] = [];
  for (const [emoji, reactors] of groups) {
    reactions.push({ emoji, reactors });
  }

  return { reactions };
};

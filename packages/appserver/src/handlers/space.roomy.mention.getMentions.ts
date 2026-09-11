/**
 * XRPC: space.roomy.mention.getMentions (query).
 *
 * Returns recent messages that mention a given DID, across all spaces the
 * caller can read. Used for backfill when a client subscribes to the
 * `mentions:<did>` sync topic — the client fetches history via HTTP, then
 * receives live `#mention` frames.
 *
 * Authorisation: a caller may only query their own mentions (the DID is the
 * stable ID; eavesdropping on another user's mentions is not allowed).
 */
import { openGlobalDb } from "../db/db.ts";
import { requireString, optionalInt } from "../xrpc/params.ts";
import { XrpcError } from "../xrpc/errors.ts";
import type { AuthCtx, QueryHandler, QueryParams } from "../xrpc/types.ts";
import type { UserDid } from "@roomy-space/sdk";
import { getMentions, loadMentionMessages } from "../queries/mentions.ts";
import type { MessageDto } from "../queries/selectMessages.ts";

export interface GetMentionsResult {
  mentions: Array<{
    message: MessageDto;
    spaceId: string;
    roomId: string;
    /** 'mention' (plain #didMention) or 'reply' (depth-1 reply to this DID's message). */
    kind: "mention" | "reply";
  }>;
  cursor?: string;
}

export const getMentionsHandler: QueryHandler<
  QueryParams,
  GetMentionsResult
> = async (params: QueryParams, auth: AuthCtx) => {
  const did = requireString(params, "did") as UserDid;
  if (auth.did !== did) {
    throw new XrpcError(403, "Forbidden", "You can only query your own mentions");
  }

  const limit = optionalInt(params, "limit", { min: 1, max: 100, default: 50 });
  const cursor = params["cursor"] as string | undefined;

  const db = openGlobalDb();
  const { mentions, cursor: nextCursor } = await getMentions(db, did, limit, cursor);

  const messages = await loadMentionMessages(mentions);

  return {
    mentions: mentions
      .filter((m) => messages.has(m.message_id))
      .map((m) => ({
        message: messages.get(m.message_id)!,
        spaceId: m.space_did,
        roomId: m.room_id,
        kind: m.kind,
      })),
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
};

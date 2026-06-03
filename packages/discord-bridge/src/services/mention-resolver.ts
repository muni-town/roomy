/**
 * Resolve Discord mention syntax inline in message content.
 *
 * Transforms:
 *   <@!?12345> → [@DisplayName]()
 *   <#12345>   → [#channel-name](roomyRoomUlid)
 *   <:name:id> / <a:name:id> → stripped
 *
 * Both `channelNames` and `roomyRoomIds` are pre-resolved maps
 * (snowflake → name / roomy ULID). The caller is responsible for
 * resolving them before calling this function (e.g. via REST API
 * fallback on cache miss).
 */

import { createLogger } from "../logger.ts";

const log = createLogger("mention-resolver");

/**
 * Minimal user mention data needed for display name resolution.
 */
export interface UserMention {
  id: bigint;
  username: string;
  globalName?: string | null;
}

export interface MentionContext {
  /** Snowflake → display name for Discord channels. */
  channelNames: Map<string, string>;
  /** Snowflake → Roomy room ULID (per-space). */
  roomyRoomIds: Map<string, string>;
}

/**
 * Resolve Discord-specific mention and emoji syntax in message content.
 *
 * @param content - Raw message content from Discord.
 * @param mentions - Parsed Discord mention objects (from msg.mentions).
 * @param ctx - Pre-resolved channel names and roomy room IDs.
 * @returns Clean Markdown content with mentions replaced inline.
 */
export function resolveMentions(
  content: string,
  mentions: UserMention[] | undefined,
  ctx: MentionContext,
): string {
  if (!content) return "";

  // Build user display name map from structured mention data
  const userMap = new Map<string, string>();
  for (const u of mentions || []) {
    const displayName = u.globalName || u.username;
    userMap.set(u.id.toString(), displayName);
  }

  let result = content;

  // Step 1: Replace user mentions: <@12345> or <@!12345> → [@DisplayName]()
  result = result.replace(/<@!?(\d+)>/g, (_match, snowflake: string) => {
    const name = userMap.get(snowflake) ?? snowflake;
    const escaped = name.replace(/[_*~`[\]\\]/g, "\\$&");
    return `[@${escaped}]()`;
  });

  // Step 2: Replace channel mentions: <#12345> → [#Name](roomyRoomUlid)
  result = result.replace(/<#(\d+)>/g, (_match, snowflake: string) => {
    const displayName = ctx.channelNames.get(snowflake) ?? snowflake;
    const escaped = displayName.replace(/[_*~`[\]\\]/g, "\\$&");
    const roomyRoomId = ctx.roomyRoomIds.get(snowflake);
    return roomyRoomId
      ? `[#${escaped}](${roomyRoomId})`
      : `[#${escaped}]()`;
  });

  // Step 3: Strip custom emoji syntax <:name:id> and <a:name:id>
  result = result.replace(/<a?:\w+:\d+>/g, "");

  log.debug(
    `Resolved mentions in ${content.length} chars → ${result.length} chars`,
  );

  return result;
}
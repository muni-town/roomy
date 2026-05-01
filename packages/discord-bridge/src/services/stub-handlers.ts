import { createLogger } from "../logger.ts";

const log = createLogger("events");

export function handleReactionAdd(
  messageId: bigint,
  channelId: bigint,
  userId: bigint,
  emoji: { id?: bigint; name?: string },
  guildId: bigint,
): void {
  log.debug(
    `REACTION_ADD: ${emoji.name ?? emoji.id} on message ${messageId} by user ${userId} (deferred to #117)`,
  );
}

export function handleReactionRemove(
  messageId: bigint,
  channelId: bigint,
  userId: bigint,
  emoji: { id?: bigint; name?: string },
  guildId: bigint,
): void {
  log.debug(
    `REACTION_REMOVE: ${emoji.name ?? emoji.id} on message ${messageId} by user ${userId} (deferred to #117)`,
  );
}

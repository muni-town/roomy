import type { MessageProperties, ChannelProperties } from "../discord/types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("events");

export function handleMessageUpdate(message: MessageProperties): void {
  const messageId = message.id.toString();
  const channelId = message.channelId.toString();

  if (!message.editedTimestamp) return;
  log.debug(`MESSAGE_UPDATE: ${messageId} in channel ${channelId} (deferred to #116)`);
}

export function handleMessageDelete(
  messageId: bigint,
  channelId: bigint,
  guildId?: bigint,
): void {
  log.debug(
    `MESSAGE_DELETE: ${messageId} in channel ${channelId}, guild ${guildId} (deferred to #116)`,
  );
}

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

export function handleThreadCreate(channel: ChannelProperties): void {
  log.debug(
    `THREAD_CREATE: ${channel.id} "${channel.name}" in guild ${channel.guildId} (deferred to #115)`,
  );
}

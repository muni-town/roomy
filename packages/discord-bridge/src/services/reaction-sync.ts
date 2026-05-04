import {
  newUlid,
  UserDid,
  type Did,
  type Event,
  type Ulid,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import { emojiToString, reactionKey } from "../utils/emoji.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("reactions");

export async function handleReactionAdd(
  messageId: bigint,
  channelId: bigint,
  userId: bigint,
  emoji: { id?: bigint; name?: string },
  guildId: bigint,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const messageIdStr = messageId.toString();
  const channelIdStr = channelId.toString();
  const guildIdStr = guildId.toString();
  const reactionString = emojiToString(emoji);

  const targetSpaces = repo.getTargetSpacesForChannel(guildIdStr, channelIdStr);
  if (targetSpaces.length === 0) {
    log.debug(
      `Skipping reaction add ${reactionString}: channel ${channelIdStr} not bridged`,
    );
    return;
  }

  const key = reactionKey(messageId, userId, emoji);

  for (const spaceDid of targetSpaces) {
    // Idempotency: already synced this reaction to this space?
    const existing = repo.getRoomyId(spaceDid, "reaction", key);
    if (existing) {
      log.debug(
        `Skipping reaction add ${key}: already synced to ${spaceDid}`,
      );
      continue;
    }

    // Resolve the Roomy message being reacted to
    const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageIdStr);
    if (!roomyMessageId) {
      log.debug(
        `Skipping reaction add: message ${messageIdStr} not synced to ${spaceDid}`,
      );
      continue;
    }

    // Resolve the Roomy room
    const roomyRoomId =
      repo.getRoomyId(spaceDid, "channel", channelIdStr) ??
      repo.getRoomyId(spaceDid, "thread", channelIdStr);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelIdStr} in ${spaceDid}, skipping reaction`,
      );
      continue;
    }

    const connected = await spaceManager.getOrConnect(spaceDid);

    const eventUlid = newUlid();
    const extensions: Record<string, unknown> = {
      "space.roomy.extension.discordReactionOrigin.v0": {
        $type: "space.roomy.extension.discordReactionOrigin.v0",
        snowflake: eventUlid,
        messageId: messageIdStr,
        channelId: channelIdStr,
        userId: userId.toString(),
        emoji: reactionString,
        guildId: guildIdStr,
      },
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: `did:discord:${userId}` as Did,
      },
    };

    const event = {
      id: eventUlid,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.reaction.addBridgedReaction.v0",
      reactionTo: roomyMessageId as Ulid,
      reaction: reactionString,
      reactingUser: UserDid.assert(`did:discord:${userId}`),
      extensions,
    } as Event;

    try {
      await connected.sendEvent(event);
      repo.registerMapping(spaceDid, "reaction", key, eventUlid);
      log.info(
        `Synced reaction ${reactionString} on ${messageIdStr} → ${eventUlid} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to sync reaction add ${reactionString} on ${messageIdStr} to ${spaceDid}`,
        err,
      );
    }
  }
}

export async function handleReactionRemove(
  messageId: bigint,
  channelId: bigint,
  userId: bigint,
  emoji: { id?: bigint; name?: string },
  guildId: bigint,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const channelIdStr = channelId.toString();
  const guildIdStr = guildId.toString();
  const reactionString = emojiToString(emoji);

  const targetSpaces = repo.getTargetSpacesForChannel(guildIdStr, channelIdStr);
  if (targetSpaces.length === 0) {
    log.debug(
      `Skipping reaction remove ${reactionString}: channel ${channelIdStr} not bridged`,
    );
    return;
  }

  const key = reactionKey(messageId, userId, emoji);

  for (const spaceDid of targetSpaces) {
    // Find the Roomy reaction event we previously registered
    const reactionEventId = repo.getRoomyId(spaceDid, "reaction", key);
    if (!reactionEventId) {
      log.debug(
        `Skipping reaction remove ${key}: no mapping in ${spaceDid}`,
      );
      continue;
    }

    // Resolve the Roomy room
    const roomyRoomId =
      repo.getRoomyId(spaceDid, "channel", channelIdStr) ??
      repo.getRoomyId(spaceDid, "thread", channelIdStr);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelIdStr} in ${spaceDid}, skipping reaction remove`,
      );
      continue;
    }

    const connected = await spaceManager.getOrConnect(spaceDid);

    const eventUlid = newUlid();
    const extensions: Record<string, unknown> = {
      "space.roomy.extension.discordReactionOrigin.v0": {
        $type: "space.roomy.extension.discordReactionOrigin.v0",
        snowflake: eventUlid,
        messageId: messageId.toString(),
        channelId: channelIdStr,
        userId: userId.toString(),
        emoji: reactionString,
        guildId: guildIdStr,
      },
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: `did:discord:${userId}` as Did,
      },
    };

    const event = {
      id: eventUlid,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.reaction.removeBridgedReaction.v0",
      reactionId: reactionEventId as Ulid,
      reactingUser: UserDid.assert(`did:discord:${userId}`),
      extensions,
    } as Event;

    try {
      await connected.sendEvent(event);
      // Remove the reaction mapping so a re-add will sync fresh
      repo.unregisterMapping(spaceDid, "reaction", key);
      log.info(
        `Synced reaction remove ${reactionString} on ${messageId.toString()} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to sync reaction remove ${reactionString} on ${messageId.toString()} to ${spaceDid}`,
        err,
      );
    }
  }
}

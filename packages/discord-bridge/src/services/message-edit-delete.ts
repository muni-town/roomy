import {
  newUlid,
  toBytes,
  type Did,
  type Event,
  type Ulid,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { MessageProperties } from "../discord/types.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("edit-delete");

export async function handleMessageEdit(
  message: MessageProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const messageId = message.id.toString();
  const channelId = message.channelId.toString();

  // Only process actual user edits (not embed updates)
  if (!message.editedTimestamp) return;

  const guildId = message.guildId?.toString();
  if (!guildId) return;

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) return;

  for (const spaceDid of targetSpaces) {
    const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageId);
    if (!roomyMessageId) {
      log.debug(
        `Skipping edit for ${messageId}: no Roomy mapping in ${spaceDid}`,
      );
      continue;
    }

    const roomKey = `room:${channelId}`;
    const roomyRoomId = repo.getRoomyId(spaceDid, "channel", roomKey);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelId} in ${spaceDid}, skipping edit`,
      );
      continue;
    }

    const connected = await spaceManager.getOrConnect(spaceDid);

    // Sync author profile before edit
    if (message.author) {
      await syncUserProfile(message.author, [spaceDid], repo, spaceManager);
    }

    const eventUlid = newUlid();
    const extensions: Record<string, unknown> = {
      "space.roomy.extension.discordMessageOrigin.v0": {
        $type: "space.roomy.extension.discordMessageOrigin.v0",
        snowflake: messageId,
        channelId,
        guildId,
      },
      "space.roomy.extension.authorOverride.v0": {
        $type: "space.roomy.extension.authorOverride.v0",
        did: `did:discord:${message.author.id}` as Did,
      },
    };

    const event: Event = {
      id: eventUlid,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.editMessage.v0",
      messageId: roomyMessageId as Ulid,
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(message.content || "")),
      },
      extensions,
    };

    try {
      await connected.sendEvent(event);
      log.info(
        `Synced edit for message ${messageId} → ${roomyMessageId} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to sync edit for message ${messageId} to ${spaceDid}`,
        err,
      );
    }
  }
}

export async function handleMessageDelete(
  messageId: bigint,
  channelId: bigint,
  guildId: bigint | undefined,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const messageIdStr = messageId.toString();
  const channelIdStr = channelId.toString();
  const guildIdStr = guildId?.toString();

  if (!guildIdStr) return;

  const targetSpaces = repo.getTargetSpacesForChannel(guildIdStr, channelIdStr);
  if (targetSpaces.length === 0) return;

  for (const spaceDid of targetSpaces) {
    const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageIdStr);
    if (!roomyMessageId) {
      log.debug(
        `Skipping delete for ${messageIdStr}: no Roomy mapping in ${spaceDid}`,
      );
      continue;
    }

    const roomKey = `room:${channelIdStr}`;
    const roomyRoomId = repo.getRoomyId(spaceDid, "channel", roomKey);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelIdStr} in ${spaceDid}, skipping delete`,
      );
      continue;
    }

    const connected = await spaceManager.getOrConnect(spaceDid);

    const eventUlid = newUlid();
    const extensions: Record<string, unknown> = {
      "space.roomy.extension.discordMessageOrigin.v0": {
        $type: "space.roomy.extension.discordMessageOrigin.v0",
        snowflake: messageIdStr,
        channelId: channelIdStr,
        guildId: guildIdStr,
      },
    };

    const event: Event = {
      id: eventUlid,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.deleteMessage.v0",
      messageId: roomyMessageId as Ulid,
      extensions,
    };

    try {
      await connected.sendEvent(event);
      // Keep mapping row — delete is recorded; future edit attempts skip naturally
      log.info(
        `Synced delete for message ${messageIdStr} → ${roomyMessageId} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to sync delete for message ${messageIdStr} to ${spaceDid}`,
        err,
      );
    }
  }
}

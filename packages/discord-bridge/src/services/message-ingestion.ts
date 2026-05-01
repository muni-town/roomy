import {
  newUlid,
  toBytes,
  type Did,
  type Event,
  type Ulid,
  type Attachment,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { MessageProperties } from "../discord/types.ts";
import { handleThreadStarterMessage } from "./thread-ingestion.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ingest");

const DISCORD_MESSAGE_TYPES = {
  DEFAULT: 0,
  CHANNEL_NAME_CHANGE: 4,
  THREAD_STARTER_MESSAGE: 21,
  THREAD_CREATED: 18,
} as const;

export async function ingestDiscordMessage(
  message: MessageProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<{ synced: number; skipped: number }> {
  const channelId = message.channelId.toString();
  const messageId = message.id.toString();
  const guildId = message.guildId?.toString();

  if (!guildId) {
    log.debug(`Skipping message ${messageId}: no guildId`);
    return { synced: 0, skipped: 1 };
  }

  // Determine which spaces should receive this channel's events
  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) {
    log.debug(`Skipping message ${messageId}: channel ${channelId} not bridged`);
    return { synced: 0, skipped: 1 };
  }

  // ThreadStarterMessage (type 21): forward original message into thread
  if (message.type === DISCORD_MESSAGE_TYPES.THREAD_STARTER_MESSAGE) {
    return handleThreadStarterMessage(message, repo, spaceManager);
  }

  // Skip system messages
  if (
    message.type === DISCORD_MESSAGE_TYPES.THREAD_CREATED ||
    message.type === DISCORD_MESSAGE_TYPES.CHANNEL_NAME_CHANGE
  ) {
    return { synced: 0, skipped: 1 };
  }

  let synced = 0;

  for (const spaceDid of targetSpaces) {
    // Dedup: already synced to this space?
    const existing = repo.getRoomyId(spaceDid, "message", messageId);
    if (existing) {
      log.debug(`Skipping message ${messageId}: already synced to ${spaceDid}`);
      continue;
    }

    // Resolve the Roomy room for this channel
    const roomKey = `room:${channelId}`;
    const roomyRoomId = repo.getRoomyId(spaceDid, "channel", roomKey);
    if (!roomyRoomId) {
      log.warn(`No Roomy room mapping for channel ${channelId} in ${spaceDid}, skipping message`);
      continue;
    }

    // Build attachments
    const attachments = buildAttachments(message, repo, spaceDid);

    // Skip messages with no content and no attachments
    if (!message.content && attachments.length === 0) {
      continue;
    }

    // Get connected space
    const connected = await spaceManager.getOrConnect(spaceDid);

    // Sync author profile before sending the message
    await syncUserProfile(
      message.author,
      [spaceDid],
      repo,
      spaceManager,
    );

    // Build and send the event
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
      "space.roomy.extension.timestampOverride.v0": {
        $type: "space.roomy.extension.timestampOverride.v0",
        timestamp: message.timestamp
          ? new Date(message.timestamp as unknown as string).getTime()
          : Date.now(),
      },
    };

    if (attachments.length > 0) {
      extensions["space.roomy.extension.attachments.v0"] = {
        $type: "space.roomy.extension.attachments.v0",
        attachments,
      };
    }

    const event: Event = {
      id: eventUlid,
      room: roomyRoomId as Ulid,
      $type: "space.roomy.message.createMessage.v0",
      body: {
        mimeType: "text/markdown",
        data: toBytes(new TextEncoder().encode(message.content || "")),
      },
      extensions,
    };

    try {
      await connected.sendEvent(event);

      // Register mapping and advance cursor
      repo.registerMapping(spaceDid, "message", messageId, eventUlid);
      repo.setChannelCursor(channelId, messageId);

      log.info(
        `Synced message ${messageId} → ${eventUlid} in ${spaceDid}`,
      );
      synced++;
    } catch (err) {
      log.error(`Failed to send message ${messageId} to ${spaceDid}`, err);
      // Don't update cursor — event will retry on backfill
    }
  }

  return { synced, skipped: targetSpaces.length - synced };
}

function buildAttachments(
  message: MessageProperties,
  repo: BridgeRepository,
  spaceDid: string,
): Attachment[] {
  const attachments: Attachment[] = [];

  // Reply attachment
  if (message.messageReference?.messageId) {
    const targetIdStr = message.messageReference.messageId.toString();
    const replyTargetId = repo.getRoomyId(spaceDid, "message", targetIdStr);
    if (replyTargetId) {
      attachments.push({
        $type: "space.roomy.attachment.reply.v0",
        target: replyTargetId as Ulid,
      });
    }
  }

  // Media attachments
  for (const att of message.attachments || []) {
    if (att.contentType?.startsWith("image/")) {
      attachments.push({
        $type: "space.roomy.attachment.image.v0",
        uri: att.url,
        mimeType: att.contentType,
        width: att.width,
        height: att.height,
        size: att.size,
      });
    } else if (att.contentType?.startsWith("video/")) {
      attachments.push({
        $type: "space.roomy.attachment.video.v0",
        uri: att.url,
        mimeType: att.contentType,
        width: att.width,
        height: att.height,
        size: att.size,
      });
    } else {
      attachments.push({
        $type: "space.roomy.attachment.file.v0",
        uri: att.url,
        mimeType: att.contentType || "application/octet-stream",
        name: att.filename,
        size: att.size,
      });
    }
  }

  // Sticker attachments
  for (const sticker of message.stickerItems || []) {
    const id = sticker.id.toString();
    if (sticker.formatType === 4) {
      attachments.push({
        $type: "space.roomy.attachment.image.v0",
        uri: `https://cdn.discordapp.com/stickers/${id}.gif`,
        mimeType: "image/gif",
      });
    } else if (sticker.formatType === 1 || sticker.formatType === 2) {
      attachments.push({
        $type: "space.roomy.attachment.image.v0",
        uri: `https://cdn.discordapp.com/stickers/${id}.png`,
        mimeType: "image/png",
      });
    }
  }

  return attachments;
}

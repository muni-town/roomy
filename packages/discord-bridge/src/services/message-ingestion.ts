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
import { MsgType } from "../discord/types.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("ingest");

export async function ingestDiscordMessage(
  message: MessageProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  guildIdOverride?: string,
  spaceDidOverride?: string,
): Promise<{ synced: number; skipped: number }> {
  const channelId = message.channelId.toString();
  const messageId = message.id.toString();
  // REST endpoint GET /channels/{id}/messages does not include guild_id, so
  // backfill must pass it explicitly. Gateway events have it on the message.
  const guildId = guildIdOverride ?? message.guildId?.toString();

  if (!guildId) {
    log.debug(`Skipping message ${messageId}: no guildId`);
    return { synced: 0, skipped: 1 };
  }

  // Determine which spaces should receive this channel's events.
  // Backfill restricts to a single space (spaceDidOverride); live ingestion
  // fans out to every bridged space for the channel.
  let targetSpaces: string[];
  if (spaceDidOverride) {
    const allTargets = repo.getTargetSpacesForChannel(guildId, channelId);
    targetSpaces = allTargets.includes(spaceDidOverride) ? [spaceDidOverride] : [];
  } else {
    targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  }
  if (targetSpaces.length === 0) {
    log.debug(`Skipping message ${messageId}: channel ${channelId} not bridged`);
    return { synced: 0, skipped: 1 };
  }

  // ThreadStarterMessage (type 21): forward original message into thread
  if (message.type === MsgType.ThreadStarterMessage) {
    return handleThreadStarterMessage(message, repo, spaceManager);
  }

  // Skip system messages
  if (
    message.type === MsgType.ThreadCreated ||
    message.type === MsgType.ChannelNameChange
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

    // Resolve the Roomy room for this channel or thread
    const roomyRoomId =
      repo.getRoomyRoomId(spaceDid, channelId);
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
      repo.setChannelCursor(spaceDid, channelId, messageId);

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

/**
 * Handle Discord ThreadStarterMessage (type 21): forward the original message
 * into the thread's Roomy room. Skipped if the original message hasn't been synced yet.
 */
async function handleThreadStarterMessage(
  message: MessageProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<{ synced: number; skipped: number }> {
  const threadId = message.channelId.toString();
  const messageId = message.id.toString();
  const guildId = message.guildId?.toString();

  if (!guildId || !message.messageReference?.messageId || !message.messageReference?.channelId) {
    return { synced: 0, skipped: 1 };
  }

  const originalMsgId = message.messageReference.messageId.toString();
  const parentChannelId = message.messageReference.channelId.toString();

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, threadId);
  if (targetSpaces.length === 0) {
    log.debug(`Skipping thread starter ${messageId}: thread ${threadId} not bridged`);
    return { synced: 0, skipped: 1 };
  }

  let synced = 0;

  for (const spaceDid of targetSpaces) {
    const existing = repo.getRoomyId(spaceDid, "message", messageId);
    if (existing) {
      log.debug(`Skipping thread starter ${messageId}: already synced to ${spaceDid}`);
      continue;
    }

    const threadRoomyId = repo.getRoomyId(spaceDid, "thread", threadId);
    if (!threadRoomyId) {
      log.debug(`No Roomy room for thread ${threadId} in ${spaceDid}, skipping forward`);
      continue;
    }

    const originalRoomyId = repo.getRoomyId(spaceDid, "message", originalMsgId);
    if (!originalRoomyId) {
      log.debug(`Original message ${originalMsgId} not synced to ${spaceDid}, skipping forward`);
      continue;
    }

    const fromRoomId = repo.getRoomyId(spaceDid, "channel", parentChannelId);
    if (!fromRoomId) {
      log.debug(`No Roomy room for parent channel ${parentChannelId} in ${spaceDid}, skipping forward`);
      continue;
    }

    const forwardUlid = newUlid();
    const forwardEvent: Event = {
      id: forwardUlid,
      room: threadRoomyId as Ulid,
      $type: "space.roomy.message.forwardMessages.v0",
      messageIds: [originalRoomyId as Ulid],
      fromRoomId: fromRoomId as Ulid,
    };

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvent(forwardEvent);

      repo.registerMapping(spaceDid, "message", messageId, forwardUlid);

      log.info(`Forwarded original message ${originalMsgId} to thread ${threadId} in ${spaceDid}`);
      synced++;
    } catch (err) {
      log.error(`Failed to forward message to thread ${threadId} in ${spaceDid}`, err);
    }
  }

  return { synced, skipped: targetSpaces.length - synced };
}

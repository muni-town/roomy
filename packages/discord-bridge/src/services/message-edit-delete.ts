import {
  newUlid,
  toBytes,
  type Did,
  type Event,
  type Ulid,
} from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { RoomyGateway } from "../roomy/gateway.ts";
import type { DiscordMessageData } from "../discord/data.ts";
import { syncUserProfile } from "./profile-sync.ts";
import { createLogger } from "../logger.ts";
import { resolveMentions, type MentionContext } from "./mention-resolver.ts";

const log = createLogger("edit-delete");

export async function handleMessageEdit(
  message: DiscordMessageData,
  repo: BridgeRepository,
  roomy: RoomyGateway,
  resolveChannelName?: (snowflake: string) => Promise<string | undefined>,
): Promise<void> {
  const messageId = message.id;
  const channelId = message.channelId;

  // Only process actual user edits (not embed updates)
  if (!message.editedTimestamp) return;

  const guildId = message.guildId;
  if (!guildId) return;

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) return;

  // Pre-resolve channel names from mentionedChannelIds (with REST fallback)
  const channelNames = new Map<string, string>();
  if (resolveChannelName && message.mentionChannelIds) {
    const results = await Promise.all(
      message.mentionChannelIds.map(async (id) => {
        const idStr = id;
        const name = await resolveChannelName(idStr);
        return { idStr, name } as const;
      }),
    );
    for (const { idStr, name } of results) {
      if (name) channelNames.set(idStr, name);
    }
  }

  for (const spaceDid of targetSpaces) {
    const roomyMessageId = repo.getRoomyId(spaceDid, "message", messageId);
    if (!roomyMessageId) {
      log.debug(
        `Skipping edit for ${messageId}: no Roomy mapping in ${spaceDid}`,
      );
      continue;
    }

    const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelId);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelId} in ${spaceDid}, skipping edit`,
      );
      continue;
    }

    // Sync author profile before edit
    await syncUserProfile(message.author, [spaceDid], repo, roomy);

    const eventUlid = newUlid();

    // Resolve Discord mention syntax into clean Markdown (per-space, so
    // channel mentions resolve to the correct Roomy room ULID).
    const roomyRoomIds = new Map<string, string>();
    for (const [snowflake] of channelNames) {
      const roomyId = repo.getRoomyRoomId(spaceDid, snowflake);
      if (roomyId) roomyRoomIds.set(snowflake, roomyId);
    }
    const mentionCtx: MentionContext = { channelNames, roomyRoomIds };
    const userMentions = message.mentions.map((m) => ({
      id: m.id,
      username: m.name,
      globalName: m.globalName,
    }));
    const resolvedContent = resolveMentions(
      message.content || "",
      userMentions,
      mentionCtx,
    );

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
        data: toBytes(new TextEncoder().encode(resolvedContent)),
      },
      extensions,
    };

    try {
      await roomy.sendEvent(spaceDid, event);
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
  roomy: RoomyGateway,
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

    const roomyRoomId = repo.getRoomyRoomId(spaceDid, channelIdStr);
    if (!roomyRoomId) {
      log.warn(
        `No Roomy room for channel ${channelIdStr} in ${spaceDid}, skipping delete`,
      );
      continue;
    }

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
      await roomy.sendEvent(spaceDid, event);
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
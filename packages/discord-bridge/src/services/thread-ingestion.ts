import { newUlid, type Event, type Ulid } from "@roomy-space/sdk";
import type { BridgeRepository } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { ChannelProperties, MessageProperties } from "../discord/types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("thread");

/**
 * Handle Discord THREAD_CREATE: create a Roomy thread linked to the parent channel's room.
 * Idempotent — skips if the thread already has a mapping.
 */
export async function handleThreadCreate(
  channel: ChannelProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const threadId = channel.id.toString();
  const parentId = channel.parentId?.toString();
  const guildId = channel.guildId?.toString();
  const threadName = channel.name ?? "Thread";

  if (!parentId || !guildId) {
    log.debug(`Skipping thread ${threadId}: no parentId or guildId`);
    return;
  }

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, parentId);
  if (targetSpaces.length === 0) {
    log.debug(`Skipping thread ${threadId}: parent channel ${parentId} not bridged`);
    return;
  }

  for (const spaceDid of targetSpaces) {
    const threadKey = `room:${threadId}`;
    const existing = repo.getRoomyId(spaceDid, "thread", threadKey);
    if (existing) {
      log.debug(`Thread ${threadId} already synced to ${spaceDid}`);
      continue;
    }

    const parentKey = `room:${parentId}`;
    const parentRoomyId = repo.getRoomyId(spaceDid, "channel", parentKey);
    if (!parentRoomyId) {
      log.warn(`No Roomy room for parent channel ${parentId} in ${spaceDid}, skipping thread`);
      continue;
    }

    const threadUlid = newUlid();
    const linkUlid = newUlid();

    const events: Event[] = [
      {
        id: threadUlid,
        room: threadUlid,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.thread",
        name: threadName,
        extensions: {
          "space.roomy.extension.discordOrigin.v0": {
            $type: "space.roomy.extension.discordOrigin.v0",
            snowflake: threadId,
            guildId,
          },
        },
      },
      {
        id: linkUlid,
        room: parentRoomyId as Ulid,
        $type: "space.roomy.link.createRoomLink.v0",
        linkToRoom: threadUlid,
        isCreationLink: true,
      },
    ];

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvents(events);

      repo.registerMapping(spaceDid, "thread", threadKey, threadUlid);

      // Auto-add thread to allowlist for subset mode bridges
      const config = repo.getBridgeConfig(guildId, spaceDid);
      if (config?.mode === "subset") {
        repo.addToAllowlist(spaceDid, threadId, guildId);
      }

      log.info(`Created Roomy thread ${threadUlid} for Discord thread ${threadId} in ${spaceDid}`);
    } catch (err) {
      log.error(`Failed to create Roomy thread for ${threadId} in ${spaceDid}`, err);
    }
  }
}

/**
 * Handle Discord ThreadStarterMessage (type 21): forward the original message
 * into the thread's Roomy room. Skipped if the original message hasn't been synced yet.
 */
export async function handleThreadStarterMessage(
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

    const threadKey = `room:${threadId}`;
    const threadRoomyId = repo.getRoomyId(spaceDid, "thread", threadKey);
    if (!threadRoomyId) {
      log.debug(`No Roomy room for thread ${threadId} in ${spaceDid}, skipping forward`);
      continue;
    }

    const originalRoomyId = repo.getRoomyId(spaceDid, "message", originalMsgId);
    if (!originalRoomyId) {
      log.debug(`Original message ${originalMsgId} not synced to ${spaceDid}, skipping forward`);
      continue;
    }

    const parentKey = `room:${parentChannelId}`;
    const fromRoomId = repo.getRoomyId(spaceDid, "channel", parentKey);
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

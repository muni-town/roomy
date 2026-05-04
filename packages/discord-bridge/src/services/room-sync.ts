import { newUlid, type Event, type Ulid } from "@roomy-space/sdk";
import type { BridgeRepository, MappingKind } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import type { ChannelProperties } from "../discord/types.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("room");

const CHANNEL_TYPES = new Set([0, 5]);
const THREAD_TYPES = new Set([11, 12]);

function mappingKindFor(channel: ChannelProperties): MappingKind {
  return THREAD_TYPES.has(channel.type) ? "thread" : "channel";
}

/**
 * Handle Discord CHANNEL_CREATE: create a Roomy room for the new channel
 * in every space that bridges this guild in `full` mode. Subset bridges are
 * skipped — the channel must be added to their allowlist explicitly.
 * Threads are not handled here; see handleThreadCreate.
 */
export async function handleChannelCreate(
  channel: ChannelProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const channelId = channel.id.toString();
  const guildId = channel.guildId?.toString();

  if (!guildId) return;
  if (!CHANNEL_TYPES.has(channel.type)) return;

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) {
    log.debug(`Skipping channel ${channelId}: no bridges target it`);
    return;
  }

  const channelName = channel.name;
  if (!channelName) {
    log.error(`Channel ${channelId} has no name; skipping create`);
    return;
  }

  for (const spaceDid of targetSpaces) {
    if (repo.getRoomyId(spaceDid, "channel", channelId)) {
      log.debug(`Channel ${channelId} already synced to ${spaceDid}`);
      continue;
    }

    const roomUlid = newUlid();
    const event = {
      id: roomUlid,
      $type: "space.roomy.room.createRoom.v0",
      kind: "space.roomy.channel",
      name: channelName,
      defaultAccess: "read",
      extensions: {
        "space.roomy.extension.discordOrigin.v0": {
          snowflake: channelId,
          guildId,
        },
      },
    } as Event;

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvent(event);
      repo.registerMapping(spaceDid, "channel", channelId, roomUlid);
      log.info(
        `Created Roomy room ${roomUlid} for Discord channel ${channelId} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to create Roomy room for channel ${channelId} in ${spaceDid}`,
        err,
      );
    }
  }
}

/**
 * Handle Discord THREAD_CREATE: create a Roomy thread linked to the parent
 * channel's room. Idempotent — skips if the thread already has a mapping.
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
    if (repo.getRoomyId(spaceDid, "thread", threadId)) {
      log.debug(`Thread ${threadId} already synced to ${spaceDid}`);
      continue;
    }

    const parentRoomyId = repo.getRoomyId(spaceDid, "channel", parentId);
    if (!parentRoomyId) {
      log.warn(`No Roomy room for parent channel ${parentId} in ${spaceDid}, skipping thread`);
      continue;
    }

    const threadUlid = newUlid();
    const linkUlid = newUlid();

    const events: Event[] = [
      {
        id: threadUlid,
        $type: "space.roomy.room.createRoom.v0",
        kind: "space.roomy.thread",
        name: threadName,
        defaultAccess: "read",
        extensions: {
          "space.roomy.extension.discordOrigin.v0": {
            snowflake: threadId,
            guildId,
          },
        },
      } as Event,
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

      repo.registerMapping(spaceDid, "thread", threadId, threadUlid);

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
 * Handle Discord CHANNEL_UPDATE / THREAD_UPDATE: propagate name changes to
 * the corresponding Roomy room. Discord fires update for many things
 * (topic, perms, etc.); we always send updateRoom.v0 with the current name —
 * cheap and idempotent.
 */
export async function handleRoomUpdate(
  channel: ChannelProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const channelId = channel.id.toString();
  const guildId = channel.guildId?.toString();

  if (!guildId) return;
  if (!channel.name) return;

  const kind = mappingKindFor(channel);

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) return;

  for (const spaceDid of targetSpaces) {
    const roomyId = repo.getRoomyId(spaceDid, kind, channelId);
    if (!roomyId) {
      log.debug(`No Roomy room mapped for ${kind} ${channelId} in ${spaceDid}`);
      continue;
    }

    const event = {
      id: newUlid(),
      $type: "space.roomy.room.updateRoom.v0",
      roomId: roomyId as Ulid,
      name: channel.name,
    } as Event;

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvent(event);
      log.info(
        `Updated Roomy ${kind} ${roomyId} name to "${channel.name}" in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to update Roomy ${kind} ${roomyId} in ${spaceDid}`,
        err,
      );
    }
  }
}

/**
 * Handle Discord CHANNEL_DELETE / THREAD_DELETE: soft-delete the corresponding
 * Roomy room and drop the snowflake → ULID mapping so a future re-create
 * gets a fresh room.
 */
export async function handleRoomDelete(
  channel: ChannelProperties,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const channelId = channel.id.toString();
  const guildId = channel.guildId?.toString();
  if (!guildId) return;

  const kind = mappingKindFor(channel);

  const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
  if (targetSpaces.length === 0) return;

  for (const spaceDid of targetSpaces) {
    const roomyId = repo.getRoomyId(spaceDid, kind, channelId);
    if (!roomyId) continue;

    const event = {
      id: newUlid(),
      $type: "space.roomy.room.deleteRoom.v0",
      roomId: roomyId as Ulid,
    } as Event;

    try {
      const connected = await spaceManager.getOrConnect(spaceDid);
      await connected.sendEvent(event);
      repo.unregisterMapping(spaceDid, kind, channelId);
      log.info(
        `Deleted Roomy ${kind} ${roomyId} for Discord channel ${channelId} in ${spaceDid}`,
      );
    } catch (err) {
      log.error(
        `Failed to delete Roomy ${kind} ${roomyId} in ${spaceDid}`,
        err,
      );
    }
  }
}

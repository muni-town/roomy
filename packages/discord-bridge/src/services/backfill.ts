import type { Collection } from "@discordeno/bot";
import { newUlid, type Event } from "@roomy-space/sdk";
import type { DiscordBot, MessageProperties } from "../discord/types.ts";
import type { BridgeRepository, BridgeConfig } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import { ingestDiscordMessage } from "./message-ingestion.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("backfill");

// Discord channel types that can contain messages
const MESSAGE_CHANNEL_TYPES = new Set([0, 5, 11, 12]);
// 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT, 11 = PUBLIC_THREAD, 12 = PRIVATE_THREAD

// The proxy cache bot has .cache which DiscordBot doesn't encode in its type.
// Narrow to what backfill actually needs.
interface CachedChannel {
  id: bigint;
  type: number;
  name?: string;
}

interface CachedGuild {
  id: bigint;
  channels?: Collection<bigint, CachedChannel>;
}

interface BotWithCache extends DiscordBot {
  cache: {
    guilds: {
      memory: Collection<bigint, CachedGuild>;
      get(id: bigint): Promise<CachedGuild | undefined>;
    };
    channels: {
      memory: Collection<bigint, CachedChannel>;
      get(id: bigint): Promise<CachedChannel | undefined>;
    };
  };
}

export async function runBackfill(
  bot: DiscordBot,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
): Promise<void> {
  const cached = bot as unknown as BotWithCache;
  log.info("Starting history backfill...");

  const configs = repo.listAllBridgeConfigs();
  if (configs.length === 0) {
    log.info("No bridge configs found, skipping backfill");
    return;
  }

  // Ensure Roomy rooms exist for all bridged channels before backfilling
  await ensureRoomyRooms(cached, repo, spaceManager, configs);

  const channels = collectBridgedChannels(cached, repo, configs);
  if (channels.size === 0) {
    log.info("No channels to backfill");
    return;
  }

  log.info(`Backfilling ${channels.size} channels`);

  const results = await Promise.allSettled(
    [...channels].map((channelId) =>
      backfillChannel(cached, repo, spaceManager, channelId),
    ),
  );

  const succeeded = results.filter((r) => r.status === "fulfilled").length;
  const failed = results.filter((r) => r.status === "rejected").length;
  log.info(`Backfill complete: ${succeeded} succeeded, ${failed} failed`);
}

async function ensureRoomyRooms(
  bot: BotWithCache,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  configs: BridgeConfig[],
): Promise<void> {
  for (const config of configs) {
    const { guildId, spaceDid, mode } = config;
    let channelIds: string[];

    if (mode === "full") {
      const guild = bot.cache.guilds.memory.get(BigInt(guildId));
      if (!guild?.channels) continue;
      channelIds = [...guild.channels.values()]
        .filter((ch) => MESSAGE_CHANNEL_TYPES.has(ch.type))
        .map((ch) => ch.id.toString());
    } else {
      channelIds = repo.listAllowlistForBridge(spaceDid).map((e) => e.channelId);
    }

    const connected = await spaceManager.getOrConnect(spaceDid);
    let created = 0;

    for (const channelId of channelIds) {
      const roomKey = `room:${channelId}`;
      if (repo.getRoomyId(spaceDid, "channel", roomKey)) continue;

      const channelName = resolveChannelName(bot, channelId) ?? `discord-${channelId}`;
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

      await connected.sendEvent(event);
      repo.registerMapping(spaceDid, "channel", roomKey, roomUlid);
      created++;
    }

    if (created > 0) {
      log.info(`Created ${created} Roomy rooms for ${channelIds.length} bridged channels in ${spaceDid}`);
    }
  }
}

function resolveChannelName(bot: BotWithCache, channelId: string): string | undefined {
  const channel = bot.cache.channels.memory.get(BigInt(channelId));
  return channel?.name || undefined;
}

function collectBridgedChannels(
  bot: BotWithCache,
  repo: BridgeRepository,
  configs: Array<{ guildId: string; spaceDid: string; mode: string }>,
): Set<string> {
  const channels = new Set<string>();

  for (const config of configs) {
    if (config.mode === "full") {
      const guild = bot.cache.guilds.memory.get(BigInt(config.guildId));
      if (!guild) {
        log.warn(`Guild ${config.guildId} not in cache, skipping`);
        continue;
      }

      if (!guild.channels) continue;
      for (const [channelId, channel] of guild.channels) {
        if (MESSAGE_CHANNEL_TYPES.has(channel.type)) {
          channels.add(channelId.toString());
        }
      }
    } else {
      const allowlist = repo.listAllowlistForBridge(config.spaceDid);
      for (const entry of allowlist) {
        channels.add(entry.channelId);
      }
    }
  }

  return channels;
}

export async function backfillSingleChannel(
  bot: DiscordBot,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  channelId: string,
  guildId?: string,
): Promise<void> {
  // Ensure Roomy room exists for this channel in all relevant spaces
  if (guildId) {
    const cached = bot as unknown as BotWithCache;
    const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
    for (const spaceDid of targetSpaces) {
      const roomKey = `room:${channelId}`;
      if (repo.getRoomyId(spaceDid, "channel", roomKey)) continue;

      const channelName = resolveChannelName(cached, channelId) ?? `discord-${channelId}`;
      const roomUlid = newUlid();
      const connected = await spaceManager.getOrConnect(spaceDid);

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

      await connected.sendEvent(event);
      repo.registerMapping(spaceDid, "channel", roomKey, roomUlid);
      log.info(`Created Roomy room ${roomUlid} for Discord channel ${channelId} in ${spaceDid}`);
    }
  }

  await backfillChannel(bot as unknown as BotWithCache, repo, spaceManager, channelId);
}

async function backfillChannel(
  bot: BotWithCache,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  channelId: string,
): Promise<void> {
  const cursor = repo.getChannelCursor(channelId);
  // First-time backfill: start from snowflake 0 (before all valid IDs)
  // Resume: start from last cursor
  let afterCursor = cursor?.lastMessageId ?? "0";

  log.info(`Backfilling channel ${channelId} (cursor: ${cursor?.lastMessageId ?? "none"})`);

  let totalSynced = 0;
  let totalSkipped = 0;

  while (true) {
    const messages = await bot.helpers.getMessages(
      BigInt(channelId),
      { after: BigInt(afterCursor), limit: 100 },
    );

    if (messages.length === 0) break;

    for (const message of messages) {
      try {
        const result = await ingestDiscordMessage(
          message as MessageProperties,
          repo,
          spaceManager,
        );
        totalSynced += result.synced;
        totalSkipped += result.skipped;
      } catch (err) {
        log.error(`Error processing message in backfill for channel ${channelId}`, err);
      }
    }

    const lastMessage = messages[messages.length - 1]!;
    afterCursor = lastMessage.id.toString();

    if (messages.length < 100) break;
  }

  log.info(
    `Channel ${channelId} backfill done: ${totalSynced} synced, ${totalSkipped} skipped`,
  );
}

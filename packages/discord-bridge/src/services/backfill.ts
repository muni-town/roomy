import type { Collection } from "@discordeno/bot";
import { newUlid, type Event, type Ulid } from "@roomy-space/sdk";
import type { DiscordBot, MessageProperties } from "../discord/types.ts";
import type { BridgeRepository, BridgeConfig, BridgeMode } from "../db/repository.ts";
import type { SpaceManager } from "../roomy/space-manager.ts";
import { ingestDiscordMessage } from "./message-ingestion.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("backfill");

const activeBackfills = new Set<string>();

// 0 = GUILD_TEXT, 5 = GUILD_ANNOUNCEMENT
const CHANNEL_TYPES = new Set([0, 5]);
// 11 = PUBLIC_THREAD, 12 = PRIVATE_THREAD
const THREAD_TYPES = new Set([11, 12]);
// Union: anything that can carry messages (used for message backfill enumeration)
const MESSAGE_CHANNEL_TYPES = new Set([...CHANNEL_TYPES, ...THREAD_TYPES]);

// The proxy cache bot has .cache which DiscordBot doesn't encode in its type.
// Narrow to what backfill actually needs.
export interface CachedChannel {
  id: bigint;
  type: number;
  name?: string;
  parentId?: bigint;
}

export interface CachedGuild {
  id: bigint;
  channels?: Collection<bigint, CachedChannel>;
}

export interface BotWithCache extends DiscordBot {
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

  // Ensure Roomy rooms exist for all bridged channels before backfilling.
  // Channels first, then threads (threads need parent channel mappings).
  await ensureRoomyRooms(cached, repo, spaceManager, configs);
  await ensureRoomyThreads(cached, repo, spaceManager, configs);

  // Backfill is per (channel, space) — each pair has its own cursor.
  const tasks: Array<{ channelId: string; spaceDid: string }> = [];
  for (const config of configs) {
    const channelIds = channelsForConfig(cached, repo, config);
    for (const channelId of channelIds) {
      tasks.push({ channelId, spaceDid: config.spaceDid });
    }
  }

  if (tasks.length === 0) {
    log.info("No channels to backfill");
    return;
  }

  log.info(`Backfilling ${tasks.length} (channel, space) pairs`);

  const results = await Promise.allSettled(
    tasks.map((t) => backfillChannel(cached, repo, spaceManager, t.channelId, t.spaceDid)),
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
        .filter((ch) => CHANNEL_TYPES.has(ch.type))
        .map((ch) => ch.id.toString());
    } else {
      channelIds = repo.listAllowlistForBridge(spaceDid).map((e) => e.channelId);
    }

    const connected = await spaceManager.getOrConnect(spaceDid);
    let created = 0;

    for (const channelId of channelIds) {
      if (repo.getRoomyId(spaceDid, "channel", channelId)) continue;

      const channelName = resolveChannelName(bot, channelId);
      if (!channelName) {
        log.error(
          `Cannot resolve name for Discord channel ${channelId} in guild ${guildId}; skipping room creation`,
        );
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

      await connected.sendEvent(event);
      repo.registerMapping(spaceDid, "channel", channelId, roomUlid);
      created++;
    }

    if (created > 0) {
      log.info(`Created ${created} Roomy rooms for ${channelIds.length} bridged channels in ${spaceDid}`);
    }
  }
}

async function ensureRoomyThreads(
  bot: BotWithCache,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  configs: BridgeConfig[],
): Promise<void> {
  for (const config of configs) {
    const { guildId, spaceDid, mode } = config;

    // Subset mode threads are handled at thread-create time (auto-allowlisted);
    // skip thread backfill here to keep behavior aligned with the live path.
    if (mode !== "full") continue;

    const guild = bot.cache.guilds.memory.get(BigInt(guildId));
    if (!guild?.channels) continue;

    const threads = [...guild.channels.values()].filter((ch) =>
      THREAD_TYPES.has(ch.type),
    );

    const connected = await spaceManager.getOrConnect(spaceDid);
    let created = 0;

    for (const thread of threads) {
      const threadId = thread.id.toString();
      if (repo.getRoomyId(spaceDid, "thread", threadId)) continue;

      if (!thread.parentId) {
        log.warn(`Thread ${threadId} has no parentId; skipping`);
        continue;
      }
      const parentId = thread.parentId.toString();
      const parentRoomyId = repo.getRoomyId(spaceDid, "channel", parentId);
      if (!parentRoomyId) {
        log.warn(
          `Parent channel ${parentId} not bridged in ${spaceDid}; skipping thread ${threadId}`,
        );
        continue;
      }

      if (!thread.name) {
        log.error(
          `Cannot resolve name for Discord thread ${threadId} in guild ${guildId}; skipping`,
        );
        continue;
      }

      const threadUlid = newUlid();
      const linkUlid = newUlid();

      const events: Event[] = [
        {
          id: threadUlid,
          $type: "space.roomy.room.createRoom.v0",
          kind: "space.roomy.thread",
          name: thread.name,
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

      await connected.sendEvents(events);
      repo.registerMapping(spaceDid, "thread", threadId, threadUlid);
      created++;
    }

    if (created > 0) {
      log.info(`Created ${created} Roomy threads in ${spaceDid}`);
    }
  }
}

function resolveGuildIdForChannel(bot: BotWithCache, channelId: string): string | undefined {
  const id = BigInt(channelId);
  for (const guild of bot.cache.guilds.memory.values()) {
    if (guild.channels?.has(id)) return guild.id.toString();
  }
  return undefined;
}

function resolveChannelName(bot: BotWithCache, channelId: string): string | undefined {
  const id = BigInt(channelId);
  const direct = bot.cache.channels.memory.get(id);
  if (direct?.name) return direct.name;
  // Guild text channels are typically only present in guild.channels, not the
  // top-level channel cache. Scan guilds as a fallback.
  for (const guild of bot.cache.guilds.memory.values()) {
    const ch = guild.channels?.get(id);
    if (ch?.name) return ch.name;
  }
  return undefined;
}

function channelsForConfig(
  bot: BotWithCache,
  repo: BridgeRepository,
  config: { guildId: string; spaceDid: string; mode: BridgeMode },
): string[] {
  const channels: string[] = [];

  if (config.mode === "full") {
    const guild = bot.cache.guilds.memory.get(BigInt(config.guildId));
    if (!guild) {
      log.warn(`Guild ${config.guildId} not in cache, skipping`);
      return channels;
    }
    if (!guild.channels) return channels;
    for (const [channelId, channel] of guild.channels) {
      if (MESSAGE_CHANNEL_TYPES.has(channel.type)) {
        channels.push(channelId.toString());
      }
    }
  } else {
    const allowlist = repo.listAllowlistForBridge(config.spaceDid);
    for (const entry of allowlist) {
      channels.push(entry.channelId);
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
      if (repo.getRoomyId(spaceDid, "channel", channelId)) continue;

      const channelName = resolveChannelName(cached, channelId);
      if (!channelName) {
        log.error(
          `Cannot resolve name for Discord channel ${channelId} in guild ${guildId}; skipping room creation in ${spaceDid}`,
        );
        continue;
      }
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
      repo.registerMapping(spaceDid, "channel", channelId, roomUlid);
      log.info(`Created Roomy room ${roomUlid} for Discord channel ${channelId} in ${spaceDid}`);
    }
  }

  // Backfill into each bridged space for this channel.
  if (guildId) {
    const targetSpaces = repo.getTargetSpacesForChannel(guildId, channelId);
    const cached = bot as unknown as BotWithCache;
    for (const spaceDid of targetSpaces) {
      await backfillChannel(cached, repo, spaceManager, channelId, spaceDid);
    }
  }
}

async function backfillChannel(
  bot: BotWithCache,
  repo: BridgeRepository,
  spaceManager: SpaceManager,
  channelId: string,
  spaceDid: string,
): Promise<void> {
  const key = `${channelId}:${spaceDid}`;
  if (activeBackfills.has(key)) {
    log.debug(`Skipping backfill for ${key}: already in progress`);
    return;
  }
  activeBackfills.add(key);

  try {
  const guildId = resolveGuildIdForChannel(bot, channelId);
  if (!guildId) {
    log.error(`Cannot resolve guildId for channel ${channelId}; skipping backfill`);
    return;
  }

  const cursor = repo.getChannelCursor(spaceDid, channelId);
  // First-time backfill: start from snowflake 0 (before all valid IDs)
  // Resume: start from last cursor
  let afterCursor = cursor?.lastMessageId ?? "0";

  log.info(
    `Backfilling channel ${channelId} → ${spaceDid} (cursor: ${cursor?.lastMessageId ?? "none"})`,
  );

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
          guildId,
          spaceDid,
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
    `Channel ${channelId} → ${spaceDid} backfill done: ${totalSynced} synced, ${totalSkipped} skipped`,
  );
  } finally {
    activeBackfills.delete(key);
  }
}

/**
 * LiveDiscordDataSource: wraps a DiscordBot (Discordeno) and converts
 * Discordeno types to plain data types via normalizers.
 */

import type { DiscordBot } from "./types.ts";
import type {
  DiscordMessageData,
  DiscordChannelData,
  DiscordGuildData,
} from "./data.ts";
import type {
  DiscordDataSource,
  PaginationOpts,
  ThreadPage,
} from "./data-source.ts";
import {
  normalizeMessage,
  normalizeChannel,
  normalizeGuild,
} from "./normalizers.ts";

// Shape of the proxy cache bot's guild cache entries.
interface CachedChannel {
  id: bigint;
  type: number;
  name?: string;
  parentId?: bigint;
  permissionOverwrites?: Array<{ id: bigint; deny?: string[] }>;
}

interface CachedGuild {
  id: bigint;
  channels?: Map<bigint, CachedChannel>;
}

/**
 * Extended bot type that includes the proxy cache layer.
 */
export interface BotWithCache extends DiscordBot {
  cache: {
    guilds: {
      memory: Map<bigint, CachedGuild>;
      get(id: bigint): Promise<CachedGuild | undefined>;
    };
    channels: {
      memory: Map<bigint, CachedChannel>;
      get(id: bigint): Promise<CachedChannel | undefined>;
    };
  };
}

export class LiveDiscordDataSource implements DiscordDataSource {
  #bot: BotWithCache;

  constructor(bot: DiscordBot) {
    this.#bot = bot as unknown as BotWithCache;
  }

  async getMessages(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<DiscordMessageData[]> {
    const raw = await this.#bot.helpers.getMessages(BigInt(channelId), {
      after: opts.after ? BigInt(opts.after) : undefined,
      before: opts.before ? BigInt(opts.before) : undefined,
      limit: opts.limit ?? 100,
    });
    return raw.map(normalizeMessage);
  }

  async getChannel(channelId: string): Promise<DiscordChannelData | undefined> {
    try {
      // Fast path: check local cache
      const cached = this.#bot.cache.channels.memory.get(BigInt(channelId));
      if (cached) {
        return normalizeChannel(cached as unknown as Parameters<typeof normalizeChannel>[0]);
      }
      // Fallback: guild channel caches
      for (const guild of this.#bot.cache.guilds.memory.values()) {
        const ch = guild.channels?.get(BigInt(channelId));
        if (ch) {
          return normalizeChannel(ch as unknown as Parameters<typeof normalizeChannel>[0]);
        }
      }
      // REST fallback
      const channel = await this.#bot.helpers.getChannel(BigInt(channelId));
      return normalizeChannel(channel as unknown as Parameters<typeof normalizeChannel>[0]);
    } catch {
      return undefined;
    }
  }

  async getChannels(guildId: string): Promise<DiscordChannelData[]> {
    const guild = this.#bot.cache.guilds.memory.get(BigInt(guildId));
    if (!guild?.channels) return [];
    const channels: DiscordChannelData[] = [];
    for (const ch of guild.channels.values()) {
      channels.push(normalizeChannel(ch as unknown as Parameters<typeof normalizeChannel>[0]));
    }
    return channels;
  }

  async getGuild(guildId: string): Promise<DiscordGuildData | undefined> {
    const guild = this.#bot.cache.guilds.memory.get(BigInt(guildId));
    if (!guild) return undefined;
    return normalizeGuild(guild);
  }

  async getPublicArchivedThreads(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<ThreadPage> {
    const options: Record<string, unknown> = { limit: opts.limit ?? 100 };
    if (opts.before) {
      options.before = BigInt(opts.before);
    }

    const result = await (this.#bot.helpers as any).getPublicArchivedThreads(
      BigInt(channelId),
      options,
    );

    const threads: DiscordChannelData[] = (result.threads ?? []).map(
      (t: unknown) => normalizeChannel(t as Parameters<typeof normalizeChannel>[0]),
    );

    return {
      threads,
      hasMore: result.hasMore ?? false,
    };
  }

  async resolveChannelName(channelId: string): Promise<string | undefined> {
    // Fast path: direct channel cache
    const direct = this.#bot.cache.channels.memory.get(BigInt(channelId));
    if (direct?.name) return direct.name;
    // Scan guild channel caches
    for (const guild of this.#bot.cache.guilds.memory.values()) {
      const ch = guild.channels?.get(BigInt(channelId));
      if (ch?.name) return ch.name;
    }
    // REST fallback
    try {
      const channel = await this.#bot.helpers.getChannel(BigInt(channelId));
      return (channel as { name?: string }).name;
    } catch {
      return undefined;
    }
  }

  async resolveChannelType(channelId: string): Promise<number | undefined> {
    const id = BigInt(channelId);
    // Check top-level channel cache
    const direct = this.#bot.cache.channels.memory.get(id);
    if (direct) return direct.type;
    // Check guild channel caches
    for (const guild of this.#bot.cache.guilds.memory.values()) {
      const ch = guild.channels?.get(id);
      if (ch) return ch.type;
    }
    // REST fallback
    try {
      const channel = await this.#bot.helpers.getChannel(id);
      return (channel as { type: number }).type;
    } catch {
      return undefined;
    }
  }

  /**
   * Resolve the guild ID that a channel belongs to by scanning cached guilds.
   */
  async resolveGuildIdForChannel(channelId: string): Promise<string | undefined> {
    const id = BigInt(channelId);
    for (const guild of this.#bot.cache.guilds.memory.values()) {
      if (guild.channels?.has(id)) return guild.id.toString();
    }
    return undefined;
  }
}
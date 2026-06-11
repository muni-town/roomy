/**
 * FileDiscordDataSource: reads Discord data from JSON export files.
 *
 * Indexes all files on load so getMessages / getChannels / etc. serve
 * data from in-memory maps. Perfect for offline debugging and testing.
 *
 * Expected file layout:
 *   exportDir/
 *     guild.json              — DiscordGuildData
 *     channels.json           — DiscordChannelData[]
 *     messages/{channelId}.json  — DiscordMessageData[]
 *
 * If the export directory doesn't exist yet, the data source starts empty
 * and any method that would read from it returns empty results.
 */

import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
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

export class FileDiscordDataSource implements DiscordDataSource {
  #guild?: DiscordGuildData;
  #channels = new Map<string, DiscordChannelData>();
  #messages = new Map<string, DiscordMessageData[]>();

  private constructor() {}

  /**
   * Create a FileDiscordDataSource and load data from the given export dir.
   */
  static async create(exportDir: string): Promise<FileDiscordDataSource> {
    const ds = new FileDiscordDataSource();
    await ds.#load(exportDir);
    return ds;
  }

  /**
   * Create a FileDiscordDataSource with pre-loaded data (useful in tests).
   */
  static fromData(data: {
    guild?: DiscordGuildData;
    channels?: DiscordChannelData[];
    messages?: Record<string, DiscordMessageData[]>;
  }): FileDiscordDataSource {
    const ds = new FileDiscordDataSource();
    ds.#guild = data.guild;
    if (data.channels) {
      for (const ch of data.channels) {
        ds.#channels.set(ch.id, ch);
      }
    }
    if (data.messages) {
      for (const [channelId, msgs] of Object.entries(data.messages)) {
        ds.#messages.set(channelId, msgs);
      }
    }
    return ds;
  }

  async #load(exportDir: string): Promise<void> {
    if (!existsSync(exportDir)) return;

    // Load guild
    try {
      const guildPath = join(exportDir, "guild.json");
      if (existsSync(guildPath)) {
        const raw = await readFile(guildPath, "utf-8");
        this.#guild = JSON.parse(raw) as DiscordGuildData;
      }
    } catch {
      // silently continue
    }

    // Load channels
    try {
      const channelsPath = join(exportDir, "channels.json");
      if (existsSync(channelsPath)) {
        const raw = await readFile(channelsPath, "utf-8");
        const channels = JSON.parse(raw) as DiscordChannelData[];
        for (const ch of channels) {
          this.#channels.set(ch.id, ch);
        }
      } else if (this.#guild?.channels) {
        for (const ch of this.#guild.channels) {
          this.#channels.set(ch.id, ch);
        }
      }
    } catch {
      // silently continue
    }

    // Load messages from files
    try {
      const messagesDir = join(exportDir, "messages");
      if (existsSync(messagesDir)) {
        const files = await readdir(messagesDir);
        for (const file of files) {
          if (!file.endsWith(".json")) continue;
          const channelId = file.slice(0, -".json".length);
          const raw = await readFile(join(messagesDir, file), "utf-8");
          const msgs = JSON.parse(raw) as DiscordMessageData[];
          this.#messages.set(channelId, msgs);
        }
      }
    } catch {
      // silently continue
    }
  }

  async getMessages(
    channelId: string,
    opts: PaginationOpts,
  ): Promise<DiscordMessageData[]> {
    const all = this.#messages.get(channelId) ?? [];
    // Sort newest-first (Discord API convention)
    const sorted = [...all].sort(
      (a, b) => BigInt(b.id) - BigInt(a.id) > 0n ? 1 : -1,
    );

    let filtered = sorted;

    // Apply cursor filters
    if (opts.after) {
      filtered = filtered.filter((m) => BigInt(m.id) > BigInt(opts.after!));
    }
    if (opts.before) {
      filtered = filtered.filter((m) => BigInt(m.id) < BigInt(opts.before!));
    }

    // Apply limit
    const limit = opts.limit ?? 100;
    return filtered.slice(0, limit);
  }

  async getChannel(channelId: string): Promise<DiscordChannelData | undefined> {
    return this.#channels.get(channelId);
  }

  async getChannels(guildId: string): Promise<DiscordChannelData[]> {
    if (this.#guild?.id !== guildId) return [];
    return [...this.#channels.values()];
  }

  async getGuild(guildId: string): Promise<DiscordGuildData | undefined> {
    if (this.#guild?.id !== guildId) return undefined;
    return this.#guild;
  }

  async getPublicArchivedThreads(
    _channelId: string,
    _opts: PaginationOpts,
  ): Promise<ThreadPage> {
    // File exports don't separate archived threads; they're all in messages/
    return { threads: [], hasMore: false };
  }

  async resolveChannelName(channelId: string): Promise<string | undefined> {
    return this.#channels.get(channelId)?.name;
  }

  async resolveChannelType(channelId: string): Promise<number | undefined> {
    return this.#channels.get(channelId)?.type;
  }

  async resolveGuildIdForChannel(channelId: string): Promise<string | undefined> {
    if (this.#guild) {
      const ch = this.#channels.get(channelId);
      if (ch) return this.#guild.id;
    }
    return undefined;
  }
}
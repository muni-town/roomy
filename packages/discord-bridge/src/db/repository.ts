import { Database } from "bun:sqlite";
import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { runMigrations } from "./schema.ts";

export type MappingKind =
  | "message"
  | "channel"
  | "thread"
  | "user"
  | "reaction";

export type BridgeMode = "full" | "subset";

export type BridgeConfig = {
  guildId: string;
  spaceDid: string;
  mode: BridgeMode;
  createdAt: number;
  updatedAt: number;
};

export type AllowlistEntry = {
  spaceDid: string;
  channelId: string;
  guildId: string;
  addedAt: number;
};

export type ChannelCursor = {
  channelId: string;
  lastMessageId: string | null;
  updatedAt: number;
};

export type WebhookToken = {
  channelId: string;
  webhookId: string;
  token: string;
};

export class BridgeRepository {
  private constructor(private readonly db: Database) {}

  static open(path: string): BridgeRepository {
    if (path !== ":memory:") {
      mkdirSync(dirname(path), { recursive: true });
    }
    const db = new Database(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db);
    return new BridgeRepository(db);
  }

  close(): void {
    this.db.close();
  }

  // === Bridge config ===

  upsertBridgeConfig(guildId: string, spaceDid: string, mode: BridgeMode): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO bridge_config (guild_id, space_did, mode, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, space_did) DO UPDATE SET
           mode = excluded.mode,
           updated_at = excluded.updated_at`,
      )
      .run(guildId, spaceDid, mode, now, now);
  }

  removeBridgeConfig(guildId: string, spaceDid: string): void {
    this.db.transaction(() => {
      this.db
        .prepare("DELETE FROM allowlist WHERE guild_id = ? AND space_did = ?")
        .run(guildId, spaceDid);
      this.db
        .prepare("DELETE FROM bridge_config WHERE guild_id = ? AND space_did = ?")
        .run(guildId, spaceDid);
    })();
  }

  getBridgeConfig(guildId: string, spaceDid: string): BridgeConfig | undefined {
    const row = this.db
      .query<
        {
          guild_id: string;
          space_did: string;
          mode: BridgeMode;
          created_at: number;
          updated_at: number;
        },
        [string, string]
      >(
        `SELECT guild_id, space_did, mode, created_at, updated_at
         FROM bridge_config WHERE guild_id = ? AND space_did = ?`,
      )
      .get(guildId, spaceDid);
    if (!row) return undefined;
    return {
      guildId: row.guild_id,
      spaceDid: row.space_did,
      mode: row.mode,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  listBridgeConfigsForGuild(guildId: string): BridgeConfig[] {
    return this.db
      .query<
        {
          guild_id: string;
          space_did: string;
          mode: BridgeMode;
          created_at: number;
          updated_at: number;
        },
        [string]
      >(
        `SELECT guild_id, space_did, mode, created_at, updated_at
         FROM bridge_config WHERE guild_id = ? ORDER BY created_at ASC`,
      )
      .all(guildId)
      .map((row) => ({
        guildId: row.guild_id,
        spaceDid: row.space_did,
        mode: row.mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  listAllBridgeConfigs(): BridgeConfig[] {
    return this.db
      .query<
        {
          guild_id: string;
          space_did: string;
          mode: BridgeMode;
          created_at: number;
          updated_at: number;
        },
        []
      >(
        `SELECT guild_id, space_did, mode, created_at, updated_at
         FROM bridge_config ORDER BY guild_id, created_at ASC`,
      )
      .all()
      .map((row) => ({
        guildId: row.guild_id,
        spaceDid: row.space_did,
        mode: row.mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
  }

  /**
   * Returns every space DID that should receive events from `channelId` in `guildId`.
   * Includes all `full` bridges for the guild plus all `subset` bridges where the
   * channel appears in the allowlist. Empty array means the channel is not bridged.
   */
  getTargetSpacesForChannel(guildId: string, channelId: string): string[] {
    const rows = this.db
      .query<{ space_did: string }, [string, string, string]>(
        `SELECT space_did FROM bridge_config
         WHERE guild_id = ? AND mode = 'full'
         UNION
         SELECT bc.space_did
         FROM bridge_config bc
         JOIN allowlist a
           ON a.space_did = bc.space_did AND a.guild_id = bc.guild_id
         WHERE bc.guild_id = ? AND bc.mode = 'subset' AND a.channel_id = ?`,
      )
      .all(guildId, guildId, channelId);
    return rows.map((r) => r.space_did);
  }

  // === ID mappings (per space) ===

  registerMapping(
    spaceDid: string,
    kind: MappingKind,
    discordId: string,
    roomyId: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO id_mappings (space_did, kind, discord_id, roomy_id, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(space_did, kind, discord_id) DO UPDATE SET roomy_id = excluded.roomy_id`,
      )
      .run(spaceDid, kind, discordId, roomyId, Date.now());
  }

  getRoomyId(
    spaceDid: string,
    kind: MappingKind,
    discordId: string,
  ): string | undefined {
    const row = this.db
      .query<{ roomy_id: string }, [string, string, string]>(
        "SELECT roomy_id FROM id_mappings WHERE space_did = ? AND kind = ? AND discord_id = ?",
      )
      .get(spaceDid, kind, discordId);
    return row?.roomy_id;
  }

  getDiscordId(
    spaceDid: string,
    kind: MappingKind,
    roomyId: string,
  ): string | undefined {
    const row = this.db
      .query<{ discord_id: string }, [string, string, string]>(
        "SELECT discord_id FROM id_mappings WHERE space_did = ? AND kind = ? AND roomy_id = ?",
      )
      .get(spaceDid, kind, roomyId);
    return row?.discord_id;
  }

  unregisterMapping(
    spaceDid: string,
    kind: MappingKind,
    discordId: string,
  ): void {
    this.db
      .prepare(
        "DELETE FROM id_mappings WHERE space_did = ? AND kind = ? AND discord_id = ?",
      )
      .run(spaceDid, kind, discordId);
  }

  // === Channel cursors (shared across bridges) ===

  getChannelCursor(channelId: string): ChannelCursor | undefined {
    const row = this.db
      .query<
        { channel_id: string; last_message_id: string | null; updated_at: number },
        [string]
      >("SELECT channel_id, last_message_id, updated_at FROM channel_cursors WHERE channel_id = ?")
      .get(channelId);
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      lastMessageId: row.last_message_id,
      updatedAt: row.updated_at,
    };
  }

  setChannelCursor(channelId: string, lastMessageId: string | null): void {
    this.db
      .prepare(
        `INSERT INTO channel_cursors (channel_id, last_message_id, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           last_message_id = excluded.last_message_id,
           updated_at = excluded.updated_at`,
      )
      .run(channelId, lastMessageId, Date.now());
  }

  // === Allowlist (subset mode only) ===

  addToAllowlist(spaceDid: string, channelId: string, guildId: string): void {
    this.db
      .prepare(
        `INSERT INTO allowlist (space_did, channel_id, guild_id, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(space_did, channel_id) DO UPDATE SET guild_id = excluded.guild_id`,
      )
      .run(spaceDid, channelId, guildId, Date.now());
  }

  removeFromAllowlist(spaceDid: string, channelId: string): void {
    this.db
      .prepare("DELETE FROM allowlist WHERE space_did = ? AND channel_id = ?")
      .run(spaceDid, channelId);
  }

  isAllowlisted(spaceDid: string, channelId: string): boolean {
    const row = this.db
      .query<{ one: number }, [string, string]>(
        "SELECT 1 AS one FROM allowlist WHERE space_did = ? AND channel_id = ?",
      )
      .get(spaceDid, channelId);
    return row !== null && row !== undefined;
  }

  listAllowlistForBridge(spaceDid: string): AllowlistEntry[] {
    return this.db
      .query<
        { space_did: string; channel_id: string; guild_id: string; added_at: number },
        [string]
      >(
        `SELECT space_did, channel_id, guild_id, added_at
         FROM allowlist WHERE space_did = ? ORDER BY added_at ASC`,
      )
      .all(spaceDid)
      .map((r) => ({
        spaceDid: r.space_did,
        channelId: r.channel_id,
        guildId: r.guild_id,
        addedAt: r.added_at,
      }));
  }

  // === Profile hashes (per space) ===

  getProfileHash(spaceDid: string, discordUserId: string): string | undefined {
    const row = this.db
      .query<{ hash: string }, [string, string]>(
        "SELECT hash FROM profile_hashes WHERE space_did = ? AND discord_user_id = ?",
      )
      .get(spaceDid, discordUserId);
    return row?.hash;
  }

  setProfileHash(spaceDid: string, discordUserId: string, hash: string): void {
    this.db
      .prepare(
        `INSERT INTO profile_hashes (space_did, discord_user_id, hash, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(space_did, discord_user_id) DO UPDATE SET
           hash = excluded.hash,
           updated_at = excluded.updated_at`,
      )
      .run(spaceDid, discordUserId, hash, Date.now());
  }

  // === Webhook tokens (placeholder for future bidirectional) ===

  getWebhookToken(channelId: string): WebhookToken | undefined {
    const row = this.db
      .query<
        { channel_id: string; webhook_id: string; token: string },
        [string]
      >("SELECT channel_id, webhook_id, token FROM webhook_tokens WHERE channel_id = ?")
      .get(channelId);
    if (!row) return undefined;
    return {
      channelId: row.channel_id,
      webhookId: row.webhook_id,
      token: row.token,
    };
  }

  setWebhookToken(channelId: string, webhookId: string, token: string): void {
    this.db
      .prepare(
        `INSERT INTO webhook_tokens (channel_id, webhook_id, token)
         VALUES (?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET
           webhook_id = excluded.webhook_id,
           token = excluded.token`,
      )
      .run(channelId, webhookId, token);
  }

  deleteWebhookToken(channelId: string): void {
    this.db.prepare("DELETE FROM webhook_tokens WHERE channel_id = ?").run(channelId);
  }
}

import type { Database } from "bun:sqlite"

export type Migration = {
  version: number
  name: string
  up: (db: Database) => void
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "initial",
    up(db) {
      db.run(`
        CREATE TABLE bridge_config (
          guild_id   TEXT NOT NULL,
          space_did  TEXT NOT NULL,
          mode       TEXT NOT NULL CHECK (mode IN ('full', 'subset')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (guild_id, space_did)
        );
        CREATE INDEX idx_bridge_config_guild ON bridge_config (guild_id);

        CREATE TABLE id_mappings (
          space_did  TEXT NOT NULL,
          kind       TEXT NOT NULL,
          discord_id TEXT NOT NULL,
          roomy_id   TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (space_did, kind, discord_id)
        );
        CREATE INDEX idx_mappings_roomy ON id_mappings (space_did, kind, roomy_id);

        CREATE TABLE channel_cursors (
          channel_id      TEXT PRIMARY KEY,
          last_message_id TEXT,
          updated_at      INTEGER NOT NULL
        );

        CREATE TABLE allowlist (
          space_did  TEXT NOT NULL,
          channel_id TEXT NOT NULL,
          guild_id   TEXT NOT NULL,
          added_at   INTEGER NOT NULL,
          PRIMARY KEY (space_did, channel_id)
        );
        CREATE INDEX idx_allowlist_channel ON allowlist (channel_id);
        CREATE INDEX idx_allowlist_guild ON allowlist (guild_id);

        CREATE TABLE profile_hashes (
          space_did       TEXT NOT NULL,
          discord_user_id TEXT NOT NULL,
          hash            TEXT NOT NULL,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (space_did, discord_user_id)
        );

        CREATE TABLE webhook_tokens (
          channel_id TEXT PRIMARY KEY,
          webhook_id TEXT NOT NULL,
          token      TEXT NOT NULL
        );
      `)
    }
  },
  {
    version: 2,
    name: "channel_cursors_per_space",
    up(db) {
      // Cursors were keyed by channel_id alone, which meant connecting a
      // channel to a second Roomy space inherited the first space's cursor
      // and silently skipped backfill. Re-key by (space_did, channel_id).
      // Existing cursor rows are dropped — they were never correct under
      // multi-bridge conditions.
      db.run(`
        DROP TABLE channel_cursors;

        CREATE TABLE channel_cursors (
          space_did       TEXT NOT NULL,
          channel_id      TEXT NOT NULL,
          last_message_id TEXT,
          updated_at      INTEGER NOT NULL,
          PRIMARY KEY (space_did, channel_id)
        );
      `)
    }
  }
]

export function runMigrations(db: Database): {
  applied: number[]
  current: number
} {
  db.run(
    `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`
  )
  const row = db
    .query<
      { v: number | null },
      []
    >("SELECT MAX(version) AS v FROM schema_version")
    .get()
  const current = row?.v ?? 0
  const applied: number[] = []
  const insertVersion = db.prepare(
    "INSERT INTO schema_version (version) VALUES (?)"
  )

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue
    db.transaction(() => {
      migration.up(db)
      insertVersion.run(migration.version)
    })()
    applied.push(migration.version)
  }

  const after = db
    .query<
      { v: number | null },
      []
    >("SELECT MAX(version) AS v FROM schema_version")
    .get()
  return { applied, current: after?.v ?? 0 }
}

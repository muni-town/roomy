import type { Database } from "bun:sqlite";

export type Migration = {
	version: number;
	name: string;
	up: (db: Database) => void;
};

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
      `);
		},
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
      `);
		},
	},
	{
		version: 3,
		name: "profile_sync_queue",
		up(db) {
			db.run(`
        CREATE TABLE profile_sync_queue (
          space_did        TEXT NOT NULL,
          discord_user_id  TEXT NOT NULL,
          username         TEXT NOT NULL,
          global_name      TEXT,
          avatar_hash      TEXT,
          discriminator    TEXT NOT NULL,
          retry_count      INTEGER NOT NULL DEFAULT 0,
          last_error       TEXT,
          next_retry_at    INTEGER NOT NULL,
          created_at       INTEGER NOT NULL,
          updated_at       INTEGER NOT NULL,
          PRIMARY KEY (space_did, discord_user_id)
        );
      `);
		},
	},
	{
		version: 4,
		name: "space_cursors",
		up(db) {
			db.run(`
        CREATE TABLE space_cursors (
          space_did      TEXT PRIMARY KEY,
          last_idx       INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );
      `);
		},
	},
	{
		version: 5,
		name: "pending_room_creations",
		up(db) {
			db.run(`
        CREATE TABLE pending_room_creations (
          space_did      TEXT NOT NULL,
          roomy_id       TEXT NOT NULL,
          kind           TEXT NOT NULL,
          name           TEXT NOT NULL,
          default_access TEXT,
          created_at     INTEGER NOT NULL,
          PRIMARY KEY (space_did, roomy_id)
        );
      `);
		},
	},
	{
		version: 6,
		name: "event_errors",
		up(db) {
			db.run(`
        CREATE TABLE event_errors (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          space_did     TEXT NOT NULL,
          event_idx     INTEGER NOT NULL,
          event_type    TEXT NOT NULL,
          error_message TEXT NOT NULL,
          occurred_at   INTEGER NOT NULL
        );
        CREATE INDEX idx_event_errors_space ON event_errors (space_did, occurred_at);
      `);
		},
	},
	{
		version: 7,
		name: "structure_sync",
		up(db) {
			// One-shot guard for the initial Discord→Roomy structure sync
			// (categories + channel order). A row exists from the moment the
			// (guild, space) structure sync is CLAIMED — before any event is
			// sent — so the sync is at-most-once by construction: a crash
			// mid-sync cannot re-apply it on the next backfill. `applied_at`
			// is null while a claim is unapplied; see BridgeRepository
			// .claimStructureSync for why the claim is not rolled back.
			db.run(`
        CREATE TABLE structure_sync (
          guild_id   TEXT NOT NULL,
          space_did  TEXT NOT NULL,
          claimed_at INTEGER NOT NULL,
          applied_at INTEGER,
          PRIMARY KEY (guild_id, space_did)
        );
      `);
		},
	},
	{
		version: 8,
		name: "backfill_progress",
		up(db) {
			// Durable per-(space, channel) backfill progress so two-phase
			// backfill survives restarts. Phase 1 (bounded recent window)
			// writes window_boundary = the oldest message it ingested; the
			// Phase 2 walk ingests everything strictly below it, resuming
			// from walk_cursor. phase 'complete' means the channel's whole
			// history has been ingested (or the pair was only ever short).
			// Counts are ABSOLUTE (not deltas) so any row refresh can
			// overwrite safely.
			db.run(`
        CREATE TABLE backfill_progress (
          space_did        TEXT NOT NULL,
          channel_id       TEXT NOT NULL,
          guild_id         TEXT,
          kind             TEXT CHECK (kind IN ('channel', 'thread')),
          channel_name     TEXT,
          phase            TEXT NOT NULL CHECK (phase IN ('phase1', 'phase2', 'complete')),
          messages_synced  INTEGER NOT NULL DEFAULT 0,
          messages_skipped INTEGER NOT NULL DEFAULT 0,
          window_boundary  TEXT,
          walk_cursor      TEXT,
          updated_at       INTEGER NOT NULL,
          PRIMARY KEY (space_did, channel_id)
        );
        CREATE INDEX idx_backfill_progress_guild ON backfill_progress (guild_id);
      `);
		},
	},
	{
		version: 9,
		name: "backfill_progress_details",
		up(db) {
			// parent_id: for thread rows, the Discord id of the parent
			// channel so the Roomy status panel can nest threads under
			// channels. window_synced: snapshot of messages_synced at the
			// phase1→phase2 transition, so the UI can report how much of
			// the recent window was ingested before the deep walk started.
			db.run(`
        ALTER TABLE backfill_progress ADD COLUMN parent_id TEXT;
        ALTER TABLE backfill_progress ADD COLUMN window_synced INTEGER;
      `);
		},
	},
];

export function runMigrations(db: Database): {
	applied: number[];
	current: number;
} {
	db.run(
		`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)`,
	);
	const row = db
		.query<{ v: number | null }, []>(
			"SELECT MAX(version) AS v FROM schema_version",
		)
		.get();
	const current = row?.v ?? 0;
	const applied: number[] = [];
	const insertVersion = db.prepare(
		"INSERT INTO schema_version (version) VALUES (?)",
	);

	for (const migration of MIGRATIONS) {
		if (migration.version <= current) continue;
		db.transaction(() => {
			migration.up(db);
			insertVersion.run(migration.version);
		})();
		applied.push(migration.version);
	}

	const after = db
		.query<{ v: number | null }, []>(
			"SELECT MAX(version) AS v FROM schema_version",
		)
		.get();
	return { applied, current: after?.v ?? 0 };
}

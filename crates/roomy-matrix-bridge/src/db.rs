//! The bridge's SQLite store.
//!
//! Mirrors the Discord bridge's shape (`bridge_config`, `id_mappings`,
//! `channel_cursors`, `backfill_progress`, `failed_sends`) with Matrix
//! identifiers, and adds `portals` because a bridged Matrix space fans out into
//! many rooms while a guild maps one channel at a time.
//!
//! Migrations are an ordered array applied in a transaction with the version
//! row written last, so a crash mid-migration leaves the database on the
//! previous version rather than half-migrated.

use std::path::Path;

use bridge_core::{Mapping, MappingKind, MatrixRoomId, RoomyRoomId};
use rusqlite::{params, Connection, OptionalExtension};

/// One entry in the migration manifest.
pub struct Migration {
    pub version: i64,
    pub name: &'static str,
    pub up: fn(&Connection) -> rusqlite::Result<()>,
}

/// Every migration, in order.
pub const MIGRATIONS: &[Migration] = &[Migration {
    version: 1,
    name: "initial",
    up: |db| {
        db.execute_batch(
            r#"
            create table bridge_config (
              id             text primary key,
              space_did      text not null,
              matrix_id      text not null,
              kind           text not null check (kind in ('room', 'space')),
              mode           text not null check (mode in ('full', 'subset')),
              auto_bridge    integer not null default 0,
              target_room_id text,
              created_at     integer not null,
              updated_at     integer not null,
              unique (space_did, matrix_id)
            );
            create index idx_bridge_config_space on bridge_config (space_did);

            create table portals (
              space_did      text not null,
              matrix_room_id text not null,
              roomy_room_id  text not null,
              bridge_id      text not null references bridge_config (id) on delete cascade,
              depth          integer not null default 1,
              name           text,
              encrypted      integer not null default 0,
              state          text not null default 'syncing',
              reason         text,
              created_at     integer not null,
              updated_at     integer not null,
              primary key (space_did, matrix_room_id)
            );
            create index idx_portals_roomy on portals (space_did, roomy_room_id);

            create table id_mappings (
              space_did  text not null,
              kind       text not null,
              matrix_id  text not null,
              roomy_id   text not null,
              created_at integer not null,
              primary key (space_did, kind, matrix_id)
            );
            create index idx_id_mappings_roomy on id_mappings (space_did, kind, roomy_id);

            create table ghosts (
              mxid         text primary key,
              did          text not null,
              profile_hash text,
              updated_at   integer not null
            );
            create index idx_ghosts_did on ghosts (did);

            create table cursors (
              space_did         text not null,
              roomy_room_id     text not null,
              matrix_stream_pos text,
              roomy_cursor      integer,
              primary key (space_did, roomy_room_id)
            );

            create table backfill_progress (
              space_did      text not null,
              matrix_room_id text not null,
              phase          text not null,
              token          text,
              messages       integer not null default 0,
              complete       integer not null default 0,
              updated_at     integer not null,
              primary key (space_did, matrix_room_id)
            );

            create table failed_sends (
              id              text primary key,
              space_did       text not null,
              op              text not null,
              attempts        integer not null default 0,
              next_attempt_at integer not null,
              last_error      text,
              created_at      integer not null
            );
            create index idx_failed_sends_due on failed_sends (next_attempt_at);
            "#,
        )
    },
}];

/// A bridge configuration row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeConfigRow {
    pub id: String,
    pub space_did: String,
    pub matrix_id: String,
    pub kind: String,
    pub mode: String,
    pub auto_bridge: bool,
    pub target_room_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// A portal row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PortalRow {
    pub space_did: String,
    pub matrix_room_id: String,
    pub roomy_room_id: String,
    pub bridge_id: String,
    pub depth: u32,
    pub name: Option<String>,
    pub encrypted: bool,
    pub state: String,
    pub reason: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

/// The bridge database.
pub struct BridgeDb {
    connection: Connection,
}

impl BridgeDb {
    /// Open the database at `path`, creating and migrating it as needed.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, DbError> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).map_err(|source| DbError::Io {
                path: parent.display().to_string(),
                source,
            })?;
        }
        let connection = Connection::open(path).map_err(DbError::Sqlite)?;
        Self::from_connection(connection)
    }

    /// Open an in-memory database, for tests.
    #[cfg(test)]
    pub fn open_in_memory() -> Result<Self, DbError> {
        Self::from_connection(Connection::open_in_memory().map_err(DbError::Sqlite)?)
    }

    fn from_connection(connection: Connection) -> Result<Self, DbError> {
        connection
            .execute_batch(
                "pragma journal_mode = wal;
                 pragma foreign_keys = on;
                 create table if not exists schema_version (version integer primary key);",
            )
            .map_err(DbError::Sqlite)?;

        let mut db = Self { connection };
        db.migrate()?;
        Ok(db)
    }

    /// Apply every migration the database has not had yet.
    fn migrate(&mut self) -> Result<(), DbError> {
        let current: i64 = self
            .connection
            .query_row(
                "select coalesce(max(version), 0) from schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(DbError::Sqlite)?;

        for migration in MIGRATIONS {
            if migration.version <= current {
                continue;
            }
            let tx = self.connection.transaction().map_err(DbError::Sqlite)?;
            (migration.up)(&tx).map_err(DbError::Sqlite)?;
            tx.execute(
                "insert into schema_version (version) values (?1)",
                params![migration.version],
            )
            .map_err(DbError::Sqlite)?;
            tx.commit().map_err(DbError::Sqlite)?;
            tracing::info!(
                version = migration.version,
                name = migration.name,
                "applied migration"
            );
        }
        Ok(())
    }

    /// The migration version the database is on.
    #[cfg(test)]
    pub fn version(&self) -> Result<i64, DbError> {
        self.connection
            .query_row(
                "select coalesce(max(version), 0) from schema_version",
                [],
                |row| row.get(0),
            )
            .map_err(DbError::Sqlite)
    }

    // ── bridge config ────────────────────────────────────────────────────

    /// Insert a bridge configuration row.
    pub fn insert_bridge(&self, row: &BridgeConfigRow) -> Result<(), DbError> {
        self.connection
            .execute(
                "insert into bridge_config
                   (id, space_did, matrix_id, kind, mode, auto_bridge, target_room_id,
                    created_at, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    row.id,
                    row.space_did,
                    row.matrix_id,
                    row.kind,
                    row.mode,
                    row.auto_bridge as i64,
                    row.target_room_id,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Every bridge configured for one space.
    pub fn bridges_for_space(&self, space_did: &str) -> Result<Vec<BridgeConfigRow>, DbError> {
        let mut statement = self
            .connection
            .prepare(
                "select id, space_did, matrix_id, kind, mode, auto_bridge, target_room_id,
                        created_at, updated_at
                 from bridge_config where space_did = ?1 order by created_at",
            )
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map(params![space_did], |row| {
                Ok(BridgeConfigRow {
                    id: row.get(0)?,
                    space_did: row.get(1)?,
                    matrix_id: row.get(2)?,
                    kind: row.get(3)?,
                    mode: row.get(4)?,
                    auto_bridge: row.get::<_, i64>(5)? != 0,
                    target_room_id: row.get(6)?,
                    created_at: row.get(7)?,
                    updated_at: row.get(8)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    /// One bridge by id.
    pub fn bridge(&self, id: &str) -> Result<Option<BridgeConfigRow>, DbError> {
        self.connection
            .query_row(
                "select id, space_did, matrix_id, kind, mode, auto_bridge, target_room_id,
                        created_at, updated_at
                 from bridge_config where id = ?1",
                params![id],
                |row| {
                    Ok(BridgeConfigRow {
                        id: row.get(0)?,
                        space_did: row.get(1)?,
                        matrix_id: row.get(2)?,
                        kind: row.get(3)?,
                        mode: row.get(4)?,
                        auto_bridge: row.get::<_, i64>(5)? != 0,
                        target_room_id: row.get(6)?,
                        created_at: row.get(7)?,
                        updated_at: row.get(8)?,
                    })
                },
            )
            .optional()
            .map_err(DbError::Sqlite)
    }

    /// Update a bridge's mutable fields.
    pub fn update_bridge(
        &self,
        id: &str,
        mode: Option<&str>,
        auto_bridge: Option<bool>,
        updated_at: i64,
    ) -> Result<(), DbError> {
        self.connection
            .execute(
                "update bridge_config
                 set mode = coalesce(?2, mode),
                     auto_bridge = coalesce(?3, auto_bridge),
                     updated_at = ?4
                 where id = ?1",
                params![id, mode, auto_bridge.map(|value| value as i64), updated_at],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Delete a bridge and, by cascade, its portals.
    pub fn delete_bridge(&self, id: &str) -> Result<bool, DbError> {
        self.connection
            .execute("delete from bridge_config where id = ?1", params![id])
            .map(|changed| changed > 0)
            .map_err(DbError::Sqlite)
    }

    // ── portals ──────────────────────────────────────────────────────────

    /// Record a portal.
    pub fn upsert_portal(&self, row: &PortalRow) -> Result<(), DbError> {
        self.connection
            .execute(
                "insert into portals
                   (space_did, matrix_room_id, roomy_room_id, bridge_id, depth, name,
                    encrypted, state, reason, created_at, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 on conflict (space_did, matrix_room_id) do update set
                   roomy_room_id = excluded.roomy_room_id,
                   depth = excluded.depth,
                   name = excluded.name,
                   encrypted = excluded.encrypted,
                   state = excluded.state,
                   reason = excluded.reason,
                   updated_at = excluded.updated_at",
                params![
                    row.space_did,
                    row.matrix_room_id,
                    row.roomy_room_id,
                    row.bridge_id,
                    row.depth,
                    row.name,
                    row.encrypted as i64,
                    row.state,
                    row.reason,
                    row.created_at,
                    row.updated_at,
                ],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Every portal belonging to one bridge.
    pub fn portals_for_bridge(&self, bridge_id: &str) -> Result<Vec<PortalRow>, DbError> {
        let mut statement = self
            .connection
            .prepare(
                "select space_did, matrix_room_id, roomy_room_id, bridge_id, depth, name,
                        encrypted, state, reason, created_at, updated_at
                 from portals where bridge_id = ?1 order by depth, matrix_room_id",
            )
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map(params![bridge_id], |row| {
                Ok(PortalRow {
                    space_did: row.get(0)?,
                    matrix_room_id: row.get(1)?,
                    roomy_room_id: row.get(2)?,
                    bridge_id: row.get(3)?,
                    depth: row.get(4)?,
                    name: row.get(5)?,
                    encrypted: row.get::<_, i64>(6)? != 0,
                    state: row.get(7)?,
                    reason: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    /// Every portal in a space, across all bridges.
    pub fn portals_for_space(&self, space_did: &str) -> Result<Vec<PortalRow>, DbError> {
        let mut statement = self
            .connection
            .prepare(
                "select space_did, matrix_room_id, roomy_room_id, bridge_id, depth, name,
                        encrypted, state, reason, created_at, updated_at
                 from portals where space_did = ?1 order by depth, matrix_room_id",
            )
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map(params![space_did], |row| {
                Ok(PortalRow {
                    space_did: row.get(0)?,
                    matrix_room_id: row.get(1)?,
                    roomy_room_id: row.get(2)?,
                    bridge_id: row.get(3)?,
                    depth: row.get(4)?,
                    name: row.get(5)?,
                    encrypted: row.get::<_, i64>(6)? != 0,
                    state: row.get(7)?,
                    reason: row.get(8)?,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    /// How many portals exist in total, for `GET /health`.
    pub fn portal_count(&self) -> Result<i64, DbError> {
        self.connection
            .query_row("select count(*) from portals", [], |row| row.get(0))
            .map_err(DbError::Sqlite)
    }

    // ── id mappings ──────────────────────────────────────────────────────

    /// Record an id pairing.
    pub fn put_mapping(&self, space_did: &str, mapping: &Mapping) -> Result<(), DbError> {
        self.connection
            .execute(
                "insert or ignore into id_mappings (space_did, kind, matrix_id, roomy_id, created_at)
                 values (?1, ?2, ?3, ?4, ?5)",
                params![
                    space_did,
                    kind_label(mapping.kind),
                    mapping.matrix_id,
                    mapping.roomy_id,
                    mapping.created_at
                ],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Every mapping in a space, to warm the in-memory index at startup.
    pub fn mappings(&self, space_did: &str) -> Result<Vec<Mapping>, DbError> {
        let mut statement = self
            .connection
            .prepare(
                "select kind, matrix_id, roomy_id, created_at
                 from id_mappings where space_did = ?1",
            )
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map(params![space_did], |row| {
                let kind: String = row.get(0)?;
                Ok(Mapping {
                    kind: kind_from_label(&kind),
                    matrix_id: row.get(1)?,
                    roomy_id: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    // ── ghosts ───────────────────────────────────────────────────────────

    // ── ghosts ───────────────────────────────────────────────────────────

    /// Record or refresh a ghost.
    pub fn put_ghost(&self, ghost: &GhostWrite<'_>) -> Result<(), DbError> {
        self.connection
            .execute(
                "insert into ghosts (mxid, did, profile_hash, updated_at) values (?1, ?2, ?3, ?4)
                 on conflict (mxid) do update set
                   did = excluded.did,
                   profile_hash = coalesce(excluded.profile_hash, ghosts.profile_hash),
                   updated_at = excluded.updated_at",
                params![ghost.mxid, ghost.did, ghost.profile_hash, ghost.updated_at],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Every ghost the bridge has minted.
    pub fn all_ghosts(&self) -> Result<Vec<GhostRow>, DbError> {
        let mut statement = self
            .connection
            .prepare("select mxid, did, profile_hash from ghosts order by updated_at")
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map([], |row| {
                Ok(GhostRow {
                    mxid: row.get(0)?,
                    did: row.get(1)?,
                    profile_hash: row.get(2)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    /// The ghost for a DID: its MXID and the profile hash last pushed.
    ///
    /// The hash is what makes a profile sync idempotent — an unchanged profile
    /// must not be re-sent on every restart.
    pub fn ghost_for_did(&self, did: &str) -> Result<Option<GhostRow>, DbError> {
        self.connection
            .query_row(
                "select mxid, did, profile_hash from ghosts where did = ?1",
                params![did],
                |row| {
                    Ok(GhostRow {
                        mxid: row.get(0)?,
                        did: row.get(1)?,
                        profile_hash: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(DbError::Sqlite)
    }

    // ── cursors ──────────────────────────────────────────────────────────

    /// The stream position last processed for a Roomy room.
    pub fn cursor(&self, space_did: &str, roomy_room_id: &str) -> Result<Option<i64>, DbError> {
        self.connection
            .query_row(
                "select roomy_cursor from cursors where space_did = ?1 and roomy_room_id = ?2",
                params![space_did, roomy_room_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(|value| value.flatten())
            .map_err(DbError::Sqlite)
    }

    /// Advance the cursor for a Roomy room.
    pub fn set_cursor(
        &self,
        space_did: &str,
        roomy_room_id: &str,
        roomy_cursor: i64,
    ) -> Result<(), DbError> {
        self.connection
            .execute(
                "insert into cursors (space_did, roomy_room_id, roomy_cursor)
                 values (?1, ?2, ?3)
                 on conflict (space_did, roomy_room_id) do update set
                   roomy_cursor = excluded.roomy_cursor",
                params![space_did, roomy_room_id, roomy_cursor],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    // ── backfill progress ────────────────────────────────────────────────

    /// Record backfill progress for a portal.
    pub fn set_backfill(&self, progress: &BackfillWrite<'_>) -> Result<(), DbError> {
        let BackfillWrite {
            space_did,
            matrix_room_id,
            phase,
            token,
            messages,
            complete,
            updated_at,
        } = progress;
        self.connection
            .execute(
                "insert into backfill_progress
                   (space_did, matrix_room_id, phase, token, messages, complete, updated_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 on conflict (space_did, matrix_room_id) do update set
                   phase = excluded.phase,
                   token = excluded.token,
                   messages = excluded.messages,
                   complete = excluded.complete,
                   updated_at = excluded.updated_at",
                params![
                    space_did,
                    matrix_room_id,
                    phase,
                    token,
                    *messages as i64,
                    *complete as i64,
                    updated_at
                ],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// The backfill row for a portal.
    pub fn backfill(
        &self,
        space_did: &str,
        matrix_room_id: &str,
    ) -> Result<Option<BackfillRow>, DbError> {
        self.connection
            .query_row(
                "select phase, token, messages, complete, updated_at
                 from backfill_progress where space_did = ?1 and matrix_room_id = ?2",
                params![space_did, matrix_room_id],
                |row| {
                    Ok(BackfillRow {
                        phase: row.get(0)?,
                        token: row.get(1)?,
                        messages: row.get(2)?,
                        complete: row.get::<_, i64>(3)? != 0,
                        updated_at: row.get(4)?,
                    })
                },
            )
            .optional()
            .map_err(DbError::Sqlite)
    }

    // ── failed sends ─────────────────────────────────────────────────────

    /// Record a send that failed and must be retried.
    pub fn put_failed_send(&self, send: &FailedSendWrite<'_>) -> Result<(), DbError> {
        let FailedSendWrite {
            id,
            space_did,
            payload,
            attempts,
            next_attempt_at,
            last_error,
            created_at,
        } = send;
        self.connection
            .execute(
                "insert into failed_sends
                   (id, space_did, op, attempts, next_attempt_at, last_error, created_at)
                 values (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 on conflict (id) do update set
                   attempts = excluded.attempts,
                   next_attempt_at = excluded.next_attempt_at,
                   last_error = excluded.last_error",
                params![
                    id,
                    space_did,
                    payload,
                    *attempts as i64,
                    next_attempt_at,
                    last_error,
                    created_at
                ],
            )
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }

    /// Sends due to be retried at `now`, oldest first.
    ///
    /// Entries that have spent their attempt budget are excluded: they are
    /// parked, kept for inspection and requeue, not offered again. `rowid`
    /// breaks ties so batches queued together keep their insertion order.
    pub fn due_failed_sends(
        &self,
        now: i64,
        max_attempts: u32,
        limit: usize,
    ) -> Result<Vec<FailedSendRow>, DbError> {
        let mut statement = self
            .connection
            .prepare(
                "select id, space_did, op, attempts, next_attempt_at, last_error
                 from failed_sends where next_attempt_at <= ?1 and attempts < ?2
                 order by next_attempt_at, rowid limit ?3",
            )
            .map_err(DbError::Sqlite)?;
        let rows = statement
            .query_map(params![now, max_attempts as i64, limit as i64], |row| {
                Ok(FailedSendRow {
                    id: row.get(0)?,
                    space_did: row.get(1)?,
                    op: row.get(2)?,
                    attempts: row.get(3)?,
                    next_attempt_at: row.get(4)?,
                    last_error: row.get(5)?,
                })
            })
            .map_err(DbError::Sqlite)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(DbError::Sqlite)
    }

    /// When the next retryable send falls due, or `None` when the queue holds
    /// nothing left to retry.
    pub fn next_failed_send_at(&self, max_attempts: u32) -> Result<Option<i64>, DbError> {
        self.connection
            .query_row(
                "select min(next_attempt_at) from failed_sends where attempts < ?1",
                params![max_attempts as i64],
                |row| row.get(0),
            )
            .map_err(DbError::Sqlite)
    }

    /// One queued send, by id.
    pub fn failed_send(&self, id: &str) -> Result<Option<FailedSendRow>, DbError> {
        self.connection
            .query_row(
                "select id, space_did, op, attempts, next_attempt_at, last_error
                 from failed_sends where id = ?1",
                params![id],
                |row| {
                    Ok(FailedSendRow {
                        id: row.get(0)?,
                        space_did: row.get(1)?,
                        op: row.get(2)?,
                        attempts: row.get(3)?,
                        next_attempt_at: row.get(4)?,
                        last_error: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(DbError::Sqlite)
    }

    /// Remove a failed send that has since succeeded.
    pub fn clear_failed_send(&self, id: &str) -> Result<(), DbError> {
        self.connection
            .execute("delete from failed_sends where id = ?1", params![id])
            .map(|_| ())
            .map_err(DbError::Sqlite)
    }
}

/// A backfill progress write.
pub struct BackfillWrite<'a> {
    pub space_did: &'a str,
    pub matrix_room_id: &'a str,
    /// `recent` for the synchronously-read window, `deep` for the background
    /// walk, `skipped` for a room whose history cannot be read.
    pub phase: &'a str,
    pub token: Option<&'a str>,
    pub messages: u64,
    pub complete: bool,
    pub updated_at: i64,
}

/// A ghost write.
pub struct GhostWrite<'a> {
    pub mxid: &'a str,
    pub did: &'a str,
    pub profile_hash: Option<&'a str>,
    pub updated_at: i64,
}

/// A ghost row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GhostRow {
    pub mxid: String,
    pub did: String,
    pub profile_hash: Option<String>,
}

/// A failed-send write.
pub struct FailedSendWrite<'a> {
    pub id: &'a str,
    pub space_did: &'a str,
    /// The serialised event batch to re-send.
    pub payload: &'a str,
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub last_error: Option<&'a str>,
    pub created_at: i64,
}

/// A backfill progress row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BackfillRow {
    pub phase: String,
    pub token: Option<String>,
    pub messages: i64,
    pub complete: bool,
    pub updated_at: i64,
}

/// A failed send awaiting retry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FailedSendRow {
    pub id: String,
    pub space_did: String,
    pub op: String,
    pub attempts: u32,
    pub next_attempt_at: i64,
    pub last_error: Option<String>,
}

fn kind_label(kind: MappingKind) -> &'static str {
    match kind {
        MappingKind::Message => "message",
        MappingKind::Reaction => "reaction",
        MappingKind::Room => "room",
        MappingKind::Edit => "edit",
        MappingKind::Redaction => "redaction",
    }
}

fn kind_from_label(label: &str) -> MappingKind {
    match label {
        "reaction" => MappingKind::Reaction,
        "room" => MappingKind::Room,
        "edit" => MappingKind::Edit,
        "redaction" => MappingKind::Redaction,
        _ => MappingKind::Message,
    }
}

/// The database could not be opened or queried.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlite error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("could not create {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// The parts of a new portal.
pub struct NewPortal<'a> {
    pub space_did: &'a str,
    pub bridge_id: &'a str,
    pub matrix_room_id: &'a MatrixRoomId,
    pub roomy_room_id: &'a RoomyRoomId,
    pub depth: u32,
    pub name: Option<String>,
    pub encrypted: bool,
    pub now: i64,
}

/// Build a portal row from its parts.
pub fn portal_row(new: NewPortal<'_>) -> PortalRow {
    let NewPortal {
        space_did,
        bridge_id,
        matrix_room_id,
        roomy_room_id,
        depth,
        name,
        encrypted,
        now,
    } = new;
    PortalRow {
        space_did: space_did.to_string(),
        matrix_room_id: matrix_room_id.as_str().to_string(),
        roomy_room_id: roomy_room_id.as_str().to_string(),
        bridge_id: bridge_id.to_string(),
        depth,
        name,
        encrypted,
        state: "syncing".into(),
        reason: None,
        created_at: now,
        updated_at: now,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn db() -> BridgeDb {
        BridgeDb::open_in_memory().unwrap()
    }

    fn bridge_row(id: &str, space: &str) -> BridgeConfigRow {
        BridgeConfigRow {
            id: id.into(),
            space_did: space.into(),
            matrix_id: "!room:example.org".into(),
            kind: "room".into(),
            mode: "full".into(),
            auto_bridge: false,
            target_room_id: None,
            created_at: 1,
            updated_at: 1,
        }
    }

    #[test]
    fn a_fresh_database_is_at_the_latest_version() {
        assert_eq!(db().version().unwrap(), 1);
    }

    #[test]
    fn reopening_a_database_does_not_reapply_migrations() {
        let path =
            std::env::temp_dir().join(format!("bridge-test-{}.sqlite", ulid::Ulid::generate()));
        {
            let db = BridgeDb::open(&path).unwrap();
            assert_eq!(db.version().unwrap(), 1);
        }
        {
            let db = BridgeDb::open(&path).unwrap();
            assert_eq!(db.version().unwrap(), 1);
            assert_eq!(db.portal_count().unwrap(), 0);
        }
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn bridges_round_trip() {
        let db = db();
        db.insert_bridge(&bridge_row("b1", "did:plc:space"))
            .unwrap();
        let bridges = db.bridges_for_space("did:plc:space").unwrap();
        assert_eq!(bridges.len(), 1);
        assert_eq!(bridges[0].matrix_id, "!room:example.org");
        assert_eq!(db.bridge("b1").unwrap().unwrap().kind, "room");
    }

    #[test]
    fn a_bridge_updates_its_mutable_fields() {
        let db = db();
        db.insert_bridge(&bridge_row("b1", "did:plc:space"))
            .unwrap();
        db.update_bridge("b1", Some("subset"), Some(true), 2)
            .unwrap();
        let bridge = db.bridge("b1").unwrap().unwrap();
        assert_eq!(bridge.mode, "subset");
        assert!(bridge.auto_bridge);
        assert_eq!(bridge.updated_at, 2);
    }

    #[test]
    fn deleting_a_bridge_removes_its_portals() {
        let db = db();
        db.insert_bridge(&bridge_row("b1", "did:plc:space"))
            .unwrap();
        db.upsert_portal(&portal_row(NewPortal {
            space_did: "did:plc:space",
            bridge_id: "b1",
            matrix_room_id: &MatrixRoomId::parse("!room:example.org").unwrap(),
            roomy_room_id: &RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: Some("General".into()),
            encrypted: false,
            now: 1,
        }))
        .unwrap();
        assert_eq!(db.portal_count().unwrap(), 1);

        assert!(db.delete_bridge("b1").unwrap());
        assert_eq!(db.portal_count().unwrap(), 0);
    }

    #[test]
    fn a_portal_upsert_updates_in_place() {
        let db = db();
        db.insert_bridge(&bridge_row("b1", "did:plc:space"))
            .unwrap();
        let mut row = portal_row(NewPortal {
            space_did: "did:plc:space",
            bridge_id: "b1",
            matrix_room_id: &MatrixRoomId::parse("!room:example.org").unwrap(),
            roomy_room_id: &RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: Some("General".into()),
            encrypted: false,
            now: 1,
        });
        db.upsert_portal(&row).unwrap();
        row.depth = 2;
        row.name = Some("Renamed".into());
        db.upsert_portal(&row).unwrap();

        let portals = db.portals_for_bridge("b1").unwrap();
        assert_eq!(portals.len(), 1);
        assert_eq!(portals[0].name.as_deref(), Some("Renamed"));
    }

    #[test]
    fn a_portal_keeps_its_state_and_reason_across_a_read() {
        let db = db();
        db.insert_bridge(&bridge_row("b1", "did:plc:space"))
            .unwrap();
        db.upsert_portal(&portal_row(NewPortal {
            space_did: "did:plc:space",
            bridge_id: "b1",
            matrix_room_id: &MatrixRoomId::parse("!room:example.org").unwrap(),
            roomy_room_id: &RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: None,
            encrypted: true,
            now: 1,
        }))
        .unwrap();

        let mut row = portal_row(NewPortal {
            space_did: "did:plc:space",
            bridge_id: "b1",
            matrix_room_id: &MatrixRoomId::parse("!room:example.org").unwrap(),
            roomy_room_id: &RoomyRoomId::parse("01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB").unwrap(),
            depth: 1,
            name: None,
            encrypted: true,
            now: 1,
        });
        row.state = "blocked".into();
        row.reason = Some("no room key".into());
        db.upsert_portal(&row).unwrap();

        let portals = db.portals_for_bridge("b1").unwrap();
        assert_eq!(portals[0].state, "blocked");
        assert_eq!(portals[0].reason.as_deref(), Some("no room key"));
        assert!(portals[0].encrypted);
    }

    #[test]
    fn mappings_survive_and_stay_unique() {
        let db = db();
        let mapping = Mapping {
            kind: MappingKind::Message,
            matrix_id: "$evt".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB".into(),
            created_at: 1,
        };
        db.put_mapping("did:plc:space", &mapping).unwrap();
        db.put_mapping("did:plc:space", &mapping).unwrap();
        let mappings = db.mappings("did:plc:space").unwrap();
        assert_eq!(mappings.len(), 1);
        assert_eq!(mappings[0].kind, MappingKind::Message);
    }

    #[test]
    fn mappings_are_scoped_to_a_space() {
        let db = db();
        let mapping = Mapping {
            kind: MappingKind::Message,
            matrix_id: "$evt".into(),
            roomy_id: "01J9ZQ9W3N7Q4Z6ZC0W4Y4T0AB".into(),
            created_at: 1,
        };
        db.put_mapping("did:plc:a", &mapping).unwrap();
        assert!(db.mappings("did:plc:b").unwrap().is_empty());
    }

    #[test]
    fn cursors_advance_monotonically_by_assignment() {
        let db = db();
        assert_eq!(db.cursor("did:plc:space", "room").unwrap(), None);
        db.set_cursor("did:plc:space", "room", 10).unwrap();
        db.set_cursor("did:plc:space", "room", 12).unwrap();
        assert_eq!(db.cursor("did:plc:space", "room").unwrap(), Some(12));
    }

    #[test]
    fn ghosts_are_found_by_did() {
        let db = db();
        db.put_ghost(&GhostWrite {
            mxid: "@_roomy_abc:matrix.local",
            did: "did:plc:alice",
            profile_hash: Some("h1"),
            updated_at: 1,
        })
        .unwrap();
        assert_eq!(
            db.ghost_for_did("did:plc:alice").unwrap(),
            Some(GhostRow {
                mxid: "@_roomy_abc:matrix.local".to_string(),
                did: "did:plc:alice".to_string(),
                profile_hash: Some("h1".to_string()),
            })
        );
    }

    #[test]
    fn a_profile_hash_is_not_erased_by_a_null_update() {
        let db = db();
        db.put_ghost(&GhostWrite {
            mxid: "@_roomy_abc:matrix.local",
            did: "did:plc:alice",
            profile_hash: Some("h1"),
            updated_at: 1,
        })
        .unwrap();
        db.put_ghost(&GhostWrite {
            mxid: "@_roomy_abc:matrix.local",
            did: "did:plc:alice",
            profile_hash: None,
            updated_at: 2,
        })
        .unwrap();
        assert_eq!(
            db.ghost_for_did("did:plc:alice")
                .unwrap()
                .unwrap()
                .profile_hash,
            Some("h1".to_string())
        );
    }

    #[test]
    fn backfill_progress_records_its_token_and_completion() {
        let db = db();
        db.set_backfill(&BackfillWrite {
            space_did: "did:plc:space",
            matrix_room_id: "!room:example.org",
            phase: "recent",
            token: Some("t1"),
            messages: 10,
            complete: false,
            updated_at: 1,
        })
        .unwrap();
        let row = db
            .backfill("did:plc:space", "!room:example.org")
            .unwrap()
            .unwrap();
        assert_eq!(row.token.as_deref(), Some("t1"));
        assert_eq!(row.messages, 10);
        assert!(!row.complete);

        db.set_backfill(&BackfillWrite {
            space_did: "did:plc:space",
            matrix_room_id: "!room:example.org",
            phase: "deep",
            token: None,
            messages: 60,
            complete: true,
            updated_at: 2,
        })
        .unwrap();
        let row = db
            .backfill("did:plc:space", "!room:example.org")
            .unwrap()
            .unwrap();
        assert!(row.complete);
        assert_eq!(row.messages, 60);
    }

    #[test]
    fn failed_sends_are_returned_when_due() {
        let db = db();
        db.put_failed_send(&FailedSendWrite {
            id: "s1",
            space_did: "did:plc:space",
            payload: "[]",
            attempts: 1,
            next_attempt_at: 100,
            last_error: Some("500"),
            created_at: 0,
        })
        .unwrap();
        assert!(db.due_failed_sends(50, 10, 10).unwrap().is_empty());
        assert_eq!(db.due_failed_sends(150, 10, 10).unwrap().len(), 1);
        assert_eq!(db.next_failed_send_at(10).unwrap(), Some(100));

        db.clear_failed_send("s1").unwrap();
        assert!(db.due_failed_sends(150, 10, 10).unwrap().is_empty());
        assert_eq!(db.next_failed_send_at(10).unwrap(), None);
    }

    #[test]
    fn a_parked_send_is_neither_due_nor_scheduled() {
        let db = db();
        db.put_failed_send(&FailedSendWrite {
            id: "s1",
            space_did: "did:plc:space",
            payload: "[]",
            attempts: 3,
            next_attempt_at: 100,
            last_error: Some("500"),
            created_at: 0,
        })
        .unwrap();
        assert!(db.due_failed_sends(1_000, 3, 10).unwrap().is_empty());
        assert_eq!(db.next_failed_send_at(3).unwrap(), None);
        assert_eq!(db.failed_send("s1").unwrap().unwrap().attempts, 3);
    }

    #[test]
    fn sends_queued_together_keep_their_insertion_order() {
        let db = db();
        for id in ["b", "a"] {
            db.put_failed_send(&FailedSendWrite {
                id,
                space_did: "did:plc:space",
                payload: "[]",
                attempts: 1,
                next_attempt_at: 100,
                last_error: None,
                created_at: 0,
            })
            .unwrap();
        }
        let ids: Vec<_> = db
            .due_failed_sends(100, 10, 10)
            .unwrap()
            .into_iter()
            .map(|row| row.id)
            .collect();
        assert_eq!(ids, vec!["b", "a"]);
    }
}

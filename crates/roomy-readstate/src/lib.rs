//! The caller-scoped state a gateway owns, behind one trait.
//!
//! Read positions, block sets, space membership and bridge-token grants are not
//! per-space data and not global materialised data: they belong to a user, and
//! the node that answers their requests holds them. [`ReadStateStore`] is the
//! whole of that surface, so a gateway depends on the trait and never on the
//! file behind it.
//!
//! [`SqliteReadStateStore`] is the implementation a single node runs. A
//! networked store (one writer per partition, read by many gateways) implements
//! the same trait; nothing above it changes.
//!
//! Two things this crate deliberately does *not* do:
//!
//!  * It never fetches from a PDS. A block set is the rows the node already
//!    indexed; refreshing a user's repos is the account's own business
//!    (`space.roomy.user.refreshBlocks`), because a PDS round-trip inside a read
//!    makes that read as slow as its slowest author's host.
//!  * It never decides access. It answers "what are this user's watermarks",
//!    not "may this user read this room".

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};

/// Where a user last read up to in one room.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadPosition {
    pub room_id: String,
    /// `sort_idx` of the last read message, or `"0"` for "read nothing".
    pub seen_up_to: String,
}

/// A thread the user has been active in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ThreadActivity {
    pub thread_id: String,
    pub last_active_at: i64,
}

/// Who a viewer must not see.
///
/// A block hides both ways: the set is the union of the blocks the user wrote
/// and the blocks naming the user in other people's repos. Every read path asks
/// only whether an author is hidden, so the direction is absorbed here.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct BlockedSet {
    hidden: BTreeSet<String>,
}

impl BlockedSet {
    /// The set from the DIDs the user blocked and the DIDs whose repos block
    /// the user.
    pub fn from_parts(
        written: impl IntoIterator<Item = String>,
        blockers: impl IntoIterator<Item = String>,
    ) -> Self {
        Self {
            hidden: written.into_iter().chain(blockers).collect(),
        }
    }

    /// Whether `did` is hidden from the user, in either direction.
    #[must_use]
    pub fn is_hidden(&self, did: &str) -> bool {
        self.hidden.contains(did)
    }

    /// Whether the user has no block in either direction.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.hidden.is_empty()
    }

    /// How many DIDs are hidden.
    #[must_use]
    pub fn len(&self) -> usize {
        self.hidden.len()
    }

    /// The hidden DIDs, for a query that must exclude their rows.
    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.hidden.iter().map(String::as_str)
    }
}

/// One `bridge_token_grants` row: a grantor who granted this space a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BridgeTokenGrant {
    pub grantor_did: String,
    pub granted_at: i64,
    pub spent_at: Option<i64>,
    pub capacity_snapshot: i64,
}

impl BridgeTokenGrant {
    /// Whether the grant's token has already been exchanged.
    #[must_use]
    pub fn spent(&self) -> bool {
        self.spent_at.is_some()
    }
}

/// A space the user belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpaceMembership {
    pub space_did: String,
    /// The user's `space_order.position` for this space, when they have one.
    pub position: Option<i64>,
}

#[derive(Debug, thiserror::Error)]
pub enum ReadStateError {
    #[error("read-state database error: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("read-state database lock poisoned")]
    Poisoned,
}

/// Everything a gateway reads or writes about one caller.
///
/// Read methods return an empty answer rather than an error when the user has
/// no rows: "no watermark" and "no membership" are ordinary states, not
/// failures.
pub trait ReadStateStore: Send + Sync {
    fn read_positions(&self, user_did: &str) -> Result<Vec<ReadPosition>, ReadStateError>;

    fn thread_activity(&self, user_did: &str) -> Result<Vec<ThreadActivity>, ReadStateError>;

    /// The union of the user's own blocks and the blocks naming them.
    fn blocked(&self, user_did: &str) -> Result<BlockedSet, ReadStateError>;

    /// Grants a space has received, oldest first.
    fn bridge_tokens(&self, space_did: &str) -> Result<Vec<BridgeTokenGrant>, ReadStateError>;

    /// The spaces the user belongs to, in their sidebar order when they have
    /// one.
    fn space_memberships(&self, user_did: &str) -> Result<Vec<SpaceMembership>, ReadStateError>;

    /// Record where a user read up to in a room.
    fn set_read_position(
        &self,
        user_did: &str,
        space_did: &str,
        room_id: &str,
        seen_up_to: &str,
        updated_at: i64,
    ) -> Result<(), ReadStateError>;

    /// Record that a user was active in a thread.
    fn mark_thread_active(
        &self,
        user_did: &str,
        space_did: &str,
        thread_id: &str,
        last_active_at: i64,
        updated_at: i64,
    ) -> Result<(), ReadStateError>;

    /// Forget a user's pending push digest for a room, so the next burst starts
    /// a fresh batch. A pair with no row is not an error.
    fn reset_notification_state(&self, user_did: &str, room_id: &str)
        -> Result<(), ReadStateError>;
}

/// No read state on this node: every caller has no watermarks, no blocks and no
/// memberships.
#[derive(Debug, Default)]
pub struct NoReadState;

impl ReadStateStore for NoReadState {
    fn read_positions(&self, _user_did: &str) -> Result<Vec<ReadPosition>, ReadStateError> {
        Ok(Vec::new())
    }

    fn thread_activity(&self, _user_did: &str) -> Result<Vec<ThreadActivity>, ReadStateError> {
        Ok(Vec::new())
    }

    fn blocked(&self, _user_did: &str) -> Result<BlockedSet, ReadStateError> {
        Ok(BlockedSet::default())
    }

    fn bridge_tokens(&self, _space_did: &str) -> Result<Vec<BridgeTokenGrant>, ReadStateError> {
        Ok(Vec::new())
    }

    fn space_memberships(&self, _user_did: &str) -> Result<Vec<SpaceMembership>, ReadStateError> {
        Ok(Vec::new())
    }

    fn set_read_position(
        &self,
        _user_did: &str,
        _space_did: &str,
        _room_id: &str,
        _seen_up_to: &str,
        _updated_at: i64,
    ) -> Result<(), ReadStateError> {
        Ok(())
    }

    fn mark_thread_active(
        &self,
        _user_did: &str,
        _space_did: &str,
        _thread_id: &str,
        _last_active_at: i64,
        _updated_at: i64,
    ) -> Result<(), ReadStateError> {
        Ok(())
    }

    fn reset_notification_state(
        &self,
        _user_did: &str,
        _room_id: &str,
    ) -> Result<(), ReadStateError> {
        Ok(())
    }
}

/// A read-write handle on a node's `roomy-readstate.sqlite`.
pub struct SqliteReadStateStore {
    conn: Mutex<Connection>,
}

impl SqliteReadStateStore {
    /// Open the read-state database for reading and writing.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ReadStateError> {
        let conn = Connection::open_with_flags(
            path,
            // The database outlives the process and is shared with the
            // TypeScript appserver during the migration; a reader that must
            // retry a lock beats a failed request.
            OpenFlags::SQLITE_OPEN_READ_WRITE
                | OpenFlags::SQLITE_OPEN_CREATE
                | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_millis(2000))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open a read-state database for reading only: a replica, or a file a test
    /// already built.
    pub fn open_read_only(path: impl AsRef<Path>) -> Result<Self, ReadStateError> {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        conn.busy_timeout(Duration::from_millis(2000))?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Wrap a connection the caller already opened, for tests and for a node
    /// that owns one handle per store.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    /// The tables this crate reads. Applying them to a fresh file makes a store
    /// usable without the TypeScript appserver's migration runner.
    pub fn apply_schema(&self) -> Result<(), ReadStateError> {
        let conn = self.conn.lock().map_err(|_| ReadStateError::Poisoned)?;
        conn.execute_batch(SCHEMA)?;
        Ok(())
    }

    fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
    ) -> Result<T, ReadStateError> {
        let conn = self.conn.lock().map_err(|_| ReadStateError::Poisoned)?;
        f(&conn).map_err(ReadStateError::Sqlite)
    }
}

impl ReadStateStore for SqliteReadStateStore {
    fn read_positions(&self, user_did: &str) -> Result<Vec<ReadPosition>, ReadStateError> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "select room_id, seen_up_to
                   from read_positions
                  where user_did = ?
                  order by room_id",
            )?;
            let rows = statement.query_map([user_did], |row| {
                Ok(ReadPosition {
                    room_id: row.get(0)?,
                    seen_up_to: row.get(1)?,
                })
            })?;
            rows.collect()
        })
    }

    fn thread_activity(&self, user_did: &str) -> Result<Vec<ThreadActivity>, ReadStateError> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "select thread_id, last_active_at
                   from user_thread_activity
                  where user_did = ?
                  order by thread_id",
            )?;
            let rows = statement.query_map([user_did], |row| {
                Ok(ThreadActivity {
                    thread_id: row.get(0)?,
                    last_active_at: row.get(1)?,
                })
            })?;
            rows.collect()
        })
    }

    fn blocked(&self, user_did: &str) -> Result<BlockedSet, ReadStateError> {
        self.with(|conn| {
            // One table, two directions: the rows this user wrote name who they
            // hide, and the rows naming this user are their hidden-by set.
            let mut statement = conn.prepare(
                "select blocked_did from user_blocks where user_did = ?
                 union
                 select user_did from user_blocks where blocked_did = ?",
            )?;
            let rows = statement.query_map([user_did, user_did], |row| row.get::<_, String>(0))?;
            let mut hidden = BTreeSet::new();
            for did in rows {
                hidden.insert(did?);
            }
            Ok(BlockedSet { hidden })
        })
    }

    fn bridge_tokens(&self, space_did: &str) -> Result<Vec<BridgeTokenGrant>, ReadStateError> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "select grantor_did, granted_at, spent_at, capacity_snapshot
                   from bridge_token_grants
                  where space_did = ?
                  order by granted_at asc",
            )?;
            let rows = statement.query_map([space_did], |row| {
                Ok(BridgeTokenGrant {
                    grantor_did: row.get(0)?,
                    granted_at: row.get(1)?,
                    spent_at: row.get(2)?,
                    capacity_snapshot: row.get(3)?,
                })
            })?;
            rows.collect()
        })
    }

    fn space_memberships(&self, user_did: &str) -> Result<Vec<SpaceMembership>, ReadStateError> {
        self.with(|conn| {
            let mut statement = conn.prepare(
                "select m.space_did, o.position
                   from user_space_membership m
                   left join space_order o
                          on o.user_did = m.user_did and o.space_did = m.space_did
                  where m.user_did = ?
                  order by m.space_did",
            )?;
            let rows = statement.query_map([user_did], |row| {
                Ok(SpaceMembership {
                    space_did: row.get(0)?,
                    position: row.get(1)?,
                })
            })?;
            rows.collect()
        })
    }

    fn set_read_position(
        &self,
        user_did: &str,
        space_did: &str,
        room_id: &str,
        seen_up_to: &str,
        updated_at: i64,
    ) -> Result<(), ReadStateError> {
        self.with(|conn| {
            conn.execute(
                "insert into read_positions (user_did, room_id, space_did, seen_up_to, updated_at)
                 values (?, ?, ?, ?, ?)
                 on conflict (user_did, room_id) do update
                    set space_did = excluded.space_did,
                        seen_up_to = excluded.seen_up_to,
                        updated_at = excluded.updated_at",
                (user_did, room_id, space_did, seen_up_to, updated_at),
            )
        })?;
        Ok(())
    }

    fn mark_thread_active(
        &self,
        user_did: &str,
        space_did: &str,
        thread_id: &str,
        last_active_at: i64,
        updated_at: i64,
    ) -> Result<(), ReadStateError> {
        self.with(|conn| {
            conn.execute(
                "insert into user_thread_activity
                   (user_did, thread_id, space_did, last_active_at, updated_at)
                 values (?, ?, ?, ?, ?)
                 on conflict (user_did, thread_id) do update
                    set space_did = excluded.space_did,
                        last_active_at = excluded.last_active_at,
                        updated_at = excluded.updated_at",
                (user_did, thread_id, space_did, last_active_at, updated_at),
            )
        })?;
        Ok(())
    }

    fn reset_notification_state(
        &self,
        user_did: &str,
        room_id: &str,
    ) -> Result<(), ReadStateError> {
        self.with(|conn| {
            conn.execute(
                "delete from notification_state where user_did = ? and room_id = ?",
                (user_did, room_id),
            )
        })?;
        Ok(())
    }
}

/// The columns this crate reads, spelled the way `readStateSchema.sql` spells
/// them. Only the tables with a reader or writer here are listed, so a fresh
/// database holds nothing this crate cannot answer from.
const SCHEMA: &str = "\
create table if not exists user_space_membership (
  user_did  text not null,
  space_did text not null,
  primary key (user_did, space_did)
) strict;

create table if not exists space_order (
  user_did  text not null,
  space_did text not null,
  position  integer not null,
  primary key (user_did, space_did)
) strict;

create table if not exists read_positions (
  user_did    text not null,
  room_id     text not null,
  space_did   text not null default '',
  seen_up_to  text not null,
  updated_at  integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;

create table if not exists user_thread_activity (
  user_did       text not null,
  thread_id      text not null,
  space_did      text not null,
  last_active_at integer not null,
  updated_at     integer not null default (unixepoch() * 1000),
  primary key (user_did, thread_id)
) strict;

create table if not exists bridge_token_grants (
  grantor_did       text primary key,
  space_did         text not null,
  granted_at        integer not null default (unixepoch() * 1000),
  spent_at          integer,
  capacity_snapshot integer not null
) strict;

create table if not exists notification_state (
  user_did            text not null,
  room_id             text not null,
  first_unseen_at     integer,
  first_unseen_msg_id text,
  unseen_count        integer not null default 0,
  notified            integer not null default 0 check (notified in (0, 1)),
  pushed_at           integer,
  updated_at          integer not null default (unixepoch() * 1000),
  primary key (user_did, room_id)
) strict;

create table if not exists user_blocks (
  user_did    text not null,
  blocked_did text not null,
  source      text not null check(source in ('roomy', 'bluesky')),
  created_at  integer,
  fetched_at  integer not null default (unixepoch() * 1000),
  primary key (user_did, blocked_did)
) strict;
create index if not exists idx_user_blocks_blocked on user_blocks(blocked_did);
";

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> SqliteReadStateStore {
        let store = SqliteReadStateStore::from_connection(Connection::open_in_memory().unwrap());
        store.apply_schema().unwrap();
        store
    }

    #[test]
    fn read_positions_round_trip() {
        let store = store();
        assert!(store.read_positions("did:plc:a").unwrap().is_empty());
        store
            .set_read_position("did:plc:a", "did:web:s", "r1", "01HK", 5)
            .unwrap();
        store
            .set_read_position("did:plc:a", "did:web:s", "r1", "01HM", 6)
            .unwrap();
        assert_eq!(
            store.read_positions("did:plc:a").unwrap(),
            vec![ReadPosition {
                room_id: "r1".to_string(),
                seen_up_to: "01HM".to_string(),
            }]
        );
    }

    #[test]
    fn thread_activity_round_trip() {
        let store = store();
        store
            .mark_thread_active("did:plc:a", "did:web:s", "t1", 100, 200)
            .unwrap();
        assert_eq!(
            store.thread_activity("did:plc:a").unwrap(),
            vec![ThreadActivity {
                thread_id: "t1".to_string(),
                last_active_at: 100,
            }]
        );
    }

    #[test]
    fn a_block_hides_both_ways() {
        let store = store();
        store
            .with(|conn| {
                conn.execute(
                    "insert into user_blocks (user_did, blocked_did, source) values (?, ?, 'roomy')",
                    ("did:plc:viewer", "did:plc:them"),
                )
            })
            .unwrap();
        // What the viewer wrote hides that author from them.
        let viewer = store.blocked("did:plc:viewer").unwrap();
        assert!(viewer.is_hidden("did:plc:them"));
        // The same row hides the viewer from that author.
        let them = store.blocked("did:plc:them").unwrap();
        assert!(them.is_hidden("did:plc:viewer"));
        // A third party sees nothing.
        assert!(store.blocked("did:plc:other").unwrap().is_empty());
    }

    #[test]
    fn bridge_grants_are_oldest_first() {
        let store = store();
        store
            .with(|conn| {
                conn.execute(
                    "insert into bridge_token_grants
                       (grantor_did, space_did, granted_at, spent_at, capacity_snapshot)
                     values ('did:plc:b', 'did:web:s', 20, 30, 5),
                            ('did:plc:a', 'did:web:s', 10, null, 3),
                            ('did:plc:c', 'did:web:other', 5, null, 1)",
                    [],
                )
            })
            .unwrap();
        let grants = store.bridge_tokens("did:web:s").unwrap();
        assert_eq!(
            grants
                .iter()
                .map(|grant| (grant.grantor_did.as_str(), grant.spent()))
                .collect::<Vec<_>>(),
            vec![("did:plc:a", false), ("did:plc:b", true)]
        );
    }

    #[test]
    fn memberships_carry_the_sidebar_position() {
        let store = store();
        store
            .with(|conn| {
                conn.execute(
                    "insert into user_space_membership (user_did, space_did) values
                       ('did:plc:a', 'did:web:one'), ('did:plc:a', 'did:web:two')",
                    [],
                )?;
                conn.execute(
                    "insert into space_order (user_did, space_did, position)
                     values ('did:plc:a', 'did:web:two', 1)",
                    [],
                )
            })
            .unwrap();
        assert_eq!(
            store.space_memberships("did:plc:a").unwrap(),
            vec![
                SpaceMembership {
                    space_did: "did:web:one".to_string(),
                    position: None,
                },
                SpaceMembership {
                    space_did: "did:web:two".to_string(),
                    position: Some(1),
                },
            ]
        );
    }

    #[test]
    fn resetting_a_digest_forgets_only_that_pair() {
        let store = store();
        store
            .with(|conn| {
                conn.execute(
                    "insert into notification_state (user_did, room_id, unseen_count) values
                       ('did:plc:a', 'r1', 3), ('did:plc:a', 'r2', 1), ('did:plc:b', 'r1', 2)",
                    [],
                )
            })
            .unwrap();
        store.reset_notification_state("did:plc:a", "r1").unwrap();
        let remaining: Vec<(String, String)> = store
            .with(|conn| {
                let mut statement = conn.prepare(
                    "select user_did, room_id from notification_state
                     order by user_did, room_id",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                rows.collect::<rusqlite::Result<Vec<_>>>()
            })
            .unwrap();
        assert_eq!(
            remaining,
            vec![
                ("did:plc:a".to_string(), "r2".to_string()),
                ("did:plc:b".to_string(), "r1".to_string()),
            ]
        );
        // Re-arming an already-reset pair is not an error.
        store.reset_notification_state("did:plc:a", "r1").unwrap();
    }

    #[test]
    fn no_read_state_answers_empty() {
        let store = NoReadState;
        assert!(store.read_positions("did:plc:a").unwrap().is_empty());
        assert!(store.blocked("did:plc:a").unwrap().is_empty());
        assert!(store.bridge_tokens("did:web:s").unwrap().is_empty());
        assert!(store.space_memberships("did:plc:a").unwrap().is_empty());
    }

    #[test]
    fn missing_tables_are_an_error_not_a_silent_empty() {
        // A database that was never migrated must fail loudly: an empty answer
        // would read as "this user has no blocks", which is a wrong answer.
        let store = SqliteReadStateStore::from_connection(Connection::open_in_memory().unwrap());
        assert!(matches!(
            store.read_positions("did:plc:a"),
            Err(ReadStateError::Sqlite(_))
        ));
    }
}

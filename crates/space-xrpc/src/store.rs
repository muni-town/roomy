//! Reads of the space-agnostic stores the gateway owns.
//!
//! A per-space worker's own database holds no user profiles, link-card
//! enrichments or DNS space handles — those live in the gateway's global store.
//! A worker replica may hold a read replica of that store; when it does not
//! (`NoGlobalStores`), reads fall back to the per-space rows, exactly as the
//! appserver does for a process whose global DB is unavailable.
//!
//! This is a read-only capability: nothing here writes.

use std::sync::Mutex;

use rusqlite::{Connection, OptionalExtension};

/// A user's profile fields, as the global `profiles` row carries them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProfileFields {
    pub name: Option<String>,
    pub handle: Option<String>,
    pub avatar: Option<String>,
}

impl ProfileFields {
    /// `profileStore.ts:entryToFields` — a row with no usable field is a miss,
    /// and an empty handle is not a handle.
    pub fn is_resolved(&self) -> bool {
        self.name.is_some() || self.handle.is_some() || self.avatar.is_some()
    }
}

/// Which side of a federation a space is on.
///
/// A federation is one row keyed by `(space_id, federating_space_did)`: the
/// origin is the space whose content is shared, the receiving space is the one
/// that gains access. The same row answers both spaces' questions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FederationView<'a> {
    /// Rows where this space is the origin (`space_id`).
    Origin(&'a str),
    /// Rows where this space is the receiver (`federating_space_did`).
    Receiver(&'a str),
}

/// The order a federation list is returned in. The registry's own ordering, so
/// a list that ties on `requested_at` reads the same in both implementations.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FederationOrder {
    RequestedAtAscending,
    RequestedAtDescending,
}

/// One federation row: the origin, the receiver, and where the request stands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederationRecord {
    pub space_id: String,
    pub federating_space_did: String,
    /// `pending` | `active` | `rejected` | `removed`.
    pub status: String,
    pub requested_by_did: String,
    pub requested_at: i64,
    pub message: Option<String>,
    pub decided_by_did: Option<String>,
    pub decided_at: Option<i64>,
    pub decision_message: Option<String>,
}

/// An origin's grant: the access a receiving space was given on one channel of
/// the origin.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederationRoomPermission {
    pub federating_space_did: String,
    pub room_id: String,
    /// `read` | `readwrite`.
    pub permission: String,
}

/// A receiver's grant: what one grantee (every member, a user, or a role) was
/// given on a federated channel, inside the ceiling the origin set.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FederationReceiverPermission {
    pub space_id: String,
    pub room_id: String,
    pub grantee: String,
    /// `members` | `user` | `role`.
    pub kind: String,
    pub permission: String,
}

/// The space-agnostic stores the gateway owns, read-only.
///
/// Every read is a lookup that may miss: a worker without a replica answers
/// every miss, and the per-space fallback is the caller's business.
pub trait GlobalStores: Send + Sync {
    /// `profiles` row for `did`, or `None` when absent/unusable.
    fn profile(&self, did: &str) -> Option<ProfileFields>;
    /// Raw `link_embeds.embed_json` for `url`, or `None` when absent.
    fn link_embed_json(&self, url: &str) -> Option<String>;
    /// `space_handles.handle` for a space DID.
    fn space_handle(&self, space_did: &str) -> Option<String>;

    /// The federation rows one side of a space sees, optionally narrowed to a
    /// status.
    fn federations(
        &self,
        view: FederationView<'_>,
        status: Option<&str>,
        order: FederationOrder,
    ) -> Vec<FederationRecord>;

    /// The channel grants an origin has made, for the federations that are
    /// active. Ordered by receiving space, then room.
    fn federation_origin_grants(&self, space_id: &str) -> Vec<FederationRoomPermission>;

    /// The channel grants a receiving space's admins have made, for the
    /// federations that are active. Ordered by origin space, room, kind, then
    /// grantee.
    fn federation_receiver_grants(&self, space_id: &str) -> Vec<FederationReceiverPermission>;
}

/// No global store on this worker: every lookup misses.
#[derive(Debug, Default)]
pub struct NoGlobalStores;

impl GlobalStores for NoGlobalStores {
    fn profile(&self, _did: &str) -> Option<ProfileFields> {
        None
    }

    fn link_embed_json(&self, _url: &str) -> Option<String> {
        None
    }

    fn space_handle(&self, _space_did: &str) -> Option<String> {
        None
    }

    fn federations(
        &self,
        _view: FederationView<'_>,
        _status: Option<&str>,
        _order: FederationOrder,
    ) -> Vec<FederationRecord> {
        Vec::new()
    }

    fn federation_origin_grants(&self, _space_id: &str) -> Vec<FederationRoomPermission> {
        Vec::new()
    }

    fn federation_receiver_grants(&self, _space_id: &str) -> Vec<FederationReceiverPermission> {
        Vec::new()
    }
}

/// A read-only handle on a replica of the gateway's `global.sqlite`.
pub struct SqliteGlobalStores {
    conn: Mutex<Connection>,
}

impl SqliteGlobalStores {
    /// Open `path` read-only.
    pub fn open(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }
}

impl GlobalStores for SqliteGlobalStores {
    fn profile(&self, did: &str) -> Option<ProfileFields> {
        let conn = self.conn.lock().ok()?;
        let row = conn
            .query_row(
                "select handle, name, avatar from profiles where did = ?",
                [did],
                |row| {
                    Ok(ProfileFields {
                        name: row.get::<_, Option<String>>(1)?,
                        handle: row.get::<_, Option<String>>(0)?,
                        avatar: row.get::<_, Option<String>>(2)?,
                    })
                },
            )
            .optional()
            .ok()??;
        let fields = ProfileFields {
            name: row.name,
            // `''` is not a handle.
            handle: row.handle.filter(|h| !h.is_empty()),
            avatar: row.avatar,
        };
        fields.is_resolved().then_some(fields)
    }

    fn link_embed_json(&self, url: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "select embed_json from link_embeds where url = ?",
            [url],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .ok()?
        .flatten()
    }

    fn space_handle(&self, space_did: &str) -> Option<String> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "select handle from space_handles where space_did = ?",
            [space_did],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()?
    }

    fn federations(
        &self,
        view: FederationView<'_>,
        status: Option<&str>,
        order: FederationOrder,
    ) -> Vec<FederationRecord> {
        let Ok(conn) = self.conn.lock() else {
            return Vec::new();
        };
        let (column, space_id) = match view {
            FederationView::Origin(space_id) => ("space_id", space_id),
            FederationView::Receiver(space_id) => ("federating_space_did", space_id),
        };
        let direction = match order {
            FederationOrder::RequestedAtAscending => "asc",
            FederationOrder::RequestedAtDescending => "desc",
        };
        // Status is a bound parameter rather than interpolated text, and the
        // column name is one of two literals chosen above, never user input.
        let sql = format!(
            "select space_id, federating_space_did, status, requested_by_did,
                    requested_at, message, decided_by_did, decided_at, decision_message
               from space_federations
              where {column} = ?
                and (? is null or status = ?)
              order by requested_at {direction}"
        );
        let mut statement = match conn.prepare(&sql) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = statement.query_map((space_id, status, status), |row| {
            Ok(FederationRecord {
                space_id: row.get(0)?,
                federating_space_did: row.get(1)?,
                status: row.get(2)?,
                requested_by_did: row.get(3)?,
                requested_at: row.get(4)?,
                message: row.get(5)?,
                decided_by_did: row.get(6)?,
                decided_at: row.get(7)?,
                decision_message: row.get(8)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn federation_origin_grants(&self, space_id: &str) -> Vec<FederationRoomPermission> {
        let Ok(conn) = self.conn.lock() else {
            return Vec::new();
        };
        let mut statement = match conn.prepare(
            "select frp.federating_space_did, frp.room_id, frp.permission
               from federation_room_permissions frp
               join space_federations sf
                 on sf.space_id = frp.space_id
                and sf.federating_space_did = frp.federating_space_did
              where frp.space_id = ?
                and sf.status = 'active'
              order by frp.federating_space_did, frp.room_id",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = statement.query_map([space_id], |row| {
            Ok(FederationRoomPermission {
                federating_space_did: row.get(0)?,
                room_id: row.get(1)?,
                permission: row.get(2)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }

    fn federation_receiver_grants(&self, space_id: &str) -> Vec<FederationReceiverPermission> {
        let Ok(conn) = self.conn.lock() else {
            return Vec::new();
        };
        let mut statement = match conn.prepare(
            "select frp.space_id, frp.room_id, frp.grantee, frp.kind, frp.permission
               from federation_receiver_permissions frp
               join space_federations sf
                 on sf.space_id = frp.space_id
                and sf.federating_space_did = frp.federating_space_did
              where frp.federating_space_did = ?
                and sf.status = 'active'
              order by frp.space_id, frp.room_id, frp.kind, frp.grantee",
        ) {
            Ok(statement) => statement,
            Err(_) => return Vec::new(),
        };
        let rows = statement.query_map([space_id], |row| {
            Ok(FederationReceiverPermission {
                space_id: row.get(0)?,
                room_id: row.get(1)?,
                grantee: row.get(2)?,
                kind: row.get(3)?,
                permission: row.get(4)?,
            })
        });
        match rows {
            Ok(rows) => rows.filter_map(Result::ok).collect(),
            Err(_) => Vec::new(),
        }
    }
}

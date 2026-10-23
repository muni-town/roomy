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

pub trait GlobalStores: Send + Sync {
    /// `profiles` row for `did`, or `None` when absent/unusable.
    fn profile(&self, did: &str) -> Option<ProfileFields>;
    /// Raw `link_embeds.embed_json` for `url`, or `None` when absent.
    fn link_embed_json(&self, url: &str) -> Option<String>;
    /// `space_handles.handle` for a space DID.
    fn space_handle(&self, space_did: &str) -> Option<String>;
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
}

/// A read-only handle on a replica of the gateway's `global.sqlite`.
pub struct SqliteGlobalStores {
    conn: Mutex<Connection>,
}

impl SqliteGlobalStores {
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
}

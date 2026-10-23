//! Server state: one per-space database, a caller verifier, and the optional
//! global-store replica.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::store::{GlobalStores, NoGlobalStores};
use crate::verify::CallerVerifier;

/// A per-space SQLite database, opened read-only.
///
/// The worker serves reads only: materialisation is another component's job.
/// `Mutex<Connection>` because SQLite connections are not `Sync`; the queries
/// are short index reads.
pub struct SpaceDb {
    conn: Mutex<Connection>,
}

impl SpaceDb {
    pub fn open_readonly(path: &str) -> rusqlite::Result<Self> {
        let conn = Connection::open_with_flags(
            path,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Open an in-memory database for tests: the caller has already built the
    /// schema on it.
    pub fn from_connection(conn: Connection) -> Self {
        Self {
            conn: Mutex::new(conn),
        }
    }

    pub fn with<T>(
        &self,
        f: impl FnOnce(&Connection) -> Result<T, crate::error::XrpcError>,
    ) -> Result<T, crate::error::XrpcError> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| crate::error::XrpcError::internal("database lock poisoned"))?;
        f(&conn)
    }
}

#[derive(Clone)]
pub struct XrpcState {
    pub db: Arc<SpaceDb>,
    pub stores: Arc<dyn GlobalStores>,
    pub verifier: Arc<dyn CallerVerifier>,
}

impl XrpcState {
    pub fn new(db: Arc<SpaceDb>, verifier: Arc<dyn CallerVerifier>) -> Self {
        Self {
            db,
            stores: Arc::new(NoGlobalStores),
            verifier,
        }
    }

    pub fn with_stores(mut self, stores: Arc<dyn GlobalStores>) -> Self {
        self.stores = stores;
        self
    }
}

impl std::fmt::Debug for XrpcState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("XrpcState").finish_non_exhaustive()
    }
}

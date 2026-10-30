//! Resolving a request to the space database that answers it.
//!
//! One process serves many spaces. `spaceId` names one directly; the read
//! NSIDs that take a `roomId` or `messageId` name an entity, and the gateway's
//! global `entity_space` index is what turns that into a space.
//!
//! The registry keeps a bounded set of open databases — an LRU over the spaces
//! that have been read — so a process serving thousands of spaces holds handles
//! for the busy ones only. Each open space is a small pool of read-only
//! connections: reads then do not queue behind each other, and none of them is
//! the writer's connection.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::state::SpaceReadDb;

/// Where a request's space database comes from.
pub trait SpaceResolver: Send + Sync {
    /// The database for `space_id`, or `None` when this process does not serve
    /// it.
    fn resolve_space(&self, space_id: &str) -> Option<Arc<SpaceReadDb>>;

    /// The database holding `entity_id`, resolved through the entity→space
    /// index.
    fn resolve_entity(&self, entity_id: &str) -> Option<Arc<SpaceReadDb>>;

    /// The space that holds `entity_id`. A router that has to make a routing
    /// decision before it can open anything asks this first.
    fn space_of_entity(&self, entity_id: &str) -> Option<String>;
}

/// A bounded registry over a directory of per-space databases.
pub struct SpaceRegistry {
    spaces_dir: PathBuf,
    /// The global store's `entity_space` index, for entity→space resolution.
    index: Option<PathBuf>,
    max_open: usize,
    pool_size: usize,
    open: Mutex<Open>,
}

/// The open set, in least-recently-used order.
#[derive(Default)]
struct Open {
    /// `spaces_dir`-relative id → handle, oldest first.
    order: Vec<String>,
    by_id: HashMap<String, Arc<SpaceReadDb>>,
}

impl SpaceRegistry {
    /// A registry over `<spaces_dir>/<spaceDid>.sqlite`, using `index` for the
    /// entity→space lookup.
    pub fn new(spaces_dir: impl Into<PathBuf>, index: Option<PathBuf>, max_open: usize) -> Self {
        Self {
            spaces_dir: spaces_dir.into(),
            index,
            max_open: max_open.max(1),
            pool_size: 4,
            open: Mutex::new(Open::default()),
        }
    }

    /// How many read connections an open space keeps.
    pub fn with_pool_size(mut self, pool_size: usize) -> Self {
        self.pool_size = pool_size.max(1);
        self
    }

    /// The file a space's database lives in.
    pub fn path_of(&self, space_id: &str) -> PathBuf {
        self.spaces_dir.join(format!("{space_id}.sqlite"))
    }

    fn touch(&self, space_id: &str) -> Option<Arc<SpaceReadDb>> {
        let mut open = self.open.lock().ok()?;
        if let Some(db) = open.by_id.get(space_id).cloned() {
            // Move it to the back: most recently used.
            open.order.retain(|id| id != space_id);
            open.order.push(space_id.to_string());
            return Some(db);
        }
        let path = self.path_of(space_id);
        if !path.is_file() {
            return None;
        }
        let db = Arc::new(SpaceReadDb::open_pooled(&path, self.pool_size).ok()?);
        while open.by_id.len() >= self.max_open {
            let Some(evicted) = open.order.first().cloned() else {
                break;
            };
            open.order.remove(0);
            open.by_id.remove(&evicted);
        }
        open.order.push(space_id.to_string());
        open.by_id.insert(space_id.to_string(), Arc::clone(&db));
        Some(db)
    }

    fn space_of_entity(&self, entity_id: &str) -> Option<String> {
        let index = self.index.as_ref()?;
        let conn = rusqlite::Connection::open_with_flags(
            index,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()?;
        conn.query_row(
            "select space_did from entity_space where entity_id = ?",
            [entity_id],
            |row| row.get::<_, String>(0),
        )
        .ok()
    }

    /// The spaces currently open, least recently used first.
    pub fn open_spaces(&self) -> Vec<String> {
        self.open
            .lock()
            .map(|open| open.order.clone())
            .unwrap_or_default()
    }

    /// Drop every open handle (a supervisor unload).
    pub fn close_all(&self) {
        if let Ok(mut open) = self.open.lock() {
            open.order.clear();
            open.by_id.clear();
        }
    }
}

impl SpaceResolver for SpaceRegistry {
    fn resolve_space(&self, space_id: &str) -> Option<Arc<SpaceReadDb>> {
        self.touch(space_id)
    }

    fn resolve_entity(&self, entity_id: &str) -> Option<Arc<SpaceReadDb>> {
        let space = SpaceRegistry::space_of_entity(self, entity_id)?;
        self.touch(&space)
    }

    fn space_of_entity(&self, entity_id: &str) -> Option<String> {
        SpaceRegistry::space_of_entity(self, entity_id)
    }
}

/// A resolver over a fixed set of handles, for a test or a single-space worker.
pub struct FixedSpaces {
    spaces: HashMap<String, Arc<SpaceReadDb>>,
    entities: HashMap<String, String>,
}

impl FixedSpaces {
    /// A resolver over `spaces`, keyed by space DID.
    pub fn new(spaces: impl IntoIterator<Item = (String, Arc<SpaceReadDb>)>) -> Self {
        Self {
            spaces: spaces.into_iter().collect(),
            entities: HashMap::new(),
        }
    }

    /// Make `entity_id` resolve to `space_id`.
    pub fn with_entity(
        mut self,
        entity_id: impl Into<String>,
        space_id: impl Into<String>,
    ) -> Self {
        self.entities.insert(entity_id.into(), space_id.into());
        self
    }
}

impl SpaceResolver for FixedSpaces {
    fn resolve_space(&self, space_id: &str) -> Option<Arc<SpaceReadDb>> {
        self.spaces.get(space_id).cloned()
    }

    fn resolve_entity(&self, entity_id: &str) -> Option<Arc<SpaceReadDb>> {
        let space = self.entities.get(entity_id)?;
        self.spaces.get(space).cloned()
    }

    fn space_of_entity(&self, entity_id: &str) -> Option<String> {
        self.entities.get(entity_id).cloned()
    }
}

/// The space a path names, for a caller that has a database and no registry.
#[must_use]
pub fn space_of_path(path: &Path) -> String {
    path.file_stem()
        .map(|stem| stem.to_string_lossy().into_owned())
        .unwrap_or_default()
}

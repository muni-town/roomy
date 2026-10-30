//! Per-space read authorisation, ported from `src/auth/access.ts`.
//!
//! The decisions are pure reads of the per-space database: membership and admin
//! edges, bans, the room's effective `default_access` (threads inherit the more
//! restrictive value from their canonical parent channel), role grants, and the
//! public-join gate.
//!
//! Federation grants live in the gateway's global store and other spaces' DBs,
//! so the worker has no federation fallback: a caller with native access gets
//! the same decision as the appserver, and one relying on a federated grant is
//! denied here. The gateway resolves federation before routing.

use rusqlite::{Connection, OptionalExtension};

use crate::error::XrpcError;

/// The access a room grants by default, before role grants are considered.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DefaultAccess {
    ReadWrite,
    Read,
    None,
}

impl DefaultAccess {
    /// The wire spelling: `readwrite`, `read` or `none`.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            DefaultAccess::ReadWrite => "readwrite",
            DefaultAccess::Read => "read",
            DefaultAccess::None => "none",
        }
    }

    fn normalize(raw: Option<&str>) -> Self {
        match raw {
            Some("read") => DefaultAccess::Read,
            Some("none") => DefaultAccess::None,
            Some("readwrite") => DefaultAccess::ReadWrite,
            _ => DefaultAccess::ReadWrite,
        }
    }

    fn min(self, other: Self) -> Self {
        fn level(a: DefaultAccess) -> u8 {
            match a {
                DefaultAccess::None => 0,
                DefaultAccess::Read => 1,
                DefaultAccess::ReadWrite => 2,
            }
        }
        if level(self) <= level(other) {
            self
        } else {
            other
        }
    }
}

/// The caller's standing in a space.
#[derive(Debug, Clone, Copy, Default)]
pub struct SpaceAccess {
    /// The caller holds a `member` edge from the space.
    pub is_member: bool,
    /// The caller holds an `admin` edge from the space.
    pub is_admin: bool,
    /// The caller is banned from the space.
    pub is_banned: bool,
}

/// The caller's effective access to one room, and what resolving it found.
#[derive(Debug, Clone)]
pub struct RoomAccess {
    /// The room exists as an entity.
    pub exists: bool,
    /// The caller may read the room.
    pub can_read: bool,
    /// The caller may write to the room.
    pub can_write: bool,
    /// The caller administers the owning space.
    pub is_admin: bool,
    /// The access the room grants by default.
    pub default_access: DefaultAccess,
    /// The space that owns the room, absent when the room is not an entity.
    pub space_id: Option<String>,
    /// The canonical parent channel, when the room is a thread.
    pub parent_channel_id: Option<String>,
    /// The caller is banned from the owning space.
    pub is_banned: bool,
}

impl RoomAccess {
    fn missing() -> Self {
        Self {
            exists: false,
            can_read: false,
            can_write: false,
            is_admin: false,
            default_access: DefaultAccess::ReadWrite,
            space_id: None,
            parent_channel_id: None,
            is_banned: false,
        }
    }
}

fn has_edge(conn: &Connection, head: &str, tail: &str, label: &str) -> rusqlite::Result<bool> {
    conn.query_row(
        "select 1 from edges where head = ? and tail = ? and label = ? limit 1",
        (head, tail, label),
        |_| Ok(()),
    )
    .optional()
    .map(|r| r.is_some())
}

/// The caller's standing in `space_id`. An absent caller holds nothing.
pub fn space_access(
    conn: &Connection,
    space_id: &str,
    did: Option<&str>,
) -> rusqlite::Result<SpaceAccess> {
    let Some(did) = did else {
        return Ok(SpaceAccess::default());
    };
    let is_banned = conn
        .query_row(
            "select 1 from comp_bans where entity = ? and user_did = ? limit 1",
            (space_id, did),
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(SpaceAccess {
        is_member: has_edge(conn, space_id, did, "member")?,
        is_admin: has_edge(conn, space_id, did, "admin")?,
        is_banned,
    })
}

/// `coalesce(allow_public_join, 1)` — an absent row means open.
pub fn allows_public_join(conn: &Connection, space_id: &str) -> rusqlite::Result<bool> {
    let row = conn
        .query_row(
            "select coalesce(allow_public_join, 1) as v from comp_space where entity = ?",
            [space_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()?;
    Ok(row.map(|v| v == 1).unwrap_or(true))
}

fn live_default_access(conn: &Connection, room_id: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row(
        "select default_access from comp_room where entity = ?",
        [room_id],
        |row| row.get::<_, Option<String>>(0),
    )
    .optional()
    .map(Option::flatten)
}

/// `(space id, effective access)` plus the canonical parent channel.
type ResolvedRoom = (Option<(String, DefaultAccess)>, Option<String>);

/// `resolveRoom`: parent space, canonical parent channel, and the effective
/// access for the room (a thread never grants more than its channel).
pub fn resolve_room(conn: &Connection, room_id: &str) -> rusqlite::Result<ResolvedRoom> {
    let row = conn
        .query_row(
            "select e.stream_id as space_id, cr.default_access as default_access
               from entities e
               left join comp_room cr on cr.entity = e.id
              where e.id = ?",
            [room_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()?;
    let Some((space_id, own_access)) = row else {
        return Ok((None, None));
    };

    let parent_id: Option<String> = conn
        .query_row(
            "select head from edges
              where tail = ? and label = 'link'
                and coalesce(json_extract(payload, '$.canonical_parent'), 0) = 1
              limit 1",
            [room_id],
            |row| row.get(0),
        )
        .optional()?;

    let own = DefaultAccess::normalize(own_access.as_deref());
    let effective = match &parent_id {
        Some(parent) => {
            let parent_access =
                DefaultAccess::normalize(live_default_access(conn, parent)?.as_deref());
            parent_access.min(own)
        }
        None => own,
    };

    Ok((Some((space_id.unwrap_or_default(), effective)), parent_id))
}

/// The read and write a role grants the caller on one room.
struct RoleGrant {
    read: bool,
    write: bool,
}

fn role_grant(
    conn: &Connection,
    space_id: &str,
    room_id: &str,
    did: Option<&str>,
) -> rusqlite::Result<RoleGrant> {
    let no_grant = RoleGrant {
        read: false,
        write: false,
    };
    let Some(did) = did else {
        return Ok(no_grant);
    };
    let row = conn
        .query_row(
            "select
               max(case when rr.permission in ('read', 'readwrite') then 1 else 0 end) as has_read,
               max(case when rr.permission = 'readwrite' then 1 else 0 end) as has_write
               from member_roles mr
               join role_rooms rr on rr.role_id = mr.role_id
               join roles ro on ro.id = mr.role_id
              where mr.user_id = ?1
                and rr.room_id = ?2
                and ro.stream_id = ?3
                and ro.deleted = 0",
            (did, room_id, space_id),
            |row| {
                Ok(RoleGrant {
                    read: row.get::<_, Option<i64>>(0)?.unwrap_or(0) != 0,
                    write: row.get::<_, Option<i64>>(1)?.unwrap_or(0) != 0,
                })
            },
        )
        .optional()?;
    Ok(row.unwrap_or(no_grant))
}

/// The caller's effective access to `room_id`: the room's default, capped by its
/// canonical parent channel's, with role grants and the ban list applied.
pub fn room_access(
    conn: &Connection,
    room_id: &str,
    did: Option<&str>,
) -> rusqlite::Result<RoomAccess> {
    let (resolved, parent_channel_id) = resolve_room(conn, room_id)?;
    let Some((space_id, default_access)) = resolved else {
        return Ok(RoomAccess::missing());
    };
    // An entity with no owning stream is not a readable room.
    if space_id.is_empty() {
        return Ok(RoomAccess::missing());
    }

    let space = space_access(conn, &space_id, did)?;
    if space.is_banned {
        return Ok(RoomAccess {
            exists: true,
            can_read: false,
            can_write: false,
            is_admin: false,
            default_access,
            space_id: Some(space_id),
            parent_channel_id,
            is_banned: true,
        });
    }
    if space.is_admin {
        return Ok(RoomAccess {
            exists: true,
            can_read: true,
            can_write: true,
            is_admin: true,
            default_access,
            space_id: Some(space_id),
            parent_channel_id,
            is_banned: false,
        });
    }

    let grant_room = parent_channel_id.as_deref().unwrap_or(room_id);
    let grant = role_grant(conn, &space_id, grant_room, did)?;
    let public_join = allows_public_join(conn, &space_id)?;
    let passes_read_gate = public_join || space.is_member;

    Ok(RoomAccess {
        exists: true,
        can_read: passes_read_gate && (default_access != DefaultAccess::None || grant.read),
        can_write: space.is_member && (default_access == DefaultAccess::ReadWrite || grant.write),
        is_admin: false,
        default_access,
        space_id: Some(space_id),
        parent_channel_id,
        is_banned: false,
    })
}

/// `requireSpaceAccess` from `src/xrpc/authGuards.ts`: membership or admin,
/// with no public-join allowance.
///
/// This is the stricter sibling of [`require_space_read`]: a space that anyone
/// may read is still not a space anyone may act on — starting a call, listing
/// bridge grants, reading federation state.
pub fn require_space_access(
    conn: &Connection,
    space_id: &str,
    did: Option<&str>,
) -> Result<SpaceAccess, XrpcError> {
    let access = space_access(conn, space_id, did)?;
    if access.is_banned {
        return Err(XrpcError::forbidden("Caller is banned from this space"));
    }
    if !access.is_member && !access.is_admin {
        return Err(XrpcError::forbidden(
            "Caller is neither a member nor an admin of this space",
        ));
    }
    Ok(access)
}

/// `requireSpaceRead` from `src/xrpc/authGuards.ts`.
pub fn require_space_read(
    conn: &Connection,
    space_id: &str,
    did: Option<&str>,
) -> Result<SpaceAccess, XrpcError> {
    let access = space_access(conn, space_id, did)?;
    if access.is_banned {
        return Err(XrpcError::forbidden("Caller is banned from this space"));
    }
    if !access.is_member && !access.is_admin && !allows_public_join(conn, space_id)? {
        return Err(XrpcError::forbidden(
            "Caller is neither a member nor an admin of this space",
        ));
    }
    Ok(access)
}

/// `requireRoomRead` from `src/xrpc/authGuards.ts`.
pub fn require_room_read(
    conn: &Connection,
    room_id: &str,
    did: Option<&str>,
) -> Result<RoomAccess, XrpcError> {
    let access = room_access(conn, room_id, did)?;
    if !access.exists {
        return Err(XrpcError::not_found(format!("Room not found: {room_id}")));
    }
    if access.is_banned {
        return Err(XrpcError::forbidden("Caller is banned from this space"));
    }
    if access.can_read {
        return Ok(access);
    }
    Err(XrpcError::forbidden(
        "Caller has no read access to this room",
    ))
}

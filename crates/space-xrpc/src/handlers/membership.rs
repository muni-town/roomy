//! `space.roomy.space.getMembers`, `.getRoles`, `.getInvites` and
//! `.getUserAccess`.
//!
//! Members and roles are read from the space's own edge graph and role tables.
//! Profile fields are overlaid from the global store, because a member's
//! profile entity lives in their own stream, not the space's, so the per-space
//! `comp_user`/`comp_info` joins are empty for cross-stream members.

use std::collections::HashMap;

use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::access::{require_space_access, space_access};
use crate::error::XrpcError;
use crate::handlers::common::{parse_space, Context};
use crate::params::Params;
use crate::state::XrpcState;
use crate::store::ProfileFields;

// ─── Responses ────────────────────────────────────────────────────────────

/// The profile fields the space's own tables held, in the order they are
/// written.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RowProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

/// The profile fields the global store supplied for the ones the space's tables
/// did not have. They are a separate group because they are written after every
/// other field: a hydrate appends what it adds, and the differential pins that.
#[derive(Debug, Clone, Default, Serialize)]
pub struct SuppliedProfile {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handle: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
}

impl RowProfile {
    /// Fill what the space's tables lacked from `profile`, keeping a supplied
    /// value that overwrites one of theirs in place.
    fn hydrate(&mut self, supplied: &mut SuppliedProfile, profile: Option<ProfileFields>) {
        let Some(profile) = profile else {
            return;
        };
        fn take(row: &mut Option<String>, supplied: &mut Option<String>, value: Option<String>) {
            let Some(value) = value else { return };
            if row.is_some() {
                *row = Some(value);
            } else {
                *supplied = Some(value);
            }
        }
        take(&mut self.name, &mut supplied.name, profile.name);
        take(&mut self.handle, &mut supplied.handle, profile.handle);
        take(&mut self.avatar, &mut supplied.avatar, profile.avatar);
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct MemberRow {
    pub did: String,
    #[serde(flatten)]
    pub row: RowProfile,
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    #[serde(rename = "isBanned")]
    pub is_banned: bool,
    #[serde(rename = "roleIds")]
    pub role_ids: Vec<String>,
    #[serde(flatten)]
    pub supplied: SuppliedProfile,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExternalAdminRow {
    pub did: String,
    #[serde(flatten)]
    pub row: RowProfile,
    #[serde(flatten)]
    pub supplied: SuppliedProfile,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetMembersResult {
    pub members: Vec<MemberRow>,
    #[serde(rename = "externalAdmins")]
    pub external_admins: Vec<ExternalAdminRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleRoom {
    #[serde(rename = "roomId")]
    pub room_id: String,
    pub permission: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct RoleRow {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub rooms: Vec<RoleRoom>,
    #[serde(rename = "memberDids")]
    pub member_dids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetRolesResult {
    pub roles: Vec<RoleRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct InviteRow {
    pub token: String,
    #[serde(rename = "createdBy")]
    pub created_by: String,
    #[serde(rename = "eventUlid")]
    pub event_ulid: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetInvitesResult {
    pub invites: Vec<InviteRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct GetUserAccessResult {
    #[serde(rename = "isAdmin")]
    pub is_admin: bool,
    #[serde(rename = "roleIds")]
    pub role_ids: Vec<String>,
}

// ─── getMembers ───────────────────────────────────────────────────────────

struct MemberRecord {
    did: String,
    handle: Option<String>,
    name: Option<String>,
    avatar: Option<String>,
    is_admin: i64,
    is_banned: i64,
}

struct ExternalAdminRecord {
    did: String,
    handle: Option<String>,
    name: Option<String>,
    avatar: Option<String>,
}

/// Case-insensitive substring match against handle, name, or DID. An absent or
/// whitespace-only query matches everything.
fn member_matches_search(
    did: &str,
    handle: Option<&str>,
    name: Option<&str>,
    search: Option<&str>,
) -> bool {
    let Some(query) = search.map(str::trim).filter(|query| !query.is_empty()) else {
        return true;
    };
    let query = query.to_lowercase();
    handle.unwrap_or("").to_lowercase().contains(&query)
        || name.unwrap_or("").to_lowercase().contains(&query)
        || did.to_lowercase().contains(&query)
}

/// The global store's value wins; the per-space column is the fallback.
pub fn get_members(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetMembersResult, XrpcError> {
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let space_id = parse_space(params)?;
    let search = params.optional_string("search");

    state.db.with(|conn| {
        require_space_access(conn, space_id.as_str(), Some(did))?;

        let member_records = {
            let mut stmt = conn.prepare(
                "select
                   m.tail as did,
                   cu.handle as handle,
                   ci.name as name,
                   ci.avatar as avatar,
                   exists (
                     select 1 from edges
                      where head = m.head and tail = m.tail and label = 'admin'
                   ) as is_admin,
                   exists (
                     select 1 from comp_bans
                      where entity = m.head and user_did = m.tail
                   ) as is_banned
                 from edges m
                 left join comp_user cu on cu.did = m.tail
                 left join comp_info ci on ci.entity = m.tail
                where m.head = ? and m.label = 'member'",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok(MemberRecord {
                    did: row.get(0)?,
                    handle: row.get(1)?,
                    name: row.get(2)?,
                    avatar: row.get(3)?,
                    is_admin: row.get(4)?,
                    is_banned: row.get(5)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut roles_by_user: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "select user_id, role_id from member_roles
                  where stream_id = ?",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (user_id, role_id) = row?;
                roles_by_user.entry(user_id).or_default().push(role_id);
            }
        }

        let mut members: Vec<MemberRow> = member_records
            .into_iter()
            .map(|record| {
                let role_ids = roles_by_user.get(&record.did).cloned().unwrap_or_default();
                MemberRow {
                    did: record.did,
                    row: RowProfile {
                        handle: record.handle,
                        name: record.name,
                        avatar: record.avatar,
                    },
                    is_admin: record.is_admin != 0,
                    is_banned: record.is_banned != 0,
                    role_ids,
                    supplied: SuppliedProfile::default(),
                }
            })
            .collect();

        for member in &mut members {
            let profile = state.stores.profile(&member.did);
            member.row.hydrate(&mut member.supplied, profile);
        }
        members.retain(|member| {
            member_matches_search(
                &member.did,
                member
                    .row
                    .handle
                    .as_deref()
                    .or(member.supplied.handle.as_deref()),
                member
                    .row
                    .name
                    .as_deref()
                    .or(member.supplied.name.as_deref()),
                search.as_deref(),
            )
        });

        let external_admin_records = {
            let mut stmt = conn.prepare(
                "select
                   a.tail as did,
                   cu.handle as handle,
                   ci.name as name,
                   ci.avatar as avatar
                 from edges a
                 left join comp_user cu on cu.did = a.tail
                 left join comp_info ci on ci.entity = a.tail
                where a.head = ?
                  and a.label = 'admin'
                  and not exists (
                    select 1 from edges m
                     where m.head = a.head and m.tail = a.tail and m.label = 'member'
                  )",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok(ExternalAdminRecord {
                    did: row.get(0)?,
                    handle: row.get(1)?,
                    name: row.get(2)?,
                    avatar: row.get(3)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut external_admins: Vec<ExternalAdminRow> = external_admin_records
            .into_iter()
            .map(|record| ExternalAdminRow {
                did: record.did,
                row: RowProfile {
                    handle: record.handle,
                    name: record.name,
                    avatar: record.avatar,
                },
                supplied: SuppliedProfile::default(),
            })
            .collect();

        for admin in &mut external_admins {
            let profile = state.stores.profile(&admin.did);
            admin.row.hydrate(&mut admin.supplied, profile);
        }
        external_admins.retain(|admin| {
            member_matches_search(
                &admin.did,
                admin
                    .row
                    .handle
                    .as_deref()
                    .or(admin.supplied.handle.as_deref()),
                admin.row.name.as_deref().or(admin.supplied.name.as_deref()),
                search.as_deref(),
            )
        });

        Ok(GetMembersResult {
            members,
            external_admins,
        })
    })
}

// ─── getRoles ─────────────────────────────────────────────────────────────

struct RoleRecord {
    id: String,
    name: Option<String>,
    avatar: Option<String>,
    description: Option<String>,
}

pub fn get_roles(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetRolesResult, XrpcError> {
    let space_id = parse_space(params)?;
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };

    state.db.with(|conn| {
        let access = require_space_access(conn, space_id.as_str(), Some(did))?;

        let role_records = {
            let mut stmt = conn.prepare(
                "select id, name, avatar, description
                   from roles
                  where stream_id = ?
                    and deleted = 0",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok(RoleRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    avatar: row.get(2)?,
                    description: row.get(3)?,
                })
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut rooms_by_role: HashMap<String, Vec<RoleRoom>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "select role_id, room_id, permission from role_rooms
                  where stream_id = ?",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })?;
            for row in rows {
                let (role_id, room_id, permission) = row?;
                rooms_by_role.entry(role_id).or_default().push(RoleRoom {
                    room_id,
                    permission,
                });
            }
        }

        let mut members_by_role: HashMap<String, Vec<String>> = HashMap::new();
        {
            let mut stmt = conn.prepare(
                "select role_id, user_id from member_roles
                  where stream_id = ?",
            )?;
            let rows = stmt.query_map([space_id.as_str()], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })?;
            for row in rows {
                let (role_id, user_id) = row?;
                members_by_role.entry(role_id).or_default().push(user_id);
            }
        }

        let mut roles = Vec::new();
        for record in role_records {
            let member_dids = members_by_role.get(&record.id).cloned().unwrap_or_default();
            if !access.is_admin && !member_dids.iter().any(|member| member.as_str() == did) {
                continue;
            }
            let rooms = rooms_by_role.get(&record.id).cloned().unwrap_or_default();
            roles.push(RoleRow {
                id: record.id,
                name: record.name,
                avatar: record.avatar,
                description: record.description,
                rooms,
                member_dids,
            });
        }

        Ok(GetRolesResult { roles })
    })
}

// ─── getInvites ───────────────────────────────────────────────────────────

struct InviteRecord {
    token: String,
    created_by: String,
    event_ulid: String,
}

fn invite_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<InviteRecord> {
    Ok(InviteRecord {
        token: row.get(0)?,
        created_by: row.get(1)?,
        event_ulid: row.get(2)?,
    })
}

fn select_invites(
    conn: &Connection,
    space_id: &str,
    created_by: Option<&str>,
) -> rusqlite::Result<Vec<InviteRecord>> {
    match created_by {
        Some(did) => {
            let mut stmt = conn.prepare(
                "select token, created_by_did, event_ulid
                   from comp_invite
                  where entity = ? and created_by_did = ?",
            )?;
            let rows = stmt.query_map((space_id, did), invite_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }
        None => {
            let mut stmt = conn.prepare(
                "select token, created_by_did, event_ulid
                   from comp_invite where entity = ?",
            )?;
            let rows = stmt.query_map([space_id], invite_from_row)?;
            rows.collect::<rusqlite::Result<Vec<_>>>()
        }
    }
}

pub fn get_invites(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetInvitesResult, XrpcError> {
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };
    let space_id = parse_space(params)?;

    state.db.with(|conn| {
        let access = require_space_access(conn, space_id.as_str(), Some(did))?;

        if !access.is_admin {
            // A null policy means unset, and the spec default is "false".
            let policy: Option<Option<i64>> = conn
                .query_row(
                    "select allow_member_invites from comp_space where entity = ?",
                    [space_id.as_str()],
                    |row| row.get(0),
                )
                .optional()?;
            if policy.flatten() != Some(1) {
                return Err(XrpcError::forbidden(
                    "Member-created invites are disabled in this space",
                ));
            }
        }

        let records = select_invites(
            conn,
            space_id.as_str(),
            if access.is_admin { None } else { Some(did) },
        )?;

        Ok(GetInvitesResult {
            invites: records
                .into_iter()
                .map(|record| InviteRow {
                    token: record.token,
                    created_by: record.created_by,
                    event_ulid: record.event_ulid,
                })
                .collect(),
        })
    })
}

// ─── getUserAccess ────────────────────────────────────────────────────────

pub fn get_user_access(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetUserAccessResult, XrpcError> {
    let space_id = parse_space(params)?;
    let user_did = params.require_string("userDid")?;

    // Only the space's own account may read its own user-access state. The
    // request signature is verified against the issuer's signing key, so a
    // caller can match the space DID only when it holds the space's key.
    if ctx.did() != Some(space_id.as_str()) {
        return Err(XrpcError::forbidden("Caller must be the space's own DID"));
    }

    state.db.with(|conn| {
        let is_admin = space_access(conn, space_id.as_str(), Some(user_did.as_str()))?.is_admin;

        let mut stmt = conn.prepare(
            "select role_id from member_roles
              where user_id = ? and stream_id = ?",
        )?;
        let role_ids = stmt
            .query_map((user_did.as_str(), space_id.as_str()), |row| {
                row.get::<_, String>(0)
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        Ok(GetUserAccessResult { is_admin, role_ids })
    })
}

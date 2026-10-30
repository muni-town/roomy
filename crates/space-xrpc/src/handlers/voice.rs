//! `space.roomy.voice.getToken`, `getParticipants` and `getActiveCalls`.
//!
//! Reads over the per-space voice projection: `active_calls` names the call a
//! room currently has, `call_participants` who is in it, and `entities` scopes
//! a space's calls to its own rooms. Authorization is room read access, plus
//! space membership for the two endpoints that name a call the caller may act
//! on — a public space is readable by strangers, who must not learn or join its
//! calls.
//!
//! `getToken` mints the caller's LiveKit access token locally: a plain HS256
//! JWT over the API secret, with LiveKit's `video` grant and the participant's
//! profile in `metadata`. Nothing is sent to the SFU, so the endpoint works
//! against an unreachable LiveKit and is testable without one. Starting a call
//! is a write and belongs to the write ingress (`space.roomy.voice.join`), so
//! this worker mints for the call the room already projects and answers
//! `CallNotStarted` when there is none.
//!
//! LiveKit is configured from the environment (`LIVEKIT_URL`,
//! `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, `LIVEKIT_SERVER_ID`). Unconfigured,
//! every endpoint reports "no call" instead of failing: `getToken` returns every
//! field null, and the two lists come back empty, which is what lets a
//! deployment without an SFU render no call UI.

use std::env;
use std::time::{SystemTime, UNIX_EPOCH};

use jsonwebtoken::{encode, Algorithm, EncodingKey, Header};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;

use crate::access;
use crate::error::XrpcError;
use crate::handlers::common;
use crate::handlers::common::Context;
use crate::params::Params;
use crate::state::XrpcState;

/// Access-token lifetime. Short by design: the client re-mints on reconnect.
const TOKEN_TTL_SECONDS: i64 = 300;

/// This deployment's LiveKit configuration, or `None` when voice is not
/// deployed.
///
/// The three connection values are required together: a URL with no key pair
/// cannot mint a token, so a partial configuration is no configuration.
#[derive(Debug, Clone)]
pub struct VoiceConfig {
    /// The SFU origin clients should reach, without a trailing slash.
    pub url: String,
    pub api_key: String,
    pub api_secret: String,
    /// First segment of the room name, so deployments sharing one LiveKit
    /// project cannot see each other's rooms.
    pub server_id: String,
}

impl VoiceConfig {
    /// Read the configuration from the environment, matching the appserver's
    /// variable names and defaults.
    pub fn from_env() -> Option<Self> {
        let url = non_empty("LIVEKIT_URL")?;
        let api_key = non_empty("LIVEKIT_API_KEY")?;
        let api_secret = non_empty("LIVEKIT_API_SECRET")?;
        Some(Self {
            url: url.trim_end_matches('/').to_owned(),
            api_key,
            api_secret,
            server_id: non_empty("LIVEKIT_SERVER_ID").unwrap_or_else(|| "roomy".to_owned()),
        })
    }
}

fn non_empty(key: &str) -> Option<String> {
    env::var(key).ok().filter(|value| !value.is_empty())
}

/// `space.roomy.voice.getToken`: the caller's token, the call's generation, the
/// SFU origin and the token TTL.
///
/// Every field is always present on the wire; the unconfigured answer carries
/// nulls rather than dropping the keys.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceTokenResult {
    pub token: Option<String>,
    #[serde(rename = "callId")]
    pub call_id: Option<String>,
    #[serde(rename = "livekitUrl")]
    pub livekit_url: Option<String>,
    #[serde(rename = "e2eeKey")]
    pub e2ee_key: Option<String>,
    pub ttl: Option<i64>,
}

impl VoiceTokenResult {
    /// LiveKit is unconfigured: the caller renders no call UI.
    fn unconfigured() -> Self {
        Self {
            token: None,
            call_id: None,
            livekit_url: None,
            e2ee_key: None,
            ttl: None,
        }
    }
}

/// One participant of a room's call, as the presence snapshot reports them.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceParticipant {
    pub did: String,
    #[serde(rename = "joinedAt", skip_serializing_if = "Option::is_none")]
    pub joined_at: Option<i64>,
    pub source: String,
}

/// `space.roomy.voice.getParticipants`: the room's call generation and who is
/// in it.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceParticipantsResult {
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "callId")]
    pub call_id: Option<String>,
    pub participants: Vec<VoiceParticipant>,
}

impl VoiceParticipantsResult {
    /// No call to report: no LiveKit configured, or the room has none.
    fn none(room_id: String) -> Self {
        Self {
            room_id,
            call_id: None,
            participants: Vec::new(),
        }
    }
}

/// One room of a space that currently has a call.
#[derive(Debug, Clone, Serialize)]
pub struct ActiveCallSummary {
    #[serde(rename = "roomId")]
    pub room_id: String,
    #[serde(rename = "callId")]
    pub call_id: String,
    #[serde(rename = "startedAt")]
    pub started_at: i64,
    #[serde(rename = "participantCount")]
    pub participant_count: i64,
}

/// `space.roomy.voice.getActiveCalls`: the space's rooms that have a call.
#[derive(Debug, Clone, Serialize)]
pub struct VoiceActiveCallsResult {
    pub calls: Vec<ActiveCallSummary>,
}

/// The call generation the room currently has, if any.
///
/// A database without the projection's tables reads as "no call", the same way
/// an appserver that has never served one does.
fn active_call(conn: &Connection, room_id: &str) -> Option<String> {
    conn.query_row(
        "select call_id from active_calls where room_id = ?",
        [room_id],
        |row| row.get::<_, String>(0),
    )
    .optional()
    .ok()
    .flatten()
}

/// The room's participants, oldest join first.
///
/// Filtered by room alone: a new generation replaces the previous generation's
/// rows wholesale, so every row of the room belongs to its current call.
fn list_participants(conn: &Connection, room_id: &str) -> Vec<VoiceParticipant> {
    let Ok(mut statement) = conn.prepare(
        "select did, joined_at, source
           from call_participants
          where room_id = ?
          order by joined_at asc",
    ) else {
        return Vec::new();
    };
    let rows = statement.query_map([room_id], |row| {
        Ok(VoiceParticipant {
            did: row.get(0)?,
            joined_at: row.get(1)?,
            source: row.get(2)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// The space's active calls, each with the size of its participant list.
fn list_active_calls(conn: &Connection, space_id: &str) -> Vec<ActiveCallSummary> {
    let Ok(mut statement) = conn.prepare(
        "select ac.room_id as room_id,
                ac.call_id as call_id,
                ac.started_at as started_at,
                (select count(*) from call_participants cp
                  where cp.room_id = ac.room_id and cp.call_id = ac.call_id)
                  as participant_count
           from active_calls ac
           join entities e on e.id = ac.room_id
          where e.stream_id = ?",
    ) else {
        return Vec::new();
    };
    let rows = statement.query_map([space_id], |row| {
        Ok(ActiveCallSummary {
            room_id: row.get(0)?,
            call_id: row.get(1)?,
            started_at: row.get(2)?,
            participant_count: row.get(3)?,
        })
    });
    match rows {
        Ok(rows) => rows.filter_map(Result::ok).collect(),
        Err(_) => Vec::new(),
    }
}

/// The call's LiveKit room name: `{serverId}.{spaceId}.{roomId}@{callId}`.
///
/// The `@{callId}` suffix is what makes a stale webhook harmless: LiveKit keeps
/// emitting events for a room after the appserver has moved on to the next call
/// in that Roomy room, and the suffix attributes each event to one generation.
fn room_name(config: &VoiceConfig, space_id: &str, room_id: &str, call_id: &str) -> String {
    format!("{}.{}.{}@{}", config.server_id, space_id, room_id, call_id)
}

/// Identity embedded in the token's `metadata` so the client renders a
/// participant card without a profile round-trip.
#[derive(Debug, Serialize)]
struct ParticipantMetadata<'a> {
    did: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    handle: Option<&'a str>,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    display_name: Option<&'a str>,
    #[serde(rename = "avatarUrl", skip_serializing_if = "Option::is_none")]
    avatar_url: Option<&'a str>,
}

/// LiveKit's own grant for one room: what the token may do once connected.
#[derive(Debug, Serialize)]
struct VideoGrant<'a> {
    room: &'a str,
    #[serde(rename = "roomJoin")]
    room_join: bool,
    #[serde(rename = "canPublish")]
    can_publish: bool,
    #[serde(rename = "canSubscribe")]
    can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    can_publish_data: bool,
}

#[derive(Debug, Serialize)]
struct TokenClaims<'a> {
    iss: &'a str,
    sub: &'a str,
    nbf: i64,
    iat: i64,
    exp: i64,
    name: &'a str,
    metadata: String,
    video: VideoGrant<'a>,
}

/// Mint an HS256 access token for one participant in one call.
///
/// The `sub` claim is the participant's DID: LiveKit echoes it back on
/// webhooks, and the call-fact pipeline matches it against the projection.
fn mint_token(
    config: &VoiceConfig,
    room_name: &str,
    did: &str,
    metadata: &ParticipantMetadata<'_>,
) -> Result<String, XrpcError> {
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| XrpcError::internal(format!("system clock is before the epoch: {err}")))?
        .as_millis() as i64;
    let iat = now_ms / 1000;
    let name = metadata.display_name.or(metadata.handle).unwrap_or(did);
    let metadata_json = serde_json::to_string(metadata).map_err(|err| {
        XrpcError::internal(format!("participant metadata is not serialisable: {err}"))
    })?;
    let claims = TokenClaims {
        iss: &config.api_key,
        sub: did,
        nbf: iat,
        iat,
        exp: iat + TOKEN_TTL_SECONDS,
        name,
        metadata: metadata_json,
        video: VideoGrant {
            room: room_name,
            room_join: true,
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };
    encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(config.api_secret.as_bytes()),
    )
    .map_err(|err| XrpcError::internal(format!("voice token signing failed: {err}")))
}

/// `voice.getToken`: the caller's LiveKit token for the room's current call.
///
/// # Errors
///
/// Returns `CallNotStarted` when the room projects no call, and `Forbidden`
/// when the caller does not hold space membership.
pub fn get_token(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<VoiceTokenResult, XrpcError> {
    let room_id = params.require_string("roomId")?;

    state.db.with(|conn| {
        // Access is resolved before configuration, so a deployment without
        // LiveKit answers "may I?" identically.
        let access = access::require_room_read(conn, &room_id, ctx.did())?;
        let Some(did) = ctx.did() else {
            return Err(XrpcError::forbidden("Sign in to join this call"));
        };
        let Some(space_id) = access.space_id.as_deref() else {
            return Err(XrpcError::forbidden("Sign in to join this call"));
        };
        access::require_space_access(conn, space_id, Some(did))?;

        let Some(config) = VoiceConfig::from_env() else {
            return Ok(VoiceTokenResult::unconfigured());
        };

        let Some(call_id) = active_call(conn, &room_id) else {
            return Err(XrpcError::new(
                409,
                "CallNotStarted",
                format!(
                    "Call has not started for room {room_id}; space.roomy.voice.join starts it"
                ),
            ));
        };

        let profile = state.stores.profile(did);
        let metadata = ParticipantMetadata {
            did,
            handle: profile.as_ref().and_then(|p| p.handle.as_deref()),
            display_name: profile.as_ref().and_then(|p| p.name.as_deref()),
            avatar_url: profile.as_ref().and_then(|p| p.avatar.as_deref()),
        };
        let token = mint_token(
            &config,
            &room_name(&config, space_id, &room_id, &call_id),
            did,
            &metadata,
        )?;

        Ok(VoiceTokenResult {
            token: Some(token),
            call_id: Some(call_id),
            livekit_url: Some(config.url),
            // The per-call key lives in read-state, which this worker does not
            // own: it neither creates nor derives one.
            e2ee_key: None,
            ttl: Some(TOKEN_TTL_SECONDS),
        })
    })
}

/// `voice.getParticipants`: the room's call and who is in it.
pub fn get_participants(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<VoiceParticipantsResult, XrpcError> {
    let room_id = params.require_string("roomId")?;

    state.db.with(|conn| {
        access::require_room_read(conn, &room_id, ctx.did())?;

        // Unconfigured LiveKit means no call can exist, so this agrees with
        // `getToken` rather than reporting a projection nothing populates.
        if VoiceConfig::from_env().is_none() {
            return Ok(VoiceParticipantsResult::none(room_id));
        }

        let Some(call_id) = active_call(conn, &room_id) else {
            return Ok(VoiceParticipantsResult::none(room_id));
        };
        let participants = list_participants(conn, &room_id);
        Ok(VoiceParticipantsResult {
            room_id,
            call_id: Some(call_id),
            participants,
        })
    })
}

/// `voice.getActiveCalls`: the space's rooms that currently have a call.
pub fn get_active_calls(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<VoiceActiveCallsResult, XrpcError> {
    let space_id = common::parse_space(params)?;
    // Authentication before the space is read at all: the membership check
    // below reports an absent caller as a non-member, which is not the answer.
    let Some(did) = ctx.did() else {
        return Err(XrpcError::new(
            401,
            "AuthRequired",
            "Authentication required",
        ));
    };

    state.db.with(|conn| {
        // Membership, not public read: the list names which rooms have live
        // calls, which is not something a stranger to the space should learn.
        access::require_space_access(conn, space_id.as_str(), Some(did))?;

        if VoiceConfig::from_env().is_none() {
            return Ok(VoiceActiveCallsResult { calls: Vec::new() });
        }
        Ok(VoiceActiveCallsResult {
            calls: list_active_calls(conn, space_id.as_str()),
        })
    })
}

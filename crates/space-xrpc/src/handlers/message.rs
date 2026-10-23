//! `space.roomy.message.getMessage` and `space.roomy.message.getReactions`.

use indexmap::IndexMap;
use rusqlite::OptionalExtension;

use crate::access::require_room_read;
use crate::dto::{GetReactionsResult, MessageDto, ReactionGroup, ReactorInfo};
use crate::error::XrpcError;
use crate::handlers::common::Context;
use crate::ids::MessageId;
use crate::params::Params;
use crate::queries::messages::{select_messages, SelectScope};
use crate::state::XrpcState;

/// Resolve the message's room and enforce read access on it.
fn message_room(
    state: &XrpcState,
    message_id: &MessageId,
    ctx: &Context,
) -> Result<String, XrpcError> {
    state.db.with(|conn| {
        let row: Option<Option<String>> = conn
            .query_row(
                "select room from entities where id = ?",
                [message_id.as_str()],
                |row| row.get(0),
            )
            .optional()?;
        let Some(room) = row else {
            return Err(XrpcError::not_found(format!(
                "Message not found: {}",
                message_id.as_str()
            )));
        };
        let Some(room) = room else {
            return Err(XrpcError::invalid_request(format!(
                "Entity {} is not a message (no room)",
                message_id.as_str()
            )));
        };
        require_room_read(conn, &room, ctx.did())?;
        Ok(room)
    })
}

pub fn get_message(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<MessageDto, XrpcError> {
    let message_id = MessageId::try_from(params.require_string("messageId")?)?;
    message_room(state, &message_id, ctx)?;

    state.db.with(|conn| {
        let result = select_messages(
            conn,
            state.stores.as_ref(),
            SelectScope::Ids {
                ids: vec![message_id.as_str().to_owned()],
                forward_chain: Vec::new(),
                skip_profile_hydration: false,
            },
            ctx.did(),
            &[],
        )?;
        result.messages.into_iter().next().ok_or_else(|| {
            XrpcError::not_found(format!("Message not found: {}", message_id.as_str()))
        })
    })
}

pub fn get_reactions(
    state: &XrpcState,
    params: &Params,
    ctx: &Context,
) -> Result<GetReactionsResult, XrpcError> {
    let message_id = MessageId::try_from(params.require_string("messageId")?)?;
    message_room(state, &message_id, ctx)?;

    state.db.with(|conn| {
        let mut stmt = conn.prepare(
            "select r.reaction, r.user, u.handle, i.name, i.avatar
               from comp_reaction r
               left join comp_user u on u.did = r.user
               left join comp_info i on i.entity = r.user
              where r.entity = ?
              order by r.created_at asc",
        )?;
        let rows: Vec<ReactionRow> = stmt
            .query_map([message_id.as_str()], |row| {
                Ok(ReactionRow {
                    reaction: row.get(0)?,
                    user: row.get(1)?,
                    handle: row.get(2)?,
                    name: row.get(3)?,
                    avatar: row.get(4)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;

        // No block set on the worker; the gateway resolves it.
        let mut groups: IndexMap<String, Vec<ReactorInfo>> = IndexMap::new();
        for row in rows {
            let profile = state.stores.profile(&row.user);
            let handle = profile
                .as_ref()
                .and_then(|p| p.handle.clone())
                .or(row.handle);
            let avatar = profile
                .as_ref()
                .and_then(|p| p.avatar.clone())
                .or(row.avatar);
            let name = profile
                .as_ref()
                .and_then(|p| p.name.clone())
                .or(row.name)
                .unwrap_or_else(|| row.user.clone());
            groups.entry(row.reaction).or_default().push(ReactorInfo {
                did: row.user,
                name,
                handle,
                avatar,
            });
        }

        Ok(GetReactionsResult {
            reactions: groups
                .into_iter()
                .map(|(emoji, reactors)| ReactionGroup { emoji, reactors })
                .collect(),
        })
    })
}

struct ReactionRow {
    reaction: String,
    user: String,
    handle: Option<String>,
    name: Option<String>,
    avatar: Option<String>,
}

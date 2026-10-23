//! Projection rules for the singleton kinds `spaceInfo` and `spaceSidebar`.
//!
//! Both records live on the space's own entity: `spaceInfo` is `comp_info` plus
//! the join policy columns on `comp_space`, and `spaceSidebar` is
//! `comp_space.sidebar_config`. Every write to either is an update, because the
//! singletons exist from the space's beginning.
//!
//! `updateSpaceInfo` also materialises an entity for the entry that carried it,
//! and a `comp_space` row for a space that has none yet; both stay, because a
//! space created with only a name would otherwise have no row for `getMetadata`
//! to read.

use crate::change::{SpaceInfoPatch, SpaceInfoRecord, SpaceSidebarRecord};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::rules::ensure_entity;

/// `spaceInfo` — the space's profile and join policy. A create carries the whole
/// record; an update carries the fields it sets, so both are folded into one
/// patch here.
pub fn space_info_effects(record: impl Into<SpaceInfoPatch>, ctx: &RuleContext) -> Vec<Effect> {
    let patch = record.into();
    let stream = ctx.stream_id.as_str();
    let mut effects = vec![
        // The entry's own entity, kept because the event path writes it and the
        // global entity→space index records it.
        ensure_entity(&ctx.stream_id, &ctx.event_id, None),
        ensure_entity(&ctx.stream_id, stream, None),
        Effect::space(
            "insert into comp_space (entity) values (?) on conflict do nothing",
            vec![Value::text(stream)],
        ),
    ];

    if let Some(name) = &patch.name {
        effects.push(Effect::space(
            "insert into comp_info (entity, name) values (?, ?)
             on conflict(entity) do update set name = excluded.name",
            vec![Value::text(stream), Value::opt_text(name.clone())],
        ));
    }
    if let Some(avatar) = &patch.avatar {
        effects.push(Effect::space(
            "insert into comp_info (entity, avatar) values (?, ?)
             on conflict(entity) do update set avatar = excluded.avatar",
            vec![Value::text(stream), Value::opt_text(avatar.clone())],
        ));
    }
    if let Some(description) = &patch.description {
        effects.push(Effect::space(
            "insert into comp_info (entity, description) values (?, ?)
             on conflict(entity) do update set description = excluded.description",
            vec![Value::text(stream), Value::opt_text(description.clone())],
        ));
    }

    if let Some(allow) = &patch.allow_public_join {
        effects.push(policy_effect(stream, "allow_public_join", *allow));
    }
    if let Some(allow) = &patch.allow_member_invites {
        effects.push(policy_effect(stream, "allow_member_invites", *allow));
    }
    if let Some(suggest) = &patch.suggest_to_others {
        effects.push(policy_effect(stream, "suggest_to_others", *suggest));
    }

    effects
}

/// One three-valued join-policy column: `null` is "not answered", which every
/// reader distinguishes from `0`.
fn policy_effect(stream: &str, column: &'static str, value: Option<bool>) -> Effect {
    // The column is chosen here, not from the record, so the statement stays a
    // `&'static str` per column.
    let sql: &'static str = match column {
        "allow_public_join" => {
            "insert into comp_space (entity, allow_public_join) values (?, ?)
             on conflict(entity) do update set allow_public_join = excluded.allow_public_join"
        }
        "allow_member_invites" => {
            "insert into comp_space (entity, allow_member_invites) values (?, ?)
             on conflict(entity) do update set allow_member_invites = excluded.allow_member_invites"
        }
        _ => {
            "insert into comp_space (entity, suggest_to_others) values (?, ?)
             on conflict(entity) do update set suggest_to_others = excluded.suggest_to_others"
        }
    };
    Effect::space(sql, vec![Value::text(stream), Value::opt_flag(value)])
}

/// `spaceSidebar` — the space's sidebar ordering. Both sidebar versions
/// overwrite the whole config, so the record is the config.
pub fn space_sidebar_effects(record: &SpaceSidebarRecord, ctx: &RuleContext) -> Vec<Effect> {
    // The stored config is the record as JSON, with the same key order the
    // TypeScript writes: `id` only when the category has one, then `name`, then
    // `children`. The column is compared as text, so the order matters.
    let categories: Vec<StoredCategory> = record
        .categories
        .iter()
        .map(|category| StoredCategory {
            id: category.id.clone(),
            name: category.name.clone(),
            children: category.children.clone(),
        })
        .collect();
    let config =
        serde_json::to_string(&StoredConfig { categories }).expect("the sidebar config serialises");

    vec![Effect::space(
        "update comp_space set sidebar_config = ? where entity = ?",
        vec![Value::text(config), Value::text(ctx.stream_id.as_str())],
    )]
}

/// One category as `comp_space.sidebar_config` holds it.
#[derive(serde::Serialize)]
struct StoredCategory {
    #[serde(skip_serializing_if = "Option::is_none")]
    id: Option<String>,
    name: String,
    children: Vec<String>,
}

/// The stored config's shape: `{ categories }`, and nothing else — an extension
/// the record carries has no reader in this table.
#[derive(serde::Serialize)]
struct StoredConfig {
    categories: Vec<StoredCategory>,
}

impl From<SpaceInfoRecord> for SpaceInfoPatch {
    fn from(record: SpaceInfoRecord) -> Self {
        Self {
            name: Some(record.name),
            avatar: Some(record.avatar),
            description: Some(record.description),
            allow_public_join: Some(record.allow_public_join),
            allow_member_invites: Some(record.allow_member_invites),
            suggest_to_others: Some(record.suggest_to_others),
        }
    }
}

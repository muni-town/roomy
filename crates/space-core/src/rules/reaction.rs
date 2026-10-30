//! Projection rules for the `reaction` kind.
//!
//! One row of `comp_reaction`, keyed by the message it targets and the user who
//! reacted; `reaction_id` is the id of the change that added it, which is what a
//! removal names. Only a bridged add also materialises the reacting user's
//! entity — that user may be an external account this space has never seen.

use crate::change::{ChangeBase, ReactionRecord, RecordChange};
use crate::context::RuleContext;
use crate::effects::{Effect, Value};
use crate::rules;

/// The reaction's row, and the reacting user's entity when the add was
/// bridged.
pub fn create_effects(
    base: &ChangeBase,
    record: &ReactionRecord,
    ctx: &RuleContext,
) -> Vec<Effect> {
    let mut effects: Vec<Effect> = Vec::new();
    if record.bridged {
        effects.push(rules::ensure_entity(
            &ctx.stream_id,
            record.user.as_str(),
            None,
            ctx.decided_at_ms,
        ));
    }
    effects.push(Effect::space(
        "insert or replace into comp_reaction (
           entity, user, reaction, reaction_id, created_at, updated_at
         )
         values (?, ?, ?, ?, ?, ?)",
        vec![
            Value::text(&record.target),
            Value::text(record.user.as_str()),
            Value::text(&record.reaction),
            Value::text(base.rkey.as_str()),
            Value::Integer(ctx.decided_at_ms),
            Value::Integer(ctx.decided_at_ms),
        ],
    ));
    effects
}

/// The removal: the row the add wrote, found by the add's own id.
pub fn delete_effects(change: &RecordChange) -> Vec<Effect> {
    vec![Effect::space(
        "delete from comp_reaction where reaction_id = ?",
        vec![Value::text(change.base().rkey.as_str())],
    )]
}

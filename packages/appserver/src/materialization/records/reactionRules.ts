/**
 * Projection rules for the `reaction` kind.
 *
 * A reaction is one row of `comp_reaction`, keyed by the message it targets and
 * the user who reacted; `reaction_id` is the id of the add event, which is what
 * a removal names. The row is written by both the local and the bridged add,
 * and only the bridged form also materialises the reacting user's entity — that
 * user may be an external account this space has never seen.
 */

import { ensureEntity, type SqlStatement, sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { space, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type ReactionChange = ChangeOf<"reaction">;

/** The statements that apply one `reaction` change. */
export function reactionStatements(
  change: ReactionChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "delete") {
    return [
      space(
        sql`delete from comp_reaction where reaction_id = ${change.rkey}`,
      ),
    ];
  }

  const record = change.record;
  const statements: SqlStatement[] = [];
  if (record.bridged === true) {
    statements.push(ensureEntity(ctx.streamId, record.user));
  }
  statements.push(sql`
    insert or replace into comp_reaction (entity, user, reaction, reaction_id)
    values (${record.target}, ${record.user}, ${record.reaction}, ${change.rkey})
  `);
  return statements.map(space);
}

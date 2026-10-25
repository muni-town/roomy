/**
 * Projection rules for the singleton kinds `spaceInfo` and `spaceSidebar`.
 *
 * Both records live on the space's own entity: `spaceInfo` is `comp_info` plus
 * the join policy columns on `comp_space`, and `spaceSidebar` is
 * `comp_space.sidebar_config`. Every write to either is an update, because the
 * singletons exist from the space's beginning.
 *
 * `updateSpaceInfo` also materialises an entity for the event that carried it,
 * and a `comp_space` row for a space that has none yet; the rule keeps both,
 * because a space created with only a name would otherwise have no row for
 * `getMetadata` to read.
 */

import { ensureEntity, type SqlStatement, sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { space, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type SpaceInfoChange = ChangeOf<"spaceInfo">;
export type SpaceSidebarChange = ChangeOf<"spaceSidebar">;

/** The statements that apply one `spaceInfo` change. */
export function spaceInfoStatements(
  change: SpaceInfoChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "delete") {
    throw new Error("spaceInfo rule: the record has no delete");
  }

  const patch = change.record;
  const stream = ctx.streamId;
  const statements: RuleStatement[] = [
    // The event's own entity, kept because the event path writes it and the
    // global entity→space index records it.
    space(ensureEntity(stream, ctx.eventId, undefined, ctx.decidedAt)),
    space(ensureEntity(stream, stream, undefined, ctx.decidedAt)),
    space(sql`
      insert into comp_space (entity, created_at, updated_at)
      values (${stream}, ${ctx.decidedAt}, ${ctx.decidedAt})
      on conflict do nothing
    `),
  ];

  const info = [
    { key: "name", value: patch.name },
    { key: "avatar", value: patch.avatar },
    { key: "description", value: patch.description },
  ].filter((field) => field.value !== undefined);
  if (info.length > 0) {
    const columns = info.map((field) => field.key);
    statements.push(
      space({
        sql: `insert into comp_info (entity, ${columns.join(", ")}, created_at, updated_at)
          values (?, ${columns.map(() => "?").join(", ")}, ?, ?)
          on conflict do update set ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
        params: [stream, ...info.map((field) => field.value), ctx.decidedAt, ctx.decidedAt],
      }),
    );
  }

  // The space's name and avatar are denormalised into every feed row it holds.
  if (patch.name !== undefined || patch.avatar !== undefined) {
    statements.push(
      space(sql`
        update activity_item
            set space_name = (select name from comp_info where entity = activity_item.space_id),
                space_avatar = (select avatar from comp_info where entity = activity_item.space_id)
      `),
    );
  }

  const policy = [
    { key: "allow_public_join", value: patch.allowPublicJoin },
    { key: "allow_member_invites", value: patch.allowMemberInvites },
    { key: "suggest_to_others", value: patch.suggestToOthers },
  ].filter((field) => field.value !== undefined);
  if (policy.length > 0) {
    const columns = policy.map((field) => field.key);
    statements.push(
      space({
        sql: `insert into comp_space (entity, ${columns.join(", ")}, created_at, updated_at)
          values (?, ${columns.map(() => "?").join(", ")}, ?, ?)
          on conflict do update set ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
        params: [
          stream,
          ...policy.map((field) =>
            field.value === null ? null : field.value ? 1 : 0,
          ),
          ctx.decidedAt,
          ctx.decidedAt,
        ],
      }),
    );
  }

  return statements;
}

/**
 * The statements that apply one `spaceSidebar` change.
 *
 * Both sidebar versions overwrite the whole config, so the record is the
 * config. The rule writes the categories and nothing else: the event path's
 * stored JSON is `{ categories }`, and an extension the record carries has no
 * reader in this table.
 */
export function spaceSidebarStatements(
  change: SpaceSidebarChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op !== "update") {
    throw new Error(`spaceSidebar rule: unsupported op ${change.op}`);
  }

  const config: SqlStatement = {
    sql: `update comp_space set sidebar_config = ? where entity = ?`,
    params: [JSON.stringify({ categories: change.record.categories }), ctx.streamId],
  };
  return [space(config)];
}

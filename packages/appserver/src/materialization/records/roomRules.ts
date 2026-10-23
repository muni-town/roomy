/**
 * Projection rules for the `room` record kind.
 *
 * A room is created by `createRoom`, patched by `updateRoom` and the
 * soft-delete/restore pair, and linked from a parent room by
 * `createRoomLink`/`removeRoomLink`. A room is never removed from the set: a
 * deleted room keeps its row with `deleted = 1`, which is what the client's
 * deleted-rooms list reads.
 *
 * `parent` is a `link` edge, not a column: `roomAccess` resolves a thread's
 * access through the edge whose payload marks it canonical, so the rule writes
 * the same edge shape the event materialiser does. `removeRoomLink` names only
 * the room it unlinks, so the edge it removes is the parent the planner read.
 */

import { ensureEntity, type SqlStatement, sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { space, type RuleContext, type RuleStatement } from "./recordRules.ts";

/** One `room` change, narrowed to the kind. */
export type RoomChange = ChangeOf<"room">;

/** The statements that apply one `room` change. */
export function roomStatements(
  change: RoomChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create":
      return createStatements(change, ctx);
    case "update":
      return updateStatements(change, ctx);
    case "delete":
      // The record model has no hard delete for a room; this is unreachable
      // while the adapter only emits updates for the delete/restore pair.
      throw new Error("room rule: a room is never deleted");
  }
}

/** `createRoom` — the entity, its info, its kind and access, its origin. */
function createStatements(
  change: Extract<RoomChange, { op: "create" }>,
  ctx: RuleContext,
): RuleStatement[] {
  const record = change.record;
  const id = change.rkey;
  const statements: SqlStatement[] = [
    ensureEntity(ctx.streamId, id),
    sql`
      insert into comp_info (entity, name, avatar, description)
      values (${id}, ${record.name}, ${record.avatar}, ${record.description})
      on conflict do nothing
    `,
    sql`
      insert into comp_room (entity, label, default_access)
      values (${id}, ${record.kind}, ${record.defaultAccess})
      on conflict do nothing
    `,
  ];

  if (record.discordOrigin !== undefined) {
    statements.push(sql`
      insert or ignore into comp_discord_origin (entity, snowflake, guild_id)
      values (${id}, ${record.discordOrigin.snowflake}, ${record.discordOrigin.guildId})
    `);
  }

  return statements.map(space);
}

/**
 * A patch writes only the fields it carries, in the event path's order: the
 * kind, the access level, the basic info, the soft-delete bit, the parent.
 */
function updateStatements(
  change: Extract<RoomChange, { op: "update" }>,
  ctx: RuleContext,
): RuleStatement[] {
  const patch = change.record;
  const id = change.rkey;
  const statements: RuleStatement[] = [];

  if (patch.kind !== undefined) {
    statements.push(
      space(sql`update comp_room set label = ${patch.kind} where entity = ${id}`),
    );
  }

  if (patch.defaultAccess !== undefined) {
    statements.push(
      space(
        sql`update comp_room set default_access = ${patch.defaultAccess} where entity = ${id}`,
      ),
    );
  }

  const info = [
    { key: "name", value: patch.name },
    { key: "avatar", value: patch.avatar },
    { key: "description", value: patch.description },
  ].filter((field) => field.value !== undefined);
  if (info.length > 0) {
    const columns = info.map((field) => field.key);
    statements.push(
      space({
        sql: `insert into comp_info (entity, ${columns.join(", ")})
          values (?, ${columns.map(() => "?").join(", ")})
          on conflict do update set ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}`,
        params: [id, ...info.map((field) => field.value)],
      }),
    );
  }

  if (patch.deleted !== undefined) {
    statements.push(
      space(
        sql`update comp_room set deleted = ${patch.deleted ? 1 : 0} where entity = ${id}`,
      ),
    );
  }

  if (patch.parent !== undefined) {
    statements.push(...parentStatements(id, patch.parent, ctx));
  }

  return statements;
}

/**
 * The `link` edge a parent write maintains. A link records whether it is the
 * room's canonical parent at the instant it is written, and "first link wins"
 * is why the insert does nothing on conflict: re-evaluating the count on a
 * replay would flip the payload of the link that is already there.
 */
function parentStatements(
  roomId: string,
  parent: string | null,
  ctx: RuleContext,
): RuleStatement[] {
  if (parent === null) {
    return ctx.priorParent === undefined
      ? [
          space(sql`
            delete from edges
            where label = 'link' and tail = ${roomId}
          `),
        ]
      : [
          space(sql`
            delete from edges
            where label = 'link' and head = ${ctx.priorParent} and tail = ${roomId}
          `),
        ];
  }

  return [
    space(sql`
      insert into edges (head, tail, label, payload)
      values (
        ${parent},
        ${roomId},
        'link',
        json_object('canonical_parent', (
          SELECT COUNT(*) = 0
          FROM edges
          WHERE head = ${parent}
            AND tail = ${roomId}
            AND label = 'link'
        ))
      )
      on conflict (head, tail, label) do nothing
    `),
  ];
}


/**
 * Projection rules for the role kinds: `role`, `roleGrant` and
 * `roomPermission`.
 *
 * `role` is the `roles` row; a deleted role keeps its row with `deleted = 1`,
 * which every reader filters on, so the record's delete is that update.
 * `roleGrant` is one `member_roles` row keyed by the pair the rkey carries.
 * `roomPermission` is one `role_rooms` row, written as delete-then-insert
 * because a set is a removal followed by a presence, and cleared by its delete.
 */

import { type SqlStatement, sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { space, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type RoleChange = ChangeOf<"role">;
export type RoleGrantChange = ChangeOf<"roleGrant">;
export type RoomPermissionChange = ChangeOf<"roomPermission">;

/** The statements that apply one `role` change. */
export function roleStatements(
  change: RoleChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create": {
      const record = change.record;
      return [
        space(sql`
          insert or ignore into roles (id, stream_id, name, avatar, description)
          values (
            ${change.rkey},
            ${ctx.streamId},
            ${record.name},
            ${record.avatar},
            ${record.description}
          )
        `),
      ];
    }
    case "update": {
      const patch = change.record;
      const fields = [
        { key: "name", value: patch.name },
        { key: "avatar", value: patch.avatar },
        { key: "description", value: patch.description },
      ].filter((field) => field.value !== undefined);
      if (fields.length === 0) return [];
      return [
        space({
          sql: `update roles set ${fields.map((f) => `${f.key} = ?`).join(", ")} where id = ?`,
          params: [...fields.map((f) => f.value), change.rkey],
        }),
      ];
    }
    case "delete":
      return [
        space(sql`update roles set deleted = 1 where id = ${change.rkey}`),
      ];
  }
}

/** The statements that apply one `roleGrant` change. */
export function roleGrantStatements(
  change: RoleGrantChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "create") {
    const record = change.record;
    const statements: SqlStatement[] = [
      sql`
        insert or ignore into member_roles (user_id, role_id, stream_id)
        values (${record.user}, ${record.role}, ${ctx.streamId})
      `,
    ];
    return statements.map(space);
  }
  // The delete names the pair through its key, which is (user, role).
  const [user, role] = splitPair(change.rkey);
  return [
    space(sql`
      delete from member_roles
      where user_id = ${user} and role_id = ${role}
    `),
  ];
}

/** The statements that apply one `roomPermission` change. */
export function roomPermissionStatements(
  change: RoomPermissionChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "delete") {
    const [role, room] = splitPair(change.rkey);
    return [
      space(sql`
        delete from role_rooms
        where role_id = ${role} and room_id = ${room}
      `),
    ];
  }

  const record = change.record;
  return [
    space(sql`
      delete from role_rooms
      where role_id = ${record.role} and room_id = ${record.room}
    `),
    space(sql`
      insert into role_rooms (role_id, room_id, stream_id, permission)
      values (${record.role}, ${record.room}, ${ctx.streamId}, ${record.permission})
    `),
  ];
}

/**
 * The two parts of a composite record key. The join separator is `~`, which
 * appears in no DID or ULID, so a record's identity is the only place the parts
 * have to come from when a delete carries no body.
 */
function splitPair(key: string): [string, string] {
  const [head = "", tail = ""] = key.split("~");
  return [head, tail];
}

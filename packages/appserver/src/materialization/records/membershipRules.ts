/**
 * Projection rules for the membership kinds: `membership`, `ban` and `invite`.
 *
 * Membership is a pair of `member`/`admin` edges in the space's DB and a
 * `joinedSpace`/`leftSpace` pair in the global one, plus — for a join — the
 * system message announcing it. The message is keyed by the join event's id and
 * lands in the space's first channel, so both come from the planner's context
 * rather than from the record.
 *
 * A rejoin keeps the admin bit through the member edge's own subquery, not
 * through the record's `can`: `joinSpace` always carries `post`, and the
 * projection's rule is "an existing `admin` edge wins". `addAdmin`/`removeAdmin`
 * are the writes that move that bit.
 */

import { ensureEntity, type SqlStatement, sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import {
  global,
  space,
  type RuleContext,
  type RuleStatement,
} from "./recordRules.ts";

export type MembershipChange = ChangeOf<"membership">;
export type BanChange = ChangeOf<"ban">;
export type InviteChange = ChangeOf<"invite">;

/** The statements that apply one `membership` change. */
export function membershipStatements(
  change: MembershipChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create":
      return joinStatements(change, ctx);
    case "update":
      return change.record.can === "admin"
        ? addAdminStatements(change.rkey, ctx)
        : removeAdminStatements(change.rkey, ctx);
    case "delete":
      return leaveStatements(change.rkey, ctx);
  }
}

/** A join: both edge sets, the member edge, and the announcement. */
function joinStatements(
  change: Extract<MembershipChange, { op: "create" }>,
  ctx: RuleContext,
): RuleStatement[] {
  const user = change.record.user;
  const stream = ctx.streamId;
  return [
    space(ensureEntity(stream, user, undefined, ctx.decidedAt)),
    space(ensureEntity(stream, stream, undefined, ctx.decidedAt)),
    global(sql`
      insert or ignore into edges (head, tail, label, created_at, updated_at)
      values (${user}, ${stream}, 'joinedSpace', ${ctx.decidedAt}, ${ctx.decidedAt})
    `),
    global(sql`
      delete from edges
      where head = ${user} and tail = ${stream} and label = 'leftSpace'
    `),
    space(sql`
      insert into edges (head, tail, label, payload, created_at, updated_at)
      select
        ${stream},
        ${user},
        'member',
        case when exists (
          select 1 from edges
          where head = ${stream}
            and tail = ${user}
            and label = 'admin'
        ) then '{"can":"admin"}' else '{"can":"post"}' end,
        ${ctx.decidedAt},
        ${ctx.decidedAt}
      where not exists (
        select 1 from edges
        where head = ${stream}
          and tail = ${user}
          and label = 'member'
      )
    `),
    // The announcement: an entity in the space's first live channel, an author
    // edge on the space, and a markdown body naming the joiner.
    space(sql`
      insert into entities (id, stream_id, room, created_at, updated_at)
      values (
        ${ctx.eventId},
        ${stream},
        (
          select entity
            from comp_room join entities e on e.id = entity
            where label = 'space.roomy.channel' and deleted = 0 and e.stream_id = ${stream}
            order by entity
            limit 1
        ),
        ${ctx.decidedAt},
        ${ctx.decidedAt}
      ) on conflict do nothing
    `),
    space(sql`
      insert or replace into edges (head, tail, label, created_at, updated_at)
      select ${ctx.eventId}, ${stream}, 'author', ${ctx.decidedAt}, ${ctx.decidedAt}
    `),
    space(sql`
      insert or replace into comp_content (
        entity, mime_type, data, last_edit, created_at, updated_at
      )
      values (
        ${ctx.eventId},
        'text/markdown',
        cast(('[@' || ${user} || '](/user/' || ${user} || ') joined the space.') as blob),
        ${ctx.eventId},
        ${ctx.decidedAt},
        ${ctx.decidedAt}
      )
    `),
  ];
}

/** `addAdmin`: the member edge carries `admin`, and the durable admin edge appears. */
function addAdminStatements(
  user: string,
  ctx: RuleContext,
): RuleStatement[] {
  const stream = ctx.streamId;
  return [
    space(ensureEntity(stream, stream, undefined, ctx.decidedAt)),
    space(ensureEntity(stream, user, undefined, ctx.decidedAt)),
    space(sql`
      insert or replace into edges (head, tail, label, payload, created_at, updated_at)
      values (
        ${stream}, ${user}, 'member', '{"can":"admin"}',
        ${ctx.decidedAt}, ${ctx.decidedAt}
      )
    `),
    space(sql`
      insert or ignore into edges (head, tail, label, created_at, updated_at)
      values (${stream}, ${user}, 'admin', ${ctx.decidedAt}, ${ctx.decidedAt})
    `),
  ];
}

/** `removeAdmin`: keep the member, drop the admin bit and the admin edge. */
function removeAdminStatements(
  user: string,
  ctx: RuleContext,
): RuleStatement[] {
  const stream = ctx.streamId;
  return [
    space(sql`
      update edges set payload = '{"can":"post"}'
      where head = ${stream} and tail = ${user} and label = 'member'
    `),
    space(sql`
      delete from edges
      where head = ${stream} and tail = ${user} and label = 'admin'
    `),
  ];
}

/**
 * A leave: the member edge goes, the global membership edge goes, and the leave
 * marker stays so the space still lists for the user as one they left.
 */
function leaveStatements(user: string, ctx: RuleContext): RuleStatement[] {
  const stream = ctx.streamId;
  return [
    space(sql`
      delete from edges
      where head = ${stream} and tail = ${user} and label = 'member'
    `),
    global(sql`
      delete from edges
      where head = ${user} and tail = ${stream} and label = 'joinedSpace'
    `),
    global(sql`
      insert or ignore into edges (head, tail, label, created_at, updated_at)
      values (${user}, ${stream}, 'leftSpace', ${ctx.decidedAt}, ${ctx.decidedAt})
    `),
  ];
}

/** The statements that apply one `ban` change. */
export function banStatements(
  change: BanChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "create") {
    return [
      space(sql`
        insert into comp_bans (entity, user_did, created_at)
        values (${ctx.streamId}, ${change.record.user}, ${ctx.decidedAt})
      `),
    ];
  }
  return [
    space(sql`
      delete from comp_bans
      where entity = ${ctx.streamId} and user_did = ${change.rkey}
    `),
  ];
}

/** The statements that apply one `invite` change. */
export function inviteStatements(
  change: InviteChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "create") {
    const record = change.record;
    const statements: SqlStatement[] = [
      sql`
        insert or ignore into comp_invite (entity, token, created_by_did, event_ulid, created_at)
        values (
          ${ctx.streamId}, ${record.token}, ${record.createdBy}, ${ctx.eventId},
          ${ctx.decidedAt}
        )
      `,
    ];
    return statements.map(space);
  }
  return [
    space(sql`
      delete from comp_invite
      where entity = ${ctx.streamId} and token = ${change.rkey}
    `),
  ];
}

/**
 * Projection rules for the federation kinds: `federationRequest` and
 * `federationGrant`.
 *
 * Both live in the global DB — the relationship registry and the origin and
 * receiver grants — because they are cross-space facts: the request arrives on
 * the origin space's stream, while a receiver grant arrives on the receiving
 * space's stream and belongs to the origin space's record. Every statement here
 * is marked `global` rather than left to SQL-text routing.
 *
 * A relationship is never removed from the set: `federation.remove` marks it
 * `removed`, which is why the record's delete is a status update. The decision
 * instant is the derivation's own clock and is not a value the log determines.
 */

import { sql } from "@roomy-space/sdk";

import type { ChangeOf } from "./recordChange.ts";
import { global, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type FederationRequestChange = ChangeOf<"federationRequest">;
export type FederationGrantChange = ChangeOf<"federationGrant">;

/** The statements that apply one `federationRequest` change. */
export function federationRequestStatements(
  change: FederationRequestChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create": {
      const record = change.record;
      return [
        global(sql`
          insert into space_federations (
            space_id, federating_space_did, status,
            requested_by_did, requested_at, message
          )
          values (
            ${ctx.streamId},
            ${record.federatingSpace},
            'pending',
            ${record.requestedBy},
            ${ctx.decidedAt},
            ${record.message}
          )
          on conflict(space_id, federating_space_did) do update set
            status = case
              when space_federations.status = 'removed' then 'pending'
              else space_federations.status
            end,
            requested_by_did = excluded.requested_by_did,
            requested_at = excluded.requested_at,
            message = excluded.message
        `),
      ];
    }
    case "update": {
      const patch = change.record;
      return [
        global(sql`
          update space_federations set
            status = ${patch.status},
            decided_by_did = ${patch.decidedBy},
            decided_at = ${ctx.decidedAt},
            decision_message = ${patch.message}
          where space_id = ${ctx.streamId}
            and federating_space_did = ${change.rkey}
            and status = 'pending'
        `),
      ];
    }
    case "delete":
      // A removed relationship keeps its row so a later request can revive it.
      return [
        global(sql`
          update space_federations set
            status = 'removed',
            decided_by_did = ${ctx.actor},
            decided_at = ${ctx.decidedAt}
          where space_id = ${ctx.streamId}
            and federating_space_did = ${change.rkey}
        `),
      ];
  }
}

/**
 * The statements that apply one `federationGrant` change. The record's repo is
 * the origin space and its key the receiving space, whichever stream the event
 * arrived on.
 */
export function federationGrantStatements(
  change: FederationGrantChange,
): RuleStatement[] {
  if (change.op === "delete") {
    return [
      global(sql`
        delete from federation_room_permissions
        where space_id = ${change.repo}
          and federating_space_did = ${change.rkey}
      `),
      global(sql`
        delete from federation_receiver_permissions
        where space_id = ${change.repo}
          and federating_space_did = ${change.rkey}
      `),
    ];
  }

  if (change.op === "create") {
    // The adapter writes a grant as an update in both directions: a setter
    // names one room or one grantee, which is a patch, not the whole record.
    throw new Error("federationGrant rule: a grant is created by an update");
  }
  const patch = change.record;
  const origin = change.repo;
  const receiving = change.rkey;

  if (patch.scope === "origin") {
    return [
      global(sql`
        delete from federation_room_permissions
        where space_id = ${origin}
          and federating_space_did = ${receiving}
          and room_id = ${patch.room}
      `),
      ...(patch.permission === null
        ? []
        : [
            global(sql`
              insert into federation_room_permissions (
                space_id, federating_space_did, room_id, permission
              )
              values (${origin}, ${receiving}, ${patch.room}, ${patch.permission})
            `),
          ]),
    ];
  }

  return [
    global(sql`
      delete from federation_receiver_permissions
      where space_id = ${origin}
        and federating_space_did = ${receiving}
        and room_id = ${patch.room}
        and grantee = ${patch.grantee}
        and kind = ${patch.granteeKind}
    `),
    ...(patch.permission === null
      ? []
      : [
          global(sql`
            insert into federation_receiver_permissions (
              space_id, federating_space_did, room_id, grantee, kind, permission
            )
            values (
              ${origin}, ${receiving}, ${patch.room},
              ${patch.grantee}, ${patch.granteeKind}, ${patch.permission}
            )
          `),
        ]),
  ];
}

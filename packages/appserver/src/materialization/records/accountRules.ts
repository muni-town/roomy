/**
 * Projection rules for the account and call kinds: `profile`, `calendarLink`
 * and `voiceCall`.
 *
 * `profile` writes the space-local copy of a user's profile — `comp_info` and,
 * when the bridge supplied one, the handle on `comp_user`. The global
 * `profiles` table is not written by either path: profile hydration moved to
 * read time, so the materialiser's output is exactly these two local rows.
 *
 * `calendarLink` is the space's OpenMeet connection: an upsert while a group is
 * configured, a delete when the slug is cleared.
 *
 * `voiceCall` is one call's facts, which live in three tables: `active_calls`
 * and `call_participants` in the space, `voice_projected_calls` in the global
 * index the reconciler walks. A new call supersedes the participants recorded
 * for the previous one in its room.
 */

import { ensureEntity, sql } from "@roomy-space/sdk";
import { decodeTime } from "ulidx";

import type { ChangeOf } from "./recordChange.ts";
import { global, space, type RuleContext, type RuleStatement } from "./recordRules.ts";

export type ProfileChange = ChangeOf<"profile">;
export type CalendarLinkChange = ChangeOf<"calendarLink">;
export type VoiceCallChange = ChangeOf<"voiceCall">;

/** The statements that apply one `profile` change. */
export function profileStatements(
  change: ProfileChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op !== "update") {
    throw new Error(`profile rule: unsupported op ${change.op}`);
  }

  const patch = change.record;
  const statements: RuleStatement[] = [
    space(ensureEntity(ctx.streamId, change.repo, undefined, ctx.decidedAt)),
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
        params: [
          change.repo,
          ...info.map((field) => field.value),
          ctx.decidedAt,
          ctx.decidedAt,
        ],
      }),
    );
  }

  if (patch.handle !== undefined) {
    statements.push(
      space(sql`
        insert into comp_user (did, handle, created_at, updated_at)
        values (${change.repo}, ${patch.handle}, ${ctx.decidedAt}, ${ctx.decidedAt})
        on conflict(did) do update set handle = ${patch.handle}
      `),
    );
  }

  return statements;
}

/** The statements that apply one `calendarLink` change. */
export function calendarLinkStatements(
  change: CalendarLinkChange,
  ctx: RuleContext,
): RuleStatement[] {
  if (change.op === "delete") {
    return [
      space(sql`delete from comp_calendar_link where entity = ${ctx.streamId}`),
    ];
  }
  const record = change.record;
  return [
    space(sql`
      insert or replace into comp_calendar_link (entity, group_slug, tenant_id, api_url)
      values (${ctx.streamId}, ${record.groupSlug}, ${record.tenantId}, ${record.apiUrl})
    `),
  ];
}

/** The statements that apply one `voiceCall` change. */
export function voiceCallStatements(
  change: VoiceCallChange,
  ctx: RuleContext,
): RuleStatement[] {
  switch (change.op) {
    case "create": {
      const record = change.record;
      const room = record.room;
      return [
        space(sql`
          insert into active_calls (room_id, call_id, started_at, source, created_at)
          values (
            ${room},
            ${change.rkey},
            ${record.startedAt},
            ${record.source},
            ${ctx.decidedAt}
          )
          on conflict (room_id) do update set
            started_at = excluded.started_at,
            source = excluded.source
        `),
        // A new call supersedes every participant recorded for the previous
        // one in the same room.
        space(sql`
          delete from call_participants
          where room_id = ${room} and call_id != ${change.rkey}
        `),
        global(sql`
          insert into voice_projected_calls (room_id, space_id, call_id, started_at)
          values (${room}, ${ctx.streamId}, ${change.rkey}, ${record.startedAt})
          on conflict (room_id) do update set
            space_id = excluded.space_id,
            call_id = excluded.call_id,
            started_at = excluded.started_at
        `),
      ];
    }
    case "update": {
      const patch = change.record;
      const room = ctx.priorRoom;
      if (room === undefined) {
        throw new Error(
          `voiceCall rule: no room for call ${change.rkey}`,
        );
      }
      if ("joined" in patch) {
        return [
          space(sql`
            insert into call_participants (room_id, did, call_id, joined_at, source)
            values (
              ${room},
              ${patch.joined},
              ${change.rkey},
              ${decodeTime(ctx.eventId)},
              ${patch.source}
            )
            on conflict (room_id, did) do update set
              call_id = excluded.call_id,
              joined_at = excluded.joined_at,
              source = excluded.source
          `),
        ];
      }
      return [
        space(sql`
          delete from call_participants
          where room_id = ${room}
            and did = ${patch.left}
            and call_id = ${change.rkey}
        `),
      ];
    }
    case "delete": {
      const room = ctx.priorRoom;
      if (room === undefined) {
        throw new Error(
          `voiceCall rule: no room for call ${change.rkey}`,
        );
      }
      return [
        space(sql`
          delete from active_calls
          where room_id = ${room} and call_id = ${change.rkey}
        `),
        space(sql`
          delete from call_participants
          where room_id = ${room} and call_id = ${change.rkey}
        `),
        global(sql`
          delete from voice_projected_calls
          where room_id = ${room} and call_id = ${change.rkey}
        `),
      ];
    }
  }
}

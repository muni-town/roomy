/**
 * Voice call events: durable, room-scoped call facts.
 *
 * One active call per room, identified by `callId`. These events are the
 * record; `active_calls` / `call_participants` (per-space) and
 * `voice_projected_calls` (global) are projections the materialisers below
 * maintain.
 *
 * `source` names the path that produced the fact — explicit client intent,
 * a LiveKit webhook, or the reconciler — so a correction is distinguishable
 * from a user action. Duplicate transitions are collapsed before the fact is
 * written (see the appserver's `voice/callFacts.ts`), and the projections are
 * written idempotently so a replay lands on the same rows.
 */

import { decodeTime } from "ulidx";
import { type, Ulid, UserDid } from "../primitives";
import { defineEvent } from "./utils";
import { sql } from "../../utils";

export const CallFactSource = type(
  "'user' | 'livekit' | 'reconciliation'",
).describe("Which path produced this call fact.");
export type CallFactSource = typeof CallFactSource.infer;

const CallStartedSchema = type({
  $type: "'space.roomy.voice.callStarted.v0'",
  callId: Ulid.describe("The call this fact belongs to."),
  source: CallFactSource,
}).describe("A call started in this room. A room has at most one active call.");

export const CallStarted = defineEvent(CallStartedSchema, ({ streamId, event }) => {
  if (!event.room) throw new Error("No room for call fact");
  return [
    sql`
      insert into active_calls (room_id, call_id, started_at, source)
      values (${event.room}, ${event.callId}, ${decodeTime(event.id)}, ${event.source})
      on conflict (room_id) do update set
        started_at = excluded.started_at,
        source = excluded.source
    `,
    // A new call supersedes every participant recorded for a previous one.
    sql`
      delete from call_participants
      where room_id = ${event.room} and call_id != ${event.callId}
    `,
    // Cross-space index: the reconciler enumerates projected calls from one
    // table rather than walking every per-space DB.
    sql`
      insert into voice_projected_calls (room_id, space_id, call_id, started_at)
      values (${event.room}, ${streamId}, ${event.callId}, ${decodeTime(event.id)})
      on conflict (room_id) do update set
        space_id = excluded.space_id,
        call_id = excluded.call_id,
        started_at = excluded.started_at
    `,
  ];
});

const CallJoinedSchema = type({
  $type: "'space.roomy.voice.callJoined.v0'",
  callId: Ulid.describe("The call that was joined."),
  userDid: UserDid.describe("The participant."),
  source: CallFactSource,
}).describe("A participant joined the room's active call.");

export const CallJoined = defineEvent(CallJoinedSchema, ({ event }) => {
  if (!event.room) throw new Error("No room for call fact");
  return [
    sql`
      insert into call_participants (room_id, did, call_id, joined_at, source)
      values (${event.room}, ${event.userDid}, ${event.callId}, ${decodeTime(event.id)}, ${event.source})
      on conflict (room_id, did) do update set
        call_id = excluded.call_id,
        joined_at = excluded.joined_at,
        source = excluded.source
    `,
  ];
});

const CallLeftSchema = type({
  $type: "'space.roomy.voice.callLeft.v0'",
  callId: Ulid.describe("The call that was left."),
  userDid: UserDid.describe("The participant."),
  source: CallFactSource,
}).describe("A participant left the room's active call.");

export const CallLeft = defineEvent(CallLeftSchema, ({ event }) => {
  if (!event.room) throw new Error("No room for call fact");
  return [
    sql`
      delete from call_participants
      where room_id = ${event.room}
        and did = ${event.userDid}
        and call_id = ${event.callId}
    `,
  ];
});

const CallEndedSchema = type({
  $type: "'space.roomy.voice.callEnded.v0'",
  callId: Ulid.describe("The call that ended."),
  source: CallFactSource,
}).describe("The room's call ended.");

export const CallEnded = defineEvent(CallEndedSchema, ({ event }) => {
  if (!event.room) throw new Error("No room for call fact");
  return [
    sql`
      delete from active_calls
      where room_id = ${event.room} and call_id = ${event.callId}
    `,
    sql`
      delete from call_participants
      where room_id = ${event.room} and call_id = ${event.callId}
    `,
    sql`
      delete from voice_projected_calls
      where room_id = ${event.room} and call_id = ${event.callId}
    `,
  ];
});

/** All voice call event variants. */
export const VoiceEventVariant = type.or(
  CallStartedSchema,
  CallJoinedSchema,
  CallLeftSchema,
  CallEndedSchema,
);
